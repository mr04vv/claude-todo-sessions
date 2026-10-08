pub mod agents;
pub mod cloud;
pub mod codex;
pub mod desktop;
pub mod feynman;
pub mod files;
pub mod github;
pub mod herdr;
pub mod launch;
pub mod ogp;
pub mod transcript;
pub mod usage;

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row};

use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub enum Error {
    Sql(rusqlite::Error),
    TodoNotFound(i64),
    InputNotFound(i64),
    SessionNotFound(String),
    /// Subtasks go one level deep: why this parent cannot be set.
    InvalidParent(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Sql(e) => write!(f, "sqlite: {e}"),
            Error::TodoNotFound(id) => write!(f, "todo {id} not found"),
            Error::InputNotFound(id) => write!(f, "input {id} not found"),
            Error::SessionNotFound(id) => write!(f, "session {id} not found"),
            Error::InvalidParent(why) => write!(f, "{why}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Sql(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Set aside for a while; not planned yet.
    Backlog,
    Todo,
    Doing,
    /// A PR is up and waiting on review.
    Review,
    /// On hold, waiting on something outside the work.
    Pending,
    Done,
}

/// Skill that drills into the details before implementing.
const GRILLING_COMMAND: &str = "/grilling";
/// Every session the app starts asks its questions through the tool, so
/// the answers are picked instead of typed (and the app can tell it waits).
pub(crate) const ASK_INSTRUCTIONS: &str = "質問はすべて AskUserQuestion ツールで聞いてください（本文に質問を書いて待たない）。";
/// Implementation work ends in a PR, whose reviewer the user picks.
const REVIEWER_INSTRUCTIONS: &str = "PR を作ったら、レビューを誰に頼むかを AskUserQuestion で聞いてください（候補は、このリポジトリの最近の PR をレビューした人を `gh` で調べて挙げる）。選ばれた人に `gh pr edit <PR> --add-reviewer <user>` で依頼します。";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Running,
    NeedsInput,
    Idle,
    Ended,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Todo {
    pub id: i64,
    pub title: String,
    pub status: Status,
    pub issue_url: Option<String>,
    pub cwd: Option<String>,
    pub memo: Option<String>,
    pub updated_at: i64,
    /// `owner/repo` list the todo spans; the first one is the main repo.
    pub repos: Vec<String>,
    /// First prompt of sessions started from this todo; None means the title.
    pub prompt: Option<String>,
    /// Last seen GitHub state of `issue_url` ("open" / "closed").
    pub issue_state: Option<String>,
    /// The one pull request this todo ships as.
    pub pr_url: Option<String>,
    /// draft / open / review_requested / changes_requested / approved / merged / closed
    pub pr_state: Option<String>,
    /// The orchestrator todo this one was split from.
    pub parent_id: Option<i64>,
    /// Its PR's CI: "pending", "success" or "failure" (None: no checks).
    pub ci_state: Option<String>,
    /// The checks that failed.
    pub ci_failed: Vec<String>,
}

impl Todo {
    /// A todo spanning several GitHub repositories is planned (split into
    /// subtasks) by default when it starts.
    pub fn is_orchestrator(&self) -> bool {
        self.repos.iter().filter(|r| r.contains('/')).count() > 1
    }

    /// First prompt (without the `[todo:<id>]` marker): the todo's own, else
    /// one grilling the details of its title and memo. Implementing, its PR
    /// closes the issue (so GitHub closes it on merge) and asks whom to
    /// review; `plan` asks instead to split the work into subtasks. Every
    /// session asks its questions through AskUserQuestion.
    pub fn prompt_body(&self, plan: bool) -> String {
        let mut body = self.prompt.clone().unwrap_or_else(|| {
            let memo = self.memo.as_deref().map(str::trim).filter(|m| !m.is_empty());
            [Some(format!("{GRILLING_COMMAND} {}", self.title)), memo.map(Into::into)].into_iter().flatten().collect::<Vec<_>>().join("\n\n")
        });
        body.push_str("\n\n");
        if plan {
            body.push_str(&self.plan_instructions());
        } else {
            if let Some(url) = self.issue_url.as_deref().filter(|u| u.contains("/issues/")) {
                body.push_str(&format!("PR を作るときは、本文に `Closes {url}` を入れてください。"));
            }
            body.push_str(REVIEWER_INSTRUCTIONS);
        }
        body.push_str("\n\n");
        body.push_str(ASK_INSTRUCTIONS);
        body
    }

    /// What a planning session is asked: no implementing, the details settled,
    /// then a subtask per piece of work (per repository when it spans several).
    fn plan_instructions(&self) -> String {
        let repos: Vec<&str> = self.repos.iter().filter(|r| r.contains('/')).map(String::as_str).collect();
        let span = if repos.len() > 1 { format!("複数リポジトリ（{}）にまたがる", repos.join(", ")) } else { "いくつかの作業に分けて進める".into() };
        format!(
            "これは{span}計画用の todo です。ここでは実装せず、詳細を詰めたあと、作業ごとにサブタスクを todo-sessions の create_todo で登録してください（parent_id={}、repos はそのサブタスクのリポジトリ1つ、memo にそのサブタスクの実装方針と完了条件）。",
            self.id
        )
    }
}

#[derive(Debug, Default)]
pub struct NewTodo {
    pub parent_id: Option<i64>,
    pub title: String,
    pub issue_url: Option<String>,
    pub cwd: Option<String>,
    pub memo: Option<String>,
    pub repos: Vec<String>,
}

/// Material to take in (an article, a book's chapter), read in the Input
/// mode: apart from the todos, with no status or sessions of its own.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Input {
    pub id: i64,
    pub title: String,
    pub memo: Option<String>,
    /// Read already: kept, out of the way.
    pub done: bool,
    pub updated_at: i64,
    /// Its pages (and its note), in the order they were added.
    pub links: Vec<InputLink>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InputLink {
    pub id: i64,
    pub input_id: i64,
    pub url: String,
    pub title: Option<String>,
    pub image: Option<String>,
    pub created_at: i64,
}

/// None leaves a field unchanged; an empty memo clears it.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct InputPatch {
    pub title: Option<String>,
    pub memo: Option<String>,
    pub done: Option<bool>,
}

#[derive(Debug, Default)]
/// None leaves a field unchanged; an empty issue_url or cwd clears it.
pub struct TodoPatch {
    pub title: Option<String>,
    pub status: Option<Status>,
    pub memo: Option<String>,
    pub cwd: Option<String>,
    pub issue_url: Option<String>,
    pub repos: Option<Vec<String>>,
    /// Blank clears it, so the title is used again.
    pub prompt: Option<String>,
    /// Blank clears it.
    pub pr_url: Option<String>,
}

/// The program a session runs.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    #[default]
    Claude,
    Codex,
}

