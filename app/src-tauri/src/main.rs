#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use cts_core::{launch, Db, NewTodo, Session, SessionState, Status, Todo, TodoPatch};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State, WindowEvent};
use mac_notification_sys::{Notification, NotificationResponse};

const DB_ENV: &str = "CTS_DB";
const DATA_DIR: &str = "Library/Application Support/claude-todo-sessions";
const DB_FILE: &str = "db.sqlite";
const DESKTOP_SESSIONS_DIR: &str = "Library/Application Support/Claude/claude-code-sessions";
const CLOUD_SYNC_INTERVAL: Duration = Duration::from_secs(30);
/// How often the tray menu and notifications look at the DB.
const WATCH_INTERVAL: Duration = Duration::from_secs(3);
const TRAY_ID: &str = "main";
const MENU_OPEN: &str = "open";
const MENU_QUIT: &str = "quit";
const MENU_SESSION_PREFIX: &str = "session:";
const GH_ISSUE_LIMIT: &str = "100";
/// Must match `identifier` in tauri.conf.json; notifications are posted as this app.
const APP_ID: &str = "dev.mr04vv.todo-sessions";

struct AppState {
    db: Mutex<Db>,
    /// Result of the last cloud sync, shown in the header.
    sync_status: Mutex<String>,
    /// `owner/repo` per working directory, from `git remote get-url origin`.
    origin_cache: Mutex<HashMap<String, Option<String>>>,
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

#[derive(Serialize)]
struct TodoView {
    #[serde(flatten)]
    todo: Todo,
    sessions: Vec<Session>,
    /// `owner/repo` the todo belongs to, for grouping.
    repo: Option<String>,
}

#[derive(Serialize)]
struct SessionView {
    #[serde(flatten)]
    session: Session,
    repo: Option<String>,
}

#[derive(Serialize)]
struct Board {
    todos: Vec<TodoView>,
    inbox: Vec<SessionView>,
    sync_status: String,
}

fn git_origin(cwd: &str) -> Option<String> {
    let out = Command::new("git").args(["-C", cwd, "remote", "get-url", "origin"]).output().ok()?;
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

fn repo_of_todo(state: &AppState, todo: &Todo) -> Option<String> {
    todo.issue_url
        .as_deref()
        .and_then(launch::repo_key)
        .or_else(|| todo.cwd.as_deref().and_then(|c| repo_of_cwd(state, c)))
}

#[derive(Deserialize)]
struct TodoInput {
    title: String,
    issue_url: Option<String>,
    cwd: Option<String>,
    memo: Option<String>,
}

#[derive(Deserialize)]
struct TodoUpdate {
    title: Option<String>,
    status: Option<Status>,
    memo: Option<String>,
    cwd: Option<String>,
    issue_url: Option<String>,
}

#[tauri::command]
fn board(state: State<AppState>) -> Result<Board, String> {
    let (todos, inbox) = {
        let db = state.db.lock().map_err(err)?;
        let todos = db
            .list_todos(None)
            .map_err(err)?
            .into_iter()
            .map(|todo| Ok((db.sessions_for_todo(todo.id).map_err(err)?, todo)))
            .collect::<Result<Vec<_>, String>>()?;
        let inbox: Vec<Session> = db
            .unlinked_sessions()
            .map_err(err)?
            .into_iter()
            .filter(|s| s.state != SessionState::Ended)
            .collect();
        (todos, inbox)
    };
    // Repo lookup may run git, so the DB lock is released first.
    let todos = todos
        .into_iter()
        .map(|(sessions, todo)| TodoView { repo: repo_of_todo(&state, &todo), sessions, todo })
        .collect();
    let inbox = inbox
        .into_iter()
        .map(|session| SessionView { repo: repo_of_cwd(&state, &session.cwd), session })
        .collect();
    let sync_status = state.sync_status.lock().map_err(err)?.clone();
    Ok(Board { todos, inbox, sync_status })
}

#[tauri::command]
fn create_todo(state: State<AppState>, input: TodoInput) -> Result<Todo, String> {
    let blank = |s: Option<String>| s.filter(|v| !v.trim().is_empty());
    let db = state.db.lock().map_err(err)?;
    db.create_todo(NewTodo {
        title: input.title,
        issue_url: blank(input.issue_url),
        cwd: blank(input.cwd),
        memo: blank(input.memo),
    })
    .map_err(err)
}

#[tauri::command]
fn update_todo(state: State<AppState>, id: i64, update: TodoUpdate) -> Result<Todo, String> {
    let patch = TodoPatch {
        title: update.title,
        status: update.status,
        memo: update.memo,
        cwd: update.cwd,
        issue_url: update.issue_url,
    };
    state.db.lock().map_err(err)?.update_todo(id, patch).map_err(err)
}

#[tauri::command]
fn delete_todo(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.delete_todo(id).map_err(err)
}

#[tauri::command]
fn link_session(state: State<AppState>, session_id: String, todo_id: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.link_session(&session_id, todo_id).map_err(err)
}

#[tauri::command]
fn unlink_session(state: State<AppState>, session_id: String) -> Result<(), String> {
    state.db.lock().map_err(err)?.unlink_session(&session_id).map_err(err)
}

fn open_url(url: &str) -> Result<(), String> {
    let status = Command::new("open").arg(url).status().map_err(err)?;
    status.success().then_some(()).ok_or_else(|| format!("open {url} failed: {status}"))
}

#[tauri::command]
fn open_session(session_id: String) -> Result<(), String> {
    let local = cts_core::desktop::find_local_id(&home().join(DESKTOP_SESSIONS_DIR), &session_id);
    open_url(&launch::jump_url(&session_id, local.as_deref()))
}

fn todo_or_err(db: &Db, id: i64) -> Result<Todo, String> {
    db.get_todo(id).map_err(err)?.ok_or_else(|| format!("todo {id} not found"))
}

fn require_cwd(todo: &Todo) -> Result<String, String> {
    todo.cwd.clone().ok_or_else(|| "作業フォルダ（cwd）を設定してください".into())
}

#[tauri::command]
fn start_desktop(state: State<AppState>, todo_id: i64) -> Result<(), String> {
    let todo = todo_or_err(&*state.db.lock().map_err(err)?, todo_id)?;
    let prompt = launch::start_prompt(todo.id, &todo.title);
    open_url(&launch::desktop_new_url(&require_cwd(&todo)?, &prompt))
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn herdr(args: &[&str]) -> Result<String, String> {
    let out = Command::new("herdr").args(args).output().map_err(|e| format!("herdr: {e}"))?;
    if !out.status.success() {
        return Err(format!("herdr {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into())
}

fn start_in_herdr(cwd: &str, label: &str, command: &str) -> Result<(), String> {
    let created = herdr(&["workspace", "create", "--cwd", cwd, "--label", label, "--focus"])?;
    let v: serde_json::Value = serde_json::from_str(&created).map_err(|e| format!("herdr output: {e}"))?;
    let pane = launch::herdr_pane_id(&v).ok_or("herdr output has no pane id")?;
    herdr(&["pane", "run", &pane, command]).map(|_| ())
}

// ponytail: Ghostty fallback is unverified; replace the flags if Ghostty rejects them.
fn start_in_ghostty(cwd: &str, command: &str) -> Result<(), String> {
    let status = Command::new("open")
        .args(["-na", "Ghostty", "--args", &format!("--working-directory={cwd}"), "-e", "sh", "-lc", command])
        .status()
        .map_err(err)?;
    status.success().then_some(()).ok_or_else(|| format!("Ghostty failed: {status}"))
}

#[tauri::command]
fn start_terminal(state: State<AppState>, todo_id: i64) -> Result<(), String> {
    let (todo, session_id) = {
        let db = state.db.lock().map_err(err)?;
        let todo = todo_or_err(&db, todo_id)?;
        let cwd = require_cwd(&todo)?;
        // Registered up front so the session is linked before it starts.
        let session_id = uuid::Uuid::new_v4().to_string();
        db.record_session(&session_id, &cwd, SessionState::Idle).map_err(err)?;
        db.set_session_title(&session_id, &todo.title).map_err(err)?;
        db.link_session(&session_id, todo.id).map_err(err)?;
        (todo, session_id)
    };
    let cwd = require_cwd(&todo)?;
    let command = format!(
        "claude --session-id {session_id} {}",
        shell_quote(&launch::start_prompt(todo.id, &todo.title))
    );
    start_in_herdr(&cwd, &todo.title, &command).or_else(|herdr_err| {
        start_in_ghostty(&cwd, &format!("cd {} && {command}", shell_quote(&cwd)))
            .map_err(|e| format!("{herdr_err} / {e}"))
    })
}

#[tauri::command]
fn start_cloud(state: State<AppState>, todo_id: i64) -> Result<(), String> {
    let db = state.db.lock().map_err(err)?;
    let todo = todo_or_err(&db, todo_id)?;
    let repo = todo
        .issue_url
        .as_deref()
        .and_then(launch::github_repo_url)
        .or_else(|| todo.cwd.as_deref().and_then(git_origin).as_deref().and_then(launch::github_repo_url))
        .ok_or("GitHub のリポジトリが分かりません。issue URL か、GitHub を origin に持つ cwd を設定してください")?;
    let id = cts_core::cloud::create_session(&db, todo.id, &repo, &todo.title)?;
    drop(db);
    open_url(&launch::jump_url(&id, None))
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
    let out = Command::new("ghq").arg("root").output().ok()?;
    out.status.success().then(|| PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
}

/// Open issues assigned to the user that are not todos yet.
#[tauri::command]
fn gh_issues(state: State<AppState>) -> Result<Vec<IssueView>, String> {
    let out = Command::new("gh")
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

#[tauri::command]
fn import_issues(state: State<AppState>, issues: Vec<IssueImport>) -> Result<usize, String> {
    let db = state.db.lock().map_err(err)?;
    for i in &issues {
        db.create_todo(NewTodo { title: i.title.clone(), issue_url: Some(i.url.clone()), cwd: i.cwd.clone(), memo: None })
            .map_err(err)?;
    }
    Ok(issues.len())
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn tray_menu(app: &AppHandle, waiting: &[Session]) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Todo Sessions を開く", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "終了", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = vec![Box::new(open), Box::new(sep)];
    if waiting.is_empty() {
        items.push(Box::new(MenuItem::with_id(app, "none", "入力待ちのセッションはありません", false, None::<&str>)?));
    }
    for s in waiting {
        let label = format!("入力待ち: {}", s.title.as_deref().unwrap_or(&s.session_id));
        let id = format!("{MENU_SESSION_PREFIX}{}", s.session_id);
        items.push(Box::new(MenuItem::with_id(app, id, label, true, None::<&str>)?));
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(quit));
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter().map(|i| i.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Posts a notification for a session waiting for input and opens the session
/// when the notification is clicked. The thread lives until the notification
/// is clicked or removed from Notification Center.
fn notify_waiting(session: Session) {
    std::thread::spawn(move || {
        let label = session.title.clone().unwrap_or_else(|| session.session_id.clone());
        let response = Notification::new()
            .title("入力待ち")
            .message(&label)
            .wait_for_click(true)
            .send();
        match response {
            Ok(NotificationResponse::Click) => {
                if let Err(e) = open_session(session.session_id) {
                    eprintln!("{e}");
                }
            }
            Ok(_) => {}
            Err(e) => eprintln!("notification: {e}"),
        }
    });
}

/// Keeps the tray menu current and notifies once per session that starts
/// waiting for input.
fn watch_loop(app: AppHandle) {
    let db = match open_db() {
        Ok(db) => db,
        Err(e) => return eprintln!("watch loop stopped: {e}"),
    };
    let mut known: HashSet<String> = HashSet::new();
    let mut first = true;
    loop {
        if let Ok(waiting) = db.linked_needs_input() {
            let now: HashSet<String> = waiting.iter().map(|s| s.session_id.clone()).collect();
            // Sessions already waiting at startup were notified by an earlier run, or never will be.
            if !first {
                for s in waiting.iter().filter(|s| !known.contains(&s.session_id)) {
                    notify_waiting(s.clone());
                }
            }
            if first || now != known {
                if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), tray_menu(&app, &waiting)) {
                    let _ = tray.set_menu(Some(menu));
                }
            }
            known = now;
            first = false;
        }
        std::thread::sleep(WATCH_INTERVAL);
    }
}

fn sync_loop(status: impl Fn(String)) {
    let db = match open_db() {
        Ok(db) => db,
        Err(e) => return status(format!("cloud sync 停止: {e}")),
    };
    loop {
        let msg = match cts_core::cloud::sync(&db) {
            Ok(r) if r.errors.is_empty() => format!("cloud: {} 件記録 / {} 件紐づけ", r.recorded, r.linked),
            Ok(r) => format!("cloud: {} 件失敗 ({})", r.errors.len(), r.errors.join("; ")),
            Err(e) => format!("cloud sync 失敗: {e}"),
        };
        status(msg);
        std::thread::sleep(CLOUD_SYNC_INTERVAL);
    }
}

fn main() {
    let db = open_db().expect("open database");
    tauri::Builder::default()
        .manage(AppState {
            db: Mutex::new(db),
            sync_status: Mutex::new("cloud: 同期待ち".into()),
            origin_cache: Mutex::new(HashMap::new()),
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
                        if let Err(e) = open_session(session_id.to_string()) {
                            eprintln!("{e}");
                        }
                    }
                })
                .build(app)?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                sync_loop(|msg| {
                    if let Ok(mut s) = handle.state::<AppState>().sync_status.lock() {
                        *s = msg;
                    }
                })
            });
            let handle = app.handle().clone();
            std::thread::spawn(move || watch_loop(handle));
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
            link_session,
            unlink_session,
            open_session,
            start_desktop,
            start_terminal,
            start_cloud,
            gh_issues,
            import_issues
        ])
        .run(tauri::generate_context!())
        .expect("run tauri app");
}
