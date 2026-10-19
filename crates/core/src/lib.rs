pub mod agents;
pub mod cloud;
pub mod codex;
pub mod desktop;
pub mod digest;
pub mod files;
pub mod github;
pub mod herdr;
pub mod launch;
pub mod models;
pub mod ogp;
pub mod pick;
pub mod slack;
pub mod tags;
pub mod transcript;
pub mod translate;
pub mod tts;
pub mod usage;

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row};

use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub enum Error {
    Sql(rusqlite::Error),
    TodoNotFound(i64),
    ReadingNotFound(i64),
    SessionNotFound(String),
    /// Subtasks go one level deep: why this parent cannot be set.
    InvalidParent(String),
    DatabaseNotFound(i64),
    /// Another database has the name.
    DatabaseNameTaken(String),
    DatabaseNameEmpty,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Sql(e) => write!(f, "sqlite: {e}"),
            Error::TodoNotFound(id) => write!(f, "todo {id} not found"),
            Error::ReadingNotFound(id) => write!(f, "reading {id} not found"),
            Error::SessionNotFound(id) => write!(f, "session {id} not found"),
            Error::InvalidParent(why) => write!(f, "{why}"),
            Error::DatabaseNotFound(id) => write!(f, "database {id} not found"),
            Error::DatabaseNameTaken(name) => write!(f, "a database named {name} already exists"),
            Error::DatabaseNameEmpty => write!(f, "a database needs a name"),
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
    /// A parent's plan, which its subtasks' sessions start knowing (the
    /// shared memory its planning session keeps).
    pub plan: Option<String>,
    /// Times its session was sent to fix its PR (CI, changes asked for).
    pub fix_count: i64,
    /// Why it waits on the user, as its orchestrator handed it over.
    pub escalation: Option<String>,
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
        let id = self.id;
        [
            format!("これは{span}計画用の todo です。ここでは実装せず、詳細を詰めたあと、作業ごとにサブタスクを todo-sessions の create_todo で登録してください（parent_id={id}、repos はそのサブタスクのリポジトリ1つ、cwd はそのリポジトリのローカルのフォルダ、memo にそのサブタスクの実装方針と完了条件）。"),
            format!("登録したら、決めたこと（方針・決定事項・完了条件）を set_plan で todo #{id} の計画に書いてください。サブタスクのセッションは、これを最初から知った状態で始まります。"),
            "どのサブタスクを、どこで（Cloud か herdr、Claude か Codex）始めるかを AskUserQuestion で確かめてから、start_subtask で始めてください（既定は、GitHub のリポジトリがあれば Cloud、なければ herdr）。".into(),
            "始めたあとも、このセッションは指揮役として残ってください。サブタスクの出来事（返事待ち・Cloud のサブタスクのひと区切り・CI 失敗・修正依頼・Done）は、このセッションにメッセージで届きます。計画で答えられる質問は reply_to_subtask で答え、CI 失敗と修正依頼は fix_subtask で直させてください。次のことは自分で決めず、escalate で理由を添えて私に回してください：計画に書いていない仕様の選択／お金・権限・データの削除に関わる判断／同じサブタスクで2回直させても CI が通らないとき。".into(),
            "Cloud のサブタスクへは、Claude Code の SendMessage で直接送ってください（宛先は ListAgents に出る、そのサブタスクのセッション。reply_to_subtask は herdr のサブタスク用です）。私に中継を頼む必要はありません。向こうからこのセッションへは返事が来ないので、ひと区切りしたことはこのセッションにメッセージで届きます。ただし、Cloud のサブタスクが選択肢の画面（AskUserQuestion）で止まったときは SendMessage では答えられないので、答えの案を添えて escalate で私に回してください。".into(),
            "答えたこと・させたこと・決めたことは log_progress で残してください。サブタスクが全部 Done になったら、終わったことを私に知らせてください。".into(),
        ]
        .join("\n\n")
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

/// What a reading is: a web page, a post on X, or a book (O'Reilly's) with chapters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReadingKind {
    #[default]
    Article,
    Post,
    Book,
}

impl ReadingKind {
    fn as_str(self) -> &'static str {
        match self {
            ReadingKind::Article => "article",
            ReadingKind::Post => "post",
            ReadingKind::Book => "book",
        }
    }
    fn parse(s: &str) -> ReadingKind {
        match s {
            "post" => ReadingKind::Post,
            "book" => ReadingKind::Book,
            _ => ReadingKind::Article,
        }
    }
}

/// Something kept to read (読みもの): bookmarked in the app's browser (the
/// page shown, a link ⌥-clicked, a post bookmarked on X, a book's page),
/// sorted into `tags::TAGS`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Reading {
    pub id: i64,
    pub kind: ReadingKind,
    /// A book's is the book's own page, its chapters' pages being under it.
    pub url: String,
    pub title: String,
    /// What it says, for its tags: a post's text, or what its page says it is about.
    pub text: Option<String>,
    pub image: Option<String>,
    /// None until sorted; empty when no tag fits.
    pub tags: Option<Vec<String>>,
    /// A book's table of contents, in order; none for the others.
    pub chapters: Vec<Chapter>,
    pub created_at: i64,
    /// Read and kept (a good one), as against still to read.
    pub kept: bool,
    /// A post's links, as X gives them (t.co); none for the others.
    pub links: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Chapter {
    /// From 1, in the book's order.
    pub position: i64,
    pub title: String,
    pub url: String,
    pub read: bool,
}

/// A list the user made to keep todos in (Frontend Backlog), with the todos in it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Database {
    pub id: i64,
    pub name: String,
    pub todos: Vec<i64>,
}

/// A database's name as kept: trimmed, and not empty.
fn database_name(name: &str) -> Result<String> {
    Some(name.trim()).filter(|n| !n.is_empty()).map(Into::into).ok_or(Error::DatabaseNameEmpty)
}

/// The UNIQUE on databases' names failing is the name being taken.
fn name_taken(e: rusqlite::Error, name: &str) -> Error {
    match e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => Error::DatabaseNameTaken(name.into()),
        e => e.into(),
    }
}

/// Jev's credit as read off TypeSafe's console (its billing page has no API):
/// the credit bought or given and what its usage page said was spent, at
/// `at`, with the input tokens this app had used by then (in that Spend).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct JevCredit {
    pub credit: f64,
    pub spent: f64,
    pub base_input_tokens: i64,
    pub at: i64,
}

impl JevCredit {
    /// What is left: what the console left, less what this app has used
    /// since (`all_input_tokens` being all it used); others using the key
    /// (the X extension) are not counted.
    pub fn left(&self, all_input_tokens: i64) -> f64 {
        self.credit - self.spent - tags::cost_usd((all_input_tokens - self.base_input_tokens).max(0))
    }
}

/// The requests to Jev over a span, and their tokens.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct JevTally {
    pub calls: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

