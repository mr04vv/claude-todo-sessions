// The day's readings summed up, its 日報 (cts_core::digest): every morning,
// what was kept the day before (articles, posts on X, books) and the pages
// they are or link to, read in full, go to Claude (with the Claude Docs
// connector), which writes a document of them in claude.ai; its link is kept
// with the day, and among the artifacts.
use std::sync::Mutex;
use std::time::Duration;

use cts_core::{digest, ogp, ArtifactKind, Digest, NewArtifact, Reading, ReadingKind};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{err, AppState};

/// From this local hour, the day before is summed up.
const DIGEST_HOUR: i64 = 6;
/// How often the loop looks whether a day is due.
const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);
/// How long a linked page may take to read.
const PAGE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long Claude may take to read it all and write the document.
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// The day being summed up, if one is.
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

/// Sums up `day`'s readings (the local date) into a document, and keeps what came
/// of it: the document's link, or why it was not made. One day at a time.
fn make(app: &AppHandle, day: &str) -> Result<(), String> {
    let digesting = app.state::<Digesting>();
    {
        let mut running = digesting.0.lock().map_err(err)?;
        if let Some(other) = running.as_ref() {
            return Err(format!("{other} の分をまとめています"));
        }
        *running = Some(day.to_string());
    }
    let made = write(app, day);
    if let Ok(mut running) = digesting.0.lock() {
        *running = None;
    }
    let state = app.state::<AppState>();
    let db = state.db.lock().map_err(err)?;
    match &made {
        Ok(url) => db.set_digest(day, Ok(url)),
        Err(why) => db.set_digest(day, Err(why)),
    }
    .map_err(err)?;
    made.map(|_| ())
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

/// Reads the day's readings' pages and has Claude write the document; its link.
fn write(app: &AppHandle, day: &str) -> Result<String, String> {
    let readings = app.state::<AppState>().db.lock().map_err(err)?.readings_on(day).map_err(err)?;
    let items: Vec<digest::Item> = readings.iter().map(|r| digest::Item { reading: r, pages: pages_of(r).into_iter().map(|u| ogp::page(u, PAGE_TIMEOUT)).collect() }).collect();
    let said = crate::ask::claude_docs(&digest::prompt(day, &items), CLAUDE_TIMEOUT)?;
    let url = digest::doc_url(&said).ok_or_else(|| format!("ドキュメントの URL が分かりませんでした：{}", said.chars().take(300).collect::<String>()))?;
    let artifact = NewArtifact { url: url.clone(), title: Some(format!("読みものの日報 {day}")), kind: ArtifactKind::Doc, session_id: None, todo_id: None };
    app.state::<AppState>().db.lock().map_err(err)?.add_artifact(artifact).map_err(err)?;
    Ok(url)
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
