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
use tauri::{AppHandle, Emitter, Manager, State};

/// `{id, data}` (base64 of what the program wrote) as output arrives.
const OUTPUT_EVENT: &str = "term-output";
/// `{id}` when the program has exited.
const EXIT_EVENT: &str = "term-exit";
/// Read size for the program's output.
const READ_CHUNK: usize = 16 * 1024;
/// Used when $SHELL is not set.
const FALLBACK_SHELL: &str = "/bin/zsh";
const MAIN_WEBVIEW: &str = "main";
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

/// Ghostty's config, where the app keeps it and where XDG does; later wins.
const GHOSTTY_CONFIGS: &[&str] = &[".config/ghostty/config", "Library/Application Support/com.mitchellh.ghostty/config"];
/// Where Ghostty looks for a theme by name: the user's own, then its built-in ones.
const GHOSTTY_THEME_DIRS: &[&str] = &[".config/ghostty/themes", "Library/Application Support/com.mitchellh.ghostty/themes"];
const GHOSTTY_BUILTIN_THEMES: &str = "/Applications/Ghostty.app/Contents/Resources/ghostty/themes";

/// `key = value` lines of a Ghostty config, in order, quotes dropped.
fn parse_config(text: &str) -> Vec<(String, String)> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches('"').to_string()))
        .collect()
}

/// A theme set as `light:A,dark:B` gives B; the app is dark by default.
fn theme_name(value: &str) -> &str {
    value.split(',').map(str::trim).find_map(|p| p.strip_prefix("dark:")).unwrap_or(value).trim()
}

/// The user's Ghostty settings, the theme's first so the config's own
/// colors override it as in Ghostty. The page reads what it can use.
#[tauri::command(async)]
pub fn ghostty_config() -> Vec<(String, String)> {
    let home = std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let config: Vec<_> = GHOSTTY_CONFIGS.iter().filter_map(|p| std::fs::read_to_string(home.join(p)).ok()).flat_map(|t| parse_config(&t)).collect();
    let theme = config.iter().rev().find(|(k, _)| k == "theme").map(|(_, v)| theme_name(v).to_string());
    let theme_text = theme.and_then(|name| {
        let dirs = GHOSTTY_THEME_DIRS.iter().map(|d| home.join(d)).chain([std::path::PathBuf::from(GHOSTTY_BUILTIN_THEMES)]);
        dirs.map(|d| d.join(&name)).find_map(|p| std::fs::read_to_string(p).ok())
    });
    theme_text.map(|t| parse_config(&t)).unwrap_or_default().into_iter().chain(config.into_iter().filter(|(k, _)| k != "theme")).collect()
}

/// Fonts the user installed, which the page cannot use by name: WebKit
/// shows pages only the system's fonts, so these are handed over as files.
const USER_FONT_DIRS: &[&str] = &["Library/Fonts"];
const SHARED_FONT_DIR: &str = "/Library/Fonts";
const FONT_EXTENSIONS: &[&str] = &["woff2", "otf", "ttf"];

/// Whether `file` is the regular (or bold) face of `family`, going by the
/// usual `FamilyName-Style.ext` file names.
/// ponytail: by file name only; ask Core Text for the font's file if names vary.
fn is_font_file(file: &str, family: &str, bold: bool) -> bool {
    let Some((stem, ext)) = file.rsplit_once('.') else { return false };
    if !FONT_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
        return false;
    }
    let (name, style) = stem.split_once('-').unwrap_or((stem, "Regular"));
    let wanted = if bold { "bold" } else { "regular" };
    name.to_lowercase() == family.replace(' ', "").to_lowercase() && style.to_lowercase() == wanted
}

/// The file of an installed font, for the terminal to load as the page cannot.
#[tauri::command(async)]
pub fn user_font(family: String, bold: bool) -> Result<tauri::ipc::Response, String> {
    let home = std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let dirs = USER_FONT_DIRS.iter().map(|d| home.join(d)).chain([std::path::PathBuf::from(SHARED_FONT_DIR)]);
    let mut files: Vec<_> = dirs
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| is_font_file(&e.file_name().to_string_lossy(), &family, bold))
        .map(|e| e.path())
        .collect();
    // The smallest format first.
    files.sort_by_key(|p| FONT_EXTENSIONS.iter().position(|x| p.extension().is_some_and(|e| e.eq_ignore_ascii_case(x))));
    let path = files.first().ok_or_else(|| format!("{family} のファイルが見つかりません"))?;
    Ok(tauri::ipc::Response::new(std::fs::read(path).map_err(err)?))
}