/// The requests to Jev today, this month (by the local date) and all along.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct JevSpend {
    pub today: JevTally,
    pub month: JevTally,
    pub all: JevTally,
}

/// A reading to keep; a book comes with its chapters (title, page).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct NewReading {
    pub kind: ReadingKind,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub chapters: Vec<(String, String)>,
    /// A post's links.
    #[serde(default)]
    pub links: Vec<String>,
}

/// A day's readings summed up (its 日報): the document's link, or why it was not made.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Digest {
    /// The local date, YYYY-MM-DD.
    pub day: String,
    pub url: Option<String>,
    pub error: Option<String>,
    pub made_at: i64,
    /// The session making it (the artifact it publishes is the digest).
    pub session_id: Option<String>,
}

/// A 日報 of readings picked by hand, with a podcast of them if asked for:
/// what is being done while it is made (`stage`), then the session making
/// the page, then the page's link, or why it was not made.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PickedDigest {
    pub id: i64,
    /// The readings' ids, in the order picked.
    pub readings: Vec<i64>,
    pub podcast: bool,
    pub stage: Option<String>,
    pub url: Option<String>,
    pub error: Option<String>,
    pub made_at: i64,
    pub session_id: Option<String>,
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
    /// Made in Claude Desktop (it has a record there). Not stored: the app fills it in.
    pub desktop: bool,
    /// A run of a Claude Desktop routine (scheduled task). Not stored either.
    pub routine: bool,
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
}

impl NoticeKind {
    fn as_str(self) -> &'static str {
        match self {
            NoticeKind::Finished => "finished",
            NoticeKind::NeedsInput => "needs_input",
            NoticeKind::ReviewRequested => "review_requested",
        }
    }
    fn parse(s: &str) -> NoticeKind {
        match s {
            "needs_input" => NoticeKind::NeedsInput,
            "review_requested" => NoticeKind::ReviewRequested,
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

/// What an artifact is: a claude.ai artifact, a Claude Docs document, or a
/// file on the Mac.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    Artifact,
    Doc,
    File,
}

impl ArtifactKind {
    fn as_str(self) -> &'static str {
        match self {
            ArtifactKind::Artifact => "artifact",
            ArtifactKind::Doc => "doc",
            ArtifactKind::File => "file",
        }
    }
    fn parse(s: &str) -> ArtifactKind {
        match s {
            "doc" => ArtifactKind::Doc,
            "file" => ArtifactKind::File,
            _ => ArtifactKind::Artifact,
        }
    }
}

/// Something a session made other than a PR: found in its record (a
/// claude.ai artifact or doc) or registered by it (a file), with the todo it is for.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Artifact {
    pub id: i64,
    /// A claude.ai page, or a file's path.
    pub url: String,
    pub title: Option<String>,
    pub kind: ArtifactKind,
    pub session_id: Option<String>,
    pub todo_id: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct NewArtifact {
    pub url: String,
    pub title: Option<String>,
    pub kind: ArtifactKind,
    pub session_id: Option<String>,
    pub todo_id: Option<i64>,
}

/// A Slack message for the user (#27): a mention of them, or of a user
/// group they are in, in a channel. Read or not is the app's own.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SlackMessage {
    pub channel: String,
    pub ts: String,
    /// The thread it is in; None for a message in the channel itself.
    pub thread_ts: Option<String>,
    pub channel_name: String,
    pub user_name: String,
    /// As plain text (slack::plain).
    pub text: String,
    pub permalink: String,
    /// The user group's handle when it mentions a group, not the user.
    pub via: Option<String>,
    /// The sender's picture.
    pub user_image: Option<String>,
    pub read: bool,
}

#[derive(Debug, Clone)]
pub struct NewSlackMessage {
    pub channel: String,
    pub ts: String,
    pub thread_ts: Option<String>,
    pub channel_name: String,
    pub user_name: String,
    pub text: String,
    pub permalink: String,
    pub via: Option<String>,
    pub user_image: Option<String>,
}

/// A Slack message the user bookmarked (the head of a thread stands for
/// the thread), as it was when bookmarked; kept until taken off.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlackBookmark {
    pub channel: String,
    pub ts: String,
    pub thread_ts: Option<String>,
    pub channel_name: String,
    pub user_name: String,
    pub user_image: Option<String>,
    /// As plain text.
    pub text: String,
    pub permalink: String,
}

/// A Slack channel muted in the app (Slack keeps its own mute where a user
/// token cannot read it): its mentions and replies are not kept or shown.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MutedChannel {
    pub channel: String,
    pub name: String,
}

/// A Slack thread the user is in (#28): one they wrote in, or were
/// mentioned in, and its replies since they last saw it (none while muted, #29).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SlackThread {
    pub channel: String,
    pub thread_ts: String,
    pub channel_name: String,
    pub permalink: String,
    pub latest_ts: Option<String>,
    pub latest_user_name: Option<String>,
    pub latest_text: Option<String>,
    pub latest_image: Option<String>,
    pub new_replies: i64,
}

/// A reply in a followed thread, as it came.
#[derive(Debug, Clone)]
pub struct SlackReply {
    pub ts: String,
    pub user_name: String,
    pub text: String,
    pub user_image: Option<String>,
}

/// Something that happened under a todo: what its orchestrator did, or what
/// it was told of its subtasks (its 経過).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TodoEvent {
    pub id: i64,
    pub todo_id: i64,
    pub at: i64,
    pub text: String,
}

/// Events a todo's 経過 lists.
const EVENTS_LIMIT: i64 = 200;

/// Times an orchestrator has a subtask fix its PR before the user takes over.
pub const MAX_FIXES: i64 = 2;

