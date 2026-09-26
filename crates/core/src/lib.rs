pub mod agents;
pub mod cloud;
pub mod desktop;
pub mod launch;

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row};

use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub enum Error {
    Sql(rusqlite::Error),
    TodoNotFound(i64),
    SessionNotFound(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Sql(e) => write!(f, "sqlite: {e}"),
            Error::TodoNotFound(id) => write!(f, "todo {id} not found"),
            Error::SessionNotFound(id) => write!(f, "session {id} not found"),
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
    Todo,
    Doing,
    Done,
}

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
}

#[derive(Debug, Default)]
pub struct NewTodo {
    pub title: String,
    pub issue_url: Option<String>,
    pub cwd: Option<String>,
    pub memo: Option<String>,
    pub repos: Vec<String>,
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
}

/// Hooks from parallel sessions write to the same file.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const MARKER_PREFIX: &str = "[todo:";
/// Session titles are derived from the first prompt and cut to this length.
pub const TITLE_MAX_CHARS: usize = 80;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
    issue_url TEXT,
    cwd TEXT,
    memo TEXT,
    updated_at INTEGER NOT NULL,
    repos TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
    cwd TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'needs_input', 'idle', 'ended')),
    state_at INTEGER NOT NULL,
    title TEXT,
    repos TEXT
);
CREATE TABLE IF NOT EXISTS marker_checked (
    session_id TEXT PRIMARY KEY
);
";

const TODO_COLS: &str = "id, title, status, issue_url, cwd, memo, updated_at, repos";
const SESSION_COLS: &str = "session_id, todo_id, cwd, state, state_at, title, repos";

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Todo => "todo",
            Status::Doing => "doing",
            Status::Done => "done",
        }
    }
    fn parse(s: &str) -> Status {
        match s {
            "doing" => Status::Doing,
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
    })
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
    for (table, column) in [("sessions", "title"), ("sessions", "repos"), ("todos", "repos")] {
        let exists: bool = conn.query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"),
            [],
            |r| r.get::<_, i64>(0).map(|n| n > 0),
        )?;
        if !exists {
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"), [])?;
        }
    }
    Ok(())
}

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
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Db { conn })
    }

    pub fn create_todo(&self, t: NewTodo) -> Result<Todo> {
        self.conn.execute(
            "INSERT INTO todos (title, issue_url, cwd, memo, updated_at, repos) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![t.title, t.issue_url, t.cwd, t.memo, now(), join_repos(&t.repos)],
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
                issue_url = CASE WHEN ?7 IS NULL THEN issue_url ELSE NULLIF(?7, '') END,
                repos = CASE WHEN ?8 IS NULL THEN repos ELSE NULLIF(?8, '') END,
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
            ],
        )?;
        if n == 0 {
            return Err(Error::TodoNotFound(id));
        }
        self.get_todo(id)?.ok_or(Error::TodoNotFound(id))
    }

    pub fn delete_todo(&self, id: i64) -> Result<()> {
        match self.conn.execute("DELETE FROM todos WHERE id = ?1", [id])? {
            0 => Err(Error::TodoNotFound(id)),
            _ => Ok(()),
        }
    }

    pub fn record_session(&self, id: &str, cwd: &str, state: SessionState) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sessions (session_id, cwd, state, state_at) VALUES (?1, ?2, ?3, ?4)
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

    pub fn unlinked_sessions(&self) -> Result<Vec<Session>> {
        self.query_sessions("todo_id IS NULL", None)
    }

    /// Sessions waiting for the user that belong to a todo; these get notified.
    pub fn linked_needs_input(&self) -> Result<Vec<Session>> {
        self.query_sessions("todo_id IS NOT NULL AND state = 'needs_input'", None)
    }

    /// Cloud sessions not yet ended; cloud sync re-checks any of these the
    /// list API stopped returning.
    pub fn live_cloud_sessions(&self) -> Result<Vec<Session>> {
        self.query_sessions(
            "session_id LIKE 'cse\\_%' ESCAPE '\\' AND state != 'ended'",
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

    /// Whether a cloud session's first prompt was already searched for a marker.
    pub fn set_session_repos(&self, id: &str, repos: &[String]) -> Result<()> {
        self.conn
            .execute("UPDATE sessions SET repos = ?2 WHERE session_id = ?1", params![id, join_repos(repos)])?;
        Ok(())
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
        if let Some(title) = title_from_prompt(prompt) {
            self.conn.execute(
                "UPDATE sessions SET title = ?2 WHERE session_id = ?1 AND title IS NULL",
                params![id, title],
            )?;
        }
        self.link_by_marker(id, prompt)
    }
}
