#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cef_browser;
mod feynman;
mod logins;
mod terminal;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use cts_core::launch::StartOptions;
use cts_core::{launch, Db, Input, InputPatch, NewTodo, NoticeKind, Session, SessionState, Status, Subject, Todo, TodoPatch};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
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
/// How often (in watch ticks) the 「説明する」 reviews due are looked for.
const STUDY_EVERY_TICKS: u32 = 20;
/// A local session missing from `claude agents` is ended only after this long
/// without a state change, so one just started by a hook is not cut off.
const DISCOVER_GRACE_SECS: i64 = 60;
/// Where the CLIs live when the app is launched from Finder with a bare PATH.
const EXTRA_PATH: &[&str] = &[".local/bin", ".cargo/bin"];
const SYSTEM_PATHS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/run/current-system/sw/bin"];
const TRAY_ID: &str = "main";
const MENU_OPEN: &str = "open";
const MENU_QUIT: &str = "quit";
/// The app menu's ⌘W, which closes a browser tab rather than the window.
const MENU_CLOSE_TAB: &str = "close-tab";

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
    /// The focus mode is on: pages' Esc asks about leaving it, and macOS
    /// notifications wait (the in-app list still gets them).
    focus_mode: AtomicBool,
    /// Logins kept per host (logins.rs), as read from the Keychain this run (None: none kept).
    logins: Mutex<HashMap<String, Option<logins::Login>>>,
    /// A login a page just sent, asked about before it is kept: its host and the login.
    pending_login: Mutex<Option<(String, logins::Login)>>,
    /// The app's keys for the pages, as JSON (see `set_page_keys`).
    page_keys: Mutex<String>,
    /// Tabs whose page should focus its text box once it loads, and since when.
    focus_input: Mutex<HashMap<String, std::time::Instant>>,
    /// Held while a browser tab is shown or created.
    browser_lock: Mutex<()>,
    /// CLI session ids archived in Desktop. Reading every Desktop record is
    /// slow, so the watch loop refreshes this and the board only reads it.
    archived: Mutex<HashSet<String>>,
    /// Each site's zoom set with the keys (1.0 is none), kept across restarts (ZOOMS_FILE).
    zooms: Mutex<HashMap<String, f64>>,
    /// Each site's answer to its ask for the microphone or camera, kept (SITE_PERMISSIONS_FILE).
    site_permissions: Mutex<HashMap<String, bool>>,
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
    /// The Input page's reading material, apart from the todos.
    inputs: Vec<Input>,
    inbox: Vec<SessionView>,
    /// Notifications posted, newest first, for the in-app list.
    notifications: Vec<cts_core::Notice>,
    /// Each subject's latest 「説明する」 attempt (feynman.rs).
    feynman: Vec<cts_core::FeynmanSummary>,
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
    let (todos, inputs, inbox, notifications, feynman) = {
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
            // A review that ended without being put away stopped before submitting: it waits on the user.
            .filter(|s| (s.state != SessionState::Ended || (s.review_url.is_some() && !s.hidden)) && !archived.contains(&s.session_id))
            .collect();
        (todos, db.list_inputs().map_err(err)?, inbox, db.notifications().map_err(err)?, db.feynman_summaries().map_err(err)?)
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
    Ok(Board { todos, inputs, inbox, notifications, feynman, sync_status, loop_enabled: state.loop_enabled.load(Ordering::Relaxed) })
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

/// The herdr session hosting the session, with what `herdr agent list` says there.
fn herdr_agents_with(session_id: &str) -> Option<(String, serde_json::Value)> {
    let table = cli("herdr").args(["session", "list"]).output().ok()?;
    cts_core::herdr::running_sessions(&String::from_utf8_lossy(&table.stdout)).into_iter().find_map(|name| {
        let out = cli("herdr").args(["--session", &name, "agent", "list"]).output().ok()?;
        let agents = serde_json::from_slice::<serde_json::Value>(&out.stdout).ok()?;
        cts_core::herdr::find_pane(&agents, session_id).is_some().then_some((name, agents))
    })
}

/// The herdr session and pane running the session, if herdr hosts it.
fn herdr_pane(session_id: &str) -> Option<(String, String)> {
    let (name, agents) = herdr_agents_with(session_id)?;
    cts_core::herdr::find_pane(&agents, session_id).map(|pane| (name, pane))
}

/// Closes the herdr workspace the session runs in (its record stays, so
/// `claude --resume` brings it back). False when herdr does not host it.
fn close_herdr_workspace(session_id: &str) -> Result<bool, String> {
    let Some((name, agents)) = herdr_agents_with(session_id) else { return Ok(false) };
    let workspace = cts_core::herdr::find_workspace(&agents, session_id).ok_or("herdr がワークスペースを教えてくれませんでした")?;
    herdr(&["--session", &name, "workspace", "close", &workspace]).map(|_| true)
}

/// Focuses the herdr pane running the session, inside herdr only, and
/// returns the herdr session it is in.
fn focus_herdr_pane(session_id: &str) -> Option<String> {
    let (name, pane) = herdr_pane(session_id)?;
    cli("herdr").args(["--session", &name, "agent", "focus", &pane]).status().is_ok_and(|s| s.success()).then_some(name)
}

/// What `fix_in_session` did: sent the prompt to the session, or (a Cloud
/// one, which cannot be sent anything from here) left it to the page.
#[derive(Serialize)]
struct FixSent {
    sent: bool,
    prompt: String,
}

/// Sends the todo's session what to fix in its PR (the CI's failed checks,
/// the changes asked for): into its herdr pane while it runs there, else
/// resumed with it in a new herdr workspace that is not shown. Neither moves
/// the keyboard.
#[tauri::command(async)]
fn fix_in_session(state: State<AppState>, session_id: String, todo_id: i64) -> Result<FixSent, String> {
    let todo = todo_or_err(&*state.db.lock().map_err(err)?, todo_id)?;
    let pr = todo.pr_url.as_deref().ok_or("この todo には PR がありません")?;
    let ci = (todo.ci_state.as_deref() == Some("failure")).then_some(todo.ci_failed.as_slice());
    let prompt = launch::fix_prompt(pr, ci, todo.pr_state.as_deref() == Some("changes_requested"));
    if launch::is_cloud_session(&session_id) {
        return Ok(FixSent { sent: false, prompt });
    }
    if let Some((name, pane)) = herdr_pane(&session_id) {
        herdr(&["--session", &name, "agent", "prompt", &pane, &prompt])?;
    } else {
        let TerminalRun { cwd, title, command, .. } = resume_run(&state, &session_id)?;
        let command = format!("{command} {}", shell_quote(&prompt));
        start_in_herdr(&state, &cwd, &title, &command, false).or_else(|herdr_err| start_in_ghostty(&cwd, &command).map_err(|e| format!("{herdr_err} / {e}")))?;
    }
    Ok(FixSent { sent: true, prompt })
}

/// Opens a session in `target`: "herdr" focuses its pane, "desktop" opens
/// Claude Desktop, and none tries herdr first for local sessions.
/// Opens a new herdr workspace running a plain `claude`, outside any todo:
/// a quick question at home, or a PR review in its repository's folder.
#[tauri::command(async)]
fn quick_claude(state: State<AppState>, prompt: Option<String>, cwd: Option<String>, title: Option<String>, agent: Option<cts_core::Agent>, options: Option<StartOptions>) -> Result<(), String> {
    let TerminalRun { cwd, title: label, command, .. } = quick_agent_run(prompt.as_deref(), cwd, title, agent, &options.unwrap_or_default());
    // Started behind: neither herdr's view nor the terminal app comes forward (opening it does).
    start_in_herdr(&state, &cwd, &label, &command, false).or_else(|herdr_err| start_in_ghostty(&cwd, &command).map_err(|e| format!("{herdr_err} / {e}")))
}

/// A plain `claude` (at home unless `cwd` is given), with the prompt if one
/// is given. Its session id is picked here so the in-app terminal can find
/// its tab again.
/// A quick run with Codex instead of Claude when asked (a PR review), with
/// the model and effort picked: Codex picks its own session id, which herdr reports.
fn quick_agent_run(prompt: Option<&str>, cwd: Option<String>, title: Option<String>, agent: Option<cts_core::Agent>, opts: &StartOptions) -> TerminalRun {
    let mut run = quick_run(prompt, cwd, title);
    let codex = agent == Some(cts_core::Agent::Codex);
    let flags: String = (if codex { opts.codex_args() } else { opts.claude_args() }).iter().map(|a| format!(" {}", shell_quote(a))).collect();
    let first = prompt.map(str::trim).filter(|p| !p.is_empty()).map(|p| format!(" {}", shell_quote(p))).unwrap_or_default();
    if codex {
        run.command = format!("codex{flags}{first}");
        run.session = None;
    } else if let Some(session) = &run.session {
        run.command = format!("claude --session-id {session}{flags}{first}");
    }
    run
}

fn quick_run(prompt: Option<&str>, cwd: Option<String>, title: Option<String>) -> TerminalRun {
    let prompt = prompt.map(str::trim).filter(|p| !p.is_empty());
    let session = uuid::Uuid::new_v4().to_string();
    let first = prompt.map(|p| format!(" {}", shell_quote(p))).unwrap_or_default();
    TerminalRun {
        cwd: cwd.filter(|c| std::path::Path::new(c).is_dir()).unwrap_or_else(|| home().to_string_lossy().to_string()),
        title: title.or_else(|| prompt.map(|p| p.chars().take(24).collect())).unwrap_or_else(|| "claude".into()),
        command: format!("claude --session-id {session}{first}"),
        session: Some(session),
        herdr: None,
    }
}

/// The in-app terminal's versions of starting a todo's session, a quick
/// claude and reopening a session (see `terminal.rs`).
#[tauri::command(async)]
fn terminal_start(state: State<AppState>, todo_id: i64, options: Option<StartOptions>) -> Result<TerminalRun, String> {
    Ok(via_herdr(&state, prepare_terminal(&state, todo_id, &options.unwrap_or_default(), None)?, false))
}

#[tauri::command(async)]
fn terminal_quick(state: State<AppState>, prompt: Option<String>, cwd: Option<String>, title: Option<String>, agent: Option<cts_core::Agent>, options: Option<StartOptions>) -> TerminalRun {
    via_herdr(&state, quick_agent_run(prompt.as_deref(), cwd, title, agent, &options.unwrap_or_default()), false)
}

/// The in-app terminal's sessions run in herdr when one runs (so they go on
/// with the app closed): `run` goes to a new workspace there (herdr shows it
/// with `show`: opening, not starting), and the tab attaches that herdr session
/// (one tab for it, as `terminal_resume`'s). Without herdr, or when it fails,
/// `run` runs in the tab itself.
fn via_herdr(state: &AppState, run: TerminalRun, show: bool) -> TerminalRun {
    let Some(name) = herdr_target(state) else { return run };
    if let Err(e) = start_in_herdr(state, &run.cwd, &run.title, &run.command, show) {
        eprintln!("herdr: {e}; running in the tab instead");
        return run;
    }
    herdr_attach_run(name)
}

/// What the in-app terminal runs to show herdr session `name`.
fn herdr_attach_run(name: String) -> TerminalRun {
    TerminalRun {
        cwd: home().to_string_lossy().into(),
        title: format!("herdr: {name}"),
        command: format!("herdr session attach {}", shell_quote(&name)),
        session: None,
        herdr: Some(name),
    }
}

/// What the in-app terminal runs to show a session: a session running in
/// herdr gets its pane focused and the herdr session attached in the app;
/// with `desktop`, one still running in Claude Desktop opens there (None);
/// any other is resumed with `claude --resume`.
#[tauri::command(async)]
fn terminal_resume(state: State<AppState>, session_id: String, desktop: bool) -> Result<Option<TerminalRun>, String> {
    if let Some(name) = focus_herdr_pane(&session_id) {
        return Ok(Some(herdr_attach_run(name)));
    }
    // One still going in Desktop stays there; a finished one resumes here.
    let running = state.db.lock().map_err(err)?.get_session(&session_id).map_err(err)?.is_some_and(|s| s.state != SessionState::Ended);
    if desktop && running {
        if let Some(local) = cts_core::desktop::find_local_id(&home().join(DESKTOP_SESSIONS_DIR), &session_id) {
            return open_url(&launch::jump_url(&session_id, Some(&local))).map(|_| None);
        }
    }
    resume_run(&state, &session_id).map(|run| Some(via_herdr(&state, run, true)))
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
    let program = if session.agent == cts_core::Agent::Codex { "codex resume" } else { "claude --resume" };
    Ok(TerminalRun {
        title: session.title.clone().unwrap_or_else(|| session_id.chars().take(8).collect()),
        command: format!("{program} {session_id}"),
        cwd: session.cwd,
        session: Some(session_id.to_string()),
        herdr: None,
    })
}

/// When the window's focus changes: another app came in front, or a browser
/// tab or the page took the keyboard.
const WINDOW_FOCUS_EVENT: &str = "window-focus";

/// The app's keys for the pages (keymap.ts, as JSON), which their script reads.
fn page_keys_script(keys: &str) -> String {
    format!("window.__todoSessionsKeys = {keys};")
}

/// Sets the keys the pages take (keymap.ts's, as JSON), on every page now.
#[tauri::command]
fn set_page_keys(app: AppHandle, state: State<AppState>, keys: String) -> Result<(), String> {
    serde_json::from_str::<HashMap<String, String>>(&keys).map_err(err)?;
    *state.page_keys.lock().map_err(err)? = keys.clone();
    cef_browser::eval_all(&app, &page_keys_script(&keys));
    Ok(())
}

/// Turns the focus mode on or off for the pages (and the notifications).
#[tauri::command]
fn set_focus_mode(app: AppHandle, state: State<AppState>, on: bool) {
    state.focus_mode.store(on, Ordering::Relaxed);
    cef_browser::eval_all(&app, &focus_mode_script(on));
}

/// Whether the app is in front. With the page not having the keyboard, a
/// browser tab then has it. (The window's own focus follows the webviews, so
/// it cannot tell a browser tab from another app.)
#[tauri::command]
fn window_focused() -> bool {
    objc2_app_kit::NSRunningApplication::currentApplication().isActive()
}

/// Takes a session off the lists (⌘⇧A on a Local one, which cannot be archived from here).
#[tauri::command]
fn hide_session(state: State<AppState>, session_id: String) -> Result<(), String> {
    state.db.lock().map_err(err)?.hide_session(&session_id).map_err(err)
}

/// The session was looked at now (opened from the app, or its page or tab shown).
#[tauri::command]
fn mark_session_seen(state: State<AppState>, session_id: String) -> Result<(), String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_secs() as i64;
    state.db.lock().map_err(err)?.mark_session_seen(&session_id, now).map_err(err)
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
fn create_input(state: State<AppState>, title: String) -> Result<Input, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("タイトルを入れてください".into());
    }
    state.db.lock().map_err(err)?.create_input(title, None).map_err(err)
}