/// Notifications kept for the in-app list, newest first.
const NOTICES_LIMIT: i64 = 200;

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
    ci_failed TEXT,
    plan TEXT,
    fix_count INTEGER,
    escalation TEXT
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
    input_id INTEGER,
    -- A review request's PR no longer asks for the user's review.
    gone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY,
    todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    image TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    kind TEXT NOT NULL,
    session_id TEXT,
    todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    gone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS todo_events (
    id INTEGER PRIMARY KEY,
    todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_messages (
    channel TEXT NOT NULL,
    ts TEXT NOT NULL,
    thread_ts TEXT,
    channel_name TEXT NOT NULL,
    user_name TEXT NOT NULL,
    text TEXT NOT NULL,
    permalink TEXT NOT NULL,
    via TEXT,
    user_image TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    gone INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel, ts)
);
CREATE TABLE IF NOT EXISTS slack_threads (
    channel TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    permalink TEXT NOT NULL,
    latest_ts TEXT,
    latest_user_name TEXT,
    latest_text TEXT,
    latest_image TEXT,
    new_replies INTEGER NOT NULL DEFAULT 0,
    muted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel, thread_ts)
);
CREATE TABLE IF NOT EXISTS slack_bookmarks (
    channel TEXT NOT NULL,
    ts TEXT NOT NULL,
    thread_ts TEXT,
    channel_name TEXT NOT NULL,
    user_name TEXT NOT NULL,
    user_image TEXT,
    text TEXT NOT NULL,
    permalink TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (channel, ts)
);
CREATE TABLE IF NOT EXISTS slack_muted_channels (
    channel TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'article',
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    text TEXT,
    image TEXT,
    -- One per line; NULL until sorted.
    tags TEXT,
    created_at INTEGER NOT NULL,
    -- Read and kept (a good one), as against still to read.
    kept INTEGER NOT NULL DEFAULT 0,
    -- A post's links (as X gives them, t.co), one per line.
    links TEXT
);
CREATE TABLE IF NOT EXISTS reading_chapters (
    reading_id INTEGER NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (reading_id, position)
);
-- The requests to Jev (tags::ask) a day, by the local date, and their tokens.
CREATE TABLE IF NOT EXISTS jev_usage (
    day TEXT PRIMARY KEY,
    calls INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL
);
-- Lists the user makes to keep todos in (Frontend Backlog); a todo is in one at most.
CREATE TABLE IF NOT EXISTS databases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS database_todos (
    todo_id INTEGER PRIMARY KEY REFERENCES todos(id) ON DELETE CASCADE,
    database_id INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE
);
-- A day's readings summed up (its 日報, a Claude Docs document), or why that failed.
CREATE TABLE IF NOT EXISTS digests (
    day TEXT PRIMARY KEY,
    url TEXT,
    error TEXT,
    made_at INTEGER NOT NULL,
    session_id TEXT
);
-- A 日報 of readings picked by hand (PickedDigest); readings are their ids, comma-separated.
CREATE TABLE IF NOT EXISTS picked_digests (
    id INTEGER PRIMARY KEY,
    readings TEXT NOT NULL,
    podcast INTEGER NOT NULL DEFAULT 0,
    stage TEXT,
    url TEXT,
    error TEXT,
    made_at INTEGER NOT NULL,
    session_id TEXT
);
-- Jev's credit as last read off TypeSafe's console (JevCredit); one row at most.
CREATE TABLE IF NOT EXISTS jev_credit (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    credit REAL NOT NULL,
    spent REAL NOT NULL,
    base_input_tokens INTEGER NOT NULL,
    at INTEGER NOT NULL
);
";

const READING_COLS: &str = "id, kind, url, title, text, image, tags, created_at, kept, links";
/// A reading's tags are kept one per line (a tag may have a comma).
const TAGS_SEPARATOR: char = '\n';

const TODO_COLS: &str = "id, title, status, issue_url, cwd, memo, updated_at, repos, prompt, issue_state, pr_url, pr_state, CAST(parent_id AS INTEGER), ci_state, ci_failed, plan, COALESCE(CAST(fix_count AS INTEGER), 0), escalation";
/// A Slack row (a message, a thread) not in a channel muted in the app.
const UNMUTED: &str = "channel NOT IN (SELECT channel FROM slack_muted_channels)";
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

/// Unix seconds.
pub fn now() -> i64 {
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
        plan: r.get(15)?,
        fix_count: r.get(16)?,
        escalation: r.get(17)?,
    })
}

/// A reading's row, its chapters left for `with_chapters` to fill.
fn reading_from_row(r: &Row) -> rusqlite::Result<Reading> {
    let tags: Option<String> = r.get(6)?;
    Ok(Reading {
        id: r.get(0)?,
        kind: ReadingKind::parse(&r.get::<_, String>(1)?),
        url: r.get(2)?,
        title: r.get(3)?,
        text: r.get(4)?,
        image: r.get(5)?,
        tags: tags.map(|t| t.split(TAGS_SEPARATOR).filter(|t| !t.is_empty()).map(Into::into).collect()),
        chapters: Vec::new(),
        created_at: r.get(7)?,
        kept: r.get(8)?,
        links: r.get::<_, Option<String>>(9)?.map(|l| l.lines().map(Into::into).collect()).unwrap_or_default(),
    })
}

