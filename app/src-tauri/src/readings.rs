// Readings (読みもの): kept from the pages (⌘⇧D, a link ⌥-clicked, X's
// bookmark button, an O'Reilly book's page with its table of contents),
// filled in with what their pages say, and sorted into tags with TypeSafe's
// Jev (cts_core::tags) once an API key is kept in the Keychain. With the same
// key, posts on X's home timeline not about engineering fold away.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use cts_core::{JevCredit, JevSpend, JevTally, NewReading, Reading, ReadingKind};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{cef_browser, err, logins, AppState};

const KEY_SERVICE: &str = "shosai-typesafe";
const KEY_ACCOUNT: &str = "api-key";
const PAGE_META_TIMEOUT: Duration = Duration::from_secs(8);
/// `{title, kind, chapters}` once a page's reading is kept, for the page to say so.
const READING_ADDED_EVENT: &str = "reading-added";

/// The sorting into tags: one run at a time, and why the last one stopped.
pub struct Sorting {
    running: AtomicBool,
    has_key: AtomicBool,
    error: Mutex<Option<String>>,
}

impl Sorting {
    pub fn load() -> Sorting {
        Sorting { running: AtomicBool::new(false), has_key: AtomicBool::new(api_key().is_some()), error: Mutex::new(None) }
    }
}

/// How the sorting stands, for the 学習 page.
#[derive(Serialize)]
pub struct SortingView {
    has_key: bool,
    error: Option<String>,
    tags: Vec<&'static str>,
}

pub fn view(sorting: &Sorting) -> Result<SortingView, String> {
    Ok(SortingView {
        has_key: sorting.has_key.load(Ordering::Relaxed),
        error: sorting.error.lock().map_err(err)?.clone(),
        tags: cts_core::tags::TAGS.iter().map(|(tag, _)| *tag).collect(),
    })
}

/// What the requests to Jev took today, this month and all along, with what
/// that cost, and the credit left when it was read off TypeSafe's console.
#[derive(Serialize)]
pub struct SpendView {
    today: JevTally,
    month: JevTally,
    all: JevTally,
    today_usd: f64,
    month_usd: f64,
    all_usd: f64,
    credit: Option<CreditView>,
}

/// The credit as read off the console, what this app has spent since, and what is left.
#[derive(Serialize)]
pub struct CreditView {
    #[serde(flatten)]
    read: JevCredit,
    since_usd: f64,
    left: f64,
}

pub fn spend_view(spend: JevSpend, credit: Option<JevCredit>) -> SpendView {
    let usd = |t: &JevTally| cts_core::tags::cost_usd(t.input_tokens);
    let credit = credit.map(|c| CreditView { since_usd: cts_core::tags::cost_usd((spend.all.input_tokens - c.base_input_tokens).max(0)), left: c.left(spend.all.input_tokens), read: c });
    SpendView { today_usd: usd(&spend.today), month_usd: usd(&spend.month), all_usd: usd(&spend.all), today: spend.today, month: spend.month, all: spend.all, credit }
}

fn api_key() -> Option<String> {
    logins::load_secret(KEY_SERVICE, KEY_ACCOUNT).filter(|k| !k.is_empty())
}

#[derive(Clone, Serialize)]
struct Added<'a> {
    reading: &'a Reading,
    /// Kept to read in 学習 right away (⌘⇧S).
    study: bool,
}