#[tauri::command(async)]
fn update_input(state: State<AppState>, id: i64, update: InputPatch) -> Result<Input, String> {
    state.db.lock().map_err(err)?.update_input(id, update).map_err(err)
}

#[tauri::command(async)]
fn delete_input(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.delete_input(id).map_err(err)
}

/// A page for an input; what it says about itself comes in the background, as for a todo's link.
#[tauri::command(async)]
fn add_input_link(app: AppHandle, input_id: i64, url: String) -> Result<cts_core::InputLink, String> {
    let url = url.trim().to_string();
    if !is_web_url(&url) {
        return Err("http(s) の URL を入れてください".into());
    }
    let link = app.state::<AppState>().db.lock().map_err(err)?.add_input_link(input_id, &url).map_err(err)?;
    let id = link.id;
    std::thread::spawn(move || {
        let Ok(meta) = cts_core::ogp::fetch(&url) else { return };
        if let Ok(db) = app.state::<AppState>().db.lock() {
            if let Err(e) = db.set_input_link_meta(id, meta.title.as_deref(), meta.image.as_deref()) {
                eprintln!("{e}");
            }
        }
    });
    Ok(link)
}

#[tauri::command(async)]
fn remove_input_link(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.remove_input_link(id).map_err(err)
}

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

/// Where a review runs: on Cloud, or in herdr on the Mac.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ReviewRunner {
    Cloud,
    Herdr,
}

/// Reviews the PR at `url` in a session linked to no todo, started behind
/// (nothing comes forward): on Cloud, or in a herdr workspace not shown
/// (Ghostty when herdr is down) in the repository's folder `cwd`. With `auto`
/// it submits on its own. Returns its session id (Codex picks its own, which
/// herdr reports: `discover_sessions` knows it by its prompt).
#[tauri::command(async)]
fn start_review(state: State<AppState>, url: String, repo: String, title: String, agent: cts_core::Agent, auto: bool, runner: ReviewRunner, cwd: Option<String>, options: Option<StartOptions>) -> Result<Option<String>, String> {
    let prompt = launch::review_prompt(&url, agent, auto);
    let opts = options.unwrap_or_default();
    if runner == ReviewRunner::Cloud {
        if agent == cts_core::Agent::Codex {
            return Err("Codex のレビューは herdr でだけ動きます".into());
        }
        let db = open_db()?;
        let id = cts_core::cloud::create_review_session(&db, &repo, &title, &prompt, &opts)?;
        // Its PR, for putting it away once the review is in (clean_reviews).
        db.record_review_session(&id, &url, auto).map_err(err)?;
        return Ok(Some(id));
    }
    let TerminalRun { cwd, title: label, command, session, .. } = quick_agent_run(Some(&prompt), cwd, Some(title.clone()), Some(agent), &opts);
    if let Some(id) = &session {
        let db = state.db.lock().map_err(err)?;
        db.record_session(id, &cwd, SessionState::Idle).map_err(err)?;
        db.set_session_title(id, &title).map_err(err)?;
        db.record_review_session(id, &url, auto).map_err(err)?;
    }
    start_in_herdr(&state, &cwd, &label, &command, false).or_else(|herdr_err| start_in_ghostty(&cwd, &command).map_err(|e| format!("{herdr_err} / {e}")))?;
    Ok(session)
}

/// Stops a review: a Cloud one is archived, a herdr one's workspace closed,
/// and it leaves the lists.
#[tauri::command(async)]
fn stop_review(state: State<AppState>, session_id: String) -> Result<(), String> {
    put_review_away(&*state.db.lock().map_err(err)?, &session_id)
}