/// A chapter's page, as it is matched: without its fragment.
fn chapter_url(url: &str) -> &str {
    url.split('#').next().unwrap_or(url)
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
        desktop: false,
        routine: false,
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
    // Reviews that ended before a stopped review counted as failed (with
    // review_sessions.auto) are put away once, rather than all waiting on the user.
    let reviews_counted: bool = conn.query_row("SELECT COUNT(*) FROM pragma_table_info('review_sessions') WHERE name = 'auto'", [], |r| r.get::<_, i64>(0).map(|n| n > 0))?;
    if !reviews_counted {
        conn.execute(
            "INSERT OR IGNORE INTO session_hidden (session_id, hidden_at)
             SELECT session_id, ?1 FROM sessions WHERE state = 'ended' AND session_id IN (SELECT session_id FROM review_sessions)",
            [now()],
        )?;
    }
    for (table, column) in [("sessions", "title"), ("sessions", "repos"), ("sessions", "branch"), ("sessions", "started_at"), ("todos", "repos"), ("todos", "prompt"), ("todos", "issue_state"), ("todos", "pr_url"), ("todos", "pr_state"), ("todos", "queue_runner"), ("todos", "queue_pos"), ("todos", "queue_error"), ("todos", "kind"), ("todos", "parent_id"), ("notifications", "url"), ("notifications", "input_id"), ("sessions", "agent"), ("sessions", "question"), ("review_sessions", "auto"), ("todos", "ci_state"), ("todos", "ci_failed"), ("todos", "plan"), ("todos", "fix_count"), ("todos", "escalation"), ("slack_messages", "user_image"), ("slack_messages", "gone"), ("artifacts", "gone"), ("notifications", "gone"), ("readings", "kept"), ("readings", "links"), ("digests", "session_id")] {
        let exists: bool = conn.query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"),
            [],
            |r| r.get::<_, i64>(0).map(|n| n > 0),
        )?;
        if !exists {
            // Integer columns keep integer affinity; older builds added them as TEXT,
            // which TODO_COLS casts back when reading.
            let ty = match column {
                "queue_pos" | "parent_id" | "started_at" | "input_id" | "auto" | "fix_count" => "INTEGER",
                // A flag every row needs: not let go, not kept.
                "gone" | "kept" => "INTEGER NOT NULL DEFAULT 0",
                _ => "TEXT",
            };
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
    // What was to be read (todos of kind 'input' once, then inputs in
    // learning themes) is kept as articles to read, a page each; the themes,
    // their reviews and the inputs go.
    conn.execute_batch(
        "BEGIN;
         INSERT OR IGNORE INTO readings (url, title, image, created_at)
             SELECT l.url, COALESCE(l.title, t.title), l.image, l.created_at FROM links l JOIN todos t ON t.id = l.todo_id
             WHERE t.kind = 'input' ORDER BY l.id;
         DELETE FROM todos WHERE kind = 'input';
         COMMIT;",
    )?;
    let inputs: bool = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'input_links'", [], |r| r.get::<_, i64>(0).map(|n| n > 0))?;
    if inputs {
        conn.execute(
            "INSERT OR IGNORE INTO readings (url, title, image, created_at)
             SELECT l.url, COALESCE(l.title, i.title), l.image, l.created_at FROM input_links l JOIN inputs i ON i.id = l.input_id ORDER BY l.id",
            [],
        )?;
    }
    conn.execute_batch(
        "DROP TABLE IF EXISTS input_links;
         DROP TABLE IF EXISTS inputs;
         DROP TABLE IF EXISTS themes;
         DROP TABLE IF EXISTS categories;
         DROP TABLE IF EXISTS feynman_points;
         DROP TABLE IF EXISTS feynman_attempts;",
    )?;
    // The days' digests were of X's bookmarks alone at first, in x_digests.
    let x_digests: bool = conn.query_row("SELECT COUNT(*) > 0 FROM sqlite_master WHERE name = 'x_digests'", [], |r| r.get(0))?;
    if x_digests {
        conn.execute_batch(
            "BEGIN;
             INSERT OR IGNORE INTO digests (day, url, error, made_at) SELECT day, url, error, made_at FROM x_digests;
             DROP TABLE x_digests;
             COMMIT;",
        )?;
    }
    // Digests' sessions started before start_digest put them away.
    conn.execute("INSERT OR IGNORE INTO session_hidden (session_id, hidden_at) SELECT session_id, ?1 FROM digests WHERE session_id IS NOT NULL", [now()])?;
    Ok(())
}

/// Every column of the todos table, for copying rows between versions.
const TODO_TABLE_COLS: &str = "id, title, status, issue_url, cwd, memo, updated_at, repos, prompt, issue_state, pr_url, pr_state, queue_runner, queue_pos, queue_error, kind, parent_id, ci_state, ci_failed, plan, fix_count, escalation";

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

    /// Keeps a reading; one kept already stays as it was, but a book takes
    /// the chapters it lacks.
    pub fn add_reading(&self, r: &NewReading) -> Result<Reading> {
        let text = r.text.as_deref().map(str::trim).filter(|t| !t.is_empty());
        let links = Some(r.links.join("\n")).filter(|l| !l.is_empty());
        self.conn.execute(
            "INSERT OR IGNORE INTO readings (kind, url, title, text, created_at, links) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![r.kind.as_str(), r.url, r.title.trim(), text, now(), links],
        )?;
        // Kept again: a post kept before its links were gets them.
        self.conn.execute("UPDATE readings SET links = ?2 WHERE url = ?1 AND links IS NULL", params![r.url, links])?;
        let id: i64 = self.conn.query_row("SELECT id FROM readings WHERE url = ?1", [&r.url], |row| row.get(0))?;
        for (i, (title, url)) in r.chapters.iter().enumerate() {
            self.conn.execute(
                "INSERT OR IGNORE INTO reading_chapters (reading_id, position, title, url) VALUES (?1, ?2, ?3, ?4)",
                params![id, i as i64 + 1, title.trim(), chapter_url(url)],
            )?;
        }
        Ok(self.query_readings("id = ?1", [id])?.remove(0))
    }

    /// Every reading, the newest first.
    pub fn list_readings(&self) -> Result<Vec<Reading>> {
        self.query_readings("1 ORDER BY created_at DESC, id DESC", [])
    }

    /// The readings not sorted into tags yet, the oldest first.
    pub fn unsorted_readings(&self) -> Result<Vec<Reading>> {
        self.query_readings("tags IS NULL ORDER BY created_at, id", [])
    }

    fn query_readings<P: rusqlite::Params>(&self, filter: &str, p: P) -> Result<Vec<Reading>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {READING_COLS} FROM readings WHERE {filter}"))?;
        let mut readings = stmt.query_map(p, reading_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt = self.conn.prepare("SELECT reading_id, position, title, url, read FROM reading_chapters ORDER BY reading_id, position")?;
        let chapters = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, Chapter { position: r.get(1)?, title: r.get(2)?, url: r.get(3)?, read: r.get(4)? })))?;
        for row in chapters {
            let (id, chapter) = row?;
            if let Some(reading) = readings.iter_mut().find(|r| r.id == id) {
                reading.chapters.push(chapter);
            }
        }
        Ok(readings)
    }

    /// What its page says about itself, where the reading has nothing yet.
    pub fn fill_reading(&self, id: i64, text: Option<&str>, image: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE readings SET text = COALESCE(text, ?2), image = COALESCE(image, ?3) WHERE id = ?1", params![id, text, image])?;
        Ok(())
    }

    pub fn set_reading_tags(&self, id: i64, tags: &[String]) -> Result<()> {
        match self.conn.execute("UPDATE readings SET tags = ?2 WHERE id = ?1", params![id, tags.join(&TAGS_SEPARATOR.to_string())])? {
            0 => Err(Error::ReadingNotFound(id)),
            _ => Ok(()),
        }
    }

    /// A database named `name`, new.
    pub fn create_database(&self, name: &str) -> Result<Database> {
        let name = database_name(name)?;
        self.conn.execute("INSERT INTO databases (name, created_at) VALUES (?1, ?2)", params![name, now()]).map_err(|e| name_taken(e, &name))?;
        Ok(Database { id: self.conn.last_insert_rowid(), name, todos: vec![] })
    }

    pub fn rename_database(&self, id: i64, name: &str) -> Result<()> {
        let name = database_name(name)?;
        match self.conn.execute("UPDATE databases SET name = ?2 WHERE id = ?1", params![id, name]).map_err(|e| name_taken(e, &name))? {
            0 => Err(Error::DatabaseNotFound(id)),
            _ => Ok(()),
        }
    }

    /// Its todos stay, in no database.
    pub fn delete_database(&self, id: i64) -> Result<()> {
        match self.conn.execute("DELETE FROM databases WHERE id = ?1", [id])? {
            0 => Err(Error::DatabaseNotFound(id)),
            _ => Ok(()),
        }
    }

    /// Every database, in the order made, with the todos in it.
    pub fn databases(&self) -> Result<Vec<Database>> {
        let mut stmt = self.conn.prepare("SELECT id, name FROM databases ORDER BY id")?;
        let mut databases = stmt.query_map([], |r| Ok(Database { id: r.get(0)?, name: r.get(1)?, todos: vec![] }))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt = self.conn.prepare("SELECT database_id, todo_id FROM database_todos ORDER BY todo_id")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
            let (database, todo) = row?;
            if let Some(d) = databases.iter_mut().find(|d| d.id == database) {
                d.todos.push(todo);
            }
        }
        Ok(databases)
    }

    /// Puts the todo in a database (out of the one it was in), or with None in none.
    pub fn set_todo_database(&self, todo_id: i64, database_id: Option<i64>) -> Result<()> {
        if self.get_todo(todo_id)?.is_none() {
            return Err(Error::TodoNotFound(todo_id));
        }
        let Some(database_id) = database_id else {
            self.conn.execute("DELETE FROM database_todos WHERE todo_id = ?1", [todo_id])?;
            return Ok(());
        };
        let known: bool = self.conn.query_row("SELECT COUNT(*) > 0 FROM databases WHERE id = ?1", [database_id], |r| r.get(0))?;
        if !known {
            return Err(Error::DatabaseNotFound(database_id));
        }
        self.conn.execute(
            "INSERT INTO database_todos (todo_id, database_id) VALUES (?1, ?2) ON CONFLICT(todo_id) DO UPDATE SET database_id = ?2",
            params![todo_id, database_id],
        )?;
        Ok(())
    }

    /// Counts a request to Jev, today's.
    pub fn add_jev_usage(&self, usage: &tags::Usage) -> Result<()> {
        self.conn.execute(
            "INSERT INTO jev_usage (day, calls, input_tokens, output_tokens) VALUES (date('now', 'localtime'), 1, ?1, ?2)
             ON CONFLICT(day) DO UPDATE SET calls = calls + 1, input_tokens = input_tokens + ?1, output_tokens = output_tokens + ?2",
            params![usage.input_tokens, usage.output_tokens],
        )?;
        Ok(())
    }

    /// The requests to Jev today, this month and all along.
    pub fn jev_spend(&self) -> Result<JevSpend> {
        let since = |start: &str| -> Result<JevTally> {
            Ok(self.conn.query_row(
                &format!("SELECT COALESCE(SUM(calls), 0), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0) FROM jev_usage WHERE day >= {start}"),
                [],
                |r| Ok(JevTally { calls: r.get(0)?, input_tokens: r.get(1)?, output_tokens: r.get(2)? }),
            )?)
        };
        Ok(JevSpend {
            today: since("date('now', 'localtime')")?,
            month: since("date('now', 'localtime', 'start of month')")?,
            all: since("''")?,
        })
    }

    /// Keeps Jev's credit as just read off the console, against what this app has used so far.
    pub fn set_jev_credit(&self, credit: f64, spent: f64) -> Result<JevCredit> {
        let credit = JevCredit { credit, spent, base_input_tokens: self.jev_spend()?.all.input_tokens, at: now() };
        self.conn.execute(
            "INSERT INTO jev_credit (id, credit, spent, base_input_tokens, at) VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET credit = ?1, spent = ?2, base_input_tokens = ?3, at = ?4",
            params![credit.credit, credit.spent, credit.base_input_tokens, credit.at],
        )?;
        Ok(credit)
    }

    pub fn clear_jev_credit(&self) -> Result<()> {
        self.conn.execute("DELETE FROM jev_credit", [])?;
        Ok(())
    }

    pub fn jev_credit(&self) -> Result<Option<JevCredit>> {
        Ok(self
            .conn
            .query_row("SELECT credit, spent, base_input_tokens, at FROM jev_credit", [], |r| {
                Ok(JevCredit { credit: r.get(0)?, spent: r.get(1)?, base_input_tokens: r.get(2)?, at: r.get(3)? })
            })
            .optional()?)
    }

    /// With a tag some reading has no longer among `known` (the tags were
    /// changed), every reading goes back to be sorted; how many did.
    pub fn unsort_readings_if_tags_gone(&self, known: &[&str]) -> Result<usize> {
        let mut stmt = self.conn.prepare("SELECT tags FROM readings WHERE tags IS NOT NULL")?;
        let tagged = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let gone = tagged.iter().any(|tags| tags.split(TAGS_SEPARATOR).any(|t| !t.is_empty() && !known.contains(&t)));
        if !gone {
            return Ok(0);
        }
        Ok(self.conn.execute("UPDATE readings SET tags = NULL WHERE tags IS NOT NULL", [])?)
    }

    pub fn set_chapter_read(&self, reading_id: i64, position: i64, read: bool) -> Result<()> {
        match self.conn.execute("UPDATE reading_chapters SET read = ?3 WHERE reading_id = ?1 AND position = ?2", params![reading_id, position, read])? {
            0 => Err(Error::ReadingNotFound(reading_id)),
            _ => Ok(()),
        }
    }

    /// Marks the chapter whose page `url` is as read; false when no book has it.
    pub fn mark_chapter_read(&self, url: &str) -> Result<bool> {
        Ok(self.conn.execute("UPDATE reading_chapters SET read = 1 WHERE url = ?1", [chapter_url(url)])? > 0)
    }

    /// The local date `offset` days from today, YYYY-MM-DD (the database's clock, as the days are kept).
    pub fn local_day(&self, offset: i64) -> Result<String> {
        Ok(self.conn.query_row("SELECT date('now', 'localtime', ?1 || ' days')", [offset.to_string()], |r| r.get(0))?)
    }

    /// The local hour now (0–23).
    pub fn local_hour(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT CAST(strftime('%H', 'now', 'localtime') AS INTEGER)", [], |r| r.get(0))?)
    }

    /// The readings kept on `day` (the local date), in the order kept.
    pub fn readings_on(&self, day: &str) -> Result<Vec<Reading>> {
        self.query_readings("date(created_at, 'unixepoch', 'localtime') = ?1 ORDER BY created_at, id", [day])
    }

    /// A day's digest made (its document's link), or why it was not.
    pub fn set_digest(&self, day: &str, made: std::result::Result<&str, &str>) -> Result<()> {
        let (url, error) = match made {
            Ok(url) => (Some(url), None),
            Err(why) => (None, Some(why)),
        };
        self.conn.execute(
            "INSERT INTO digests (day, url, error, made_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(day) DO UPDATE SET url = ?2, error = ?3, made_at = ?4",
            params![day, url, error, now()],
        )?;
        Ok(())
    }

    /// `day`'s digest being made in session `session_id`, from scratch. The
    /// session is off the lists (unless it asks): the digest shows it.
    pub fn start_digest(&self, day: &str, session_id: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO digests (day, url, error, made_at, session_id) VALUES (?1, NULL, NULL, ?2, ?3)
             ON CONFLICT(day) DO UPDATE SET url = NULL, error = NULL, made_at = ?2, session_id = ?3",
            params![day, now(), session_id],
        )?;
        self.hide_session(session_id)
    }

    /// An artifact session `session_id` published: the digest it makes, if it
    /// makes one (and has none yet); whether it was.
    pub fn digest_made_by(&self, session_id: &str, url: &str) -> Result<bool> {
        // Published, not a file: the html skill's page is written to a file first.
        if !url.starts_with("https://") {
            return Ok(false);
        }
        let day = self.conn.execute("UPDATE digests SET url = ?2, error = NULL WHERE session_id = ?1 AND url IS NULL", params![session_id, url])?;
        let picked = self.conn.execute("UPDATE picked_digests SET url = ?2, error = NULL WHERE session_id = ?1 AND url IS NULL", params![session_id, url])?;
        Ok(day + picked > 0)
    }

    /// A 日報 of `readings` (ids, in the order picked) to make, its podcast too
    /// if `podcast`, at `stage`; its id.
    pub fn add_picked_digest(&self, readings: &[i64], podcast: bool, stage: &str) -> Result<i64> {
        let ids = readings.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
        self.conn.execute("INSERT INTO picked_digests (readings, podcast, stage, made_at) VALUES (?1, ?2, ?3, ?4)", params![ids, podcast, stage, now()])?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Picked digest `id` to make again, from scratch, at `stage`.
    pub fn restart_picked_digest(&self, id: i64, stage: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE picked_digests SET stage = ?2, url = NULL, error = NULL, session_id = NULL, made_at = ?3 WHERE id = ?1",
            params![id, stage, now()],
        )?;
        Ok(())
    }

    /// What is being done for picked digest `id`.
    pub fn set_picked_stage(&self, id: i64, stage: &str) -> Result<()> {
        self.conn.execute("UPDATE picked_digests SET stage = ?2 WHERE id = ?1", params![id, stage])?;
        Ok(())
    }

    /// Picked digest `id`'s page being made in session `session_id`, which is
    /// off the lists as a day's digest's is.
    pub fn start_picked_digest(&self, id: i64, session_id: &str) -> Result<()> {
        self.conn.execute("UPDATE picked_digests SET stage = NULL, session_id = ?2 WHERE id = ?1", params![id, session_id])?;
        self.hide_session(session_id)
    }

    /// Why picked digest `id` was not made.
    pub fn fail_picked_digest(&self, id: i64, why: &str) -> Result<()> {
        self.conn.execute("UPDATE picked_digests SET stage = NULL, error = ?2 WHERE id = ?1", params![id, why])?;
        Ok(())
    }

    /// The picked digests still being made by the app (not by a session), as
    /// failed for `why`: the app ended while it made them.
    pub fn fail_unfinished_picked_digests(&self, why: &str) -> Result<()> {
        self.conn.execute("UPDATE picked_digests SET stage = NULL, error = ?1 WHERE stage IS NOT NULL", [why])?;
        Ok(())
    }

    /// The digests of readings picked by hand, the newest first.
    pub fn picked_digests(&self) -> Result<Vec<PickedDigest>> {
        let mut stmt = self.conn.prepare("SELECT id, readings, podcast, stage, url, error, made_at, session_id FROM picked_digests ORDER BY made_at DESC, id DESC")?;
        let picked = stmt
            .query_map([], |r| {
                Ok(PickedDigest {
                    id: r.get(0)?,
                    readings: r.get::<_, String>(1)?.split(',').filter_map(|id| id.parse().ok()).collect(),
                    podcast: r.get(2)?,
                    stage: r.get(3)?,
                    url: r.get(4)?,
                    error: r.get(5)?,
                    made_at: r.get(6)?,
                    session_id: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(picked)
    }

    pub fn digest(&self, day: &str) -> Result<Option<Digest>> {
        Ok(self.digests_where("day = ?1", [day])?.pop())
    }

    /// Every day's digest, the newest first.
    pub fn digests(&self) -> Result<Vec<Digest>> {
        self.digests_where("1", [])
    }

    fn digests_where<P: rusqlite::Params>(&self, filter: &str, p: P) -> Result<Vec<Digest>> {
        let mut stmt = self.conn.prepare(&format!("SELECT day, url, error, made_at, session_id FROM digests WHERE {filter} ORDER BY day DESC"))?;
        let digests = stmt
            .query_map(p, |r| Ok(Digest { day: r.get(0)?, url: r.get(1)?, error: r.get(2)?, made_at: r.get(3)?, session_id: r.get(4)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(digests)
    }

    /// Keeps a reading read (a good one), or puts it back to read.
    pub fn set_reading_kept(&self, id: i64, kept: bool) -> Result<()> {
        match self.conn.execute("UPDATE readings SET kept = ?2 WHERE id = ?1", params![id, kept])? {
            0 => Err(Error::ReadingNotFound(id)),
            _ => Ok(()),
        }
    }

    pub fn delete_reading(&self, id: i64) -> Result<()> {
        match self.conn.execute("DELETE FROM readings WHERE id = ?1", [id])? {
            0 => Err(Error::ReadingNotFound(id)),
            _ => Ok(()),
        }
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

    /// Records a session about to start (idle until its hooks say more),
    /// named and linked to the todo before it starts.
    pub fn register_session(&self, id: &str, cwd: &str, title: &str, todo_id: Option<i64>) -> Result<()> {
        self.record_session(id, cwd, SessionState::Idle)?;
        self.set_session_title(id, title)?;
        if let Some(todo_id) = todo_id {
            self.link_session(id, todo_id)?;
        }
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

    /// Live sessions, with a todo or not; a turn ending in one is watched for.
    pub fn live_sessions(&self) -> Result<Vec<Session>> {
        self.query_sessions("state != 'ended'", None)
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

    /// Records a review request on the PR unless one still asking was
    /// recorded, and returns its id when it is new. `read` keeps it out of
    /// the unread ones.
    pub fn add_review_notice(&self, url: &str, title: &str, read: bool) -> Result<Option<i64>> {
        let seen: bool = self.conn.query_row("SELECT EXISTS (SELECT 1 FROM notifications WHERE url = ?1 AND gone = 0)", [url], |r| r.get(0))?;
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

    /// Ends the review requests of the PRs no longer asking (all but
    /// `waiting`), so one asked again is noticed again.
    pub fn end_review_notices(&self, waiting: &[String]) -> Result<()> {
        self.conn.execute(
            "UPDATE notifications SET gone = 1 WHERE url IS NOT NULL AND gone = 0 AND url NOT IN (SELECT value FROM json_each(?1))",
            [serde_json::to_string(waiting).expect("strings serialize")],
        )?;
        Ok(())
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

    /// Keeps a parent's plan (blank clears it).
    pub fn set_plan(&self, id: i64, plan: &str) -> Result<()> {
        let plan = Some(plan.trim()).filter(|p| !p.is_empty());
        match self.conn.execute("UPDATE todos SET plan = ?2, updated_at = ?3 WHERE id = ?1", params![id, plan, now()])? {
            0 => Err(Error::TodoNotFound(id)),
            _ => Ok(()),
        }
    }

    /// The first prompt of a session for the todo (see `Todo::prompt_body`),
    /// with its parent's plan when it has one.
    pub fn session_prompt(&self, todo: &Todo, plan: bool) -> Result<String> {
        let mut body = todo.prompt_body(plan);
        if let Some(parent) = todo.parent_id.map(|id| self.get_todo(id)).transpose()?.flatten() {
            if let Some(p) = parent.plan {
                body.push_str(&format!("\n\n## 親 todo #{} の計画（全サブタスクで共有）\n\n{p}", parent.id));
            }
        }
        Ok(body)
    }

    /// One more time the todo's session was sent to fix its PR; the count now.
    pub fn count_fix(&self, id: i64) -> Result<i64> {
        self.conn.execute("UPDATE todos SET fix_count = COALESCE(CAST(fix_count AS INTEGER), 0) + 1 WHERE id = ?1", [id])?;
        Ok(self.get_todo(id)?.ok_or(Error::TodoNotFound(id))?.fix_count)
    }

    /// Takes back what was handed to the user on the session's todo, as the
    /// session runs again (answered, through the orchestrator or not);
    /// whether there was any.
    pub fn take_back_escalation(&self, session_id: &str) -> Result<bool> {
        let n = self.conn.execute(
            "UPDATE todos SET escalation = NULL WHERE escalation IS NOT NULL AND id = (SELECT todo_id FROM sessions WHERE session_id = ?1)",
            [session_id],
        )?;
        Ok(n > 0)
    }

    /// Hands the todo to the user with `why` (None takes it back).
    pub fn escalate(&self, id: i64, why: Option<&str>) -> Result<()> {
        match self.conn.execute("UPDATE todos SET escalation = ?2 WHERE id = ?1", params![id, why])? {
            0 => Err(Error::TodoNotFound(id)),
            _ => Ok(()),
        }
    }

    /// Takes an artifact off the list. Its row stays, so finding it again in
    /// its session's record does not bring it back.
    pub fn forget_artifact(&self, id: i64) -> Result<()> {
        self.conn.execute("UPDATE artifacts SET gone = 1 WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Keeps an artifact, once per URL; whether it is new.
    pub fn add_artifact(&self, a: NewArtifact) -> Result<bool> {
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO artifacts (url, title, kind, session_id, todo_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![a.url, a.title, a.kind.as_str(), a.session_id, a.todo_id, now()],
        )?;
        Ok(n > 0)
    }

    /// Every artifact not forgotten, newest first.
    pub fn artifacts(&self) -> Result<Vec<Artifact>> {
        let mut stmt = self.conn.prepare("SELECT id, url, title, kind, session_id, todo_id, created_at FROM artifacts WHERE gone = 0 ORDER BY id DESC")?;
        let rows = stmt.query_map([], |r| {
            Ok(Artifact {
                id: r.get(0)?,
                url: r.get(1)?,
                title: r.get(2)?,
                kind: ArtifactKind::parse(&r.get::<_, String>(3)?),
                session_id: r.get(4)?,
                todo_id: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Records what happened under a (parent) todo, for its 経過.
    pub fn add_event(&self, todo_id: i64, text: &str) -> Result<()> {
        self.conn.execute("INSERT INTO todo_events (todo_id, at, text) VALUES (?1, ?2, ?3)", params![todo_id, now(), text])?;
        Ok(())
    }

    /// What happened under the todo, newest first.
    pub fn events(&self, todo_id: i64) -> Result<Vec<TodoEvent>> {
        let mut stmt = self.conn.prepare("SELECT id, todo_id, at, text FROM todo_events WHERE todo_id = ?1 ORDER BY id DESC LIMIT ?2")?;
        let rows = stmt.query_map(params![todo_id, EVENTS_LIMIT], |r| Ok(TodoEvent { id: r.get(0)?, todo_id: r.get(1)?, at: r.get(2)?, text: r.get(3)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
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

    /// Keeps the Slack messages not kept yet (`read` for the first check's,
    /// which only records what is there); returns those it kept. One kept
    /// before without its sender's picture gets it.
    pub fn add_slack_messages(&self, messages: &[NewSlackMessage], read: bool) -> Result<Vec<SlackMessage>> {
        let mut kept = Vec::new();
        for m in messages {
            let n = self.conn.execute(
                "INSERT OR IGNORE INTO slack_messages (channel, ts, thread_ts, channel_name, user_name, text, permalink, via, user_image, read) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![m.channel, m.ts, m.thread_ts, m.channel_name, m.user_name, m.text, m.permalink, m.via, m.user_image, read],
            )?;
            if n == 0 {
                self.conn.execute(
                    "UPDATE slack_messages SET user_image = ?3 WHERE channel = ?1 AND ts = ?2 AND user_image IS NULL",
                    params![m.channel, m.ts, m.user_image],
                )?;
            } else {
                kept.push(SlackMessage {
                    channel: m.channel.clone(),
                    ts: m.ts.clone(),
                    thread_ts: m.thread_ts.clone(),
                    channel_name: m.channel_name.clone(),
                    user_name: m.user_name.clone(),
                    text: m.text.clone(),
                    permalink: m.permalink.clone(),
                    via: m.via.clone(),
                    user_image: m.user_image.clone(),
                    read,
                });
            }
        }
        Ok(kept)
    }

    /// Whether any Slack message was ever kept (the first check is quiet).
    pub fn has_slack_messages(&self) -> Result<bool> {
        Ok(self.conn.query_row("SELECT EXISTS (SELECT 1 FROM slack_messages)", [], |r| r.get(0))?)
    }

    /// Every unread Slack message and the newest `limit` read ones, newest
    /// first, but those of channels muted in the app.
    pub fn slack_messages(&self, limit: i64) -> Result<Vec<SlackMessage>> {
        const COLS: &str = "channel, ts, thread_ts, channel_name, user_name, text, permalink, via, read, user_image";
        let mut stmt = self.conn.prepare(&format!(
            "SELECT * FROM (SELECT {COLS} FROM slack_messages WHERE read = 0 AND gone = 0
               UNION ALL SELECT * FROM (SELECT {COLS} FROM slack_messages WHERE read = 1 AND gone = 0 ORDER BY CAST(ts AS REAL) DESC LIMIT ?1))
             WHERE {UNMUTED} ORDER BY CAST(ts AS REAL) DESC"
        ))?;
        let rows = stmt.query_map([limit], |r| {
            Ok(SlackMessage {
                channel: r.get(0)?,
                ts: r.get(1)?,
                thread_ts: r.get(2)?,
                channel_name: r.get(3)?,
                user_name: r.get(4)?,
                text: r.get(5)?,
                permalink: r.get(6)?,
                via: r.get(7)?,
                read: r.get(8)?,
                user_image: r.get(9)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn mark_slack_read(&self, channel: &str, ts: &str) -> Result<()> {
        self.conn.execute("UPDATE slack_messages SET read = 1 WHERE channel = ?1 AND ts = ?2", params![channel, ts])?;
        Ok(())
    }

    /// Forgets what came from Slack, when the user lets it go.
    pub fn clear_slack(&self) -> Result<()> {
        self.conn.execute_batch("DELETE FROM slack_messages; DELETE FROM slack_threads;")?;
        Ok(())
    }

    /// Lets a Slack message go: its words are wiped, and its key kept so a
    /// search finding it again does not bring it back (prune_slack drops it).
    pub fn forget_slack_message(&self, channel: &str, ts: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE slack_messages SET gone = 1, read = 1, text = '', user_name = '', channel_name = '', permalink = '', user_image = NULL, thread_ts = NULL
             WHERE channel = ?1 AND ts = ?2",
            params![channel, ts],
        )?;
        Ok(())
    }

    /// Lets every read Slack message go (forget_slack_message).
    pub fn forget_read_slack_messages(&self) -> Result<()> {
        self.conn.execute(
            "UPDATE slack_messages SET gone = 1, text = '', user_name = '', channel_name = '', permalink = '', user_image = NULL, thread_ts = NULL WHERE read = 1",
            [],
        )?;
        Ok(())
    }

    /// Drops what came from Slack before `before` (unix seconds): the read
    /// (and let go) messages, and the followed threads quiet since then
    /// with nothing new. The app ignores searches' messages that old.
    pub fn prune_slack(&self, before: f64) -> Result<()> {
        self.conn.execute("DELETE FROM slack_messages WHERE (read = 1 OR gone = 1) AND CAST(ts AS REAL) < ?1", [before])?;
        self.conn.execute("DELETE FROM slack_threads WHERE new_replies = 0 AND CAST(COALESCE(latest_ts, thread_ts) AS REAL) < ?1", [before])?;
        Ok(())
    }

    /// Stops following a thread (and forgets its new replies).
    pub fn forget_slack_thread(&self, channel: &str, thread_ts: &str) -> Result<()> {
        self.conn.execute("DELETE FROM slack_threads WHERE channel = ?1 AND thread_ts = ?2", params![channel, thread_ts])?;
        Ok(())
    }

    /// Follows a thread the user wrote in or was mentioned in (once).
    pub fn follow_slack_thread(&self, channel: &str, thread_ts: &str, channel_name: &str, permalink: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO slack_threads (channel, thread_ts, channel_name, permalink) VALUES (?1, ?2, ?3, ?4)",
            params![channel, thread_ts, channel_name, permalink],
        )?;
        Ok(())
    }

    /// Counts a reply in a followed thread not muted; false for any other.
    pub fn slack_thread_replied(&self, channel: &str, thread_ts: &str, reply: &SlackReply) -> Result<bool> {
        let n = self.conn.execute(
            "UPDATE slack_threads SET latest_ts = ?3, latest_user_name = ?4, latest_text = ?5, latest_image = ?6, new_replies = new_replies + 1
             WHERE channel = ?1 AND thread_ts = ?2 AND muted = 0",
            params![channel, thread_ts, reply.ts, reply.user_name, reply.text, reply.user_image],
        )?;
        Ok(n > 0)
    }

    pub fn mark_slack_thread_seen(&self, channel: &str, thread_ts: &str) -> Result<()> {
        self.conn.execute("UPDATE slack_threads SET new_replies = 0 WHERE channel = ?1 AND thread_ts = ?2", params![channel, thread_ts])?;
        Ok(())
    }

    /// Stops (or starts again) counting a thread's replies; what was new goes.
    pub fn mute_slack_thread(&self, channel: &str, thread_ts: &str, muted: bool) -> Result<()> {
        self.conn.execute("UPDATE slack_threads SET muted = ?3, new_replies = 0 WHERE channel = ?1 AND thread_ts = ?2", params![channel, thread_ts, muted])?;
        Ok(())
    }

    /// Bookmarks a Slack message (once: bookmarked again, it stays where it was).
    pub fn bookmark_slack(&self, b: &SlackBookmark) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO slack_bookmarks (channel, ts, thread_ts, channel_name, user_name, user_image, text, permalink, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![b.channel, b.ts, b.thread_ts, b.channel_name, b.user_name, b.user_image, b.text, b.permalink, now()],
        )?;
        Ok(())
    }

    pub fn unbookmark_slack(&self, channel: &str, ts: &str) -> Result<()> {
        self.conn.execute("DELETE FROM slack_bookmarks WHERE channel = ?1 AND ts = ?2", params![channel, ts])?;
        Ok(())
    }

    /// The bookmarked Slack messages, the last bookmarked first.
    pub fn slack_bookmarks(&self) -> Result<Vec<SlackBookmark>> {
        let mut stmt = self.conn.prepare(
            "SELECT channel, ts, thread_ts, channel_name, user_name, user_image, text, permalink FROM slack_bookmarks ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SlackBookmark {
                channel: r.get(0)?,
                ts: r.get(1)?,
                thread_ts: r.get(2)?,
                channel_name: r.get(3)?,
                user_name: r.get(4)?,
                user_image: r.get(5)?,
                text: r.get(6)?,
                permalink: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Mutes a channel in the app (its mentions and replies leave the Slack
    /// page and are not kept), or unmutes it (what was kept comes back).
    pub fn mute_slack_channel(&self, channel: &str, name: &str, muted: bool) -> Result<()> {
        if muted {
            self.conn.execute("INSERT OR REPLACE INTO slack_muted_channels (channel, name) VALUES (?1, ?2)", params![channel, name])?;
        } else {
            self.conn.execute("DELETE FROM slack_muted_channels WHERE channel = ?1", [channel])?;
        }
        Ok(())
    }

    /// The channels muted in the app, by name.
    pub fn slack_muted_channels(&self) -> Result<Vec<MutedChannel>> {
        let mut stmt = self.conn.prepare("SELECT channel, name FROM slack_muted_channels ORDER BY name")?;
        let rows = stmt.query_map([], |r| Ok(MutedChannel { channel: r.get(0)?, name: r.get(1)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn is_slack_thread_muted(&self, channel: &str, thread_ts: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT muted FROM slack_threads WHERE channel = ?1 AND thread_ts = ?2", params![channel, thread_ts], |r| r.get(0))
            .optional()?
            .unwrap_or(false))
    }

    /// The followed threads with replies, new or seen (to be read again),
    /// the latest first (but in channels muted in the app).
    pub fn slack_threads(&self) -> Result<Vec<SlackThread>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT channel, thread_ts, channel_name, permalink, latest_ts, latest_user_name, latest_text, latest_image, new_replies
             FROM slack_threads WHERE latest_ts IS NOT NULL AND muted = 0 AND {UNMUTED} ORDER BY CAST(latest_ts AS REAL) DESC"
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok(SlackThread {
                channel: r.get(0)?,
                thread_ts: r.get(1)?,
                channel_name: r.get(2)?,
                permalink: r.get(3)?,
                latest_ts: r.get(4)?,
                latest_user_name: r.get(5)?,
                latest_text: r.get(6)?,
                latest_image: r.get(7)?,
                new_replies: r.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Marks the session running and links it when the prompt carries a
    /// `[todo:<id>]` marker. Returns the todo id it linked to, if any.
    pub fn on_prompt(&self, id: &str, cwd: &str, prompt: &str) -> Result<Option<i64>> {
        self.record_session(id, cwd, SessionState::Running)?;
        self.name_from_prompt(id, prompt)
    }
}