/// Keeps a reading, fills in what its page says and sorts it, behind;
/// `study` has 学習 open it to read.
pub fn add(app: &AppHandle, r: NewReading, study: bool) -> Result<Reading, String> {
    if !crate::is_web_url(&r.url) {
        return Err(format!("開けない URL です: {}", r.url));
    }
    let reading = app.state::<AppState>().db.lock().map_err(err)?.add_reading(&r).map_err(err)?;
    let _ = app.emit(READING_ADDED_EVENT, Added { reading: &reading, study });
    let (app, id, url, kind) = (app.clone(), reading.id, reading.url.clone(), reading.kind);
    std::thread::spawn(move || {
        // A post's text came with it; a book's page is behind a login.
        if kind == ReadingKind::Article {
            match cts_core::ogp::fetch_within(&url, PAGE_META_TIMEOUT) {
                Ok(meta) => {
                    if let Err(e) = app.state::<AppState>().db.lock().map_err(err).and_then(|db| db.fill_reading(id, meta.description.as_deref(), meta.image.as_deref()).map_err(err)) {
                        eprintln!("reading {id}: {e}");
                    }
                }
                Err(e) => eprintln!("reading {id}: {url}: {e}"),
            }
        }
        sort_all(&app);
    });
    Ok(reading)
}

/// What Jev reads of a reading: its text, or a book's chapters.
fn sort_text(r: &Reading) -> Option<String> {
    let chapters = r.chapters.iter().map(|c| c.title.as_str()).collect::<Vec<_>>().join("\n");
    match (&r.text, chapters.is_empty()) {
        (Some(text), true) => Some(text.clone()),
        (Some(text), false) => Some(format!("{text}\n\n目次:\n{chapters}")),
        (None, false) => Some(format!("目次:\n{chapters}")),
        (None, true) => None,
    }
}

/// Sorts every reading not sorted yet into tags, the oldest first; without
/// a key there is nothing to do, and a failure stops the run (the next keep
/// or key tries again).
pub fn sort_all(app: &AppHandle) {
    let sorting = app.state::<Sorting>();
    if sorting.running.swap(true, Ordering::AcqRel) {
        return;
    }
    let result = (|| -> Result<(), String> {
        // Tags changed (one some reading has is gone): all of them are sorted again.
        let known: Vec<&str> = cts_core::tags::TAGS.iter().map(|(tag, _)| *tag).collect();
        app.state::<AppState>().db.lock().map_err(err)?.unsort_readings_if_tags_gone(&known).map_err(err)?;
        let Some(key) = api_key() else { return Ok(()) };
        let unsorted = app.state::<AppState>().db.lock().map_err(err)?.unsorted_readings().map_err(err)?;
        for r in unsorted {
            let (tags, usage) = cts_core::tags::sort(&key, &r.title, &r.url, sort_text(&r).as_deref())?;
            let state = app.state::<AppState>();
            let db = state.db.lock().map_err(err)?;
            db.add_jev_usage(&usage).map_err(err)?;
            db.set_reading_tags(r.id, &tags).map_err(err)?;
        }
        Ok(())
    })();
    if let Err(e) = &result {
        eprintln!("sorting readings: {e}");
    }
    if let Ok(mut error) = sorting.error.lock() {
        *error = result.err();
    }
    sorting.running.store(false, Ordering::Release);
}

#[tauri::command(async)]
pub fn add_reading(app: AppHandle, reading: NewReading) -> Result<Reading, String> {
    add(&app, reading, false)
}

#[tauri::command(async)]
pub fn delete_reading(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.delete_reading(id).map_err(err)
}

/// The tags put right by hand, from TAGS only.
#[tauri::command(async)]
pub fn set_reading_tags(state: State<AppState>, id: i64, tags: Vec<String>) -> Result<(), String> {
    if let Some(unknown) = tags.iter().find(|t| !cts_core::tags::TAGS.iter().any(|(tag, _)| tag == t)) {
        return Err(format!("ないタグです: {unknown}"));
    }
    state.db.lock().map_err(err)?.set_reading_tags(id, &tags).map_err(err)
}

/// Keeps a reading read (a good one), or puts it back to read.
#[tauri::command(async)]
pub fn set_reading_kept(state: State<AppState>, id: i64, kept: bool) -> Result<(), String> {
    state.db.lock().map_err(err)?.set_reading_kept(id, kept).map_err(err)
}

#[tauri::command(async)]
pub fn set_chapter_read(state: State<AppState>, reading_id: i64, position: i64, read: bool) -> Result<(), String> {
    state.db.lock().map_err(err)?.set_chapter_read(reading_id, position, read).map_err(err)
}