impl Agent {
    fn as_str(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
    }
    fn parse(s: &str) -> Agent {
        if s == "codex" { Agent::Codex } else { Agent::Claude }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Session {
    pub session_id: String,
    pub title: Option<String>,
    pub todo_id: Option<i64>,
    pub cwd: String,
    pub state: SessionState,
    pub state_at: i64,
    /// `owner/repo` list a cloud session works on; the first one is where it pushes.
    pub repos: Vec<String>,
    /// Branch a cloud session works on, for finding its PR.
    pub branch: Option<String>,
    /// When the session was first recorded; a PR from its branch made
    /// before then is not its work.
    pub started_at: i64,
    /// Its turn ended (it is idle) after it was last looked at.
    pub unread: bool,
    pub agent: Agent,
    /// The PR it reviews, when the app started it as a review.
    pub review_url: Option<String>,
    /// Taken off the session lists (a Local one, which cannot be archived from here).
    pub hidden: bool,
    /// What it asked when it last started waiting for a reply (transcript::question).
    pub question: Option<String>,
    /// A review that submits on its own, without asking first.
    pub review_auto: bool,
}

/// Why the app notified about a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeKind {
    /// A turn ended: the session went from running to idle.
    Finished,
    NeedsInput,
    /// Someone asked for the user's review on a PR (`url`).
    ReviewRequested,
    /// Time to explain an input (or a todo's pages) again (`input_id` or `todo_id`).
    Study,
}

impl NoticeKind {
    fn as_str(self) -> &'static str {
        match self {
            NoticeKind::Finished => "finished",
            NoticeKind::NeedsInput => "needs_input",
            NoticeKind::ReviewRequested => "review_requested",
            NoticeKind::Study => "study",
        }
    }
    fn parse(s: &str) -> NoticeKind {
        match s {
            "needs_input" => NoticeKind::NeedsInput,
            "review_requested" => NoticeKind::ReviewRequested,
            "study" => NoticeKind::Study,
            _ => NoticeKind::Finished,
        }
    }
}

/// A notification the app posted, kept so it can be read again in the app.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Notice {
    pub id: i64,
    pub session_id: String,
    pub todo_id: Option<i64>,
    pub kind: NoticeKind,
    /// The session's title when it was posted, or the PR's for a review request.
    pub title: String,
    pub created_at: i64,
    pub read: bool,
    /// The PR a review request is for; session notices have none (and an
    /// empty `session_id` goes with one).
    pub url: Option<String>,
    /// The input a study notice is for (a todo's is in `todo_id`).
    pub input_id: Option<i64>,
}

/// What the Input mode is open for: a todo (its pages) or an input.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub enum Subject {
    Todo(i64),
    Input(i64),
}

impl Subject {
    fn kind(self) -> &'static str {
        match self {
            Subject::Todo(_) => "todo",
            Subject::Input(_) => "input",
        }
    }
    fn id(self) -> i64 {
        match self {
            Subject::Todo(id) | Subject::Input(id) => id,
        }
    }
    fn from_row(kind: &str, id: i64) -> Subject {
        if kind == "todo" { Subject::Todo(id) } else { Subject::Input(id) }
    }
}

/// A key point of what a subject's pages say (feynman.rs).
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct FeynmanPoint {
    pub id: i64,
    pub text: String,
}

/// One explanation of a subject and its grading.
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct FeynmanAttempt {
    pub id: i64,
    pub explanation: String,
    pub grade: feynman::Grade,
    pub score: u8,
    pub created_at: i64,
}

/// A subject's latest attempt, and when to explain again.
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct FeynmanSummary {
    pub subject: Subject,
    pub score: u8,
    pub attempted_at: i64,
    pub due_at: i64,
}

/// Notifications kept for the in-app list, newest first.
const NOTICES_LIMIT: i64 = 200;

/// A URL attached to a todo, with the page's Open Graph title and image
/// once they have been fetched.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Link {
    pub id: i64,
    pub todo_id: i64,
    pub url: String,
    pub title: Option<String>,
    pub image: Option<String>,
    pub created_at: i64,
}

/// Hooks from parallel sessions write to the same file.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const MARKER_PREFIX: &str = "[todo:";
/// Session titles are derived from the first prompt and cut to this length.
pub const TITLE_MAX_CHARS: usize = 80;