/// A review session done with (submitted or stopped): archived on Cloud, its
/// herdr workspace closed, and off the lists.
fn put_review_away(db: &Db, session_id: &str) -> Result<(), String> {
    if launch::is_cloud_session(session_id) {
        let errors = cts_core::cloud::archive_sessions(db, &[session_id.to_string()])?;
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
    } else {
        close_herdr_workspace(session_id)?;
    }
    db.hide_session(session_id).map_err(err)
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
/// returns the `claude --session-id` command that runs it, with `body` (else
/// the todo's own) as its first prompt.
fn prepare_terminal(state: &AppState, todo_id: i64, opts: &StartOptions, body: Option<String>) -> Result<TerminalRun, String> {
    if opts.agent == cts_core::Agent::Codex {
        // Codex picks its own session id: herdr finds the session, and its first prompt's marker links it.
        let todo = todo_or_err(&*state.db.lock().map_err(err)?, todo_id)?;
        let prompt = launch::start_prompt(todo.id, &launch::codex_body(&opts.body(body.unwrap_or_else(|| todo.prompt_body()))));
        let flags: String = opts.codex_args().iter().map(|a| format!(" {}", shell_quote(a))).collect();
        let command = format!("codex{flags} {}", shell_quote(&prompt));
        return Ok(TerminalRun { cwd: terminal_cwd(&todo), title: todo.title, command, session: None, herdr: None });
    }
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
        shell_quote(&launch::start_prompt(todo.id, &opts.body(body.unwrap_or_else(|| todo.prompt_body()))))
    );
    Ok(TerminalRun { cwd: terminal_cwd(&todo), title: todo.title, command, session: Some(session_id), herdr: None })
}

/// Starts `claude --session-id` for the todo in herdr (Ghostty if herdr is
/// down), linked before it starts. `focus` brings the new workspace forward.
/// Returns the session's id.
fn launch_terminal(state: &AppState, todo_id: i64, focus: bool, opts: &StartOptions, body: Option<String>) -> Result<String, String> {
    let TerminalRun { cwd, title, command, session, .. } = prepare_terminal(state, todo_id, opts, body)?;
    start_in_herdr(state, &cwd, &title, &command, focus).or_else(|herdr_err| {
        start_in_ghostty(&cwd, &format!("cd {} && {command}", shell_quote(&cwd)))
            .map_err(|e| format!("{herdr_err} / {e}"))
    })?;
    Ok(session.unwrap_or_default())
}

/// Creates a cloud session for the todo and returns its `cse_…` id, with
/// `body` (else the todo's own) as its first prompt.
fn launch_cloud(state: &AppState, todo_id: i64, opts: &StartOptions, body: Option<String>) -> Result<String, String> {
    let todo = todo_or_err(&*state.db.lock().map_err(err)?, todo_id)?;
    if todo.is_orchestrator() {
        // Planning creates child todos through the local MCP server, which cloud sessions cannot reach.
        return Err("複数リポジトリの todo は計画用です。Local で計画セッションを始め、リポジトリごとの子 todo を作ってください".into());
    }
    // Without a GitHub repository the session runs with no checkout, which is fine for research.
    let repos = launch::github_repos(&repos_of_todo(state, &todo));
    let db = state.db.lock().map_err(err)?;
    cts_core::cloud::create_session(&db, todo.id, &repos, &todo.title, &opts.body(body.unwrap_or_else(|| todo.prompt_body())), opts)
}

/// A note session (the focus mode's "ノート"): where it runs, and the command
/// for the in-app terminal when it runs there.
#[derive(Serialize)]
struct NoteStart {
    session: String,
    run: Option<TerminalRun>,
}

/// Starts a session that turns `urls` into a note (in `format`) for the
/// subject: on Cloud, or locally where "herdr" sessions run (the in-app
/// terminal, whose command comes back to run, or herdr behind the app). A
/// todo's session is linked to it; an input's is linked to nothing.
#[tauri::command(async)]
fn start_note(state: State<AppState>, subject: Subject, urls: Vec<String>, format: launch::NoteFormat, cloud: bool) -> Result<NoteStart, String> {
    if urls.is_empty() {
        return Err("ノートにするページを左に開いてください".into());
    }
    let opts = StartOptions::default();
    let input_id = match subject {
        Subject::Input(id) => id,
        Subject::Todo(todo_id) => {
            let title = todo_or_err(&*state.db.lock().map_err(err)?, todo_id)?.title;
            let body = Some(launch::note_prompt(&title, &urls, format));
            if cloud {
                return Ok(NoteStart { session: launch_cloud(&state, todo_id, &opts, body)?, run: None });
            }
            if state.in_app_terminal.load(Ordering::Relaxed) {
                let run = prepare_terminal(&state, todo_id, &opts, body)?;
                return Ok(NoteStart { session: run.session.clone().unwrap_or_default(), run: Some(run) });
            }
            return Ok(NoteStart { session: launch_terminal(&state, todo_id, false, &opts, body)?, run: None });
        }
    };
    let title = state.db.lock().map_err(err)?.get_input(input_id).map_err(err)?.ok_or("input が見つかりません")?.title;
    let prompt = launch::note_prompt(&title, &urls, format);
    if cloud {
        let db = state.db.lock().map_err(err)?;
        return Ok(NoteStart { session: cts_core::cloud::create_loose_session(&db, &title, &prompt)?, run: None });
    }
    let run = quick_run(Some(&prompt), None, Some(title));
    let session = run.session.clone().unwrap_or_default();
    if state.in_app_terminal.load(Ordering::Relaxed) {
        return Ok(NoteStart { session, run: Some(run) });
    }
    start_in_herdr(&state, &run.cwd, &run.title, &run.command, false).or_else(|herdr_err| {
        start_in_ghostty(&run.cwd, &format!("cd {} && {}", shell_quote(&run.cwd), run.command)).map_err(|e| format!("{herdr_err} / {e}"))
    })?;
    Ok(NoteStart { session, run: None })
}

/// Title the note's link gets, in place of its page's (which needs a login).
const NOTE_TITLE: &str = "ノート";

/// The note session `session_id` published for the subject, once it has; it
/// is kept as one of its links from then on.
#[tauri::command(async)]
fn note_url(state: State<AppState>, subject: Subject, session_id: String) -> Result<Option<String>, String> {
    let text = if launch::is_cloud_session(&session_id) {
        serde_json::to_string(&cts_core::cloud::recent_entries(&session_id)?).map_err(err)?
    } else {
        transcript_tail(&session_id).unwrap_or_default()
    };
    let Some(url) = cts_core::transcript::note_url(&text) else { return Ok(None) };
    let db = state.db.lock().map_err(err)?;
    match subject {
        Subject::Todo(id) => {
            if !db.links_for(id).map_err(err)?.iter().any(|l| l.url == url) {
                let link = db.add_link(id, &url).map_err(err)?;
                db.set_link_meta(link.id, Some(NOTE_TITLE), None).map_err(err)?;
            }
        }
        Subject::Input(id) => {
            let input = db.get_input(id).map_err(err)?.ok_or("input が見つかりません")?;
            if !input.links.iter().any(|l| l.url == url) {
                let link = db.add_input_link(id, &url).map_err(err)?;
                db.set_input_link_meta(link.id, Some(NOTE_TITLE), None).map_err(err)?;
            }
        }
    }
    Ok(Some(url))
}

#[tauri::command(async)]
fn start_terminal(state: State<AppState>, todo_id: i64, options: Option<StartOptions>) -> Result<(), String> {
    // Started behind: neither herdr's view nor the terminal app comes forward (opening it does).
    launch_terminal(&state, todo_id, false, &options.unwrap_or_default(), None).map(|_| ())
}

/// Starts a cloud session and returns its id. `desktop` also opens it in
/// Claude Desktop; otherwise the page shows it on the web.
#[tauri::command(async)]
fn start_cloud(state: State<AppState>, todo_id: i64, options: Option<StartOptions>, desktop: bool) -> Result<String, String> {
    let id = launch_cloud(&state, todo_id, &options.unwrap_or_default(), None)?;
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
            let started = if cloud { launch_cloud(&state, todo.id, &opts, None).map(|_| ()) } else { launch_terminal(&state, todo.id, false, &opts, None).map(|_| ()) };
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

/// What a session waiting for a reply asks, from its transcript (local) or
/// events (cloud). Codex's rollouts are not read.
fn session_question(session: &Session) -> Option<String> {
    if session.agent == cts_core::Agent::Codex {
        return None;
    }
    let entries = if launch::is_cloud_session(&session.session_id) {
        cts_core::cloud::recent_entries(&session.session_id).map_err(|e| eprintln!("{e}")).ok()?
    } else {
        cts_core::transcript::parse_jsonl(&transcript_tail(&session.session_id)?)
    };
    cts_core::transcript::question(&entries)
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
    /// Open PRs the user opened: their stage, CI and reviewers.
    mine: Vec<cts_core::github::MyPr>,
}

/// Open PRs, leaving out archived repositories' (they can no longer move).
fn search_prs(filter: &str) -> Result<Vec<PrView>, String> {
    let json = gh(&["search", "prs", filter, "@me", "--state", "open", "--archived=false", "--limit", GH_PR_LIMIT, "--json", GH_PR_FIELDS])?;
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

fn my_prs() -> Result<Vec<cts_core::github::MyPr>, String> {
    let json = gh(&["api", "graphql", "-f", &format!("query={}", cts_core::github::MY_PRS_QUERY)])?;
    let resp: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("gh output: {e}"))?;
    Ok(cts_core::github::parse_my_prs(&resp))
}

/// The models Codex offers (its own cache), for picking one to start it with.
#[tauri::command(async)]
fn codex_models() -> Vec<cts_core::codex::Model> {
    std::fs::read_to_string(home().join(cts_core::codex::MODELS_CACHE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .map(|v| cts_core::codex::models(&v))
        .unwrap_or_default()
}

/// The Claude session herdr session `name` shows (its focused pane), for the
/// title over an in-app terminal attached to it.
#[tauri::command(async)]
fn herdr_focused(name: String) -> Option<String> {
    let out = cli("herdr").args(["--session", &name, "agent", "list"]).output().ok()?;
    let agents: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    cts_core::herdr::agent_states(&agents).into_iter().find(|a| a.focused).map(|a| a.session_id)
}

#[tauri::command]
async fn gh_prs() -> Result<PrLists, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(PrLists { review: search_prs("--review-requested")?, mine: my_prs()? }))
        .await
        .map_err(err)?
}

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
/// `{url, tab, behind}` for a link a page opens in a new window, which becomes a new tab.
const BROWSER_NEW_TAB_EVENT: &str = "browser-new-tab";
/// `{url}` for a page of the app's own (a PR from a notification), opened in its tab if it has one.
const OPEN_URL_EVENT: &str = "open-url";

#[derive(Clone, Serialize)]
struct OpenUrl {
    url: String,
}

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
    /// The tab whose page opened it, which it goes next to.
    tab: String,
    /// Opened behind (⌘-click), as a browser does.
    behind: bool,
}

