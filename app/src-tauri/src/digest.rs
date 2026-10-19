// Readings summed up, a 日報 (cts_core::digest): every morning, what was kept
// the day before; or, from 学習's list, the readings picked by hand, with a
// podcast of them if asked for. The readings (articles, posts on X, books) and
// the pages they are or link to, read in full, are written into a brief, and a
// Claude Code session (in herdr, as ちょっと Claude's) makes an HTML artifact
// of them in claude.ai. The artifact it publishes, found in its transcript as
// any session's (main.rs's keep_artifacts), is the digest. A podcast comes
// first: its script written by Claude (`claude -p`), read aloud by Gemini
// (cts_core::tts), made an MP3 by ffmpeg, which the session publishes beside
// the page and plays on it.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use cts_core::{digest, launch, ogp, tts, Digest, PickedDigest, Reading, ReadingKind};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{err, logins, AppState};

/// From this local hour, the day before is summed up.
const DIGEST_HOUR: i64 = 6;
/// How often the loop looks whether a day is due.
const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);
/// How long a linked page may take to read.
const PAGE_TIMEOUT: Duration = Duration::from_secs(15);
/// Where the briefs (and podcasts) go, beside the database.
const BRIEFS_DIR: &str = "digests";
/// What the session may do without asking: read its brief, write the page,
/// read the artifact skill and publish.
const SESSION_TOOLS: &str = "Read,Write,Skill,ToolSearch,Artifact";
/// How long Claude may take over a podcast's script (much to read).
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long ffmpeg may take to make the MP3.
const MP3_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// The MP3's bit rate: enough for one voice, small enough to publish.
const MP3_BITRATE: &str = "64k";
/// The Gemini API key's Keychain item (for the podcasts' voice).
const GEMINI_SERVICE: &str = "shosai-gemini";
const GEMINI_ACCOUNT: &str = "api-key";
const NO_GEMINI_KEY: &str = "ポッドキャストには Gemini の API キーが要ります（設定の「学習」で入れてください）";
/// What a picked digest is doing first.
const READING_PAGES: &str = "ページを読んでいます";

/// The day whose brief is being made (its pages read), if one is; the session
/// making a page shows on the day's digest itself. And whether a Gemini API
/// key is kept.
#[derive(Default)]
pub struct Digesting {
    day: Mutex<Option<String>>,
    has_key: AtomicBool,
}

/// The days summed up (or not, and why), the newest first, the one being
/// summed up, the digests of readings picked by hand, and whether podcasts
/// can be made (a Gemini API key is kept).
#[derive(Serialize)]
pub struct DigestView {
    digests: Vec<Digest>,
    running: Option<String>,
    picked: Vec<PickedDigest>,
    has_gemini_key: bool,
}

pub fn view(digesting: &Digesting, db: &cts_core::Db) -> Result<DigestView, String> {
    Ok(DigestView {
        digests: db.digests().map_err(err)?,
        running: digesting.day.lock().map_err(err)?.clone(),
        picked: db.picked_digests().map_err(err)?,
        has_gemini_key: digesting.has_key.load(Ordering::Relaxed),
    })
}

