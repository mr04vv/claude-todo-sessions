#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod terminal;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use cts_core::launch::StartOptions;
use cts_core::{launch, Db, NewTodo, NoticeKind, Session, SessionState, Status, Todo, TodoPatch};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewBuilder, WebviewUrl, WindowEvent};
use mac_notification_sys::{Notification, NotificationResponse};

const DB_ENV: &str = "CTS_DB";
const DATA_DIR: &str = "Library/Application Support/claude-todo-sessions";
const DB_FILE: &str = "db.sqlite";
const DESKTOP_SESSIONS_DIR: &str = "Library/Application Support/Claude/claude-code-sessions";
const CLOUD_SYNC_INTERVAL: Duration = Duration::from_secs(30);
/// How often the tray menu and notifications look at the DB.
const WATCH_INTERVAL: Duration = Duration::from_secs(3);
/// herdr's agent states are read every this many watch ticks (they are cheap).
const HERDR_EVERY_TICKS: u32 = 3;
/// `claude agents --json` runs every this many watch ticks: it starts Node
/// (about 0.4 s), and hooks and herdr already report most state changes.
const AGENTS_EVERY_TICKS: u32 = 10;
/// A local session missing from `claude agents` is ended only after this long
/// without a state change, so one just started by a hook is not cut off.
const DISCOVER_GRACE_SECS: i64 = 60;
/// Where the CLIs live when the app is launched from Finder with a bare PATH.
const EXTRA_PATH: &[&str] = &[".local/bin", ".cargo/bin"];
const SYSTEM_PATHS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/run/current-system/sw/bin"];
const TRAY_ID: &str = "main";
const MENU_OPEN: &str = "open";
const MENU_QUIT: &str = "quit";
const MENU_SESSION_PREFIX: &str = "session:";
const GH_ISSUE_LIMIT: &str = "100";
/// How often linked issues are checked for open/closed.
const ISSUE_SYNC_INTERVAL: Duration = Duration::from_secs(60);
/// Folders (under $HOME) whose direct children are checkouts, besides the ghq root.
// ponytail: fixed list; make it a setting if more roots are needed.
const EXTRA_REPO_ROOTS: &[&str] = &["Works/Atrae"];
/// Must match `identifier` in tauri.conf.json; notifications are posted as this app.
const APP_ID: &str = "dev.mr04vv.todo-sessions";
/// Terminal app hosting herdr, brought forward when a session is focused there.
const TERMINAL_APP: &str = "Ghostty";

struct AppState {
    db: Mutex<Db>,
    /// Result of the last cloud sync, shown in the header.
    sync_status: Mutex<String>,
    /// `owner/repo` per working directory, from `git remote get-url origin`.
    origin_cache: Mutex<HashMap<String, Option<String>>>,
    /// Whether the queue runner starts queued todos.
    loop_enabled: AtomicBool,
    /// Wakes the GitHub sync: Some(todo id) or None for everything.
    github_wake: Mutex<std::sync::mpsc::Sender<Option<i64>>>,
    /// Wakes the cloud session sync.
    cloud_wake: Mutex<std::sync::mpsc::Sender<()>>,
    /// herdr session the user picked for new workspaces, if any.
    herdr_session: Mutex<Option<String>>,
    /// Local sessions run in the in-app terminal pane rather than herdr.
    in_app_terminal: AtomicBool,
    /// Held while a browser tab is shown or created.
    browser_lock: Mutex<()>,
    /// CLI session ids archived in Desktop. Reading every Desktop record is
    /// slow, so the watch loop refreshes this and the board only reads it.
    archived: Mutex<HashSet<String>>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn db_path() -> PathBuf {
    std::env::var_os(DB_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(DATA_DIR).join(DB_FILE))
}

fn open_db() -> Result<Db, String> {
    let path = db_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    Db::open(&path).map_err(|e| e.to_string())
}

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}

/// A command with PATH extended to the usual CLI locations.
fn cli(program: &str) -> Command {
    let mut path: Vec<String> = EXTRA_PATH.iter().map(|p| home().join(p).to_string_lossy().into()).collect();
    path.push(format!("/etc/profiles/per-user/{}/bin", std::env::var("USER").unwrap_or_default()));
    path.extend(SYSTEM_PATHS.iter().map(|s| s.to_string()));
    path.push(std::env::var("PATH").unwrap_or_default());
    let mut cmd = Command::new(program);
    cmd.env("PATH", path.join(":"));
    cmd
}

#[derive(Serialize)]
struct TodoView {
    #[serde(flatten)]
    todo: Todo,
    sessions: Vec<Session>,
    /// `owner/repo` list for grouping; several means the todo spans repos.
    repos: Vec<String>,
    /// True when `repos` came from the issue URL or folder, not the todo's own list.
    repos_derived: bool,
    /// The exact first prompt a new session would get.
    prompt_preview: String,
    is_orchestrator: bool,
    links: Vec<cts_core::Link>,
}

#[derive(Serialize)]
struct SessionView {
    #[serde(flatten)]
    session: Session,
    repos: Vec<String>,
}

#[derive(Serialize)]
struct Board {
    todos: Vec<TodoView>,
    inbox: Vec<SessionView>,
    /// Notifications posted, newest first, for the in-app list.
    notifications: Vec<cts_core::Notice>,
    sync_status: String,
    loop_enabled: bool,
}