/// Focuses the page's text box (see `focusInput` in browser_page.js).
const FOCUS_INPUT_SCRIPT: &str = "window.__todoSessionsFocusInput?.()";
/// How long after asking a page still gets its text box focused when it loads.
const FOCUS_INPUT_WITHIN: Duration = Duration::from_secs(15);
/// `{tab}` when a page asks for the address bar (⌘L).
const BROWSER_FOCUS_URL_EVENT: &str = "browser-focus-url";
/// When a page asks for a new tab (⌘T).
const BROWSER_OPEN_NEW_TAB_EVENT: &str = "browser-open-new-tab";
/// `{tab, delta}` (-1 or 1) when a page asks for the previous or next tab (⌘⇧[ ⌘⇧]).
const BROWSER_SWITCH_TAB_EVENT: &str = "browser-switch-tab";
/// When ⌘W in the app menu asks to close the shown tab.
const BROWSER_CLOSE_TAB_EVENT: &str = "browser-close-tab";
/// `{tab}` when a page's ⌃h hands the typing back to the app's side (the
/// main page already has the keyboard by then), or to the focus mode's left.
const FOCUS_APP_EVENT: &str = "focus-app";
/// `{tab}` when a page takes the keyboard in the focus mode (which side has it).
const PAGE_FOCUSED_EVENT: &str = "page-focused";
/// `{tab, text}` when a page's ⌃l asks for the focus mode's right side, with
/// the text selected in it (to paste there), if any.
const FOCUS_PANE_EVENT: &str = "focus-pane";
/// A page's keys whose action gives a page or terminal the keyboard
/// (switching and closing tabs, ⌃l to the Input mode's right), not the app,
/// and messages that leave the keyboard where it is (⌥-click keeping a link).
const KEYS_HANDED_ON: [&str; 5] = ["tab-prev", "tab-next", "close-tab", "focus-pane", "add-input"];
/// When a page's ⌘N asks for a new todo.
const OPEN_NEW_TODO_EVENT: &str = "open-new-todo";

/// `{host, user}` when a page sent a login not kept yet: asked whether to keep it.
const LOGIN_CAPTURED_EVENT: &str = "login-captured";

#[derive(Clone, Serialize)]
struct LoginAsk {
    host: String,
    user: String,
}

/// The login kept for `host`, read from the Keychain once a run.
fn kept_login(state: &AppState, host: &str) -> Option<logins::Login> {
    let mut cache = state.logins.lock().ok()?;
    cache.entry(host.to_string()).or_insert_with(|| logins::load(host)).clone()
}

/// The answer to LOGIN_CAPTURED_EVENT: keep the login the page sent, or let it go.
#[tauri::command(async)]
fn answer_login(state: State<'_, AppState>, keep: bool) -> Result<(), String> {
    let Some((host, login)) = state.pending_login.lock().map_err(err)?.take() else { return Ok(()) };
    if !keep {
        return Ok(());
    }
    logins::save(&host, &login)?;
    state.logins.lock().map_err(err)?.insert(host, Some(login));
    Ok(())
}

/// Takes the login kept for `host` out (the Keychain's item too).
#[tauri::command(async)]
fn forget_login(state: State<'_, AppState>, host: String) -> Result<(), String> {
    logins::delete(&host)?;
    state.logins.lock().map_err(err)?.insert(host, None);
    Ok(())
}

/// `{url, title}` when a link is ⌥-clicked in a page, to keep as an input todo.
const ADD_INPUT_EVENT: &str = "add-input";

#[derive(Clone, Serialize)]
struct InputLink {
    url: String,
    title: String,
}

#[derive(Clone, Serialize)]
struct TabDelta {
    tab: String,
    delta: i32,
}

#[derive(Clone, Serialize)]
struct TabText {
    tab: String,
    text: Option<String>,
}

/// How long an input added without a title waits for its page's.
const PAGE_TITLE_TIMEOUT: Duration = Duration::from_secs(5);

/// A page's own title (og:title, else <title>), for an input added without one.
#[tauri::command]
async fn page_title(url: String) -> Result<Option<String>, String> {
    if !is_web_url(&url) {
        return Err(format!("開けない URL です: {url}"));
    }
    tauri::async_runtime::spawn_blocking(move || cts_core::ogp::fetch_within(&url, PAGE_TITLE_TIMEOUT).map(|m| m.title))
        .await
        .map_err(err)?
}

/// When a page's Esc, in the focus mode, asks about leaving it.
const FOCUS_EXIT_EVENT: &str = "focus-exit";
/// Tells every page whether the focus mode is on (their Esc then asks about leaving).
fn focus_mode_script(on: bool) -> String {
    format!("window.__todoSessionsFocusMode = {on}")
}
/// When a page's ⌘K asks for the app's commands.
const OPEN_PALETTE_EVENT: &str = "open-palette";
/// When a page's ⌘⇧K asks for the list of sessions.
const OPEN_SESSIONS_EVENT: &str = "open-sessions";
/// `{tab}` when a cloud session's page asks to archive it (⌘⇧A).
const BROWSER_ARCHIVE_EVENT: &str = "browser-archive";
/// `{tab}` when a page asks to go into an input (⌘⇧D).
const BROWSER_TO_INPUT_EVENT: &str = "browser-to-input";

#[derive(Clone, Serialize)]
struct TabOnly {
    tab: String,
}

/// `{tab, zoom}` when a tab's zoom changes (1.0 is none).
const BROWSER_ZOOM_EVENT: &str = "browser-zoom";
/// The zooms ⌘= and ⌘- step through, as Chrome's.
const ZOOM_STEPS: [f64; 13] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
const NO_ZOOM: f64 = 1.0;

#[derive(Clone, Serialize)]
struct TabZoom {
    tab: String,
    zoom: f64,
}

/// The zoom after "in", "out" or "reset" from `zoom`.
fn next_zoom(zoom: f64, action: &str) -> Option<f64> {
    let (first, last) = (ZOOM_STEPS[0], ZOOM_STEPS[ZOOM_STEPS.len() - 1]);
    match action {
        "in" => Some(ZOOM_STEPS.into_iter().find(|&z| z > zoom).unwrap_or(last)),
        "out" => Some(ZOOM_STEPS.into_iter().rev().find(|&z| z < zoom).unwrap_or(first)),
        "reset" => Some(NO_ZOOM),
        _ => None,
    }
}

/// Zooms tab `tab` "in", "out" or "reset".
fn zoom_tab(app: &AppHandle, tab: &str, action: &str) -> Result<(), String> {
    let tab = tab_id(tab)?;
    let current = cef_browser::zoom(app, tab).ok_or("このタブは開いていません")?;
    let zoom = next_zoom(current, action).ok_or_else(|| format!("unknown zoom {action}"))?;
    cef_browser::set_zoom(app, tab, zoom)?;
    if let Some(host) = cef_browser::url(app, tab).as_deref().and_then(host_of) {
        let state = app.state::<AppState>();
        let mut zooms = state.zooms.lock().map_err(err)?;
        if (zoom - NO_ZOOM).abs() < f64::EPSILON {
            zooms.remove(&host);
        } else {
            zooms.insert(host, zoom);
        }
        save_kept(ZOOMS_FILE, &zooms);
    }
    app.emit(BROWSER_ZOOM_EVENT, TabZoom { tab: tab.to_string(), zoom }).map_err(err)
}

/// "in", "out" or "reset" the zoom of a tab.
#[tauri::command(async)]
fn browser_zoom(app: AppHandle, tab: String, action: String) -> Result<(), String> {
    zoom_tab(&app, &tab, &action)
}

/// How far below the main webview's top the page starts. The main webview
/// runs under the title bar and the page's viewport begins below it
/// (`viewport` is the page's innerHeight), while a tab is placed from the
/// window's top, so the page's coordinates are shifted by this.
fn page_top(app: &AppHandle, viewport: f64) -> f64 {
    let Some(main) = app.get_webview("main") else { return 0.0 };
    let scale = main.window().scale_factor().unwrap_or(1.0);
    main.bounds().map(|b| (b.size.to_logical::<f64>(scale).height - viewport).max(0.0)).unwrap_or(0.0)
}

/// Where a tab goes, from the placeholder's rectangle in the page.
fn browser_rect(app: &AppHandle, x: f64, y: f64, width: f64, height: f64, viewport: f64) -> cef_browser::PageRect {
    cef_browser::PageRect { x, y: y + page_top(app, viewport), width, height }
}