const GHOSTTY_CLI: &str = "/Applications/Ghostty.app/Contents/MacOS/ghostty";

/// Ghostty's escapes in a keybind's text (`\x01`, `\n`, ...), as its
/// `+list-keybinds` prints them with the backslash doubled.
fn unescape(text: &str) -> String {
    let text = text.replace("\\\\", "\\");
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('x') => {
                let hex: String = chars.by_ref().take(2).collect();
                if let Some(b) = u8::from_str_radix(&hex, 16).ok().map(char::from) {
                    out.push(b);
                }
            }
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('e') => out.push('\x1b'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// The keybinds that type something (`text:`, `esc:`, `csi:`), as trigger
/// and what they send. Ones for other actions, global ones and sequences
/// are left to the app.
fn parse_keybinds(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|l| l.trim().strip_prefix("keybind = "))
        .filter_map(|b| {
            let (trigger, action) = ["=text:", "=esc:", "=csi:"].iter().find_map(|sep| b.split_once(sep).map(|(t, a)| (t, (*sep, a))))?;
            if trigger.contains(':') || trigger.contains('>') {
                return None;
            }
            let sent = match action {
                ("=text:", a) => unescape(a),
                ("=esc:", a) => format!("\x1b{a}"),
                (_, a) => format!("\x1b[{a}"),
            };
            Some((trigger.to_string(), sent))
        })
        .collect()
}

/// What Ghostty's keybinds type (its defaults and the user's), for the
/// terminal to send the same; none without Ghostty.
#[tauri::command(async)]
pub fn ghostty_keybinds() -> Vec<(String, String)> {
    match std::process::Command::new(GHOSTTY_CLI).arg("+list-keybinds").output() {
        Ok(out) => parse_keybinds(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => Vec::new(),
    }
}

/// Gives the app's own page the keyboard, which a browser tab may hold, so
/// the terminal is focused (and its cursor blinks).
#[tauri::command(async)]
pub fn term_focus(app: AppHandle) -> Result<(), String> {
    match app.get_webview(MAIN_WEBVIEW) {
        Some(view) => view.set_focus().map_err(err),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_key_values_skipping_comments_and_quotes() {
        let text = "# comment\nfont-family = \"Jetbrains Mono\"\n\nfont-size = 14\npalette = 0=#4d4d4d\nbad line\n";
        assert_eq!(
            parse_config(text),
            vec![
                ("font-family".to_string(), "Jetbrains Mono".to_string()),
                ("font-size".to_string(), "14".to_string()),
                ("palette".to_string(), "0=#4d4d4d".to_string()),
            ]
        );
    }

    #[test]
    fn matches_font_files_by_family_and_weight() {
        assert!(is_font_file("JetBrainsMono-Regular.ttf", "Jetbrains Mono", false));
        assert!(is_font_file("JetBrainsMono-Bold.woff2", "JetBrains Mono", true));
        assert!(is_font_file("NotoColorEmoji.ttf", "Noto Color Emoji", false));
        assert!(!is_font_file("JetBrainsMono-Bold.ttf", "JetBrains Mono", false));
        assert!(!is_font_file("JetBrainsMonoNL-Regular.ttf", "JetBrains Mono", false));
        assert!(!is_font_file("JetBrainsMono-Regular.txt", "JetBrains Mono", false));
    }

    #[test]
    fn reads_the_keybinds_that_type_text() {
        let out = "keybind = super+arrow_left=text:\\\\x01\nkeybind = shift+enter=text:\\\\n\nkeybind = alt+arrow_right=esc:f\nkeybind = ctrl+up=csi:1;5A\nkeybind = super+c=copy_to_clipboard:mixed\nkeybind = global:super+x=text:a\nkeybind = ctrl+a>n=text:b\n";
        assert_eq!(
            parse_keybinds(out),
            vec![
                ("super+arrow_left".to_string(), "\x01".to_string()),
                ("shift+enter".to_string(), "\n".to_string()),
                ("alt+arrow_right".to_string(), "\x1bf".to_string()),
                ("ctrl+up".to_string(), "\x1b[1;5A".to_string()),
            ]
        );
    }

    #[test]
    fn picks_the_dark_theme_of_a_pair() {
        assert_eq!(theme_name("Desert"), "Desert");
        assert_eq!(theme_name("light:Builtin Light,dark:Desert"), "Desert");
        assert_eq!(theme_name("dark:Desert, light:X"), "Desert");
    }
}