fn git_origin(cwd: &str) -> Option<String> {
    let out = cli("git").args(["-C", cwd, "remote", "get-url", "origin"]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `owner/repo` for a working directory: from its path when laid out like
/// ghq, otherwise from the git remote (cached, since the board polls).
fn repo_of_cwd(state: &AppState, cwd: &str) -> Option<String> {
    if cwd.is_empty() {
        return None;
    }
    if let Some(key) = launch::repo_key(cwd) {
        return Some(key);
    }
    let mut cache = state.origin_cache.lock().ok()?;
    cache
        .entry(cwd.to_string())
        .or_insert_with(|| git_origin(cwd).as_deref().and_then(launch::repo_key))
        .clone()
}

/// The todo's own list, else the repo of its issue URL, else of its folder.
fn repos_of_todo(state: &AppState, todo: &Todo) -> Vec<String> {
    if !todo.repos.is_empty() {
        return todo.repos.clone();
    }
    todo.issue_url
        .as_deref()
        .and_then(launch::repo_key)
        .or_else(|| todo.cwd.as_deref().and_then(|c| repo_of_cwd(state, c)))
        .into_iter()
        .collect()
}

fn repos_of_session(state: &AppState, session: &Session) -> Vec<String> {
    if !session.repos.is_empty() {
        return session.repos.clone();
    }
    repo_of_cwd(state, &session.cwd).into_iter().collect()
}

#[derive(Deserialize)]
struct TodoInput {
    title: String,
    issue_url: Option<String>,
    cwd: Option<String>,
    memo: Option<String>,
    #[serde(default)]
    repos: Vec<String>,
    #[serde(default)]
    kind: cts_core::Kind,
    parent_id: Option<i64>,
}

#[derive(Deserialize)]
struct TodoUpdate {
    title: Option<String>,
    status: Option<Status>,
    memo: Option<String>,
    cwd: Option<String>,
    issue_url: Option<String>,
    repos: Option<Vec<String>>,
    prompt: Option<String>,
    pr_url: Option<String>,
    kind: Option<cts_core::Kind>,
}

#[tauri::command(async)]
fn board(state: State<AppState>) -> Result<Board, String> {
    let (todos, inbox, notifications) = {
        let db = state.db.lock().map_err(err)?;
        let (mut sessions, mut links) = (db.sessions_by_todo().map_err(err)?, db.links_by_todo().map_err(err)?);
        let todos = db
            .list_todos(None)
            .map_err(err)?
            .into_iter()
            .map(|todo| (sessions.remove(&todo.id).unwrap_or_default(), links.remove(&todo.id).unwrap_or_default(), todo))
            .collect::<Vec<_>>();
        let archived = state.archived.lock().map_err(err)?.clone();
        let inbox: Vec<Session> = db
            .unlinked_sessions()
            .map_err(err)?
            .into_iter()
            .filter(|s| s.state != SessionState::Ended && !archived.contains(&s.session_id))
            .collect();
        (todos, inbox, db.notifications().map_err(err)?)
    };
    // Repo lookup may run git, so the DB lock is released first.
    let todos = todos
        .into_iter()
        .map(|(sessions, links, todo)| TodoView {
            repos: repos_of_todo(&state, &todo),
            repos_derived: todo.repos.is_empty(),
            prompt_preview: launch::start_prompt(todo.id, &todo.prompt_body()),
            is_orchestrator: todo.is_orchestrator(),
            sessions,
            links,
            todo,
        })
        .collect();
    let inbox = inbox
        .into_iter()
        .map(|session| SessionView { repos: repos_of_session(&state, &session), session })
        .collect();
    let sync_status = state.sync_status.lock().map_err(err)?.clone();
    Ok(Board { todos, inbox, notifications, sync_status, loop_enabled: state.loop_enabled.load(Ordering::Relaxed) })
}

#[tauri::command(async)]
fn create_todo(state: State<AppState>, input: TodoInput) -> Result<Todo, String> {
    let blank = |s: Option<String>| s.filter(|v| !v.trim().is_empty());
    let db = state.db.lock().map_err(err)?;
    db.create_todo(NewTodo {
        title: input.title,
        issue_url: blank(input.issue_url),
        cwd: blank(input.cwd),
        memo: blank(input.memo),
        repos: input.repos,
        kind: input.kind,
        parent_id: input.parent_id,
    })
    .map_err(err)
}

#[tauri::command(async)]
fn update_todo(state: State<AppState>, id: i64, update: TodoUpdate) -> Result<Todo, String> {
    let patch = TodoPatch {
        title: update.title,
        status: update.status,
        memo: update.memo,
        cwd: update.cwd,
        issue_url: update.issue_url,
        repos: update.repos,
        prompt: update.prompt,
        pr_url: update.pr_url,
        kind: update.kind,
    };
    state.db.lock().map_err(err)?.update_todo(id, patch).map_err(err)
}

#[tauri::command(async)]
fn delete_todo(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.delete_todo(id).map_err(err)
}

#[tauri::command(async)]
fn link_session(state: State<AppState>, session_id: String, todo_id: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.link_session(&session_id, todo_id).map_err(err)
}

#[tauri::command(async)]
fn unlink_session(state: State<AppState>, session_id: String) -> Result<(), String> {
    state.db.lock().map_err(err)?.unlink_session(&session_id).map_err(err)
}

fn open_url(url: &str) -> Result<(), String> {
    let status = cli("open").arg(url).status().map_err(err)?;
    status.success().then_some(()).ok_or_else(|| format!("open {url} failed: {status}"))
}

/// Focuses the herdr pane running this session, if any, and brings the
/// terminal forward. Returns false when herdr does not host it.
fn focus_in_herdr(session_id: &str) -> bool {
    if focus_herdr_pane(session_id).is_none() {
        return false;
    }
    // ponytail: assumes herdr runs in Ghostty; make the terminal app a setting if it varies.
    let _ = cli("open").args(["-a", TERMINAL_APP]).status();
    true
}

/// Focuses the herdr pane running the session, inside herdr only, and
/// returns the herdr session it is in.
fn focus_herdr_pane(session_id: &str) -> Option<String> {
    let table = cli("herdr").args(["session", "list"]).output().ok()?;
    cts_core::herdr::running_sessions(&String::from_utf8_lossy(&table.stdout)).into_iter().find(|name| {
        let Ok(out) = cli("herdr").args(["--session", name, "agent", "list"]).output() else { return false };
        let Ok(agents) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else { return false };
        cts_core::herdr::find_pane(&agents, session_id).is_some_and(|pane| {
            cli("herdr").args(["--session", name, "agent", "focus", &pane]).status().is_ok_and(|s| s.success())
        })
    })
}

/// Opens a session in `target`: "herdr" focuses its pane, "desktop" opens
/// Claude Desktop, and none tries herdr first for local sessions.
/// Opens a new herdr workspace in the home folder running a plain `claude`,
/// for a quick question outside any todo.
#[tauri::command(async)]
fn quick_claude(state: State<AppState>, prompt: Option<String>) -> Result<(), String> {
    let TerminalRun { cwd, title: label, command, .. } = quick_run(prompt.as_deref());
    match start_in_herdr(&state, &cwd, &label, &command, true) {
        // The new workspace is focused inside herdr; bring its terminal forward too.
        Ok(()) => cli("open").args(["-a", TERMINAL_APP]).status().map(|_| ()).map_err(err),
        Err(herdr_err) => start_in_ghostty(&cwd, &command).map_err(|e| format!("{herdr_err} / {e}")),
    }
}

/// A plain `claude` at home, with the prompt if one is given. Its session id
/// is picked here so the in-app terminal can find its tab again.
fn quick_run(prompt: Option<&str>) -> TerminalRun {
    let prompt = prompt.map(str::trim).filter(|p| !p.is_empty());
    let session = uuid::Uuid::new_v4().to_string();
    let first = prompt.map(|p| format!(" {}", shell_quote(p))).unwrap_or_default();
    TerminalRun {
        cwd: home().to_string_lossy().to_string(),
        title: prompt.map(|p| p.chars().take(24).collect()).unwrap_or_else(|| "claude".into()),
        command: format!("claude --session-id {session}{first}"),
        session: Some(session),
        herdr: None,
    }
}

/// The in-app terminal's versions of starting a todo's session, a quick
/// claude and reopening a session (see `terminal.rs`).
#[tauri::command(async)]
fn terminal_start(state: State<AppState>, todo_id: i64, options: Option<StartOptions>) -> Result<TerminalRun, String> {
    prepare_terminal(&state, todo_id, &options.unwrap_or_default())
}

#[tauri::command(async)]
fn terminal_quick(prompt: Option<String>) -> TerminalRun {
    quick_run(prompt.as_deref())
}

/// What the in-app terminal runs to show a session: a session running in
/// herdr gets its pane focused and the herdr session attached in the app;
/// with `desktop`, one still running in Claude Desktop opens there (None);
/// any other is resumed with `claude --resume`.
#[tauri::command(async)]
fn terminal_resume(state: State<AppState>, session_id: String, desktop: bool) -> Result<Option<TerminalRun>, String> {
    if let Some(name) = focus_herdr_pane(&session_id) {
        return Ok(Some(TerminalRun {
            cwd: home().to_string_lossy().into(),
            title: format!("herdr: {name}"),
            command: format!("herdr session attach {}", shell_quote(&name)),
            session: None,
            herdr: Some(name),
        }));
    }
    // One still going in Desktop stays there; a finished one resumes here.
    let running = state.db.lock().map_err(err)?.get_session(&session_id).map_err(err)?.is_some_and(|s| s.state != SessionState::Ended);
    if desktop && running {
        if let Some(local) = cts_core::desktop::find_local_id(&home().join(DESKTOP_SESSIONS_DIR), &session_id) {
            return open_url(&launch::jump_url(&session_id, Some(&local))).map(|_| None);
        }
    }
    resume_run(&state, &session_id).map(Some)
}

#[tauri::command]
fn set_in_app_terminal(state: State<AppState>, on: bool) {
    state.in_app_terminal.store(on, Ordering::Relaxed);
}

/// `claude --resume` in the folder the session ran in, where its transcript is.
fn resume_run(state: &AppState, session_id: &str) -> Result<TerminalRun, String> {
    let session = state.db.lock().map_err(err)?.get_session(session_id).map_err(err)?.ok_or("session not found")?;
    if !std::path::Path::new(&session.cwd).is_dir() {
        return Err(format!("作業フォルダ {} がもうないので再開できません", session.cwd));
    }
    Ok(TerminalRun {
        title: session.title.clone().unwrap_or_else(|| session_id.chars().take(8).collect()),
        command: format!("claude --resume {session_id}"),
        cwd: session.cwd,
        session: Some(session_id.to_string()),
        herdr: None,
    })
}

/// Archives cloud sessions, as archiving them on claude.ai does.
#[tauri::command(async)]
fn archive_sessions(ids: Vec<String>) -> Result<(), String> {
    let db = open_db()?;
    let errors = cts_core::cloud::archive_sessions(&db, &ids)?;
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}

/// Asks the background syncs to run now: GitHub for one todo or all, and
/// the cloud sessions when refreshing everything.
#[tauri::command]
fn sync_now(state: State<AppState>, todo_id: Option<i64>) {
    if let Ok(tx) = state.github_wake.lock() {
        let _ = tx.send(todo_id);
    }
    if todo_id.is_none() {
        if let Ok(tx) = state.cloud_wake.lock() {
            let _ = tx.send(());
        }
    }
}

fn is_web_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// Dia, by bundle id so it opens wherever it is installed.
const DIA_BUNDLE_ID: &str = "company.thebrowser.dia";

/// Opens a page in Dia, with the user's own sign-ins there.
#[tauri::command(async)]
fn open_in_dia(url: String) -> Result<(), String> {
    if !is_web_url(&url) {
        return Err(format!("開けない URL です: {url}"));
    }
    let status = cli("open").args(["-b", DIA_BUNDLE_ID, &url]).status().map_err(err)?;
    status.success().then_some(()).ok_or_else(|| format!("Dia で開けませんでした（{status}）。Dia が入っているか確認してください"))
}

#[tauri::command(async)]
fn open_link(url: String) -> Result<(), String> {
    if !is_web_url(&url) {
        return Err(format!("開けない URL です: {url}"));
    }
    open_url(&url)
}

/// Attaches a URL to a todo. The page's title and image are fetched in the
/// background, so the link shows up at once and fills in on the next refresh.
#[tauri::command(async)]
fn add_link(app: AppHandle, todo_id: i64, url: String) -> Result<cts_core::Link, String> {
    let url = url.trim().to_string();
    if !is_web_url(&url) {
        return Err("http(s) の URL を入れてください".into());
    }
    let link = app.state::<AppState>().db.lock().map_err(err)?.add_link(todo_id, &url).map_err(err)?;
    let id = link.id;
    std::thread::spawn(move || {
        let Ok(meta) = cts_core::ogp::fetch(&url) else { return };
        if let Ok(db) = app.state::<AppState>().db.lock() {
            if let Err(e) = db.set_link_meta(id, meta.title.as_deref(), meta.image.as_deref()) {
                eprintln!("{e}");
            }
        }
    });
    Ok(link)
}

#[tauri::command(async)]
fn remove_link(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.remove_link(id).map_err(err)
}

#[tauri::command(async)]
fn open_session(state: State<AppState>, session_id: String, target: Option<String>) -> Result<(), String> {
    if target.as_deref() == Some("herdr") {
        if launch::is_cloud_session(&session_id) {
            return Err("Cloud のセッションは herdr では開けません".into());
        }
        return if focus_in_herdr(&session_id) { Ok(()) } else { resume_in_herdr(&state, &session_id) };
    }
    jump_to_session(&session_id, target.as_deref() == Some("desktop"))
}

/// Shows a session where it runs: its herdr pane, else Desktop (which
/// resumes a finished or archived one). `desktop` skips the herdr lookup.
/// Asks the page to open a cloud session as it is set to: its web page in
/// the browser pane (or Dia), or Claude Desktop.
const OPEN_CLOUD_EVENT: &str = "open-cloud";
/// Asks the page to open a local session in the in-app terminal (see `terminal_resume`).
const OPEN_LOCAL_EVENT: &str = "open-local";

#[derive(Clone, Serialize)]
struct OpenCloud {
    session_id: String,
}

/// Opens a session from the menu bar or a notification: a cloud one as the
/// page is set to open them, a local one where it runs (see `jump_to_session`).
/// With the in-app terminal chosen, the page opens local sessions too.
fn open_from_outside(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let cloud = launch::is_cloud_session(session_id);
    if !cloud && !app.state::<AppState>().in_app_terminal.load(Ordering::Relaxed) {
        return jump_to_session(session_id, false);
    }
    show_window(app);
    let event = if cloud { OPEN_CLOUD_EVENT } else { OPEN_LOCAL_EVENT };
    app.emit(event, OpenCloud { session_id: session_id.into() }).map_err(err)
}

fn jump_to_session(session_id: &str, desktop: bool) -> Result<(), String> {
    if !desktop && !launch::is_cloud_session(session_id) && focus_in_herdr(session_id) {
        return Ok(());
    }
    let local = cts_core::desktop::find_local_id(&home().join(DESKTOP_SESSIONS_DIR), session_id);
    open_url(&launch::jump_url(session_id, local.as_deref()))
}

/// Reopens a session that no longer runs anywhere: `claude --resume` in a new
/// herdr workspace at the folder it ran in, which is where its transcript lives.
fn resume_in_herdr(state: &AppState, session_id: &str) -> Result<(), String> {
    let TerminalRun { cwd, title, command, .. } = resume_run(state, session_id)?;
    start_in_herdr(state, &cwd, &title, &command, true)?;
    cli("open").args(["-a", TERMINAL_APP]).status().map(|_| ()).map_err(err)
}

fn todo_or_err(db: &Db, id: i64) -> Result<Todo, String> {
    db.get_todo(id).map_err(err)?.ok_or_else(|| format!("todo {id} not found"))
}

/// A terminal session needs some folder; a todo without one starts at home.
fn terminal_cwd(todo: &Todo) -> String {
    todo.cwd.clone().unwrap_or_else(|| home().to_string_lossy().into())
}

#[tauri::command(async)]
fn start_desktop(state: State<AppState>, todo_id: i64) -> Result<(), String> {
    let todo = todo_or_err(&*state.db.lock().map_err(err)?, todo_id)?;
    let prompt = launch::start_prompt(todo.id, &todo.prompt_body());
    // Without a folder Desktop opens a scratch workspace, fine for research todos.
    open_url(&launch::desktop_new_url(todo.cwd.as_deref(), &prompt))
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn herdr(args: &[&str]) -> Result<String, String> {
    let out = cli("herdr").args(args).output().map_err(|e| format!("herdr: {e}"))?;
    if !out.status.success() {
        return Err(format!("herdr {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into())
}

fn running_herdr_sessions() -> Vec<String> {
    cli("herdr")
        .args(["session", "list"])
        .output()
        .map(|out| cts_core::herdr::running_sessions(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default()
}

/// The herdr session new workspaces go to (see `herdr::pick_session`).
fn herdr_target(state: &AppState) -> Option<String> {
    let picked = state.herdr_session.lock().ok()?.clone();
    cts_core::herdr::pick_session(&running_herdr_sessions(), picked.as_deref())
}

/// Opens a workspace in the picked herdr session and runs `command` in it.
/// Without `--session` herdr talks to its default session, which may not run.
fn start_in_herdr(state: &AppState, cwd: &str, label: &str, command: &str, focus: bool) -> Result<(), String> {
    let session = herdr_target(state).ok_or("herdr のセッションが動いていません")?;
    let focus_flag = if focus { "--focus" } else { "--no-focus" };
    let created = herdr(&["--session", &session, "workspace", "create", "--cwd", cwd, "--label", label, focus_flag])?;
    let v: serde_json::Value = serde_json::from_str(&created).map_err(|e| format!("herdr output: {e}"))?;
    let pane = launch::herdr_pane_id(&v).ok_or("herdr output has no pane id")?;
    herdr(&["--session", &session, "pane", "run", &pane, command]).map(|_| ())
}

#[derive(Serialize)]
struct HerdrSessions {
    running: Vec<String>,
    picked: Option<String>,
    /// Where a new workspace would go now.
    target: Option<String>,
}

#[tauri::command(async)]
fn herdr_sessions(state: State<AppState>) -> Result<HerdrSessions, String> {
    let running = running_herdr_sessions();
    let picked = state.herdr_session.lock().map_err(err)?.clone();
    let target = cts_core::herdr::pick_session(&running, picked.as_deref());
    Ok(HerdrSessions { running, picked, target })
}

/// Picks the herdr session for new workspaces; None goes back to the default rule.
#[tauri::command(async)]
fn set_herdr_session(state: State<AppState>, name: Option<String>) -> Result<(), String> {
    *state.herdr_session.lock().map_err(err)? = name.filter(|n| !n.is_empty());
    Ok(())
}

// ponytail: Ghostty fallback is unverified; replace the flags if Ghostty rejects them.
fn start_in_ghostty(cwd: &str, command: &str) -> Result<(), String> {
    let status = cli("open")
        .args(["-na", "Ghostty", "--args", &format!("--working-directory={cwd}"), "-e", "sh", "-lc", command])
        .status()
        .map_err(err)?;
    status.success().then_some(()).ok_or_else(|| format!("Ghostty failed: {status}"))
}

/// A command for a terminal, where to run it and what to call its tab.
#[derive(Serialize)]
struct TerminalRun {
    cwd: String,
    title: String,
    command: String,
    /// The Claude session it runs, when known.
    session: Option<String>,
    /// The herdr session it attaches to, for a session running in herdr.
    herdr: Option<String>,
}

/// Registers a session for the todo (so it is linked before it starts) and
/// returns the `claude --session-id` command that runs it.
fn prepare_terminal(state: &AppState, todo_id: i64, opts: &StartOptions) -> Result<TerminalRun, String> {
    let (todo, session_id) = {
        let db = state.db.lock().map_err(err)?;
        let todo = todo_or_err(&db, todo_id)?;
        let cwd = terminal_cwd(&todo);
        // Registered up front so the session is linked before it starts.
        let session_id = uuid::Uuid::new_v4().to_string();
        db.record_session(&session_id, &cwd, SessionState::Idle).map_err(err)?;
        db.set_session_title(&session_id, &todo.title).map_err(err)?;
        db.link_session(&session_id, todo.id).map_err(err)?;
        (todo, session_id)
    };
    let flags: String = opts.claude_args().iter().map(|a| format!(" {}", shell_quote(a))).collect();
    let command = format!(
        "claude --session-id {session_id}{flags} {}",
        shell_quote(&launch::start_prompt(todo.id, &todo.prompt_body()))
    );
    Ok(TerminalRun { cwd: terminal_cwd(&todo), title: todo.title, command, session: Some(session_id), herdr: None })
}

/// Starts `claude --session-id` for the todo in herdr (Ghostty if herdr is
/// down), linked before it starts. `focus` brings the new workspace forward.
fn launch_terminal(state: &AppState, todo_id: i64, focus: bool, opts: &StartOptions) -> Result<(), String> {
    let TerminalRun { cwd, title, command, .. } = prepare_terminal(state, todo_id, opts)?;
    start_in_herdr(state, &cwd, &title, &command, focus).or_else(|herdr_err| {
        start_in_ghostty(&cwd, &format!("cd {} && {command}", shell_quote(&cwd)))
            .map_err(|e| format!("{herdr_err} / {e}"))
    })
}

/// Creates a cloud session for the todo and returns its `cse_…` id.
fn launch_cloud(state: &AppState, todo_id: i64, opts: &StartOptions) -> Result<String, String> {
    let todo = todo_or_err(&*state.db.lock().map_err(err)?, todo_id)?;
    if todo.is_orchestrator() {
        // Planning creates child todos through the local MCP server, which cloud sessions cannot reach.
        return Err("複数リポジトリの todo は計画用です。Local で計画セッションを始め、リポジトリごとの子 todo を作ってください".into());
    }
    // Without a GitHub repository the session runs with no checkout, which is fine for research.
    let repos = launch::github_repos(&repos_of_todo(state, &todo));
    let db = state.db.lock().map_err(err)?;
    cts_core::cloud::create_session(&db, todo.id, &repos, &todo.title, &todo.prompt_body(), opts)
}

#[tauri::command(async)]
fn start_terminal(state: State<AppState>, todo_id: i64, options: Option<StartOptions>) -> Result<(), String> {
    launch_terminal(&state, todo_id, true, &options.unwrap_or_default())?;
    // herdr has switched to the new workspace; show it.
    cli("open").args(["-a", TERMINAL_APP]).status().map(|_| ()).map_err(err)
}

/// Starts a cloud session and returns its id. `desktop` also opens it in
/// Claude Desktop; otherwise the page shows it on the web.
#[tauri::command(async)]
fn start_cloud(state: State<AppState>, todo_id: i64, options: Option<StartOptions>, desktop: bool) -> Result<String, String> {
    let id = launch_cloud(&state, todo_id, &options.unwrap_or_default())?;
    if desktop {
        open_url(&launch::jump_url(&id, None))?;
    }
    Ok(id)
}

const RUNNER_CLOUD: &str = "cloud";
const RUNNER_LOCAL: &str = "local";
const RUNNER_AUTO: &str = "auto";
/// How often the queue runner looks for todos to start.
const QUEUE_INTERVAL: Duration = Duration::from_secs(10);

#[tauri::command(async)]
fn enqueue(state: State<AppState>, todo_id: i64, runner: String) -> Result<(), String> {
    if ![RUNNER_CLOUD, RUNNER_LOCAL, RUNNER_AUTO].contains(&runner.as_str()) {
        return Err(format!("unknown runner {runner}"));
    }
    state.db.lock().map_err(err)?.enqueue(todo_id, &runner).map_err(err)
}

#[tauri::command(async)]
fn dequeue(state: State<AppState>, todo_id: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.dequeue(todo_id).map_err(err)
}

#[tauri::command(async)]
fn move_in_queue(state: State<AppState>, todo_id: i64, delta: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.move_in_queue(todo_id, delta).map_err(err)
}

#[tauri::command]
fn set_loop_enabled(state: State<AppState>, enabled: bool) {
    state.loop_enabled.store(enabled, Ordering::Relaxed);
}

/// Starts every queued todo, all at once (no concurrency limit), in queue
/// order. A todo that fails to start keeps its error and waits for a retry.
// ponytail: unlimited parallel starts; add a max-running setting if machines or quotas choke.
fn queue_loop(app: AppHandle) {
    loop {
        std::thread::sleep(QUEUE_INTERVAL);
        let state = app.state::<AppState>();
        if !state.loop_enabled.load(Ordering::Relaxed) {
            continue;
        }
        let queued = match state.db.lock().map(|db| db.queued()) {
            Ok(Ok(q)) => q,
            _ => continue,
        };
        for todo in queued.into_iter().filter(|t| t.queue_error.is_none()) {
            let runner = todo.queue_runner.as_deref().unwrap_or(RUNNER_AUTO);
            let cloud = runner == RUNNER_CLOUD
                || (runner == RUNNER_AUTO && !launch::github_repos(&repos_of_todo(&state, &todo)).is_empty());
            let opts = StartOptions::default();
            let started = if cloud { launch_cloud(&state, todo.id, &opts).map(|_| ()) } else { launch_terminal(&state, todo.id, false, &opts) };
            if let Ok(db) = state.db.lock() {
                let _ = match started {
                    Ok(()) => db.dequeue(todo.id),
                    Err(e) => db.set_queue_error(todo.id, Some(&e)),
                };
            }
        }
    }
}

#[derive(Deserialize)]
struct GhRepo {
    #[serde(rename = "nameWithOwner")]
    name_with_owner: String,
}

#[derive(Deserialize)]
struct GhIssue {
    number: i64,
    title: String,
    url: String,
    repository: GhRepo,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

#[derive(Serialize)]
struct IssueView {
    number: i64,
    title: String,
    url: String,
    repo: String,
    updated_at: String,
    /// Checkout found under the ghq root, if any.
    cwd: Option<String>,
}

fn ghq_root() -> Option<PathBuf> {
    let out = cli("ghq").arg("root").output().ok()?;
    out.status.success().then(|| PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
}

/// Open issues assigned to the user that are not todos yet.
#[tauri::command(async)]
fn gh_issues(state: State<AppState>) -> Result<Vec<IssueView>, String> {
    let out = cli("gh")
        .args(["search", "issues", "--assignee", "@me", "--state", "open", "--limit", GH_ISSUE_LIMIT,
               "--json", "number,title,url,repository,updatedAt"])
        .output()
        .map_err(|e| format!("gh: {e}"))?;
    if !out.status.success() {
        return Err(format!("gh search issues: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let issues: Vec<GhIssue> = serde_json::from_slice(&out.stdout).map_err(|e| format!("gh output: {e}"))?;
    let known: HashSet<String> = state.db.lock().map_err(err)?.issue_urls().map_err(err)?.into_iter().collect();
    let root = ghq_root();
    Ok(issues
        .into_iter()
        .filter(|i| !known.contains(&i.url))
        .map(|i| IssueView {
            cwd: root.as_deref().and_then(|r| launch::ghq_cwd(r, &i.url)).map(|p| p.to_string_lossy().into()),
            number: i.number,
            title: i.title,
            url: i.url,
            repo: i.repository.name_with_owner,
            updated_at: i.updated_at,
        })
        .collect())
}

#[derive(Deserialize)]
struct IssueImport {
    title: String,
    url: String,
    cwd: Option<String>,
}

#[tauri::command(async)]
fn import_issues(state: State<AppState>, issues: Vec<IssueImport>) -> Result<usize, String> {
    let db = state.db.lock().map_err(err)?;
    for i in &issues {
        db.create_todo(NewTodo {
            title: i.title.clone(),
            issue_url: Some(i.url.clone()),
            cwd: i.cwd.clone(),
            memo: None,
            repos: Vec::new(),
            kind: Default::default(),
            parent_id: None,
        })
        .map_err(err)?;
    }
    Ok(issues.len())
}

#[derive(Serialize)]
struct LocalRepo {
    /// `owner/repo`
    key: String,
    path: String,
}

fn git_dirs(root: &std::path::Path) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.join(".git").exists())
        .collect()
}

/// Checkouts on this machine: `<ghq root>/github.com/<owner>/<repo>` and the
/// children of EXTRA_REPO_ROOTS, keyed by `owner/repo`.
#[tauri::command(async)]
fn local_repos(state: State<AppState>) -> Result<Vec<LocalRepo>, String> {
    let mut dirs = Vec::new();
    if let Some(ghq) = ghq_root() {
        for owner in std::fs::read_dir(ghq.join("github.com")).into_iter().flatten().flatten() {
            dirs.extend(git_dirs(&owner.path()));
        }
    }
    for root in EXTRA_REPO_ROOTS {
        dirs.extend(git_dirs(&home().join(root)));
    }
    let mut repos: Vec<LocalRepo> = Vec::new();
    for dir in dirs {
        let path = dir.to_string_lossy().to_string();
        let Some(key) = repo_of_cwd(&state, &path) else { continue };
        // ghq checkouts come first, so they win over a second clone elsewhere.
        if !repos.iter().any(|r| r.key == key) {
            repos.push(LocalRepo { key, path });
        }
    }
    repos.sort_by(|a, b| a.key.to_lowercase().cmp(&b.key.to_lowercase()));
    Ok(repos)
}

fn gh(args: &[&str]) -> Result<String, String> {
    let out = cli("gh").args(args).output().map_err(|e| format!("gh: {e}"))?;
    if !out.status.success() {
        return Err(format!("gh {}: {}", args.iter().take(2).cloned().collect::<Vec<_>>().join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Opens a GitHub issue for the todo in its first repository and links it.
#[tauri::command(async)]
fn create_issue(state: State<AppState>, todo_id: i64) -> Result<Todo, String> {
    let todo = todo_or_err(&*state.db.lock().map_err(err)?, todo_id)?;
    let repo = launch::github_repos(&repos_of_todo(&state, &todo))
        .into_iter()
        .next()
        .ok_or("issue を作るリポジトリがありません。リポジトリ欄で owner/repo を選んでください")?;
    let body = todo.memo.clone().unwrap_or_default();
    let out = gh(&["issue", "create", "-R", &repo, "--title", &todo.title, "--body", &body])?;
    let url = out.lines().last().unwrap_or_default().to_string();
    if !url.starts_with("https://") {
        return Err(format!("gh issue create の出力から URL が取れません: {out}"));
    }
    let db = state.db.lock().map_err(err)?;
    db.update_todo(todo_id, TodoPatch { issue_url: Some(url), ..Default::default() }).map_err(err)?;
    db.set_issue_state(todo_id, "open").map_err(err)?;
    todo_or_err(&db, todo_id)
}

#[tauri::command(async)]
fn close_issue(state: State<AppState>, todo_id: i64) -> Result<(), String> {
    let todo = todo_or_err(&*state.db.lock().map_err(err)?, todo_id)?;
    let url = todo.issue_url.ok_or("issue が紐づいていません")?;
    gh(&["issue", "close", &url])?;
    state.db.lock().map_err(err)?.set_issue_state(todo_id, "closed").map_err(err)?;
    Ok(())
}

fn mark_done(db: &Db, todo: &Todo) {
    if todo.status != Status::Done {
        if let Err(e) = db.update_todo(todo.id, TodoPatch { status: Some(Status::Done), ..Default::default() }) {
            eprintln!("{e}");
        }
    }
}

/// Bytes read from the end of a transcript to find its latest gitBranch.
const TRANSCRIPT_TAIL_BYTES: u64 = 256 * 1024;

/// The end of a local session's transcript, `~/.claude/projects/*/<id>.jsonl`.
fn transcript_tail(session_id: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let projects = home().join(".claude/projects");
    let file = std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|d| d.path().join(format!("{session_id}.jsonl")))
        .find(|p| p.exists())?;
    let mut f = std::fs::File::open(file).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(TRANSCRIPT_TAIL_BYTES))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into())
}

/// Latest non-default branch a local session worked on, from its transcript.
fn transcript_branch(session_id: &str) -> Option<String> {
    launch::last_git_branch(&transcript_tail(session_id)?)
}

/// What a session is doing: its last message, context size and recent tool
/// calls, from the transcript (local) or the events API (cloud).
#[tauri::command]
async fn session_detail(session_id: String) -> Result<cts_core::transcript::Detail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entries = if launch::is_cloud_session(&session_id) {
            cts_core::cloud::recent_entries(&session_id)?
        } else {
            transcript_tail(&session_id).map(|t| cts_core::transcript::parse_jsonl(&t)).unwrap_or_default()
        };
        Ok(cts_core::transcript::detail(&entries))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn usage() -> Result<Vec<cts_core::usage::Limit>, String> {
    tauri::async_runtime::spawn_blocking(cts_core::cloud::usage).await.map_err(err)?
}

const INSTALLED_PLUGINS: &str = ".claude/plugins/installed_plugins.json";
const USER_SKILLS_DIR: &str = ".claude/skills";

/// Skills a session in `cwd` can use (the user's, the project's, installed
/// plugins' and the built-in commands), the ones past prompts used most first.
#[tauri::command(async)]
fn skills(state: State<AppState>, cwd: Option<String>) -> Result<Vec<cts_core::skills::Skill>, String> {
    use cts_core::skills;
    let mut all = skills::read_dir(&home().join(USER_SKILLS_DIR), None);
    if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
        all.extend(skills::read_dir(&PathBuf::from(cwd).join(USER_SKILLS_DIR), None));
    }
    let plugins: serde_json::Value = std::fs::read(home().join(INSTALLED_PLUGINS))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    for (key, installs) in plugins["plugins"].as_object().into_iter().flatten() {
        let name = key.split('@').next().unwrap_or(key);
        if let Some(path) = installs[0]["installPath"].as_str() {
            all.extend(skills::read_dir(&PathBuf::from(path).join("skills"), Some(name)));
        }
    }
    all.extend(skills::builtin());
    let prompts: Vec<String> = state.db.lock().map_err(err)?.list_todos(None).map_err(err)?.into_iter().filter_map(|t| t.prompt).collect();
    Ok(skills::rank(all, &prompts))
}

/// Marks one notification read, or all of them with None.
#[tauri::command(async)]
fn read_notifications(state: State<AppState>, id: Option<i64>) -> Result<(), String> {
    let db = state.db.lock().map_err(err)?;
    match id {
        Some(id) => db.mark_notification_read(id),
        None => db.mark_all_notifications_read(),
    }
    .map_err(err)
}

#[tauri::command(async)]
fn set_parent(state: State<AppState>, todo_id: i64, parent_id: Option<i64>) -> Result<Todo, String> {
    state.db.lock().map_err(err)?.set_parent(todo_id, parent_id).map_err(err)
}

const GH_PR_LIMIT: &str = "50";
const GH_PR_FIELDS: &str = "number,title,url,repository,author,updatedAt,isDraft";

#[derive(Deserialize)]
struct GhAuthor {
    login: String,
}

#[derive(Deserialize)]
struct GhPr {
    number: i64,
    title: String,
    url: String,
    repository: GhRepo,
    author: GhAuthor,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "isDraft")]
    is_draft: bool,
}

#[derive(Serialize)]
struct PrView {
    number: i64,
    title: String,
    url: String,
    repo: String,
    author: String,
    updated_at: String,
    is_draft: bool,
}

#[derive(Serialize)]
struct PrLists {
    /// Open PRs asking the user for a review.
    review: Vec<PrView>,
    /// Open PRs the user opened.
    mine: Vec<PrView>,
}

fn search_prs(filter: &str) -> Result<Vec<PrView>, String> {
    let json = gh(&["search", "prs", filter, "@me", "--state", "open", "--limit", GH_PR_LIMIT, "--json", GH_PR_FIELDS])?;
    let prs: Vec<GhPr> = serde_json::from_str(&json).map_err(|e| format!("gh output: {e}"))?;
    Ok(prs
        .into_iter()
        .map(|p| PrView {
            number: p.number,
            title: p.title,
            url: p.url,
            repo: p.repository.name_with_owner,
            author: p.author.login,
            updated_at: p.updated_at,
            is_draft: p.is_draft,
        })
        .collect())
}

#[tauri::command]
async fn gh_prs() -> Result<PrLists, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(PrLists { review: search_prs("--review-requested")?, mine: search_prs("--author")? }))
        .await
        .map_err(err)?
}

/// The browser pane's tabs are child webviews labelled with this prefix and the tab id.
const BROWSER_PREFIX: &str = "browser-";
/// Tells the page what a tab shows as it loads: `{tab, url, loading}`.
const BROWSER_URL_EVENT: &str = "browser-url";
/// `{tab, url}` when a tab's address changes without a page load.
const BROWSER_ADDRESS_EVENT: &str = "browser-address";

#[derive(Clone, Serialize)]
struct TabAddress {
    tab: String,
    url: String,
}

/// `{tab, title}` when a tab's page title changes.
const BROWSER_TITLE_EVENT: &str = "browser-title";
/// `{url}` for a link a page opens in a new window, which becomes a new tab.
const BROWSER_NEW_TAB_EVENT: &str = "browser-new-tab";

#[derive(Clone, Serialize)]
struct TabUrl {
    tab: String,
    url: String,
    /// True from the start of a load until it finishes.
    loading: bool,
}

#[derive(Clone, Serialize)]
struct TabTitle {
    tab: String,
    title: String,
}

#[derive(Clone, Serialize)]
struct NewTab {
    url: String,
}

/// Keys and the right-click menu inside every page (see the file).
const BROWSER_PAGE_SCRIPT: &str = include_str!("browser_page.js");
/// A page sends ⌘L as a navigation to this scheme; it is cancelled and the
/// app's address bar gets focus instead.
const APP_SCHEME: &str = "todo-sessions";
/// `{tab}` when a page asks for the address bar (⌘L).
const BROWSER_FOCUS_URL_EVENT: &str = "browser-focus-url";
/// When a page asks for a new tab (⌘T).
const BROWSER_OPEN_NEW_TAB_EVENT: &str = "browser-open-new-tab";
/// `-1` or `1` when a page asks for the previous or next tab (⌘⇧[ ⌘⇧]).
const BROWSER_SWITCH_TAB_EVENT: &str = "browser-switch-tab";
/// `{tab}` when a page asks to close its tab (⌘W).
const BROWSER_CLOSE_TAB_EVENT: &str = "browser-close-tab";
/// `{tab}` when a cloud session's page asks to archive it (⌘⇧A).
const BROWSER_ARCHIVE_EVENT: &str = "browser-archive";

#[derive(Clone, Serialize)]
struct TabOnly {
    tab: String,
}

/// How far below the main webview's top the page starts. The main webview
/// runs under the title bar and the page's viewport begins below it
/// (`viewport` is the page's innerHeight), while a child webview is placed
/// from the webview's top, so the page's coordinates are shifted by this.
fn page_top(app: &AppHandle, viewport: f64) -> f64 {
    let Some(main) = app.get_webview("main") else { return 0.0 };
    let scale = main.window().scale_factor().unwrap_or(1.0);
    main.bounds().map(|b| (b.size.to_logical::<f64>(scale).height - viewport).max(0.0)).unwrap_or(0.0)
}

/// Where a tab goes, from the placeholder's rectangle in the page.
fn browser_rect(app: &AppHandle, x: f64, y: f64, width: f64, height: f64, viewport: f64) -> tauri::Rect {
    let y = y + page_top(app, viewport);
    tauri::Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(width, height).into() }
}

/// Webview label of a tab; tab ids come from the page, so only plain ones pass.
fn tab_label(tab: &str) -> Result<String, String> {
    if tab.is_empty() || !tab.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("bad tab id {tab:?}"));
    }
    Ok(format!("{BROWSER_PREFIX}{tab}"))
}

fn browser_tabs(app: &AppHandle) -> Vec<tauri::Webview> {
    app.webviews().into_iter().filter(|(label, _)| label.starts_with(BROWSER_PREFIX)).map(|(_, v)| v).collect()
}

/// Shows tab `tab` with `url` in the browser pane: a webview laid over the
/// main one at the given rectangle (logical pixels), created on first use,
/// with the other tabs hidden behind it. GitHub refuses to be framed, so the
/// pane cannot be an iframe.
#[tauri::command(async)]
fn browser_open(state: State<'_, AppState>, app: AppHandle, tab: String, url: String, x: f64, y: f64, width: f64, height: f64, viewport: f64) -> Result<(), String> {
    if !is_web_url(&url) {
        return Err(format!("開けない URL です: {url}"));
    }
    let label = tab_label(&tab)?;
    let parsed: tauri::Url = url.parse().map_err(err)?;
    // Two opens of a new tab at once (a re-render) would both create it.
    let _one_at_a_time = state.browser_lock.lock().map_err(err)?;
    for other in browser_tabs(&app).iter().filter(|v| v.label() != label) {
        other.hide().map_err(err)?;
    }
    if let Some(view) = app.get_webview(&label) {
        // Showing the tab again keeps the page the user moved on to.
        if view.url().ok().as_ref() != Some(&parsed) {
            view.navigate(parsed).map_err(err)?;
        }
        view.set_bounds(browser_rect(&app, x, y, width, height, viewport)).map_err(err)?;
        return view.show().map_err(err);
    }
    let window = app.get_window("main").ok_or("main window not found")?;
    let (on_load, on_title, on_new, on_focus) = (app.clone(), app.clone(), app.clone(), app.clone());
    let (load_tab, title_tab, focus_tab) = (tab.clone(), tab.clone(), tab);
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .initialization_script(BROWSER_PAGE_SCRIPT)
        .on_navigation(move |url| {
            if url.scheme() != APP_SCHEME {
                return true;
            }
            // Keys typed next belong in the app (its address bar).
            if let Some(main) = on_focus.get_webview("main") {
                let _ = main.set_focus();
            }
            let _ = match url.host_str() {
                Some("new-tab") => on_focus.emit(BROWSER_OPEN_NEW_TAB_EVENT, ()),
                Some("tab-prev") => on_focus.emit(BROWSER_SWITCH_TAB_EVENT, -1),
                Some("tab-next") => on_focus.emit(BROWSER_SWITCH_TAB_EVENT, 1),
                Some("close-tab") => on_focus.emit(BROWSER_CLOSE_TAB_EVENT, TabOnly { tab: focus_tab.clone() }),
                Some("archive") => on_focus.emit(BROWSER_ARCHIVE_EVENT, TabOnly { tab: focus_tab.clone() }),
                _ => on_focus.emit(BROWSER_FOCUS_URL_EVENT, TabOnly { tab: focus_tab.clone() }),
            };
            false
        })
        .on_page_load(move |_, payload| {
            let loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            let _ = on_load.emit(BROWSER_URL_EVENT, TabUrl { tab: load_tab.clone(), url: payload.url().to_string(), loading });
        })
        .on_document_title_changed(move |view, title| {
            let _ = on_title.emit(BROWSER_TITLE_EVENT, TabTitle { tab: title_tab.clone(), title });
            // Pages that move without loading (GitHub, ChatGPT, claude.ai)
            // change their title as they go: pass the address on with it.
            if let Ok(url) = view.url() {
                let _ = on_title.emit(BROWSER_ADDRESS_EVENT, TabAddress { tab: title_tab.clone(), url: url.to_string() });
            }
        })
        // A sized window is a popup (sign-in pages rely on those); a plain
        // "open in new window" link becomes a tab instead.
        .on_new_window(move |url, features| {
            if features.size().is_some() {
                return tauri::webview::NewWindowResponse::Allow;
            }
            let _ = on_new.emit(BROWSER_NEW_TAB_EVENT, NewTab { url: url.to_string() });
            tauri::webview::NewWindowResponse::Deny
        });
    window
        .add_child(builder, LogicalPosition::new(x, y + page_top(&app, viewport)), LogicalSize::new(width, height))
        .map(|_| ())
        .map_err(err)
}

/// Follows the pane's placeholder when the layout changes.
#[tauri::command(async)]
fn browser_bounds(app: AppHandle, x: f64, y: f64, width: f64, height: f64, viewport: f64) -> Result<(), String> {
    for view in browser_tabs(&app) {
        view.set_bounds(browser_rect(&app, x, y, width, height, viewport)).map_err(err)?;
    }
    Ok(())
}

/// Hides every tab; they keep their pages for the next open.
#[tauri::command(async)]
fn browser_hide(app: AppHandle) -> Result<(), String> {
    for view in browser_tabs(&app) {
        view.hide().map_err(err)?;
    }
    Ok(())
}

#[tauri::command(async)]
fn browser_close(app: AppHandle, tab: String) -> Result<(), String> {
    match app.get_webview(&tab_label(&tab)?) {
        Some(view) => view.close().map_err(err),
        None => Ok(()),
    }
}

/// Gives a tab's page the keyboard, as leaving the address bar with Esc does.
#[tauri::command(async)]
fn browser_focus(app: AppHandle, tab: String) -> Result<(), String> {
    match app.get_webview(&tab_label(&tab)?) {
        Some(view) => view.set_focus().map_err(err),
        None => Ok(()),
    }
}

/// A tab's address right now, which a page moving without a load (history
/// pushState) changes without any event.
#[tauri::command(async)]
fn browser_url(app: AppHandle, tab: String) -> Result<Option<String>, String> {
    Ok(app.get_webview(&tab_label(&tab)?).and_then(|v| v.url().ok()).map(|u| u.to_string()))
}

/// "back", "forward" or "reload" in a tab.
#[tauri::command(async)]
fn browser_go(app: AppHandle, tab: String, action: String) -> Result<(), String> {
    let view = app.get_webview(&tab_label(&tab)?).ok_or("このタブは開いていません")?;
    match action.as_str() {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        other => return Err(format!("unknown browser action {other}")),
    }
    .map_err(err)
}

/// A PR opened from the branch any of the todo's sessions works on, however
/// the session was started. Only PRs opened after the session started count:
/// a session run on someone's existing branch must not adopt their PR.
fn pr_from_session_branches(db: &Db, todo: &Todo) -> Option<String> {
    let mut todo_repos = launch::github_repos(&todo.repos);
    todo_repos.extend(todo.issue_url.as_deref().and_then(launch::repo_key));
    for s in db.sessions_for_todo(todo.id).ok()? {
        let branch = s.branch.clone().or_else(|| (!launch::is_cloud_session(&s.session_id)).then(|| transcript_branch(&s.session_id)).flatten());
        let Some(branch) = branch else { continue };
        let mut repos = launch::github_repos(&s.repos);
        repos.extend(launch::repo_key(&s.cwd));
        repos.extend(todo_repos.iter().cloned());
        repos.dedup();
        for repo in repos {
            let found = gh(&["pr", "list", "-R", &repo, "--head", &branch, "--state", "all", "--limit", "5", "--json", "url,createdAt"])
                .ok()
                .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
                .and_then(|v| launch::pr_created_after(&v, s.started_at));
            if found.is_some() {
                return found;
            }
        }
    }
    None
}

/// Links a PR opened from the todo's branch, then records the PR's review
/// stage; a PR that becomes merged marks its todo done.
/// Links a PR to a todo that has none: one opened from a `claude/todo-<id>-`
/// branch, or from the branch any of its sessions works on.
fn discover_pr(db: &Db, todo: &Todo, branch_prs: &mut HashMap<String, serde_json::Value>) {
    if todo.pr_url.is_some() {
        return;
    }
    let mut repos = launch::github_repos(&todo.repos);
    repos.extend(todo.issue_url.as_deref().and_then(launch::repo_key));
    let mut found = None;
    for repo in repos {
        let prs = branch_prs.entry(repo.clone()).or_insert_with(|| {
            gh(&["pr", "list", "-R", &repo, "--state", "all", "--limit", "100", "--json", "url,headRefName"])
                .ok()
                .and_then(|j| serde_json::from_str(&j).ok())
                .unwrap_or_default()
        });
        found = launch::pr_for_todo(prs, todo.id);
        if found.is_some() {
            break;
        }
    }
    if let Some(url) = found.or_else(|| pr_from_session_branches(db, todo)) {
        let _ = db.update_todo(todo.id, TodoPatch { pr_url: Some(url), ..Default::default() });
    }
}

/// Records the state of every linked issue and PR with batched GraphQL
/// queries. A closed issue or a merged PR marks its todo done.
fn refresh_states(db: &Db, todos: &[Todo]) {
    let mut by_url: HashMap<String, (i64, bool)> = HashMap::new();
    for t in todos {
        if let Some(u) = t.issue_url.clone().filter(|u| u.contains("/issues/")) {
            by_url.insert(u, (t.id, false));
        }
        if let Some(u) = t.pr_url.clone() {
            by_url.insert(u, (t.id, true));
        }
    }
    let urls: Vec<String> = by_url.keys().cloned().collect();
    for chunk in urls.chunks(cts_core::github::BATCH_SIZE) {
        let query = cts_core::github::status_query(chunk);
        let Ok(json) = gh(&["api", "graphql", "-f", &format!("query={query}")]) else { continue };
        let Ok(resp) = serde_json::from_str::<serde_json::Value>(&json) else { continue };
        for (url, now) in cts_core::github::parse_statuses(&resp, chunk) {
            let Some(&(id, is_pr)) = by_url.get(&url) else { continue };
            let Some(todo) = todos.iter().find(|t| t.id == id) else { continue };
            let before = if is_pr { db.set_pr_state(id, &now) } else { db.set_issue_state(id, &now) };
            let finished = if is_pr { now == "merged" } else { now == "closed" };
            let just_finished = match &before {
                Ok(b) => finished && b.as_deref() != Some(now.as_str()) && (b.is_some() || is_pr),
                Err(e) => {
                    eprintln!("{e}");
                    false
                }
            };
            // A PR under review moves its todo to Review; one sent back for changes returns it to Doing.
            if is_pr && todo.status != Status::Done && matches!(before, Ok(ref b) if b.as_deref() != Some(now.as_str())) {
                let next = match now.as_str() {
                    "review_requested" | "approved" => Some(Status::Review),
                    "changes_requested" => Some(Status::Doing),
                    _ => None,
                };
                if let Some(next) = next.filter(|n| *n != todo.status) {
                    let _ = db.update_todo(todo.id, TodoPatch { status: Some(next), ..Default::default() });
                }
            }
            if just_finished {
                mark_done(db, todo);
                // Backstop for a PR that did not say "Closes …": close its todo's issue too.
                if is_pr {
                    if let Some(issue) = todo.issue_url.as_deref().filter(|u| u.contains("/issues/")) {
                        if todo.issue_state.as_deref() != Some("closed") && gh(&["issue", "close", issue, "--comment", &format!("{url} のマージで完了しました。")]).is_ok() {
                            let _ = db.set_issue_state(todo.id, "closed");
                        }
                    }
                }
            }
        }
    }
}

/// One GitHub sync: all todos, or just `only`.
fn sync_github(db: &Db, only: Option<i64>) {
    let todos: Vec<Todo> = db
        .list_todos(None)
        .unwrap_or_default()
        .into_iter()
        .filter(|t| only.is_none_or(|id| t.id == id))
        .collect();
    let mut branch_prs = HashMap::new();
    // A PR is found from a session's branch (or the claude/todo-<id>- one a
    // session pushes), so a todo that never had a session has none to find;
    // skipping those saves a `gh pr list` per repository each minute.
    let with_sessions = db.sessions_by_todo().unwrap_or_default();
    for t in todos.iter().filter(|t| t.status != Status::Done && with_sessions.contains_key(&t.id)) {
        discover_pr(db, t, &mut branch_prs);
    }
    let todos: Vec<Todo> = todos.iter().filter_map(|t| db.get_todo(t.id).ok().flatten()).collect();
    refresh_states(db, &todos);
}

/// Syncs GitHub every ISSUE_SYNC_INTERVAL, and at once when woken: `Some(id)`
/// for one todo (its drawer opened, its session finished a turn), `None` for
/// all (window focused, the sync button).
fn issue_sync_loop(app: AppHandle, wake: std::sync::mpsc::Receiver<Option<i64>>) {
    let db = match open_db() {
        Ok(db) => db,
        Err(e) => return eprintln!("issue sync stopped: {e}"),
    };
    let mut next_full = std::time::Instant::now();
    let mut seeded = false;
    loop {
        let wait = next_full.saturating_duration_since(std::time::Instant::now());
        match wake.recv_timeout(wait) {
            Ok(Some(id)) => sync_github(&db, Some(id)),
            Ok(None) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                sync_github(&db, None);
                if let Err(e) = notify_review_requests(&app, &db, &mut seeded) {
                    eprintln!("review requests: {e}");
                }
                next_full = std::time::Instant::now() + ISSUE_SYNC_INTERVAL;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn show_window(app: &AppHandle) {
    // A window holding the browser pane's webview is no longer a "webview
    // window" to Tauri, so it is looked up as a plain window.
    if let Some(w) = app.get_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Linked sessions waiting for input or idle, as the menu bar lists them.
fn tray_menu(app: &AppHandle, sessions: &[Session]) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Todo Sessions を開く", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "終了", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = vec![Box::new(open), Box::new(sep)];
    if sessions.is_empty() {
        items.push(Box::new(MenuItem::with_id(app, "none", "入力待ち・待機中のセッションはありません", false, None::<&str>)?));
    }
    for s in sessions {
        let state = if s.state == SessionState::NeedsInput { "入力待ち" } else { "待機中" };
        let label = format!("{state}: {}", s.title.as_deref().unwrap_or(&s.session_id));
        let id = format!("{MENU_SESSION_PREFIX}{}", s.session_id);
        items.push(Box::new(MenuItem::with_id(app, id, label, true, None::<&str>)?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(quit));
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter().map(|i| i.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Records a notification for the in-app list, posts it, and opens the
/// session (marking it read) when it is clicked. The thread lives until the
/// notification is clicked or removed from Notification Center.
fn notify_session(app: &AppHandle, db: &Db, session: Session, kind: NoticeKind) {
    let headline = match kind {
        NoticeKind::NeedsInput => "入力待ち",
        _ => "作業が終わりました",
    };
    let id = db.add_notification(&session, kind).map_err(|e| eprintln!("{e}")).ok();
    let label = session.title.clone().unwrap_or_else(|| session.session_id.clone());
    post_banner(app, headline, label, id, move |app| open_from_outside(app, &session.session_id));
}

/// Posts a macOS notification; clicking it reads notice `id` and runs `open`.
fn post_banner(app: &AppHandle, headline: &'static str, label: String, id: Option<i64>, open: impl FnOnce(&AppHandle) -> Result<(), String> + Send + 'static) {
    let app = app.clone();
    std::thread::spawn(move || {
        let response = Notification::new().title(headline).message(&label).wait_for_click(true).send();
        match response {
            Ok(NotificationResponse::Click) => {
                if let (Some(id), Ok(db)) = (id, open_db()) {
                    let _ = db.mark_notification_read(id).map_err(|e| eprintln!("{e}"));
                }
                if let Err(e) = open(&app) {
                    eprintln!("{e}");
                }
            }
            Ok(_) => {}
            Err(e) => eprintln!("notification: {e}"),
        }
    });
}

/// Notifies each PR newly asking for the user's review. The first check,
/// before any was ever recorded, only records the ones already waiting.
/// ponytail: a PR re-requested after an earlier request is not noticed again.
fn notify_review_requests(app: &AppHandle, db: &Db, seeded: &mut bool) -> Result<(), String> {
    let prs = search_prs("--review-requested")?;
    let quiet = !*seeded && !db.has_review_notices().map_err(err)?;
    *seeded = true;
    for p in prs {
        let title = format!("{}#{} {}", p.repo, p.number, p.title);
        let Some(id) = db.add_review_notice(&p.url, &title, quiet).map_err(err)? else { continue };
        if !quiet {
            let url = p.url;
            post_banner(app, "レビュー依頼", title, Some(id), move |app| {
                show_window(app);
                app.emit(BROWSER_NEW_TAB_EVENT, NewTab { url }).map_err(err)
            });
        }
    }
    Ok(())
}

/// Records every session `claude agents` reports, so sessions started before
/// the hooks were installed still reach the inbox, and ends local sessions
/// that are no longer reported.
fn discover_sessions(db: &Db, with_agents: bool) -> Result<(), String> {
    // Without `claude agents` only herdr's states are read, and nothing is ended.
    let live = if with_agents {
        let out = cli("claude").args(["agents", "--json"]).output().map_err(|e| format!("claude agents: {e}"))?;
        if !out.status.success() {
            return Err(format!("claude agents: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        let json: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("claude agents output: {e}"))?;
        cts_core::agents::parse_agents(&json)
    } else {
        Vec::new()
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    for s in &live {
        let known = db.get_session(&s.session_id).map_err(err)?;
        // Hooks report state faster and more precisely; only fill in what they missed.
        let stale = known.as_ref().is_none_or(|k| k.state != s.state && now - k.state_at > DISCOVER_GRACE_SECS);
        if stale {
            let cwd = known.as_ref().map(|k| k.cwd.clone()).filter(|c| !c.is_empty()).unwrap_or_else(|| s.cwd.clone());
            db.record_session(&s.session_id, &cwd, s.state).map_err(err)?;
        }
        if let (Some(name), true) = (&s.name, known.as_ref().is_none_or(|k| k.title.is_none())) {
            db.set_session_title(&s.session_id, name).map_err(err)?;
        }
    }
    // herdr watches the terminal itself, so its state is current and wins for
    // the sessions it hosts, hooks or not.
    let mut in_herdr: HashSet<String> = HashSet::new();
    if let Ok(table) = cli("herdr").args(["session", "list"]).output() {
        for name in cts_core::herdr::running_sessions(&String::from_utf8_lossy(&table.stdout)) {
            let Ok(out) = cli("herdr").args(["--session", &name, "agent", "list"]).output() else { continue };
            let Ok(agents) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else { continue };
            for (id, cwd, state) in cts_core::herdr::agent_states(&agents) {
                let known = db.get_session(&id).map_err(err)?;
                if known.as_ref().is_none_or(|k| k.state != state) {
                    let cwd = known.map(|k| k.cwd).filter(|c| !c.is_empty()).unwrap_or(cwd);
                    db.record_session(&id, &cwd, state).map_err(err)?;
                }
                in_herdr.insert(id);
            }
        }
    }
    if !with_agents {
        return Ok(());
    }
    let listed: HashSet<&str> = live.iter().map(|s| s.session_id.as_str()).chain(in_herdr.iter().map(String::as_str)).collect();
    for k in db.live_local_sessions().map_err(err)? {
        if !listed.contains(k.session_id.as_str()) && now - k.state_at > DISCOVER_GRACE_SECS {
            db.record_session(&k.session_id, &k.cwd, SessionState::Ended).map_err(err)?;
        }
    }
    Ok(())
}

/// Keeps the tray menu current and notifies once per session that starts
/// waiting for input.
fn watch_loop(app: AppHandle) {
    let db = match open_db() {
        Ok(db) => db,
        Err(e) => return eprintln!("watch loop stopped: {e}"),
    };
    let mut known: HashSet<String> = HashSet::new();
    let mut tray_shown: Option<Vec<(String, SessionState)>> = None;
    let mut last_state: HashMap<String, SessionState> = HashMap::new();
    let mut first = true;
    let mut tick: u32 = 0;
    let mut records = cts_core::desktop::RecordCache::default();
    let desktop_dir = home().join(DESKTOP_SESSIONS_DIR);
    loop {
        let with_agents = tick % AGENTS_EVERY_TICKS == 0;
        if with_agents || tick % HERDR_EVERY_TICKS == 0 {
            if let Err(e) = discover_sessions(&db, with_agents) {
                eprintln!("{e}");
            }
        }
        tick = tick.wrapping_add(1);
        if let Ok(mut waiting) = db.linked_needs_input() {
            // Sessions archived in Claude Desktop stay out of the inbox and notifications.
            let archived = records.archived_cli_ids(&desktop_dir);
            if let Ok(mut shared) = app.state::<AppState>().archived.lock() {
                shared.clone_from(&archived);
            }
            waiting.retain(|s| !archived.contains(&s.session_id));
            let now: HashSet<String> = waiting.iter().map(|s| s.session_id.clone()).collect();
            // Sessions already waiting at startup were notified by an earlier run, or never will be.
            if !first {
                for s in waiting.iter().filter(|s| !known.contains(&s.session_id)) {
                    notify_session(&app, &db, s.clone(), NoticeKind::NeedsInput);
                }
            }
            // A linked session that stops running has finished its turn and waits for a reply.
            if let Ok(linked) = db.linked_sessions() {
                for s in linked.iter().filter(|s| !archived.contains(&s.session_id)) {
                    let before = last_state.insert(s.session_id.clone(), s.state);
                    if !first && before == Some(SessionState::Running) && s.state == SessionState::Idle {
                        notify_session(&app, &db, s.clone(), NoticeKind::Finished);
                        // A finished turn often just opened a PR: look now.
                        if let (Some(todo_id), Ok(tx)) = (s.todo_id, app.state::<AppState>().github_wake.lock()) {
                            let _ = tx.send(Some(todo_id));
                        }
                    }
                }
            }
            if let Ok(mut listed) = db.tray_sessions() {
                listed.retain(|s| !archived.contains(&s.session_id));
                let shown: Vec<(String, SessionState)> = listed.iter().map(|s| (s.session_id.clone(), s.state)).collect();
                if tray_shown.as_ref() != Some(&shown) {
                    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), tray_menu(&app, &listed)) {
                        let _ = tray.set_menu(Some(menu));
                    }
                    tray_shown = Some(shown);
                }
            }
            known = now;
            first = false;
        }
        std::thread::sleep(WATCH_INTERVAL);
    }
}

fn sync_loop(wake: std::sync::mpsc::Receiver<()>, status: impl Fn(String)) {
    let db = match open_db() {
        Ok(db) => db,
        Err(e) => return status(format!("cloud sync 停止: {e}")),
    };
    loop {
        let mut msg = match cts_core::cloud::sync(&db) {
            Ok(r) if r.errors.is_empty() => format!("cloud: {} 件記録 / {} 件紐づけ", r.recorded, r.linked),
            Ok(r) => format!("cloud: {} 件失敗 ({})", r.errors.len(), r.errors.join("; ")),
            Err(e) => format!("cloud sync 失敗: {e}"),
        };
        // Done todos' cloud sessions leave the lists on their own.
        match cts_core::cloud::archive_done(&db) {
            Ok(errors) if errors.is_empty() => {}
            Ok(errors) => msg.push_str(&format!(" / アーカイブ {} 件失敗 ({})", errors.len(), errors.join("; "))),
            Err(e) => msg.push_str(&format!(" / アーカイブ失敗: {e}")),
        }
        status(msg);
        // Sleep until the interval passes or someone asks for a sync now.
        if let Err(std::sync::mpsc::RecvTimeoutError::Disconnected) = wake.recv_timeout(CLOUD_SYNC_INTERVAL) {
            return;
        }
    }
}

fn main() {
    let db = open_db().expect("open database");
    let (github_tx, github_rx) = std::sync::mpsc::channel();
    let (cloud_tx, cloud_rx) = std::sync::mpsc::channel();
    tauri::Builder::default()
        .manage(terminal::Terminals::default())
        .manage(AppState {
            db: Mutex::new(db),
            sync_status: Mutex::new("cloud: 同期待ち".into()),
            origin_cache: Mutex::new(HashMap::new()),
            loop_enabled: AtomicBool::new(true),
            herdr_session: Mutex::new(None),
            in_app_terminal: AtomicBool::new(false),
            archived: Mutex::new(HashSet::new()),
            browser_lock: Mutex::new(()),
            github_wake: Mutex::new(github_tx),
            cloud_wake: Mutex::new(cloud_tx),
        })
        .setup(|app| {
            // Menu bar app: no Dock icon, closing the window only hides it.
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            // Without this the crate would post notifications as another app.
            if let Err(e) = mac_notification_sys::set_application(APP_ID) {
                eprintln!("notification app id: {e}");
            }
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                .icon_as_template(true)
                .menu(&tray_menu(app.handle(), &[])?)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    if id == MENU_OPEN {
                        show_window(app);
                    } else if id == MENU_QUIT {
                        app.exit(0);
                    } else if let Some(session_id) = id.strip_prefix(MENU_SESSION_PREFIX) {
                        if let Err(e) = open_from_outside(app, session_id) {
                            eprintln!("{e}");
                        }
                    }
                })
                .build(app)?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                sync_loop(cloud_rx, |msg| {
                    if let Ok(mut s) = handle.state::<AppState>().sync_status.lock() {
                        *s = msg;
                    }
                })
            });
            let handle = app.handle().clone();
            std::thread::spawn(move || watch_loop(handle));
            let handle = app.handle().clone();
            std::thread::spawn(move || issue_sync_loop(handle, github_rx));
            let handle = app.handle().clone();
            std::thread::spawn(move || queue_loop(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            board,
            create_todo,
            update_todo,
            delete_todo,
            add_link,
            remove_link,
            open_link,
            open_in_dia,
            link_session,
            unlink_session,
            open_session,
            sync_now,
            quick_claude,
            start_desktop,
            start_terminal,
            start_cloud,
            gh_issues,
            import_issues,
            local_repos,
            create_issue,
            close_issue,
            enqueue,
            dequeue,
            move_in_queue,
            set_loop_enabled,
            set_parent,
            read_notifications,
            session_detail,
            usage,
            skills,
            gh_prs,
            browser_open,
            browser_bounds,
            browser_hide,
            browser_close,
            browser_focus,
            browser_url,
            herdr_sessions,
            terminal_start,
            archive_sessions,
            terminal_quick,
            terminal_resume,
            set_in_app_terminal,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            terminal::term_focus,
            terminal::ghostty_config,
            terminal::user_font,
            set_herdr_session,
            browser_go
        ])
        .run(tauri::generate_context!())
        .expect("run tauri app");
}
