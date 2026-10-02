// The Input mode's 「説明する」 (cts_core::feynman): Claude asked through
// `claude -p` with a JSON schema, without a session or tools; the text of a
// tab's page for it to read; and the notices when it is time to explain again.
use std::io::{Read, Write};
use std::process::Stdio;
use std::time::{Duration, Instant};

use cts_core::feynman::{self, Page};
use cts_core::{FeynmanAttempt, FeynmanPoint, Subject};
use objc2::runtime::AnyObject;
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::WKWebView;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};


use crate::{err, AppState};

/// How long one answer may take (the points of eight pages take a while).
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(240);
/// The grading, done over and over, goes to a faster model; the points once.
const GRADE_MODEL: &str = "sonnet";
/// A page's text is waited for this long.
const PAGE_TEXT_TIMEOUT: Duration = Duration::from_secs(15);
const PAGE_FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// What a page's text is read with (its frames' is not).
const PAGE_TEXT_JS: &str = "document.body ? document.body.innerText : ''";
/// When a notice says it is time to explain a subject again: `{subject}`.
pub const OPEN_STUDY_EVENT: &str = "open-study";

/// Asks Claude once, with no tools and no session, for an answer in `schema`.
/// The prompt goes in on stdin (a long one would not fit in an argument).
fn ask_claude(prompt: &str, schema: &Value, model: Option<&str>) -> Result<Value, String> {
    let mut cmd = crate::cli("claude");
    cmd.args(["-p", "--output-format", "json", "--json-schema", &schema.to_string(), "--tools", "", "--no-session-persistence", "--strict-mcp-config"]);
    if let Some(model) = model {
        cmd.args(["--model", model]);
    }
    cmd.current_dir(crate::home()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("claude を起動できません: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("claude の入力を開けません")?;
    let prompt = prompt.to_string();
    std::thread::spawn(move || drop(stdin.write_all(prompt.as_bytes())));
    let mut stdout = child.stdout.take().ok_or("claude の出力を開けません")?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(err)? {
            Some(status) => {
                let out = reader.join().map_err(|_| "claude の出力を読めませんでした")?;
                let mut stderr = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut stderr);
                }
                let answer: Value = serde_json::from_slice(&out).map_err(|_| {
                    let said = String::from_utf8_lossy(&out);
                    format!("claude の答えが読めませんでした ({status}): {}{}", said.trim(), stderr.trim())
                })?;
                if answer["is_error"].as_bool() == Some(true) {
                    return Err(format!("claude: {}", answer["result"].as_str().unwrap_or("error")));
                }
                return match answer.get("structured_output") {
                    Some(output) if output.is_object() => Ok(output.clone()),
                    _ => Err("claude が決まった形で答えませんでした".into()),
                };
            }
            None if started.elapsed() > CLAUDE_TIMEOUT => {
                let _ = child.kill();
                return Err("claude の答えを待ちきれませんでした".into());
            }
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

/// The text of tab `tab`'s page (its body), or None when the tab has no page open.
#[tauri::command(async)]
pub fn browser_text(app: AppHandle, tab: String) -> Result<Option<String>, String> {
    let Some(view) = app.get_webview(&crate::tab_label(&tab)?) else { return Ok(None) };
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    view.with_webview(move |w| {
        // SAFETY: on macOS the handle is the WKWebView, and this runs on the main thread as WebKit wants.
        let web: &WKWebView = unsafe { &*(w.inner() as *const WKWebView) };
        let done = block2::RcBlock::new(move |result: *mut AnyObject, _error: *mut NSError| {
            // SAFETY: WebKit hands a live object (or null) to the handler.
            let text = unsafe { result.as_ref() }.and_then(|r| r.downcast_ref::<NSString>()).map(|s| s.to_string());
            let _ = tx.send(text);
        });
        unsafe { web.evaluateJavaScript_completionHandler(&NSString::from_str(PAGE_TEXT_JS), Some(&done)) };
    })
    .map_err(err)?;
    rx.recv_timeout(PAGE_TEXT_TIMEOUT).map_err(|_| "ページの本文を読めませんでした".to_string())
}

/// A page's text fetched afresh, for a page the app has no tab of.
#[tauri::command(async)]
pub fn page_text(url: String) -> Result<String, String> {
    if !crate::is_web_url(&url) {
        return Err(format!("開けない URL です: {url}"));
    }
    cts_core::ogp::fetch_text(&url, PAGE_FETCH_TIMEOUT)
}

#[derive(Serialize)]
pub struct FeynmanState {
    points: Vec<FeynmanPoint>,
    attempts: Vec<FeynmanAttempt>,
}

#[tauri::command]
pub fn feynman_state(state: State<AppState>, subject: Subject) -> Result<FeynmanState, String> {
    let db = state.db.lock().map_err(err)?;
    Ok(FeynmanState { points: db.feynman_points(subject).map_err(err)?, attempts: db.feynman_attempts(subject).map_err(err)? })
}

/// Makes (again) the subject's key points from its pages.
#[tauri::command(async)]
pub fn feynman_make_points(state: State<'_, AppState>, subject: Subject, title: String, pages: Vec<Page>) -> Result<Vec<FeynmanPoint>, String> {
    if pages.iter().all(|p| p.text.trim().is_empty()) {
        return Err("読めたページがありません".into());
    }
    let output = ask_claude(&feynman::points_prompt(&title, &pages), &feynman::points_schema(), None)?;
    let points = feynman::parse_points(&output)?;
    state.db.lock().map_err(err)?.set_feynman_points(subject, &points).map_err(err)
}

/// Grades `explanation` against the subject's points and keeps the attempt.
#[tauri::command(async)]
pub fn feynman_grade(state: State<'_, AppState>, subject: Subject, title: String, explanation: String) -> Result<FeynmanAttempt, String> {
    let points: Vec<String> = state.db.lock().map_err(err)?.feynman_points(subject).map_err(err)?.into_iter().map(|p| p.text).collect();
    if points.is_empty() {
        return Err("先に要点を作ってください".into());
    }
    if explanation.trim().is_empty() {
        return Err("説明を書いてください".into());
    }
    let output = ask_claude(&feynman::grade_prompt(&title, &points, &explanation), &feynman::grade_schema(), Some(GRADE_MODEL))?;
    let grade = feynman::parse_grade(&output, points.len())?;
    let score = feynman::score(&grade);
    state.db.lock().map_err(err)?.add_feynman_attempt(subject, &explanation, &grade, score).map_err(err)
}

#[derive(Clone, Serialize)]
struct OpenStudy {
    subject: Subject,
}

/// Opens the subject's Input mode on 「説明する」 (from a notification).
fn open_study(app: &AppHandle, subject: Subject) -> Result<(), String> {
    crate::show_window(app);
    app.emit(OPEN_STUDY_EVENT, OpenStudy { subject }).map_err(err)
}

/// Notices each subject whose review is due (see `Db::feynman_due`).
pub fn notify_study_due(app: &AppHandle, db: &cts_core::Db) -> Result<(), String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_secs() as i64;
    for (subject, title) in db.feynman_due(now).map_err(err)? {
        let id = db.add_study_notice(subject, &title).map_err(err)?;
        crate::post_banner(app, "復習どき：もう一度説明してみましょう", title, Some(id), move |app| open_study(app, subject));
    }
    Ok(())
}