/// A tab's id; tab ids come from the page, so only plain ones pass.
fn tab_id(tab: &str) -> Result<&str, String> {
    if tab.is_empty() || !tab.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("bad tab id {tab:?}"));
    }
    Ok(tab)
}

/// What a page asked of the app: one of browser_page.js's `todo-sessions://` URLs,
/// which carry this run's token (`todo-sessions://<action>/<token>?...`); one
/// without it comes from the page's own scripts and is dropped.
fn page_message(app: &AppHandle, tab: &str, url: &tauri::Url) {
    if url.path().trim_start_matches('/') != cef_browser::page_token() {
        return;
    }
    // A login the page sent: asked about (by host and user only) unless it is the one kept.
    if url.host_str() == Some("login-captured") {
        let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned()).unwrap_or_default();
        let host = cef_browser::url(app, tab).and_then(|u| u.parse::<tauri::Url>().ok()).and_then(|u| u.host_str().map(String::from));
        if let Some(host) = host {
            let login = logins::Login { user: param("u"), password: param("p") };
            let state = app.state::<AppState>();
            if !login.user.is_empty() && !login.password.is_empty() && kept_login(&state, &host).as_ref() != Some(&login) {
                let user = login.user.clone();
                if let Ok(mut pending) = state.pending_login.lock() {
                    *pending = Some((host.clone(), login));
                }
                let _ = app.emit(LOGIN_CAPTURED_EVENT, LoginAsk { host, user });
            }
        }
        return;
    }
    // The page keeps the keyboard for these too.
    if let Some(action) = url.host_str().and_then(|h| h.strip_prefix("zoom-")) {
        if let Err(e) = zoom_tab(app, tab, action) {
            eprintln!("zoom: {e}");
        }
        return;
    }
    // Only telling: the page keeps the keyboard.
    if url.host_str() == Some("page-focused") {
        let _ = app.emit(PAGE_FOCUSED_EVENT, TabOnly { tab: tab.to_string() });
        return;
    }
    // Keys typed next belong in the app (its address bar, a dialog),
    // but for the ones handing the keyboard on to a page or terminal
    // themselves: passing through the app would mark its side for a moment.
    let hands_on = matches!(url.host_str(), Some(h) if KEYS_HANDED_ON.contains(&h));
    if let Some(main) = app.get_webview("main").filter(|_| !hands_on) {
        let _ = main.set_focus();
    }
    let tab = tab.to_string();
    let _ = match url.host_str() {
        Some("new-tab") => app.emit(BROWSER_OPEN_NEW_TAB_EVENT, ()),
        Some("new-todo") => app.emit(OPEN_NEW_TODO_EVENT, ()),
        Some("tab-prev") => app.emit(BROWSER_SWITCH_TAB_EVENT, TabDelta { tab, delta: -1 }),
        Some("tab-next") => app.emit(BROWSER_SWITCH_TAB_EVENT, TabDelta { tab, delta: 1 }),
        Some("archive") => app.emit(BROWSER_ARCHIVE_EVENT, TabOnly { tab }),
        Some("to-input") => app.emit(BROWSER_TO_INPUT_EVENT, TabOnly { tab }),
        Some("palette") => app.emit(OPEN_PALETTE_EVENT, ()),
        Some("sessions") => app.emit(OPEN_SESSIONS_EVENT, ()),
        Some("focus-app") => app.emit(FOCUS_APP_EVENT, TabOnly { tab }),
        Some("focus-pane") => {
            let text = url.query_pairs().find(|(k, _)| k == "text").map(|(_, v)| v.into_owned());
            app.emit(FOCUS_PANE_EVENT, TabText { tab, text })
        }
        Some("focus-exit") => app.emit(FOCUS_EXIT_EVENT, ()),
        Some("close-tab") => app.emit(BROWSER_CLOSE_TAB_EVENT, TabOnly { tab }),
        Some("add-input") => {
            let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned()).unwrap_or_default();
            app.emit(ADD_INPUT_EVENT, InputLink { url: param("u"), title: param("t") })
        }
        _ => app.emit(BROWSER_FOCUS_URL_EVENT, TabOnly { tab }),
    };
}

/// What a page (or one of its frames) is given as it loads: the app's keys,
/// and whether the focus mode is on.
fn page_setup_scripts(app: &AppHandle) -> Vec<String> {
    let state = app.state::<AppState>();
    let mut scripts = Vec::new();
    if state.focus_mode.load(Ordering::Relaxed) {
        scripts.push(focus_mode_script(true));
    }
    if let Ok(keys) = state.page_keys.lock() {
        scripts.push(page_keys_script(&keys));
    }
    scripts
}

/// A tab's page began or finished loading.
fn tab_load(app: &AppHandle, tab: &str, url: String, loading: bool) {
    // The page begins without the keys and the focus mode, which are set by eval. At the
    // start of a load as well as its end: a page slow to finish (a session's, just opened)
    // would leave the app's keys (⌃h ⌃l) dead until then.
    let state = app.state::<AppState>();
    for script in page_setup_scripts(app) {
        let _ = cef_browser::eval(app, tab, &script);
    }
    // A page asked to take the typing (see `browser_focus`) once it has loaded.
    if !loading {
        keep_site_zoom(app, tab, &url);
        // A site with a kept login has it filled in (and sent) by the page's script.
        if let Some(host) = url.parse::<tauri::Url>().ok().and_then(|u| u.host_str().map(String::from)) {
            if let Some(login) = kept_login(&state, &host) {
                let args = serde_json::to_string(&(host, &login.user, &login.password)).unwrap_or_default();
                let _ = cef_browser::eval(app, tab, &format!("window.__todoSessionsFill?.(...{args})"));
            }
        }
        let asked = state.focus_input.lock().ok().and_then(|mut m| m.remove(tab));
        if asked.is_some_and(|at| at.elapsed() < FOCUS_INPUT_WITHIN) {
            let _ = cef_browser::eval(app, tab, FOCUS_INPUT_SCRIPT);
        }
    }
    let _ = app.emit(BROWSER_URL_EVENT, TabUrl { tab: tab.to_string(), url, loading });
}

/// A tab's page changed its title.
fn tab_title_changed(app: &AppHandle, tab: &str, title: String) {
    let _ = app.emit(BROWSER_TITLE_EVENT, TabTitle { tab: tab.to_string(), title });
}

/// A tab's address changed, with or without a load (history pushState).
fn tab_address_changed(app: &AppHandle, tab: &str, url: String) {
    let _ = app.emit(BROWSER_ADDRESS_EVENT, TabAddress { tab: tab.to_string(), url });
}

/// A page asks for a new window; true lets it open as one. A sized window is
/// a popup (sign-in pages rely on those); a plain "open in new window" link
/// becomes a tab instead, next to `tab`, `behind` it for a ⌘-click.
fn tab_new_window(app: &AppHandle, tab: &str, url: String, sized: bool, behind: bool) -> bool {
    if !sized {
        let _ = app.emit(BROWSER_NEW_TAB_EVENT, NewTab { url, tab: tab.to_string(), behind });
    }
    sized
}

/// Kept across restarts, beside the database: the sites' zooms and their answers about the microphone and camera.
const ZOOMS_FILE: &str = "zooms.json";
const SITE_PERMISSIONS_FILE: &str = "site-permissions.json";

fn kept_path(file: &str) -> PathBuf {
    db_path().parent().map(|d| d.join(file)).unwrap_or_else(|| PathBuf::from(file))
}

/// A kept map (none yet, or unreadable: empty, said once).
fn load_kept<V: serde::de::DeserializeOwned>(file: &str) -> HashMap<String, V> {
    let path = kept_path(file);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            eprintln!("{}: {e}", path.display());
            HashMap::new()
        }),
        Err(_) => HashMap::new(),
    }
}

fn save_kept<V: Serialize>(file: &str, map: &HashMap<String, V>) {
    let path = kept_path(file);
    if let Err(e) = serde_json::to_vec_pretty(map).map_err(err).and_then(|b| std::fs::write(&path, b).map_err(err)) {
        eprintln!("{}: {e}", path.display());
    }
}

fn host_of(url: &str) -> Option<String> {
    url.parse::<tauri::Url>().ok().and_then(|u| u.host_str().map(String::from))
}

/// A site's page takes the zoom kept for the site (Chromium keeps zoom per
/// site while it runs, not across restarts).
fn keep_site_zoom(app: &AppHandle, tab: &str, url: &str) {
    let Some(host) = host_of(url) else { return };
    let kept = app.state::<AppState>().zooms.lock().ok().and_then(|z| z.get(&host).copied()).unwrap_or(NO_ZOOM);
    if cef_browser::zoom(app, tab).is_some_and(|now| (now - kept).abs() > f64::EPSILON) && cef_browser::set_zoom(app, tab, kept).is_ok() {
        let _ = app.emit(BROWSER_ZOOM_EVENT, TabZoom { tab: tab.to_string(), zoom: kept });
    }
}

/// Where a download goes: the Downloads folder, under a name not taken there.
fn download_path(name: &str) -> PathBuf {
    let dir = home().join("Downloads");
    // A name from the page: only its last part, so it stays in the folder.
    let name = std::path::Path::new(name).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "download".into());
    dir.join(cts_core::files::unique_name(&name, |n| dir.join(n).exists()))
}

/// `{path, name}` when a page's download has finished.
const BROWSER_DOWNLOADED_EVENT: &str = "browser-downloaded";

