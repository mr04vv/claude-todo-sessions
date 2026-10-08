// The Input mode's 「説明する」 (cts_core::feynman): Claude asked through
// `claude -p` (ask.rs); the text of a tab's page for it to read; and the
// notices when it is time to explain again.
use std::time::Duration;

use cts_core::feynman::{self, Page};
use cts_core::{FeynmanAttempt, FeynmanPoint, Subject};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};


use crate::{err, AppState};

/// The grading, done over and over, goes to a faster model; the points once.
const GRADE_MODEL: &str = "sonnet";
const PAGE_FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// When a notice says it is time to explain a subject again: `{subject}`.
pub const OPEN_STUDY_EVENT: &str = "open-study";

/// The text of tab `tab`'s page (its body), or None when the tab has no page open.
#[tauri::command(async)]
pub fn browser_text(app: AppHandle, tab: String) -> Result<Option<String>, String> {
    crate::cef_browser::text(&app, crate::tab_id(&tab)?)
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
    let output = crate::ask::claude(&feynman::points_prompt(&title, &pages), &feynman::points_schema(), None, None)?;
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
    let output = crate::ask::claude(&feynman::grade_prompt(&title, &points, &explanation), &feynman::grade_schema(), Some(GRADE_MODEL), None)?;
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
