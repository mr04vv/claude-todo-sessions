// The day's readings summed up, its 日報 (cts_core::digest): every morning,
// what was kept the day before (articles, posts on X, books) and the pages
// they are or link to, read in full, are written into a brief, and a Claude
// Code session (in herdr, as ちょっと Claude's) makes an HTML artifact of them
// in claude.ai. The artifact it publishes, found in its transcript as any
// session's (main.rs's keep_artifacts), is the day's digest.
use std::sync::Mutex;
use std::time::Duration;

use cts_core::{digest, ogp, Digest, Reading, ReadingKind};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{err, AppState};

/// From this local hour, the day before is summed up.
const DIGEST_HOUR: i64 = 6;
/// How often the loop looks whether a day is due.
const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);
/// How long a linked page may take to read.
const PAGE_TIMEOUT: Duration = Duration::from_secs(15);
/// Where the briefs go, beside the database.
const BRIEFS_DIR: &str = "digests";

/// The day whose brief is being made (its pages read), if one is; the session
/// making a page shows on the day's digest itself.
#[derive(Default)]
pub struct Digesting(Mutex<Option<String>>);

/// The days summed up (or not, and why), the newest first, and the one being summed up.
#[derive(Serialize)]
pub struct DigestView {
    digests: Vec<Digest>,
    running: Option<String>,
}

pub fn view(digesting: &Digesting, db: &cts_core::Db) -> Result<DigestView, String> {
    Ok(DigestView { digests: db.digests().map_err(err)?, running: digesting.0.lock().map_err(err)?.clone() })
}

/// Has `day`'s readings (the local date) summed up by a session, and keeps
/// which (or why none could start). One day at a time.
fn make(app: &AppHandle, day: &str) -> Result<(), String> {
    let digesting = app.state::<Digesting>();
    {
        let mut running = digesting.0.lock().map_err(err)?;
        if let Some(other) = running.as_ref() {
            return Err(format!("{other} の分をまとめています"));
        }
        *running = Some(day.to_string());
    }
    let started = start(app, day);
    if let Ok(mut running) = digesting.0.lock() {
        *running = None;
    }
    if let Err(why) = &started {
        app.state::<AppState>().db.lock().map_err(err)?.set_digest(day, Err(why)).map_err(err)?;
    }
    started
}

/// A reading's pages to read: an article's own, a post's links'; a book's
/// are behind a login (its description and contents go instead).
fn pages_of(r: &Reading) -> Vec<&str> {
    match r.kind {
        ReadingKind::Article => vec![r.url.as_str()],
        ReadingKind::Post => r.links.iter().map(String::as_str).collect(),
        ReadingKind::Book => vec![],
    }
}

/// Reads the day's readings' pages into a brief and starts the session that
/// makes the page of it (in herdr, else Ghostty), behind.
fn start(app: &AppHandle, day: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let readings = state.db.lock().map_err(err)?.readings_on(day).map_err(err)?;
    let items: Vec<digest::Item> = readings.iter().map(|r| digest::Item { reading: r, pages: pages_of(r).into_iter().map(|u| ogp::page(u, PAGE_TIMEOUT)).collect() }).collect();
    let dir = crate::db_path().parent().map(|p| p.join(BRIEFS_DIR)).ok_or("データのフォルダが分かりません")?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    let brief = dir.join(format!("{day}.md"));
    std::fs::write(&brief, digest::brief(day, &items)).map_err(err)?;
    let session = uuid::Uuid::new_v4().to_string();
    // At home, as ちょっと Claude (a folder of its own would be asked to be
    // trusted first), with the briefs' folder added for its file tools.
    let command = digest::session_command(&session, &dir.to_string_lossy(), &brief.to_string_lossy());
    let (cwd, title) = (crate::home().to_string_lossy().to_string(), format!("読みものの日報 {day}"));
    state.db.lock().map_err(err)?.register_session(&session, &cwd, &title, None).map_err(err)?;
    crate::start_in_herdr(&state, &cwd, &title, &command, false, false).or_else(|herdr| crate::start_in_ghostty(&cwd, &command).map_err(|e| format!("{herdr} / {e}")))?;
    let db = state.db.lock().map_err(err)?;
    db.start_digest(day, &session).map_err(err)
}

/// Every morning (from DIGEST_HOUR), the day before, once: a day that failed
/// is not tried again by itself (⌘K tries it again).
pub fn digest_loop(app: AppHandle) {
    loop {
        if let Err(e) = due(&app).and_then(|day| day.map_or(Ok(()), |day| make(&app, &day))) {
            eprintln!("digest: {e}");
        }
        std::thread::sleep(CHECK_EVERY);
    }
}

/// The day before, when it is time, it has readings and it is not summed up yet.
fn due(app: &AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().map_err(err)?;
    if db.local_hour().map_err(err)? < DIGEST_HOUR {
        return Ok(None);
    }
    let day = db.local_day(-1).map_err(err)?;
    let done = db.digest(&day).map_err(err)?.is_some();
    Ok((!done && !db.readings_on(&day).map_err(err)?.is_empty()).then_some(day))
}

/// ⌘K (or a day that failed, again): `day` (the local date, YYYY-MM-DD) summed up now, behind.
#[tauri::command(async)]
pub fn make_digest(app: AppHandle, day: String) -> Result<(), String> {
    if app.state::<AppState>().db.lock().map_err(err)?.readings_on(&day).map_err(err)?.is_empty() {
        return Err(format!("{day} に保存した読みものはありません"));
    }
    if let Some(other) = app.state::<Digesting>().0.lock().map_err(err)?.as_ref() {
        return Err(format!("{other} の分をまとめています"));
    }
    std::thread::spawn(move || {
        if let Err(e) = make(&app, &day) {
            eprintln!("digest {day}: {e}");
        }
    });
    Ok(())
}
