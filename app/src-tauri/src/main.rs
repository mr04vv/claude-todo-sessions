#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use cts_core::{launch, Db, NewTodo, Session, SessionState, Status, Todo, TodoPatch};
use serde::{Deserialize, Serialize};
use tauri::State;

const DB_ENV: &str = "CTS_DB";
const DATA_DIR: &str = "Library/Application Support/claude-todo-sessions";
const DB_FILE: &str = "db.sqlite";
const DESKTOP_SESSIONS_DIR: &str = "Library/Application Support/Claude/claude-code-sessions";
const CLOUD_SYNC_INTERVAL: Duration = Duration::from_secs(30);

struct AppState {
    db: Mutex<Db>,
    /// Result of the last cloud sync, shown in the header.
    sync_status: Mutex<String>,
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
}

#[derive(Serialize)]
struct Board {
    todos: Vec<TodoView>,
    inbox: Vec<Session>,
    sync_status: String,
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
    let db = state.db.lock().map_err(err)?;
    let todos = db
        .list_todos(None)
        .map_err(err)?
        .into_iter()
        .map(|todo| Ok(TodoView { sessions: db.sessions_for_todo(todo.id).map_err(err)?, todo }))
        .collect::<Result<_, String>>()?;
    let inbox = db
        .unlinked_sessions()
        .map_err(err)?
        .into_iter()
        .filter(|s| s.state != SessionState::Ended)
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

fn git_origin(cwd: &str) -> Option<String> {
    let out = Command::new("git").args(["-C", cwd, "remote", "get-url", "origin"]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
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
        .manage(AppState { db: Mutex::new(db), sync_status: Mutex::new("cloud: 同期待ち".into()) })
        .setup(|app| {
            use tauri::Manager;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                sync_loop(|msg| {
                    if let Ok(mut s) = handle.state::<AppState>().sync_status.lock() {
                        *s = msg;
                    }
                })
            });
            Ok(())
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
            start_cloud
        ])
        .run(tauri::generate_context!())
        .expect("run tauri app");
}