/// The todos table; `{name}` lets the review migration build a copy.
const TODOS_TABLE: &str = "
CREATE TABLE IF NOT EXISTS {name} (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('backlog', 'todo', 'doing', 'review', 'pending', 'done')),
    issue_url TEXT,
    cwd TEXT,
    memo TEXT,
    updated_at INTEGER NOT NULL,
    repos TEXT,
    prompt TEXT,
    issue_state TEXT,
    pr_url TEXT,
    pr_state TEXT,
    queue_runner TEXT,
    queue_pos INTEGER,
    queue_error TEXT,
    kind TEXT,
    parent_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
    ci_state TEXT,
    ci_failed TEXT
);
";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
    cwd TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'needs_input', 'idle', 'ended')),
    state_at INTEGER NOT NULL,
    title TEXT,
    repos TEXT,
    branch TEXT,
    started_at INTEGER,
    agent TEXT,
    question TEXT
);
CREATE TABLE IF NOT EXISTS marker_checked (
    session_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS review_sessions (
    session_id TEXT PRIMARY KEY,
    pr_url TEXT NOT NULL,
    auto INTEGER
);
CREATE TABLE IF NOT EXISTS session_hidden (
    session_id TEXT PRIMARY KEY,
    hidden_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_seen (
    session_id TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    url TEXT,
    input_id INTEGER
);
CREATE TABLE IF NOT EXISTS feynman_points (
    id INTEGER PRIMARY KEY,
    subject_kind TEXT NOT NULL,
    subject_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feynman_attempts (
    id INTEGER PRIMARY KEY,
    subject_kind TEXT NOT NULL,
    subject_id INTEGER NOT NULL,
    explanation TEXT NOT NULL,
    grade TEXT NOT NULL,
    score INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY,
    todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    image TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inputs (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    memo TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS input_links (
    id INTEGER PRIMARY KEY,
    input_id INTEGER NOT NULL REFERENCES inputs(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    image TEXT,
    created_at INTEGER NOT NULL
);
";

const LINK_COLS: &str = "id, todo_id, url, title, image, created_at";
const INPUT_COLS: &str = "id, title, memo, done, updated_at";
const INPUT_LINK_COLS: &str = "id, input_id, url, title, image, created_at";

const TODO_COLS: &str = "id, title, status, issue_url, cwd, memo, updated_at, repos, prompt, issue_state, pr_url, pr_state, CAST(parent_id AS INTEGER), ci_state, ci_failed";
const SESSION_COLS: &str = "session_id, todo_id, cwd, state, state_at, title, repos, branch, COALESCE(started_at, state_at),
    (state = 'idle' AND state_at > COALESCE((SELECT seen_at FROM session_seen WHERE session_seen.session_id = sessions.session_id), 0)),
    COALESCE(agent, 'claude'),
    (SELECT pr_url FROM review_sessions WHERE review_sessions.session_id = sessions.session_id),
    EXISTS (SELECT 1 FROM session_hidden WHERE session_hidden.session_id = sessions.session_id),
    question,
    COALESCE((SELECT auto FROM review_sessions WHERE review_sessions.session_id = sessions.session_id), 0)";

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Backlog => "backlog",
            Status::Todo => "todo",
            Status::Doing => "doing",
            Status::Review => "review",
            Status::Pending => "pending",
            Status::Done => "done",
        }
    }
    fn parse(s: &str) -> Status {
        match s {
            "backlog" => Status::Backlog,
            "doing" => Status::Doing,
            "review" => Status::Review,
            "pending" => Status::Pending,
            "done" => Status::Done,
            _ => Status::Todo,
        }
    }
}

impl SessionState {
    fn as_str(self) -> &'static str {
        match self {
            SessionState::Running => "running",
            SessionState::NeedsInput => "needs_input",
            SessionState::Idle => "idle",
            SessionState::Ended => "ended",
        }
    }
    fn parse(s: &str) -> SessionState {
        match s {
            "running" => SessionState::Running,
            "needs_input" => SessionState::NeedsInput,
            "ended" => SessionState::Ended,
            _ => SessionState::Idle,
        }
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn todo_from_row(r: &Row) -> rusqlite::Result<Todo> {
    Ok(Todo {
        id: r.get(0)?,
        title: r.get(1)?,
        status: Status::parse(&r.get::<_, String>(2)?),
        issue_url: r.get(3)?,
        cwd: r.get(4)?,
        memo: r.get(5)?,
        updated_at: r.get(6)?,
        repos: split_repos(r.get(7)?),
        prompt: r.get(8)?,
        issue_state: r.get(9)?,
        pr_url: r.get(10)?,
        pr_state: r.get(11)?,
        parent_id: r.get(12)?,
        ci_state: r.get(13)?,
        ci_failed: r.get::<_, Option<String>>(14)?.map(|f| f.split(CI_FAILED_SEPARATOR).map(Into::into).collect()).unwrap_or_default(),
    })
}

fn input_link_from_row(r: &Row) -> rusqlite::Result<InputLink> {
    Ok(InputLink { id: r.get(0)?, input_id: r.get(1)?, url: r.get(2)?, title: r.get(3)?, image: r.get(4)?, created_at: r.get(5)? })
}

fn link_from_row(r: &Row) -> rusqlite::Result<Link> {
    Ok(Link { id: r.get(0)?, todo_id: r.get(1)?, url: r.get(2)?, title: r.get(3)?, image: r.get(4)?, created_at: r.get(5)? })
}

fn session_from_row(r: &Row) -> rusqlite::Result<Session> {
    Ok(Session {
        session_id: r.get(0)?,
        todo_id: r.get(1)?,
        cwd: r.get(2)?,
        state: SessionState::parse(&r.get::<_, String>(3)?),
        state_at: r.get(4)?,
        title: r.get(5)?,
        repos: split_repos(r.get(6)?),
        branch: r.get(7)?,
        started_at: r.get(8)?,
        unread: r.get(9)?,
        agent: Agent::parse(&r.get::<_, String>(10)?),
        review_url: r.get(11)?,
        hidden: r.get(12)?,
        question: r.get(13)?,
        review_auto: r.get(14)?,
    })
}

/// Repo lists are stored comma-separated; NULL or "" means none.
const REPOS_SEPARATOR: char = ',';

fn join_repos(repos: &[String]) -> Option<String> {
    (!repos.is_empty()).then(|| repos.join(&REPOS_SEPARATOR.to_string()))
}

fn split_repos(raw: Option<String>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(REPOS_SEPARATOR)
        .filter(|r| !r.is_empty())
        .map(Into::into)
        .collect()
}

/// Upgrades databases created before a column existed.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    for (table, column) in [("sessions", "title"), ("sessions", "repos"), ("sessions", "branch"), ("sessions", "started_at"), ("todos", "repos"), ("todos", "prompt"), ("todos", "issue_state"), ("todos", "pr_url"), ("todos", "pr_state"), ("todos", "queue_runner"), ("todos", "queue_pos"), ("todos", "queue_error"), ("todos", "kind"), ("todos", "parent_id"), ("notifications", "url"), ("notifications", "input_id"), ("sessions", "agent"), ("sessions", "question"), ("review_sessions", "auto"), ("todos", "ci_state"), ("todos", "ci_failed")] {
        let exists: bool = conn.query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"),
            [],
            |r| r.get::<_, i64>(0).map(|n| n > 0),
        )?;
        if !exists {
            // Integer columns keep integer affinity; older builds added them as TEXT,
            // which TODO_COLS casts back when reading.
            let ty = if matches!(column, "queue_pos" | "parent_id" | "started_at" | "input_id" | "auto") { "INTEGER" } else { "TEXT" };
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"), [])?;
        }
    }
    // Sessions recorded before start times were kept: their last state change is the best guess.
    conn.execute("UPDATE sessions SET started_at = state_at WHERE started_at IS NULL", [])?;
    // Before sessions could be unread, every one counts as seen.
    // ponytail: an empty table looks like a new one, so one emptied seeds again.
    conn.execute(
        "INSERT INTO session_seen (session_id, seen_at) SELECT session_id, ?1 FROM sessions WHERE NOT EXISTS (SELECT 1 FROM session_seen)",
        [now()],
    )?;
    // The status CHECK predates 'review', 'pending' or 'backlog'; SQLite cannot alter a CHECK,
    // so the table is rebuilt (which also gives migrated integer columns their type).
    let todos_sql: String = conn.query_row("SELECT sql FROM sqlite_master WHERE name = 'todos'", [], |r| r.get(0))?;
    if !todos_sql.contains("'backlog'") {
        let cols = TODO_TABLE_COLS;
        conn.execute_batch(&format!(
            "PRAGMA foreign_keys = OFF;
             BEGIN;
             {create}
             INSERT INTO todos_new ({cols}) SELECT {cols} FROM todos;
             DROP TABLE todos;
             ALTER TABLE todos_new RENAME TO todos;
             COMMIT;
             PRAGMA foreign_keys = ON;",
            create = TODOS_TABLE.replace("{name}", "todos_new"),
        ))?;
    }
    // Inputs were todos of kind 'input' once: they move to their own table
    // with their ids (the app keeps their Input mode pages by id) and pages.
    conn.execute_batch(
        "BEGIN;
         INSERT INTO inputs (id, title, memo, done, updated_at)
             SELECT id, title, memo, status = 'done', updated_at FROM todos WHERE kind = 'input';
         INSERT INTO input_links (input_id, url, title, image, created_at)
             SELECT todo_id, url, title, image, created_at FROM links
             WHERE todo_id IN (SELECT id FROM todos WHERE kind = 'input') ORDER BY id;
         DELETE FROM todos WHERE kind = 'input';
         COMMIT;",
    )?;
    Ok(())
}

/// Every column of the todos table, for copying rows between versions.
const TODO_TABLE_COLS: &str = "id, title, status, issue_url, cwd, memo, updated_at, repos, prompt, issue_state, pr_url, pr_state, queue_runner, queue_pos, queue_error, kind, parent_id, ci_state, ci_failed";

/// Check names are kept one per line (a name may have commas).
const CI_FAILED_SEPARATOR: char = '\n';

const REMINDER_OPEN: &str = "<system-reminder>";
const REMINDER_CLOSE: &str = "</system-reminder>";

/// Removes the context blocks Claude Desktop prepends to a prompt.
fn strip_system_reminders(prompt: &str) -> String {
    let mut text = prompt.to_string();
    while let Some(start) = text.find(REMINDER_OPEN) {
        let end = match text[start..].find(REMINDER_CLOSE) {
            Some(i) => start + i + REMINDER_CLOSE.len(),
            None => text.len(),
        };
        text.replace_range(start..end, "");
    }
    text
}

/// The prompt without injected context blocks and its `[todo:<id>]` marker,
/// trimmed and cut to TITLE_MAX_CHARS, or None when nothing is left.
fn title_from_prompt(prompt: &str) -> Option<String> {
    let mut text = strip_system_reminders(prompt);
    if let (Some(start), Some(_)) = (text.find(MARKER_PREFIX), parse_todo_marker(prompt)) {
        if let Some(len) = text[start..].find(']') {
            text.replace_range(start..=start + len, "");
        }
    }
    let t: String = text.trim().chars().take(TITLE_MAX_CHARS).collect();
    (!t.is_empty()).then_some(t)
}

/// Returns the id in the first `[todo:<digits>]` of the prompt.
pub fn parse_todo_marker(prompt: &str) -> Option<i64> {
    let rest = &prompt[prompt.find(MARKER_PREFIX)? + MARKER_PREFIX.len()..];
    let digits = &rest[..rest.find(']')?];
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(&TODOS_TABLE.replace("{name}", "todos"))?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Db { conn })
    }

    pub fn create_todo(&self, t: NewTodo) -> Result<Todo> {
        self.conn.execute(
            "INSERT INTO todos (title, issue_url, cwd, memo, updated_at, repos, parent_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![t.title, t.issue_url, t.cwd, t.memo, now(), join_repos(&t.repos), t.parent_id],
        )?;
        let id = self.conn.last_insert_rowid();
        self.get_todo(id)?.ok_or(Error::TodoNotFound(id))
    }

    pub fn get_todo(&self, id: i64) -> Result<Option<Todo>> {
        Ok(self
            .conn
            .query_row(&format!("SELECT {TODO_COLS} FROM todos WHERE id = ?1"), [id], todo_from_row)
            .optional()?)
    }

    pub fn list_todos(&self, status: Option<Status>) -> Result<Vec<Todo>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {TODO_COLS} FROM todos WHERE ?1 IS NULL OR status = ?1 ORDER BY updated_at DESC, id DESC"
        ))?;
        let rows = stmt.query_map([status.map(Status::as_str)], todo_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn update_todo(&self, id: i64, p: TodoPatch) -> Result<Todo> {
        let n = self.conn.execute(
            "UPDATE todos SET
                title = COALESCE(?2, title),
                status = COALESCE(?3, status),
                memo = COALESCE(?4, memo),
                cwd = CASE WHEN ?5 IS NULL THEN cwd ELSE NULLIF(?5, '') END,
                issue_state = CASE WHEN ?7 IS NULL OR NULLIF(?7, '') IS issue_url THEN issue_state ELSE NULL END,
                issue_url = CASE WHEN ?7 IS NULL THEN issue_url ELSE NULLIF(?7, '') END,
                repos = CASE WHEN ?8 IS NULL THEN repos ELSE NULLIF(?8, '') END,
                prompt = CASE WHEN ?9 IS NULL THEN prompt ELSE NULLIF(?9, '') END,
                pr_state = CASE WHEN ?10 IS NULL OR NULLIF(?10, '') IS pr_url THEN pr_state ELSE NULL END,
                pr_url = CASE WHEN ?10 IS NULL THEN pr_url ELSE NULLIF(?10, '') END,
                updated_at = ?6
             WHERE id = ?1",
            params![
                id,
                p.title,
                p.status.map(Status::as_str),
                p.memo,
                p.cwd,
                now(),
                p.issue_url,
                // Some(vec![]) clears; None keeps.
                p.repos.as_deref().map(|r| join_repos(r).unwrap_or_default()),
                p.prompt.as_deref().map(str::trim),
                p.pr_url.as_deref().map(str::trim),
            ],
        )?;
        if n == 0 {
            return Err(Error::TodoNotFound(id));
        }
        let todo = self.get_todo(id)?.ok_or(Error::TodoNotFound(id))?;
        if p.status == Some(Status::Done) {
            self.finish_parent(&todo)?;
        }
        Ok(todo)
    }

    pub fn delete_todo(&self, id: i64) -> Result<()> {
        match self.conn.execute("DELETE FROM todos WHERE id = ?1", [id])? {
            0 => Err(Error::TodoNotFound(id)),
            _ => Ok(()),
        }
    }

    pub fn add_link(&self, todo_id: i64, url: &str) -> Result<Link> {
        if self.get_todo(todo_id)?.is_none() {
            return Err(Error::TodoNotFound(todo_id));
        }
        let created_at = now();
        self.conn.execute("INSERT INTO links (todo_id, url, created_at) VALUES (?1, ?2, ?3)", params![todo_id, url, created_at])?;
        Ok(Link { id: self.conn.last_insert_rowid(), todo_id, url: url.into(), title: None, image: None, created_at })
    }

    /// Records what the linked page says about itself.
    pub fn set_link_meta(&self, id: i64, title: Option<&str>, image: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE links SET title = ?2, image = ?3 WHERE id = ?1", params![id, title, image])?;
        Ok(())
    }

    pub fn remove_link(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM links WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Every link by its todo, in the order they were added.
    pub fn links_by_todo(&self) -> Result<std::collections::HashMap<i64, Vec<Link>>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {LINK_COLS} FROM links ORDER BY id"))?;
        let rows = stmt.query_map([], link_from_row)?;
        let mut by_todo: std::collections::HashMap<i64, Vec<Link>> = std::collections::HashMap::new();
        for link in rows {
            let link = link?;
            by_todo.entry(link.todo_id).or_default().push(link);
        }
        Ok(by_todo)
    }

    pub fn create_input(&self, title: &str, memo: Option<&str>) -> Result<Input> {
        self.conn.execute("INSERT INTO inputs (title, memo, updated_at) VALUES (?1, ?2, ?3)", params![title, memo, now()])?;
        let id = self.conn.last_insert_rowid();
        self.get_input(id)?.ok_or(Error::InputNotFound(id))
    }

    pub fn get_input(&self, id: i64) -> Result<Option<Input>> {
        let row = self
            .conn
            .query_row(&format!("SELECT {INPUT_COLS} FROM inputs WHERE id = ?1"), [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .optional()?;
        let Some((id, title, memo, done, updated_at)) = row else { return Ok(None) };
        let links = self.input_links(Some(id))?;
        Ok(Some(Input { id, title, memo, done, updated_at, links }))
    }

    /// Every input, the latest changed first.
    pub fn list_inputs(&self) -> Result<Vec<Input>> {
        let mut by_input: std::collections::HashMap<i64, Vec<InputLink>> = std::collections::HashMap::new();
        for link in self.input_links(None)? {
            by_input.entry(link.input_id).or_default().push(link);
        }
        let mut stmt = self.conn.prepare(&format!("SELECT {INPUT_COLS} FROM inputs ORDER BY updated_at DESC, id DESC"))?;
        let rows = stmt.query_map([], |r| {
            let id: i64 = r.get(0)?;
            Ok(Input { id, title: r.get(1)?, memo: r.get(2)?, done: r.get(3)?, updated_at: r.get(4)?, links: by_input.remove(&id).unwrap_or_default() })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The links of one input, or of all, in the order they were added.
    fn input_links(&self, input_id: Option<i64>) -> Result<Vec<InputLink>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {INPUT_LINK_COLS} FROM input_links WHERE ?1 IS NULL OR input_id = ?1 ORDER BY id"))?;
        let rows = stmt.query_map([input_id], input_link_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn update_input(&self, id: i64, p: InputPatch) -> Result<Input> {
        let memo = p.memo.map(|m| m.trim().to_string());
        let changed = self.conn.execute(
            "UPDATE inputs SET title = COALESCE(?2, title), memo = CASE WHEN ?3 IS NULL THEN memo ELSE NULLIF(?3, '') END,
                 done = COALESCE(?4, done), updated_at = ?5 WHERE id = ?1",
            params![id, p.title, memo, p.done, now()],
        )?;
        if changed == 0 {
            return Err(Error::InputNotFound(id));
        }
        self.get_input(id)?.ok_or(Error::InputNotFound(id))
    }

    pub fn delete_input(&self, id: i64) -> Result<()> {
        match self.conn.execute("DELETE FROM inputs WHERE id = ?1", [id])? {
            0 => Err(Error::InputNotFound(id)),
            _ => Ok(()),
        }
    }

    pub fn add_input_link(&self, input_id: i64, url: &str) -> Result<InputLink> {
        let created_at = now();
        if self.conn.execute("UPDATE inputs SET updated_at = ?2 WHERE id = ?1", params![input_id, created_at])? == 0 {
            return Err(Error::InputNotFound(input_id));
        }
        self.conn.execute("INSERT INTO input_links (input_id, url, created_at) VALUES (?1, ?2, ?3)", params![input_id, url, created_at])?;
        Ok(InputLink { id: self.conn.last_insert_rowid(), input_id, url: url.into(), title: None, image: None, created_at })
    }

    /// Records what the input's page says about itself.
    pub fn set_input_link_meta(&self, id: i64, title: Option<&str>, image: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE input_links SET title = ?2, image = ?3 WHERE id = ?1", params![id, title, image])?;
        Ok(())
    }

    pub fn remove_input_link(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM input_links WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn links_for(&self, todo_id: i64) -> Result<Vec<Link>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {LINK_COLS} FROM links WHERE todo_id = ?1 ORDER BY id"))?;
        let rows = stmt.query_map([todo_id], link_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The session was looked at as of `at`: a turn that ended before then is read.
    pub fn mark_session_seen(&self, id: &str, at: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO session_seen (session_id, seen_at) VALUES (?1, ?2) ON CONFLICT(session_id) DO UPDATE SET seen_at = ?2",
            params![id, at],
        )?;
        Ok(())
    }

    pub fn record_session(&self, id: &str, cwd: &str, state: SessionState) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sessions (session_id, cwd, state, state_at, started_at) VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(session_id) DO UPDATE SET cwd = ?2, state = ?3,
                 state_at = CASE WHEN state = ?3 THEN state_at ELSE ?4 END",
            params![id, cwd, state.as_str(), now()],
        )?;
        Ok(())
    }

    pub fn get_session(&self, id: &str) -> Result<Option<Session>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {SESSION_COLS} FROM sessions WHERE session_id = ?1"),
                [id],
                session_from_row,
            )
            .optional()?)
    }

    fn query_sessions(&self, filter: &str, arg: Option<i64>) -> Result<Vec<Session>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {SESSION_COLS} FROM sessions WHERE {filter} ORDER BY state_at DESC"
        ))?;
        let rows = match arg {
            Some(a) => stmt.query_map([a], session_from_row)?,
            None => stmt.query_map([], session_from_row)?,
        };
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn sessions_for_todo(&self, todo_id: i64) -> Result<Vec<Session>> {
        self.query_sessions("todo_id = ?1", Some(todo_id))
    }

    /// Every linked session by its todo, newest state change first: one query
    /// for the whole board instead of one per todo.
    pub fn sessions_by_todo(&self) -> Result<std::collections::HashMap<i64, Vec<Session>>> {
        let mut by_todo: std::collections::HashMap<i64, Vec<Session>> = std::collections::HashMap::new();
        for s in self.query_sessions("todo_id IS NOT NULL", None)? {
            if let Some(id) = s.todo_id {
                by_todo.entry(id).or_default().push(s);
            }
        }
        Ok(by_todo)
    }

    pub fn unlinked_sessions(&self) -> Result<Vec<Session>> {
        self.query_sessions("todo_id IS NULL", None)
    }

    /// Live sessions that belong to a todo; their state changes get notified.
    pub fn linked_sessions(&self) -> Result<Vec<Session>> {
        self.query_sessions("todo_id IS NOT NULL AND state != 'ended'", None)
    }

    /// Every session waiting for the user, with a todo or not (and put away
    /// or not: asking brings it back); these get notified.
    pub fn needs_input_sessions(&self) -> Result<Vec<Session>> {
        self.query_sessions("state = 'needs_input'", None)
    }

    /// Cloud sessions not yet ended; cloud sync re-checks any of these the
    /// list API stopped returning.
    pub fn live_cloud_sessions(&self) -> Result<Vec<Session>> {
        self.query_sessions(
            "session_id LIKE 'cse\\_%' ESCAPE '\\' AND state != 'ended'",
            None,
        )
    }

    /// Cloud sessions of Done todos that are still open and not in a turn,
    /// which the app archives so they leave the session lists.
    pub fn cloud_sessions_to_archive(&self) -> Result<Vec<Session>> {
        self.query_sessions(
            "session_id LIKE 'cse\\_%' ESCAPE '\\' AND state NOT IN ('ended', 'running')
             AND todo_id IN (SELECT id FROM todos WHERE status = 'done')",
            None,
        )
    }

    /// Local (hook- or `claude agents`-tracked) sessions not yet ended.
    pub fn live_local_sessions(&self) -> Result<Vec<Session>> {
        self.query_sessions(
            "session_id NOT LIKE 'cse\\_%' ESCAPE '\\' AND state != 'ended'",
            None,
        )
    }

    /// issue_url of every todo that has one, for skipping already imported issues.
    pub fn issue_urls(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT issue_url FROM todos WHERE issue_url IS NOT NULL")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn link_session(&self, id: &str, todo_id: i64) -> Result<()> {
        if self.get_session(id)?.is_none() {
            return Err(Error::SessionNotFound(id.into()));
        }
        if self.get_todo(todo_id)?.is_none() {
            return Err(Error::TodoNotFound(todo_id));
        }
        self.conn
            .execute("UPDATE sessions SET todo_id = ?2 WHERE session_id = ?1", params![id, todo_id])?;
        self.update_todo(todo_id, TodoPatch { status: Some(Status::Doing), ..Default::default() })?;
        Ok(())
    }

    pub fn unlink_session(&self, id: &str) -> Result<()> {
        match self
            .conn
            .execute("UPDATE sessions SET todo_id = NULL WHERE session_id = ?1", [id])?
        {
            0 => Err(Error::SessionNotFound(id.into())),
            _ => Ok(()),
        }
    }

    /// Records a notification about the session, unread.
    pub fn add_notification(&self, session: &Session, kind: NoticeKind) -> Result<i64> {
        let title = session.title.clone().unwrap_or_else(|| session.session_id.clone());
        self.conn.execute(
            "INSERT INTO notifications (session_id, todo_id, kind, title, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session.session_id, session.todo_id, kind.as_str(), title, now()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn notifications(&self) -> Result<Vec<Notice>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, todo_id, kind, title, created_at, read_at IS NOT NULL, url, input_id FROM notifications ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([NOTICES_LIMIT], |r| {
            Ok(Notice {
                id: r.get(0)?,
                session_id: r.get(1)?,
                todo_id: r.get(2)?,
                kind: NoticeKind::parse(&r.get::<_, String>(3)?),
                title: r.get(4)?,
                created_at: r.get(5)?,
                read: r.get(6)?,
                url: r.get(7)?,
                input_id: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Records that it is time to explain the subject again, for the in-app list.
    pub fn add_study_notice(&self, subject: Subject, title: &str) -> Result<i64> {
        let (todo_id, input_id) = match subject {
            Subject::Todo(id) => (Some(id), None),
            Subject::Input(id) => (None, Some(id)),
        };
        self.conn.execute(
            "INSERT INTO notifications (session_id, todo_id, input_id, kind, title, created_at) VALUES ('', ?1, ?2, ?3, ?4, ?5)",
            params![todo_id, input_id, NoticeKind::Study.as_str(), title, now()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// The subject's key points, replacing the ones it had.
    pub fn set_feynman_points(&self, subject: Subject, points: &[String]) -> Result<Vec<FeynmanPoint>> {
        self.conn.execute("DELETE FROM feynman_points WHERE subject_kind = ?1 AND subject_id = ?2", params![subject.kind(), subject.id()])?;
        let at = now();
        for (i, text) in points.iter().enumerate() {
            self.conn.execute(
                "INSERT INTO feynman_points (subject_kind, subject_id, position, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![subject.kind(), subject.id(), i as i64, text, at],
            )?;
        }
        self.feynman_points(subject)
    }

    pub fn feynman_points(&self, subject: Subject) -> Result<Vec<FeynmanPoint>> {
        let mut stmt = self.conn.prepare("SELECT id, text FROM feynman_points WHERE subject_kind = ?1 AND subject_id = ?2 ORDER BY position")?;
        let rows = stmt.query_map(params![subject.kind(), subject.id()], |r| Ok(FeynmanPoint { id: r.get(0)?, text: r.get(1)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn add_feynman_attempt(&self, subject: Subject, explanation: &str, grade: &feynman::Grade, score: u8) -> Result<FeynmanAttempt> {
        let at = now();
        // Strings and enums only: it always serializes.
        let grade_json = serde_json::to_string(grade).expect("a grade serializes");
        self.conn.execute(
            "INSERT INTO feynman_attempts (subject_kind, subject_id, explanation, grade, score, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![subject.kind(), subject.id(), explanation, grade_json, score as i64, at],
        )?;
        Ok(FeynmanAttempt { id: self.conn.last_insert_rowid(), explanation: explanation.into(), grade: grade.clone(), score, created_at: at })
    }

    /// The subject's attempts, newest first.
    pub fn feynman_attempts(&self, subject: Subject) -> Result<Vec<FeynmanAttempt>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, explanation, grade, score, created_at FROM feynman_attempts WHERE subject_kind = ?1 AND subject_id = ?2 ORDER BY id DESC",
        )?;
        let rows = stmt.query_map(params![subject.kind(), subject.id()], |r| {
            let grade: String = r.get(2)?;
            Ok(FeynmanAttempt {
                id: r.get(0)?,
                explanation: r.get(1)?,
                grade: serde_json::from_str(&grade).unwrap_or_default(),
                score: r.get::<_, i64>(3)? as u8,
                created_at: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Every subject's latest attempt.
    pub fn feynman_summaries(&self) -> Result<Vec<FeynmanSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT subject_kind, subject_id, score, created_at FROM feynman_attempts a
             WHERE id = (SELECT MAX(id) FROM feynman_attempts WHERE subject_kind = a.subject_kind AND subject_id = a.subject_id)",
        )?;
        let rows = stmt.query_map([], |r| {
            let (kind, id, score, at): (String, i64, i64, i64) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
            let score = score as u8;
            Ok(FeynmanSummary { subject: Subject::from_row(&kind, id), score, attempted_at: at, due_at: at + feynman::review_after_days(score) * 86_400 })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The subjects to explain again by `now` (with their titles): their
    /// review is due, they are not done with, and no study notice went out
    /// since their last attempt.
    pub fn feynman_due(&self, now: i64) -> Result<Vec<(Subject, String)>> {
        let mut due = Vec::new();
        for s in self.feynman_summaries()? {
            if s.due_at > now {
                continue;
            }
            let title = match s.subject {
                Subject::Input(id) => self.get_input(id)?.filter(|i| !i.done).map(|i| i.title),
                Subject::Todo(id) => self.get_todo(id)?.filter(|t| t.status != Status::Done).map(|t| t.title),
            };
            let Some(title) = title else { continue };
            let (todo_id, input_id) = match s.subject {
                Subject::Todo(id) => (Some(id), None),
                Subject::Input(id) => (None, Some(id)),
            };
            let noticed: bool = self.conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM notifications WHERE kind = 'study' AND created_at >= ?1 AND ((?2 IS NOT NULL AND todo_id = ?2) OR (?3 IS NOT NULL AND input_id = ?3)))",
                params![s.attempted_at, todo_id, input_id],
                |r| r.get(0),
            )?;
            if !noticed {
                due.push((s.subject, title));
            }
        }
        Ok(due)
    }

    /// Records a review request on the PR unless one was recorded before, and
    /// returns its id when it is new. `read` keeps it out of the unread ones.
    pub fn add_review_notice(&self, url: &str, title: &str, read: bool) -> Result<Option<i64>> {
        let seen: bool = self.conn.query_row("SELECT EXISTS (SELECT 1 FROM notifications WHERE url = ?1)", [url], |r| r.get(0))?;
        if seen {
            return Ok(None);
        }
        let at = now();
        self.conn.execute(
            "INSERT INTO notifications (session_id, kind, title, created_at, read_at, url) VALUES ('', ?1, ?2, ?3, ?4, ?5)",
            params![NoticeKind::ReviewRequested.as_str(), title, at, read.then_some(at), url],
        )?;
        Ok(Some(self.conn.last_insert_rowid()))
    }

    /// Whether any review request was ever recorded.
    pub fn has_review_notices(&self) -> Result<bool> {
        Ok(self.conn.query_row("SELECT EXISTS (SELECT 1 FROM notifications WHERE url IS NOT NULL)", [], |r| r.get(0))?)
    }

    pub fn mark_notification_read(&self, id: i64) -> Result<()> {
        self.conn.execute("UPDATE notifications SET read_at = ?2 WHERE id = ?1 AND read_at IS NULL", params![id, now()])?;
        Ok(())
    }

    /// Whether a cloud session's first prompt was already searched for a marker.
    /// Records the issue's GitHub state and returns the one seen before.
    pub fn set_issue_state(&self, id: i64, state: &str) -> Result<Option<String>> {
        let before = self.get_todo(id)?.ok_or(Error::TodoNotFound(id))?.issue_state;
        self.conn.execute("UPDATE todos SET issue_state = ?2 WHERE id = ?1", params![id, state])?;
        Ok(before)
    }

    pub fn children(&self, parent_id: i64) -> Result<Vec<Todo>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {TODO_COLS} FROM todos WHERE parent_id = ?1 ORDER BY id"))?;
        let rows = stmt.query_map([parent_id], todo_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Makes the todo a subtask of `parent`, or a top-level todo with None.
    /// Subtasks go one level deep, so the parent must not be a subtask and
    /// the todo must not have subtasks of its own.
    pub fn set_parent(&self, id: i64, parent: Option<i64>) -> Result<Todo> {
        self.get_todo(id)?.ok_or(Error::TodoNotFound(id))?;
        if let Some(p) = parent {
            if p == id {
                return Err(Error::InvalidParent("自分自身は親にできません".into()));
            }
            if self.get_todo(p)?.ok_or(Error::TodoNotFound(p))?.parent_id.is_some() {
                return Err(Error::InvalidParent(format!("#{p} はサブタスクなので親にできません")));
            }
            if !self.children(id)?.is_empty() {
                return Err(Error::InvalidParent(format!("#{id} にはサブタスクがあるので、ほかの todo の下には入れられません")));
            }
        }
        self.conn.execute("UPDATE todos SET parent_id = ?2, updated_at = ?3 WHERE id = ?1", params![id, parent, now()])?;
        self.get_todo(id)?.ok_or(Error::TodoNotFound(id))
    }

    /// Marks the parent done once every child is.
    fn finish_parent(&self, child: &Todo) -> Result<()> {
        let Some(parent) = child.parent_id else { return Ok(()) };
        if self.children(parent)?.iter().all(|c| c.status == Status::Done) {
            self.conn.execute("UPDATE todos SET status = 'done', updated_at = ?2 WHERE id = ?1", params![parent, now()])?;
        }
        Ok(())
    }

    /// Puts the todo at the end of the run queue (or changes its runner).
    /// Records the pull request's state and returns the one seen before.
    pub fn set_pr_state(&self, id: i64, state: &str) -> Result<Option<String>> {
        let before = self.get_todo(id)?.ok_or(Error::TodoNotFound(id))?.pr_state;
        self.conn.execute("UPDATE todos SET pr_state = ?2 WHERE id = ?1", params![id, state])?;
        Ok(before)
    }

    /// Records the CI of the todo's PR and returns the state seen before.
    pub fn set_ci(&self, id: i64, ci: Option<&github::Ci>) -> Result<Option<String>> {
        let before = self.get_todo(id)?.ok_or(Error::TodoNotFound(id))?.ci_state;
        let failed = ci.filter(|c| !c.failed.is_empty()).map(|c| c.failed.join(&CI_FAILED_SEPARATOR.to_string()));
        self.conn.execute("UPDATE todos SET ci_state = ?2, ci_failed = ?3 WHERE id = ?1", params![id, ci.map(|c| c.state.as_str()), failed])?;
        Ok(before)
    }

    pub fn set_session_branch(&self, id: &str, branch: &str) -> Result<()> {
        self.conn
            .execute("UPDATE sessions SET branch = ?2 WHERE session_id = ?1", params![id, branch])?;
        Ok(())
    }

    pub fn set_session_repos(&self, id: &str, repos: &[String]) -> Result<()> {
        self.conn
            .execute("UPDATE sessions SET repos = ?2 WHERE session_id = ?1", params![id, join_repos(repos)])?;
        Ok(())
    }

    /// The session reviews the PR at `url` (the app started it so), and
    /// submits the review on its own with `auto`.
    pub fn record_review_session(&self, id: &str, url: &str, auto: bool) -> Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO review_sessions (session_id, pr_url, auto) VALUES (?1, ?2, ?3)", params![id, url, auto])?;
        Ok(())
    }

    /// What the session asks (None clears it).
    pub fn set_session_question(&self, id: &str, question: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE sessions SET question = ?2 WHERE session_id = ?1", params![id, question])?;
        Ok(())
    }

    /// Takes the session off the lists.
    pub fn hide_session(&self, id: &str) -> Result<()> {
        self.conn.execute("INSERT OR IGNORE INTO session_hidden (session_id, hidden_at) VALUES (?1, ?2)", params![id, now()])?;
        Ok(())
    }

    pub fn set_session_agent(&self, id: &str, agent: Agent) -> Result<()> {
        self.conn.execute("UPDATE sessions SET agent = ?2 WHERE session_id = ?1", params![id, agent.as_str()])?;
        Ok(())
    }

    /// Names a session after its first prompt (unless it has a name) and links
    /// it by the prompt's `[todo:<id>]` marker. Returns the todo id it linked to.
    pub fn name_from_prompt(&self, id: &str, prompt: &str) -> Result<Option<i64>> {
        if let Some(title) = title_from_prompt(prompt) {
            self.conn.execute("UPDATE sessions SET title = ?2 WHERE session_id = ?1 AND title IS NULL", params![id, title])?;
        }
        self.link_by_marker(id, prompt)
    }

    pub fn set_session_title(&self, id: &str, title: &str) -> Result<()> {
        self.conn
            .execute("UPDATE sessions SET title = ?2 WHERE session_id = ?1", params![id, title])?;
        Ok(())
    }

    pub fn marker_checked(&self, id: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT 1 FROM marker_checked WHERE session_id = ?1", [id], |_| Ok(()))
            .optional()?
            .is_some())
    }

    pub fn mark_marker_checked(&self, id: &str) -> Result<()> {
        self.conn
            .execute("INSERT OR IGNORE INTO marker_checked (session_id) VALUES (?1)", [id])?;
        Ok(())
    }

    /// Links an unlinked session to the todo named by the prompt's
    /// `[todo:<id>]` marker. Returns the todo id it linked to, if any.
    pub fn link_by_marker(&self, id: &str, prompt: &str) -> Result<Option<i64>> {
        let Some(todo_id) = parse_todo_marker(prompt) else {
            return Ok(None);
        };
        let unlinked = self.get_session(id)?.is_some_and(|s| s.todo_id.is_none());
        if !unlinked || self.get_todo(todo_id)?.is_none() {
            return Ok(None);
        }
        self.link_session(id, todo_id)?;
        Ok(Some(todo_id))
    }

    /// Marks the session running and links it when the prompt carries a
    /// `[todo:<id>]` marker. Returns the todo id it linked to, if any.
    pub fn on_prompt(&self, id: &str, cwd: &str, prompt: &str) -> Result<Option<i64>> {
        self.record_session(id, cwd, SessionState::Running)?;
        self.name_from_prompt(id, prompt)
    }
}