#[derive(Clone, Serialize)]
struct Downloaded {
    path: String,
    name: String,
}

fn download_finished(app: &AppHandle, path: String) {
    let name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let _ = app.emit(BROWSER_DOWNLOADED_EVENT, Downloaded { path, name });
}

/// Shows a downloaded file in the Finder.
#[tauri::command(async)]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let status = cli("open").args(["-R", &path]).status().map_err(err)?;
    status.success().then_some(()).ok_or_else(|| format!("open -R failed: {status}"))
}

/// `{id, tab, kind, message, default}` when a page shows an alert, confirm or prompt.
const PAGE_DIALOG_EVENT: &str = "page-dialog";

#[derive(Clone, Serialize)]
struct PageDialog {
    id: u64,
    tab: String,
    kind: &'static str,
    message: String,
    default: String,
}

fn page_dialog(app: &AppHandle, tab: &str, id: u64, kind: &'static str, message: String, default: String) {
    let _ = app.emit(PAGE_DIALOG_EVENT, PageDialog { id, tab: tab.to_string(), kind, message, default });
}

/// The user's answer to a page's dialog: OK (with what was typed for a prompt) or cancel.
#[tauri::command(async)]
fn answer_page_dialog(app: AppHandle, id: u64, ok: bool, text: Option<String>) -> Result<(), String> {
    cef_browser::answer_dialog(&app, id, ok, text)
}

/// `{id, site, camera}` when a site asks for the microphone (or the camera) and was not answered before.
const SITE_PERMISSION_EVENT: &str = "site-permission";
/// Chromium's bit for the camera in what a site asks for.
const VIDEO_CAPTURE: u32 = 2;

#[derive(Clone, Serialize)]
struct SitePermissionAsk {
    id: u64,
    site: String,
    camera: bool,
}

/// The answer kept for a site's ask for the microphone or camera.
fn site_permission(app: &AppHandle, site: &str) -> Option<bool> {
    app.state::<AppState>().site_permissions.lock().ok()?.get(site).copied()
}

fn ask_site_permission(app: &AppHandle, id: u64, site: String, asked: u32) {
    let _ = app.emit(SITE_PERMISSION_EVENT, SitePermissionAsk { id, site, camera: asked & VIDEO_CAPTURE != 0 });
}

/// The user's answer to SITE_PERMISSION_EVENT, kept for the site.
#[tauri::command(async)]
fn answer_site_permission(app: AppHandle, state: State<'_, AppState>, id: u64, site: String, allow: bool) -> Result<(), String> {
    let mut kept = state.site_permissions.lock().map_err(err)?;
    kept.insert(site, allow);
    save_kept(SITE_PERMISSIONS_FILE, &kept);
    drop(kept);
    cef_browser::answer_media(&app, id, allow)
}

/// The sites' kept answers about the microphone and camera, for the settings.
#[tauri::command(async)]
fn site_permissions(state: State<'_, AppState>) -> Result<HashMap<String, bool>, String> {
    Ok(state.site_permissions.lock().map_err(err)?.clone())
}

/// Takes a site's kept answer out: it is asked again next time.
#[tauri::command(async)]
fn forget_site_permission(state: State<'_, AppState>, site: String) -> Result<(), String> {
    let mut kept = state.site_permissions.lock().map_err(err)?;
    kept.remove(&site);
    save_kept(SITE_PERMISSIONS_FILE, &kept);
    Ok(())
}

/// Shows tab `tab` with `url` in the browser pane: a Chromium view laid over
/// the main window at the given rectangle (logical pixels), created on first
/// use, with the other tabs hidden behind it (but `keep`, shown beside it in
/// the focus mode). An open tab goes to `url` only with `go`. GitHub refuses
/// to be framed, so the pane cannot be an iframe.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn browser_open(state: State<'_, AppState>, app: AppHandle, tab: String, url: String, x: f64, y: f64, width: f64, height: f64, viewport: f64, go: bool, keep: Option<String>) -> Result<(), String> {
    if !is_web_url(&url) {
        return Err(format!("開けない URL です: {url}"));
    }
    let tab = tab_id(&tab)?.to_string();
    let parsed: tauri::Url = url.parse().map_err(err)?;
    // Two opens of a new tab at once (a re-render) would both create it.
    let _one_at_a_time = state.browser_lock.lock().map_err(err)?;
    let keep = keep.map(|k| tab_id(&k).map(String::from)).transpose()?;
    let shown: Vec<String> = std::iter::once(tab.clone()).chain(keep).collect();
    cef_browser::set_hidden(&app, None, &shown, true)?;
    let rect = browser_rect(&app, x, y, width, height, viewport);
    if cef_browser::exists(&app, &tab) {
        // Showing the tab again keeps the page the user moved on to; only
        // `go` (the app sending it somewhere) moves it.
        if go && cef_browser::url(&app, &tab).and_then(|u| u.parse::<tauri::Url>().ok()).as_ref() != Some(&parsed) {
            cef_browser::navigate(&app, &tab, parsed.as_str())?;
        }
        cef_browser::set_rect(&app, &tab, rect)?;
        return cef_browser::set_hidden(&app, Some(&tab), &[], false);
    }
    cef_browser::create(&app, &tab, parsed.as_str(), rect)
}

/// Follows tab `tab`'s placeholder when the layout changes.
#[tauri::command(async)]
fn browser_bounds(app: AppHandle, tab: String, x: f64, y: f64, width: f64, height: f64, viewport: f64) -> Result<(), String> {
    let tab = tab_id(&tab)?;
    if !cef_browser::exists(&app, tab) {
        return Ok(());
    }
    cef_browser::set_rect(&app, tab, browser_rect(&app, x, y, width, height, viewport))
}

/// Hides tab `tab`, or every tab; they keep their pages for the next open.
#[tauri::command(async)]
fn browser_hide(app: AppHandle, tab: Option<String>) -> Result<(), String> {
    let only = tab.as_deref().map(tab_id).transpose()?;
    cef_browser::set_hidden(&app, only, &[], true)
}

#[tauri::command(async)]
fn browser_close(app: AppHandle, tab: String) -> Result<(), String> {
    cef_browser::close(&app, tab_id(&tab)?)
}

/// Gives a tab's page the keyboard, as leaving the address bar with Esc does;
/// with `input`, its text box too (ChatGPT's prompt), now or once it loads,
/// and `text` typed into it.
#[tauri::command(async)]
fn browser_focus(app: AppHandle, state: State<AppState>, tab: String, input: Option<bool>, text: Option<String>) -> Result<(), String> {
    let id = tab_id(&tab)?;
    if !cef_browser::exists(&app, id) {
        return Ok(());
    }
    cef_browser::focus(&app, id)?;
    if input == Some(true) {
        state.focus_input.lock().map_err(err)?.insert(tab.clone(), std::time::Instant::now());
        match text {
            Some(text) => cef_browser::eval(&app, id, &format!("window.__todoSessionsFocusInput?.({})", serde_json::to_string(&text).map_err(err)?)),
            None => cef_browser::eval(&app, id, FOCUS_INPUT_SCRIPT),
        }?;
    }
    Ok(())
}

/// A tab's address right now, which a page moving without a load (history
/// pushState) changes without any event.
#[tauri::command(async)]
fn browser_url(app: AppHandle, tab: String) -> Result<Option<String>, String> {
    Ok(cef_browser::url(&app, tab_id(&tab)?))
}

/// "back", "forward" or "reload" in a tab.
#[tauri::command(async)]
fn browser_go(app: AppHandle, tab: String, action: String) -> Result<(), String> {
    cef_browser::go(&app, tab_id(&tab)?, &action)
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
/// The todos each issue / PR URL belongs to, with whether it is their PR.
fn todos_by_url(todos: &[Todo]) -> HashMap<String, Vec<(i64, bool)>> {
    let mut by_url: HashMap<String, Vec<(i64, bool)>> = HashMap::new();
    for t in todos {
        if let Some(u) = t.issue_url.clone().filter(|u| u.contains("/issues/")) {
            by_url.entry(u).or_default().push((t.id, false));
        }
        if let Some(u) = t.pr_url.clone() {
            by_url.entry(u).or_default().push((t.id, true));
        }
    }
    by_url
}

/// The issue to close as the todo's PR merges: its own, unless known to be
/// closed or closed already in this sync (`closed`, for todos sharing it).
fn issue_to_close<'a>(todo: &'a Todo, closed: &HashSet<String>) -> Option<&'a str> {
    todo.issue_url
        .as_deref()
        .filter(|u| u.contains("/issues/") && todo.issue_state.as_deref() != Some("closed") && !closed.contains(*u))
}

fn refresh_states(db: &Db, todos: &[Todo]) {
    let by_url = todos_by_url(todos);
    // Issues closed in this sync: a todo sharing one only records it.
    let mut closed: HashSet<String> = HashSet::new();
    let urls: Vec<String> = by_url.keys().cloned().collect();
    for chunk in urls.chunks(cts_core::github::BATCH_SIZE) {
        let query = cts_core::github::status_query(chunk);
        let Ok(json) = gh(&["api", "graphql", "-f", &format!("query={query}")]) else { continue };
        let Ok(resp) = serde_json::from_str::<serde_json::Value>(&json) else { continue };
        for cts_core::github::ItemStatus { url, state: now, ci } in cts_core::github::parse_statuses(&resp, chunk) {
            for &(id, is_pr) in by_url.get(&url).into_iter().flatten() {
                let Some(todo) = todos.iter().find(|t| t.id == id) else { continue };
                if is_pr {
                    if let Err(e) = db.set_ci(id, ci.as_ref()) {
                        eprintln!("{e}");
                    }
                }
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
                        if let Some(issue) = issue_to_close(todo, &closed) {
                            if gh(&["issue", "close", issue, "--comment", &format!("{url} のマージで完了しました。")]).is_ok() {
                                closed.insert(issue.to_string());
                                let _ = db.set_issue_state(todo.id, "closed");
                            }
                        } else if todo.issue_url.as_ref().is_some_and(|u| closed.contains(u)) {
                            let _ = db.set_issue_state(todo.id, "closed");
                        }
                    }
                }
            }
        }
    }
}

