//! The in-app terminal pane: commands run in a pseudo-terminal here and the
//! page draws them with xterm.js (`app/src/Terminal.tsx`). An experiment
//! next to herdr in Ghostty; to drop it, remove this module, its commands in
//! `main.rs` and `Terminal.tsx`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// `{id, data}` (base64 of what the program wrote) as output arrives.
const OUTPUT_EVENT: &str = "term-output";
/// `{id}` when the program has exited.
const EXIT_EVENT: &str = "term-exit";
/// Read size for the program's output.
const READ_CHUNK: usize = 16 * 1024;
/// Used when $SHELL is not set.
const FALLBACK_SHELL: &str = "/bin/zsh";
/// herdr marks its panes with these, and refuses to start inside one.
const HERDR_ENV_PREFIX: &str = "HERDR_";

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals(Mutex<HashMap<String, Term>>);

#[derive(Clone, Serialize)]
struct Output {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: String,
}

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}

/// Starts `command` in a login shell at `cwd`, sized `cols` × `rows`, as
/// terminal `id`. Its output arrives as `term-output` events.
#[tauri::command(async)]
pub fn term_open(app: AppHandle, terms: State<'_, Terminals>, id: String, command: String, cwd: String, cols: u16, rows: u16) -> Result<(), String> {
    let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(err)?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| FALLBACK_SHELL.into());
    let mut cmd = CommandBuilder::new(shell);
    // An interactive login shell, so PATH and the rest match the user's terminal.
    cmd.args(["-l", "-i", "-c", &command]);
    cmd.cwd(cwd);
    // Not a herdr pane, even when the app was started from one.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with(HERDR_ENV_PREFIX) {
            cmd.env_remove(key);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    terms.0.lock().map_err(err)?.insert(id.clone(), Term { master: pair.master, writer, child });
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app.emit(OUTPUT_EVENT, Output { id: id.clone(), data });
                }
            }
        }
        let _ = app.emit(EXIT_EVENT, Exit { id });
    });
    Ok(())
}

/// Sends typed text (and control sequences) to terminal `id`.
#[tauri::command(async)]
pub fn term_write(terms: State<'_, Terminals>, id: String, data: String) -> Result<(), String> {
    let mut terms = terms.0.lock().map_err(err)?;
    let term = terms.get_mut(&id).ok_or("この端末はもう閉じています")?;
    term.writer.write_all(data.as_bytes()).map_err(err)?;
    term.writer.flush().map_err(err)
}

#[tauri::command(async)]
pub fn term_resize(terms: State<'_, Terminals>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    match terms.0.lock().map_err(err)?.get(&id) {
        Some(term) => term.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(err),
        None => Ok(()),
    }
}

/// Ends the program in terminal `id` and forgets it.
#[tauri::command(async)]
pub fn term_close(terms: State<'_, Terminals>, id: String) -> Result<(), String> {
    if let Some(mut term) = terms.0.lock().map_err(err)?.remove(&id) {
        let _ = term.child.kill();
    }
    Ok(())
}