/// How likely each post seen on X's timeline (by its id) is about
/// engineering, as Jev said, for as long as the app runs.
#[derive(Default)]
pub struct PostVerdicts(Mutex<HashMap<String, f64>>);

/// A post on X's home timeline (`id`, its text) asked about: how likely it is
/// about engineering goes back to the page, which folds it away when unlikely.
/// With no key, or Jev failing, the page gets null and leaves it shown.
pub fn on_post(app: &AppHandle, tab: &str, id: String, text: String) {
    let (app, tab) = (app.clone(), tab.to_string());
    std::thread::spawn(move || {
        let probability = match post_verdict(&app, &id, &text) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("x post {id}: {e}");
                None
            }
        };
        let args = serde_json::to_string(&(id, probability)).unwrap_or_default();
        if let Err(e) = cef_browser::eval(&app, &tab, &format!("window.__todoSessionsPostVerdict?.(...{args})")) {
            eprintln!("x post verdict: {e}");
        }
    });
}

fn post_verdict(app: &AppHandle, id: &str, text: &str) -> Result<Option<f64>, String> {
    let verdicts = app.state::<PostVerdicts>();
    if let Some(p) = verdicts.0.lock().map_err(err)?.get(id) {
        return Ok(Some(*p));
    }
    let Some(key) = api_key() else { return Ok(None) };
    let (p, usage) = cts_core::tags::engineering(&key, text)?;
    app.state::<AppState>().db.lock().map_err(err)?.add_jev_usage(&usage).map_err(err)?;
    verdicts.0.lock().map_err(err)?.insert(id.to_string(), p);
    Ok(Some(p))
}

/// Keeps Jev's credit as just read off TypeSafe's console: the credit, and the Spend.
#[tauri::command(async)]
pub fn set_jev_credit(state: State<AppState>, credit: f64, spent: f64) -> Result<(), String> {
    if !(credit >= 0.0 && spent >= 0.0) {
        return Err("クレジットと Spend はドルの額（0 以上の数）で入れてください".into());
    }
    state.db.lock().map_err(err)?.set_jev_credit(credit, spent).map(|_| ()).map_err(err)
}

#[tauri::command(async)]
pub fn clear_jev_credit(state: State<AppState>) -> Result<(), String> {
    state.db.lock().map_err(err)?.clear_jev_credit().map_err(err)
}

/// Keeps the TypeSafe API key (a blank one takes it out), then sorts what waits.
#[tauri::command(async)]
pub fn set_typesafe_key(app: AppHandle, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        logins::delete_secret(KEY_SERVICE, KEY_ACCOUNT)?;
    } else {
        logins::save_secret(KEY_SERVICE, KEY_ACCOUNT, key)?;
    }
    app.state::<Sorting>().has_key.store(!key.is_empty(), Ordering::Relaxed);
    std::thread::spawn(move || sort_all(&app));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(text: Option<&str>, chapters: &[&str]) -> Reading {
        Reading {
            id: 1,
            kind: ReadingKind::Book,
            url: "https://example.com/".into(),
            title: "t".into(),
            text: text.map(Into::into),
            image: None,
            tags: None,
            chapters: chapters.iter().enumerate().map(|(i, t)| cts_core::Chapter { position: i as i64 + 1, title: t.to_string(), url: String::new(), read: false }).collect(),
            created_at: 0,
            kept: false,
            links: vec![],
        }
    }

    #[test]
    fn a_book_is_sorted_by_its_chapters_too() {
        assert_eq!(sort_text(&reading(Some("説明"), &[])).as_deref(), Some("説明"));
        assert_eq!(sort_text(&reading(Some("説明"), &["Replication", "Partitioning"])).as_deref(), Some("説明\n\n目次:\nReplication\nPartitioning"));
        assert_eq!(sort_text(&reading(None, &["Replication"])).as_deref(), Some("目次:\nReplication"));
        assert_eq!(sort_text(&reading(None, &[])), None);
    }
}