/// The PR a review session reviews: the one the app recorded, else the one its
/// first prompt names (Claude's `/review <url>`, Codex's `PR <url> をレビュー…`).
fn review_pr(s: &cts_core::Session) -> Option<String> {
    if let Some(url) = &s.review_url {
        return Some(url.clone());
    }
    let title = s.title.as_deref()?;
    let rest = title.strip_prefix("/review ").or_else(|| title.strip_prefix("PR ").filter(|r| r.contains("をレビュー")))?;
    let url = rest.split_whitespace().next()?;
    (url.starts_with("https://github.com/") && url.contains("/pull/")).then(|| url.to_string())
}

/// `secs` since the epoch as GitHub writes times (UTC, ISO 8601).
fn iso_utc(secs: i64) -> String {
    // Days to a civil date (Howard Hinnant's algorithm).
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// The user's GitHub login, asked once a run.
fn github_login() -> Option<String> {
    static LOGIN: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    LOGIN.get_or_init(|| gh(&["api", "user", "--jq", ".login"]).ok().filter(|l| !l.is_empty())).clone()
}

/// Tells the page a review went in: `{url, title, verdict}` (APPROVED,
/// CHANGES_REQUESTED or COMMENTED).
const REVIEW_SUBMITTED_EVENT: &str = "review-submitted";

#[derive(Clone, Serialize)]
struct ReviewSubmitted {
    url: String,
    title: String,
    verdict: String,
}

/// Review sessions whose work is over (the user's review is in, or the PR is
/// merged or closed) and whose turn has ended, or that ended: put away
/// (`put_review_away`), the page told of a review that went in. One that
/// stopped without it stays, for あなた待ち.
fn clean_reviews(app: &AppHandle, db: &Db) {
    let Some(me) = github_login() else { return };
    let Ok(sessions) = db.unlinked_sessions() else { return };
    for s in sessions.iter().filter(|s| matches!(s.state, SessionState::Idle | SessionState::Ended) && !s.hidden) {
        let Some(url) = review_pr(s) else { continue };
        let Ok(json) = gh(&["pr", "view", &url, "--json", "state,reviews"]) else { continue };
        let Ok(view) = serde_json::from_str::<serde_json::Value>(&json) else { continue };
        let Some(outcome) = cts_core::github::review_outcome(&view, &me, &iso_utc(s.started_at)) else { continue };
        if let Err(e) = put_review_away(db, &s.session_id) {
            eprintln!("{e}");
            continue;
        }
        if let cts_core::github::ReviewOutcome::Submitted(verdict) = outcome {
            let title = s.title.clone().unwrap_or_default();
            let _ = app.emit(REVIEW_SUBMITTED_EVENT, ReviewSubmitted { url, title, verdict });
        }
    }
}

/// One GitHub sync: all todos, or just `only`.
fn sync_github(app: &AppHandle, db: &Db, only: Option<i64>) {
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
    if only.is_none() {
        clean_reviews(app, db);
    }
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
            Ok(Some(id)) => sync_github(&app, &db, Some(id)),
            Ok(None) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                sync_github(&app, &db, None);
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
    if let Some(w) = app.get_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The app menu, as macOS's default one but without Close Window, whose ⌘W
/// would take the key before the page: closing a tab is the app's shortcut.
fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::Submenu;
    let sep = || PredefinedMenuItem::separator(app);
    let name = Submenu::with_items(app, "Todo Sessions", true, &[
        &PredefinedMenuItem::about(app, None, None)?,
        &sep()?,
        &PredefinedMenuItem::hide(app, None)?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::show_all(app, None)?,
        &sep()?,
        &PredefinedMenuItem::quit(app, None)?,
    ])?;
    let file = Submenu::with_items(app, "ファイル", true, &[
        // Its key is the user's (keymap.ts), taken by the page, so the item has none.
        &MenuItem::with_id(app, MENU_CLOSE_TAB, "タブを閉じる", true, None::<&str>)?,
    ])?;
    let edit = Submenu::with_items(app, "編集", true, &[
        &PredefinedMenuItem::undo(app, None)?,
        &PredefinedMenuItem::redo(app, None)?,
        &sep()?,
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
        &PredefinedMenuItem::select_all(app, None)?,
    ])?;
    let window = Submenu::with_items(app, "ウインドウ", true, &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?])?;
    Menu::with_items(app, &[&name, &file, &edit, &window])
}