/// Has `day`'s readings (the local date) summed up by a session, and keeps
/// which (or why none could start). One day at a time.
fn make(app: &AppHandle, day: &str) -> Result<(), String> {
    let digesting = app.state::<Digesting>();
    {
        let mut running = digesting.day.lock().map_err(err)?;
        if let Some(other) = running.as_ref() {
            return Err(format!("{other} の分をまとめています"));
        }
        *running = Some(day.to_string());
    }
    let started = start(app, day);
    if let Ok(mut running) = digesting.day.lock() {
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

/// The readings with their pages read.
fn read(readings: &[Reading]) -> Vec<digest::Item<'_>> {
    readings.iter().map(|r| digest::Item { reading: r, pages: pages_of(r).into_iter().map(|u| ogp::page(u, PAGE_TIMEOUT)).collect() }).collect()
}

/// Where the briefs and podcasts go.
fn briefs_dir() -> Result<PathBuf, String> {
    let dir = crate::db_path().parent().map(|p| p.join(BRIEFS_DIR)).ok_or("データのフォルダが分かりません")?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// Writes `brief` into `file` and starts the session titled `title` that
/// makes the page of it (in herdr, else Ghostty), behind; its id.
fn start_session(app: &AppHandle, title: &str, file: &str, brief: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    let dir = briefs_dir()?;
    let path = dir.join(file);
    std::fs::write(&path, brief).map_err(err)?;
    let session = uuid::Uuid::new_v4().to_string();
    // At home, as ちょっと Claude (a folder of its own would be asked to be
    // trusted first), with the briefs' folder added for its file tools.
    let command = format!(
        "claude --session-id {session} --add-dir {} --allowedTools {} {}",
        launch::shell_quote(&dir.to_string_lossy()),
        launch::shell_quote(SESSION_TOOLS),
        launch::shell_quote(&digest::first_prompt(&path.to_string_lossy()))
    );
    let cwd = crate::home().to_string_lossy().to_string();
    state.db.lock().map_err(err)?.register_session(&session, &cwd, title, None).map_err(err)?;
    crate::start_in_herdr(&state, &cwd, title, &command, false, false).or_else(|herdr| crate::start_in_ghostty(&cwd, &command).map_err(|e| format!("{herdr} / {e}")))?;
    Ok(session)
}

/// Reads the day's readings' pages into a brief and starts the session that
/// makes the page of it.
fn start(app: &AppHandle, day: &str) -> Result<(), String> {
    let readings = app.state::<AppState>().db.lock().map_err(err)?.readings_on(day).map_err(err)?;
    let title = format!("読みものの日報 {day}");
    let session = start_session(app, &title, &format!("{day}.md"), &digest::brief(&title, &read(&readings), None))?;
    app.state::<AppState>().db.lock().map_err(err)?.start_digest(day, &session).map_err(err)
}

/// Every morning (from DIGEST_HOUR), the day before, once: a day that failed
/// is not tried again by itself (⌘K tries it again).
pub fn digest_loop(app: AppHandle) {
    app.state::<Digesting>().has_key.store(gemini_key().is_some(), Ordering::Relaxed);
    if let Err(e) = app.state::<AppState>().db.lock().map_err(err).and_then(|db| db.fail_unfinished_picked_digests("Shosai が途中で終わりました").map_err(err)) {
        eprintln!("digest: {e}");
    }
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
    if let Some(other) = app.state::<Digesting>().day.lock().map_err(err)?.as_ref() {
        return Err(format!("{other} の分をまとめています"));
    }
    std::thread::spawn(move || {
        if let Err(e) = make(&app, &day) {
            eprintln!("digest {day}: {e}");
        }
    });
    Ok(())
}

/// 学習's 「日報を作る」: the readings picked (ids, in the order picked)
/// summed up now, behind, with a podcast of them if `podcast`.
#[tauri::command(async)]
pub fn make_picked_digest(app: AppHandle, readings: Vec<i64>, podcast: bool) -> Result<(), String> {
    if readings.is_empty() {
        return Err("読みものを選んでください".into());
    }
    if podcast && gemini_key().is_none() {
        return Err(NO_GEMINI_KEY.into());
    }
    let id = app.state::<AppState>().db.lock().map_err(err)?.add_picked_digest(&readings, podcast, READING_PAGES).map_err(err)?;
    std::thread::spawn(move || {
        if let Err(why) = make_picked(&app, id, &readings, podcast) {
            if let Err(e) = app.state::<AppState>().db.lock().map_err(err).and_then(|db| db.fail_picked_digest(id, &why).map_err(err)) {
                eprintln!("picked digest {id}: {why} / {e}");
            }
        }
    });
    Ok(())
}

/// Reads the picked readings' pages, makes their podcast if asked for, and
/// starts the session that makes the page.
fn make_picked(app: &AppHandle, id: i64, ids: &[i64], podcast: bool) -> Result<(), String> {
    let (all, day) = {
        let state = app.state::<AppState>();
        let db = state.db.lock().map_err(err)?;
        (db.list_readings().map_err(err)?, db.local_day(0).map_err(err)?)
    };
    let readings: Vec<Reading> = ids.iter().filter_map(|id| all.iter().find(|r| r.id == *id).cloned()).collect();
    if readings.is_empty() {
        return Err("選んだ読みものが見つかりません".into());
    }
    let items = read(&readings);
    let podcast = if podcast { Some(make_podcast(app, id, &day, &items)?) } else { None };
    let title = format!("読みものの日報 {day}（選んだ {} 件）", readings.len());
    let session = start_session(app, &title, &format!("picked-{id}.md"), &digest::brief(&title, &items, podcast.as_ref()))?;
    app.state::<AppState>().db.lock().map_err(err)?.start_picked_digest(id, &session).map_err(err)
}

/// The readings' podcast: Claude writes its script, a segment a reading,
/// Gemini reads each aloud, and ffmpeg makes the whole an MP3 beside the briefs.
fn make_podcast(app: &AppHandle, id: i64, day: &str, items: &[digest::Item]) -> Result<digest::Podcast, String> {
    stage(app, id, "台本を書いています")?;
    let answer = crate::ask::claude_within(&digest::script_prompt(&digest::spoken_date(day), items), Some(&digest::script_schema()), None, None, SCRIPT_TIMEOUT)?;
    let segments = digest::segments_of(&answer)?;
    let key = gemini_key().ok_or(NO_GEMINI_KEY)?;
    let mut recorded = Vec::new();
    for (i, segment) in segments.iter().enumerate() {
        stage(app, id, &format!("音声を作っています（{}/{}）", i + 1, segments.len()))?;
        let mut pcm = Vec::new();
        for piece in tts::pieces(&segment.text, tts::MAX_PIECE_CHARS) {
            pcm.extend(tts::speak(&key, &piece)?);
        }
        recorded.push(pcm);
    }
    let (wav, starts) = tts::join(&recorded);
    let dir = briefs_dir()?;
    let (wav_path, mp3) = (dir.join(format!("picked-{id}.wav")), dir.join(format!("picked-{id}.mp3")));
    std::fs::write(&wav_path, wav).map_err(err)?;
    let mut ffmpeg = crate::cli("ffmpeg");
    ffmpeg.args(["-hide_banner", "-loglevel", "error", "-y", "-i"]).arg(&wav_path).args(["-c:a", "libmp3lame", "-b:a", MP3_BITRATE]).arg(&mp3);
    let out = crate::output_within(&mut ffmpeg, MP3_TIMEOUT).map_err(|e| format!("ffmpeg: {e}"))?;
    std::fs::remove_file(&wav_path).map_err(err)?;
    if !out.status.success() {
        return Err(format!("ffmpeg: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(digest::Podcast { file: mp3.to_string_lossy().to_string(), chapters: starts.into_iter().zip(segments.into_iter().map(|s| s.title)).collect() })
}

/// What picked digest `id` is doing now, for 学習 to show.
fn stage(app: &AppHandle, id: i64, what: &str) -> Result<(), String> {
    app.state::<AppState>().db.lock().map_err(err)?.set_picked_stage(id, what).map_err(err)
}

fn gemini_key() -> Option<String> {
    logins::load_secret(GEMINI_SERVICE, GEMINI_ACCOUNT).filter(|k| !k.is_empty())
}

/// Keeps the Gemini API key (a blank one takes it out), for the podcasts.
#[tauri::command(async)]
pub fn set_gemini_key(app: AppHandle, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        logins::delete_secret(GEMINI_SERVICE, GEMINI_ACCOUNT)?;
    } else {
        logins::save_secret(GEMINI_SERVICE, GEMINI_ACCOUNT, key)?;
    }
    app.state::<Digesting>().has_key.store(!key.is_empty(), Ordering::Relaxed);
    Ok(())
}
