mod hook;
mod mcp;

use std::io::Write;
use std::path::PathBuf;

const DB_ENV: &str = "CTS_DB";
const DATA_DIR: &str = "Library/Application Support/claude-todo-sessions";
const DB_FILE: &str = "db.sqlite";
const LOG_FILE: &str = "cts.log";
const USAGE: &str = "usage: cts mcp | cts hook <session-start|user-prompt-submit|notification|post-tool-use|stop|session-end>";

fn data_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join(DATA_DIR)
}

pub fn db_path() -> PathBuf {
    std::env::var_os(DB_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir().join(DB_FILE))
}

pub fn open_db() -> Result<cts_core::Db, String> {
    let path = db_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    cts_core::Db::open(&path).map_err(|e| e.to_string())
}

/// Hooks must not write diagnostics to stdout (it becomes model context),
/// so errors go to stderr and a log file next to the DB.
fn report_error(msg: &str) {
    eprintln!("cts: {msg}");
    let log = db_path().with_file_name(LOG_FILE);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
        let _ = writeln!(f, "{msg}");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["mcp"] => mcp::run(),
        ["hook", event] => hook::run(event),
        _ => Err(USAGE.into()),
    };
    if let Err(e) = result {
        report_error(&e);
        // Exit 1 is a non-blocking hook error: the session continues.
        std::process::exit(1);
    }
}