/// Linked sessions waiting for input or idle, as the menu bar lists them.
fn tray_menu(app: &AppHandle, sessions: &[Session]) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Todo Sessions を開く", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "終了", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = vec![Box::new(open), Box::new(sep)];
    if sessions.is_empty() {
        items.push(Box::new(MenuItem::with_id(app, "none", "返事待ち・ひと区切りのセッションはありません", false, None::<&str>)?));
    }
    for s in sessions {
        let state = if s.state == SessionState::NeedsInput { "返事待ち" } else { "ひと区切り" };
        let label = format!("{state}: {}", s.title.as_deref().unwrap_or(&s.session_id));
        let id = format!("{MENU_SESSION_PREFIX}{}", s.session_id);
        items.push(Box::new(MenuItem::with_id(app, id, label, true, None::<&str>)?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(quit));
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter().map(|i| i.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Records that the session waits for a reply, posts it, and opens the
/// session when it is clicked. The thread lives until the notification is
/// clicked or removed from Notification Center.
fn notify_needs_input(app: &AppHandle, db: &Db, session: Session) {
    let id = db.add_notification(&session, NoticeKind::NeedsInput).map_err(|e| eprintln!("{e}")).ok();
    let label = session.title.clone().unwrap_or_else(|| session.session_id.clone());
    post_banner(app, "返事待ち", label, id, move |app| open_from_outside(app, &session.session_id));
}

/// Posts a macOS notification; clicking it reads notice `id` and runs `open`.
fn post_banner(app: &AppHandle, headline: &'static str, label: String, id: Option<i64>, open: impl FnOnce(&AppHandle) -> Result<(), String> + Send + 'static) {
    // The focus mode holds them; the in-app list has them, and the page tells of them after.
    if app.state::<AppState>().focus_mode.load(Ordering::Relaxed) {
        return;
    }
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
                app.emit(OPEN_URL_EVENT, OpenUrl { url }).map_err(err)
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
            for cts_core::herdr::AgentState { session_id: id, agent, cwd, state, unseen, .. } in cts_core::herdr::agent_states(&agents) {
                let known = db.get_session(&id).map_err(err)?;
                let unread = known.as_ref().is_some_and(|k| k.unread);
                let new = known.is_none();
                if known.as_ref().is_none_or(|k| k.state != state) {
                    let cwd = known.map(|k| k.cwd).filter(|c| !c.is_empty()).unwrap_or(cwd);
                    db.record_session(&id, &cwd, state).map_err(err)?;
                }
                // Codex has no hooks: its rollout's first prompt names it and links it ([todo:N]).
                if agent == cts_core::Agent::Codex {
                    if new {
                        db.set_session_agent(&id, agent).map_err(err)?;
                    }
                    if !db.marker_checked(&id).map_err(err)? {
                        let rollout = cts_core::codex::rollout_path(&home().join(cts_core::codex::SESSIONS_DIR), &id);
                        if let Some(prompt) = rollout.and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| cts_core::codex::first_prompt(&t)) {
                            db.name_from_prompt(&id, &prompt).map_err(err)?;
                            // A review Codex runs is known by its prompt (it picks its own session id).
                            if let Some((url, auto)) = launch::review_of_prompt(&prompt) {
                                db.record_review_session(&id, &url, auto).map_err(err)?;
                            }
                            db.mark_marker_checked(&id).map_err(err)?;
                        }
                    }
                }
                // herdr knows when its pane was looked at: "idle", not "done".
                if unread && state == SessionState::Idle && !unseen {
                    db.mark_session_seen(&id, now).map_err(err)?;
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
        if tick % STUDY_EVERY_TICKS == 0 {
            if let Err(e) = feynman::notify_study_due(&app, &db) {
                eprintln!("{e}");
            }
        }
        tick = tick.wrapping_add(1);
        if let Ok(mut waiting) = db.needs_input_sessions() {
            // Sessions archived in Claude Desktop stay out of the inbox and notifications.
            let archived = records.archived_cli_ids(&desktop_dir);
            if let Ok(mut shared) = app.state::<AppState>().archived.lock() {
                shared.clone_from(&archived);
            }
            waiting.retain(|s| !archived.contains(&s.session_id));
            let now: HashSet<String> = waiting.iter().map(|s| s.session_id.clone()).collect();
            // What each session asks, read once as it starts waiting (the lists show it).
            for s in waiting.iter().filter(|s| !known.contains(&s.session_id)) {
                if let Err(e) = db.set_session_question(&s.session_id, session_question(s).as_deref()) {
                    eprintln!("{e}");
                }
            }
            // Sessions already waiting at startup were notified by an earlier run, or never will be.
            if !first {
                for s in waiting.iter().filter(|s| !known.contains(&s.session_id)) {
                    notify_needs_input(&app, &db, s.clone());
                }
            }
            // A linked session that stops running has finished its turn: it is
            // marked 新着 (not notified), and it often just opened a PR.
            if let Ok(linked) = db.linked_sessions() {
                for s in linked.iter().filter(|s| !archived.contains(&s.session_id)) {
                    let before = last_state.insert(s.session_id.clone(), s.state);
                    if !first && before == Some(SessionState::Running) && s.state == SessionState::Idle {
                        // Look for the PR now.
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

/// Set in what a Claude Code session runs, with the variables below.
const CLAUDE_SESSION_MARK: &str = "CLAUDECODE";
const CLAUDE_SESSION_PREFIX: &str = "CLAUDE_CODE_";
const CLAUDE_SESSION_VARS: [&str; 2] = ["CLAUDE_PID", "CLAUDE_EFFORT"];

/// The variables of the Claude Code session the app was opened from (`open`
/// in its shell, as the swap command run there does). A `claude` the app
/// starts with them takes itself for that session's child, and its
/// transcript is not where the app looks for it (a note is never found).
fn inherited_session_vars(names: &[String]) -> Vec<String> {
    if !names.iter().any(|n| n == CLAUDE_SESSION_MARK) {
        return Vec::new();
    }
    names
        .iter()
        .filter(|n| *n == CLAUDE_SESSION_MARK || n.starts_with(CLAUDE_SESSION_PREFIX) || CLAUDE_SESSION_VARS.contains(&n.as_str()))
        .cloned()
        .collect()
}

fn main() {
    // Before any thread starts, so the programs the app runs are as when it is opened from the Dock.
    let names: Vec<String> = std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).collect();
    for name in inherited_session_vars(&names) {
        std::env::remove_var(name);
    }
    let db = open_db().expect("open database");
    let (github_tx, github_rx) = std::sync::mpsc::channel();
    let (cloud_tx, cloud_rx) = std::sync::mpsc::channel();
    // The in-app browser (Chromium) starts before Tauri makes the NSApplication.
    if !cef_browser::init() {
        eprintln!("cef: not started (the browser pane needs the .app made by scripts/bundle-cef.sh)");
    }
    tauri::Builder::default()
        .manage(terminal::Terminals::default())
        .manage(AppState {
            db: Mutex::new(db),
            sync_status: Mutex::new("cloud: 同期待ち".into()),
            origin_cache: Mutex::new(HashMap::new()),
            loop_enabled: AtomicBool::new(true),
            herdr_session: Mutex::new(None),
            in_app_terminal: AtomicBool::new(false),
            focus_input: Mutex::new(HashMap::new()),
            focus_mode: AtomicBool::new(false),
            logins: Mutex::new(HashMap::new()),
            pending_login: Mutex::new(None),
            page_keys: Mutex::new("{}".into()),
            archived: Mutex::new(HashSet::new()),
            zooms: Mutex::new(load_kept(ZOOMS_FILE)),
            site_permissions: Mutex::new(load_kept(SITE_PERMISSIONS_FILE)),
            browser_lock: Mutex::new(()),
            github_wake: Mutex::new(github_tx),
            cloud_wake: Mutex::new(cloud_tx),
        })
        .setup(|app| {
            cef_browser::start_pump(app.handle());
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
        .menu(app_menu)
        .on_menu_event(|app, event| {
            if event.id() == MENU_CLOSE_TAB {
                let _ = app.emit(BROWSER_CLOSE_TAB_EVENT, TabOnly { tab: String::new() });
            }
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            // A cue for the page to look again at who has the typing (see `window_focused`).
            WindowEvent::Focused(_) => {
                let _ = window.emit(WINDOW_FOCUS_EVENT, ());
            }
            _ => {}
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
            fix_in_session,
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
            window_focused,
            set_focus_mode,
            set_page_keys,
            start_review,
            stop_review,
            terminal_quick,
            terminal_resume,
            set_in_app_terminal,
            start_note,
            note_url,
            create_input,
            update_input,
            delete_input,
            add_input_link,
            remove_input_link,
            page_title,
            mark_session_seen,
            hide_session,
            answer_login,
            forget_login,
            reveal_in_finder,
            answer_page_dialog,
            answer_site_permission,
            site_permissions,
            forget_site_permission,
            herdr_focused,
            codex_models,
            feynman::browser_text,
            feynman::page_text,
            feynman::feynman_state,
            feynman::feynman_make_points,
            feynman::feynman_grade,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            terminal::term_focus,
            terminal::ghostty_config,
            terminal::user_font,
            terminal::ghostty_keybinds,
            set_herdr_session,
            browser_go,
            browser_zoom
        ])
        .build(tauri::generate_context!())
        .expect("build tauri app")
        .run(|app, event| {
            match event {
                tauri::RunEvent::Exit => cef_browser::shutdown(app),
                // The Dock icon brings back the window a close hid.
                tauri::RunEvent::Reopen { .. } => show_window(app),
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zooms_by_chromes_steps() {
        assert_eq!(next_zoom(1.0, "in"), Some(1.1));
        assert_eq!(next_zoom(1.0, "out"), Some(0.9));
        assert_eq!(next_zoom(1.25, "reset"), Some(1.0));
        assert_eq!(next_zoom(3.0, "in"), Some(3.0), "stays at the largest");
        assert_eq!(next_zoom(0.5, "out"), Some(0.5), "stays at the smallest");
        assert_eq!(next_zoom(1.05, "in"), Some(1.1), "off a step: the next one up");
        assert_eq!(next_zoom(1.05, "out"), Some(1.0), "off a step: the next one down");
        assert_eq!(next_zoom(1.0, "sideways"), None);
    }

    #[test]
    fn a_review_session_names_its_pr_by_record_or_title() {
        let session = |title: Option<&str>, url: Option<&str>| cts_core::Session {
            session_id: "s".into(), title: title.map(Into::into), todo_id: None, cwd: "/".into(), state: SessionState::Idle, state_at: 0,
            repos: vec![], branch: None, started_at: 0, unread: false, agent: cts_core::Agent::Claude, review_url: url.map(Into::into), hidden: false,
        };
        let pr = "https://github.com/o/r/pull/12";
        assert_eq!(review_pr(&session(Some("レビュー: x"), Some(pr))).as_deref(), Some(pr));
        assert_eq!(review_pr(&session(Some(&format!("/review {pr} レビューは日本語で")), None)).as_deref(), Some(pr));
        assert_eq!(review_pr(&session(Some(&format!("PR {pr} をレビューしてください。")), None)).as_deref(), Some(pr));
        assert_eq!(review_pr(&session(Some(&format!("{pr} を見て")), None)), None, "not a review");
        assert_eq!(review_pr(&session(None, None)), None);
    }

    #[test]
    fn writes_times_as_github_does() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_791_159_530), "2026-10-05T00:18:50Z");
    }

    #[test]
    fn an_issue_shared_by_todos_is_closed_once() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let issue = "https://github.com/o/r/issues/2";
        for title in ["a", "b"] {
            db.create_todo(NewTodo { title: title.into(), issue_url: Some(issue.into()), ..Default::default() }).unwrap();
        }
        let todos = db.list_todos(None).unwrap();
        let mut closed = HashSet::new();
        assert_eq!(issue_to_close(&todos[0], &closed), Some(issue));
        closed.insert(issue.to_string());
        assert_eq!(issue_to_close(&todos[1], &closed), None, "closed already in this sync");
        let done = db.set_issue_state(todos[1].id, "closed").map(|_| db.get_todo(todos[1].id).unwrap().unwrap()).unwrap();
        assert_eq!(issue_to_close(&done, &HashSet::new()), None, "known to be closed");
    }

    #[test]
    fn every_todo_with_the_same_url_is_synced() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let pr = "https://github.com/o/r/pull/1";
        let issue = "https://github.com/o/r/issues/2";
        let mut ids = Vec::new();
        for title in ["a", "b"] {
            let t = db.create_todo(NewTodo { title: title.into(), issue_url: Some(issue.into()), ..Default::default() }).unwrap();
            db.update_todo(t.id, TodoPatch { pr_url: Some(pr.into()), ..Default::default() }).unwrap();
            ids.push(t.id);
        }
        let todos = db.list_todos(None).unwrap();
        let by_url = todos_by_url(&todos);
        let mut got = by_url[pr].clone();
        got.sort();
        assert_eq!(got, ids.iter().map(|&id| (id, true)).collect::<Vec<_>>(), "both todos have the PR");
        let mut got = by_url[issue].clone();
        got.sort();
        assert_eq!(got, ids.iter().map(|&id| (id, false)).collect::<Vec<_>>(), "both todos have the issue");
        assert_eq!(by_url.len(), 2, "each URL is asked about once");
    }

    #[test]
    fn drops_the_variables_of_the_claude_code_session_it_was_opened_from() {
        let names = ["PATH", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "CLAUDE_EFFORT", "HOME"].map(String::from);
        assert_eq!(inherited_session_vars(&names), ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "CLAUDE_EFFORT"]);
    }

    #[test]
    fn keeps_claude_code_settings_when_not_opened_from_a_session() {
        let names = ["PATH", "CLAUDE_CODE_USE_BEDROCK"].map(String::from);
        assert!(inherited_session_vars(&names).is_empty());
    }
}
