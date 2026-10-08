// Learning by theme (cts_core::study): the themes and what waits unsorted,
// Claude's proposals (where the unsorted go, what to read next), a study
// time's review from the theme's claude.ai document, and writing what was
// read into that document. Claude is asked through `claude -p` (ask.rs);
// the document through the Claude Docs connector.
use std::time::Duration;

use cts_core::feynman::{self, Page};
use cts_core::study::{self, InputRef, Placement, Question, ThemeRef};
use cts_core::{ArtifactKind, FeynmanAttempt, NewArtifact, Subject, Theme, ThemePatch};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{err, open_db, AppState};

/// Grading and proposals go to a faster model; the document's writing to the default one.
const FAST_MODEL: &str = "sonnet";
const PAGE_FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// `{theme_id, error}` once a theme's document was written (or failed to be).
const THEME_DOC_EVENT: &str = "theme-doc-written";

#[derive(Clone, Serialize)]
struct DocWritten {
    theme_id: i64,
    error: Option<String>,
}

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

#[tauri::command(async)]
pub fn create_theme(state: State<AppState>, name: String, goal: Option<String>) -> Result<Theme, String> {
    if name.trim().is_empty() {
        return Err("テーマの名前を入れてください".into());
    }
    state.db.lock().map_err(err)?.create_theme(&name, goal.as_deref()).map_err(err)
}

#[tauri::command(async)]
pub fn update_theme(state: State<AppState>, id: i64, patch: ThemePatch) -> Result<Theme, String> {
    state.db.lock().map_err(err)?.update_theme(id, patch).map_err(err)
}

#[tauri::command(async)]
pub fn delete_theme(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.delete_theme(id).map_err(err)
}

/// Puts an input in a theme, or back among the unsorted.
#[tauri::command(async)]
pub fn set_input_theme(state: State<AppState>, input_id: i64, theme_id: Option<i64>) -> Result<(), String> {
    state.db.lock().map_err(err)?.set_input_theme(input_id, theme_id).map_err(err)
}

/// Claude's proposal of where each unsorted input goes.
#[tauri::command(async)]
pub fn sort_unsorted(state: State<AppState>) -> Result<Vec<Placement>, String> {
    let (themes, inputs) = {
        let db = state.db.lock().map_err(err)?;
        (db.list_themes().map_err(err)?, db.list_inputs().map_err(err)?.into_iter().filter(|i| i.theme_id.is_none() && !i.done).collect::<Vec<_>>())
    };
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let theme_refs: Vec<ThemeRef> = themes.iter().map(|t| ThemeRef { id: t.id, name: &t.name, goal: t.goal.as_deref() }).collect();
    let input_refs: Vec<InputRef> = inputs.iter().map(|i| InputRef { id: i.id, title: &i.title, url: i.links.first().map(|l| l.url.as_str()), done: i.done }).collect();
    let output = crate::ask::claude(&study::sort_prompt(&theme_refs, &input_refs), Some(&study::sort_schema()), Some(FAST_MODEL), None, false)?;
    Ok(study::parse_sort(&output, &inputs.iter().map(|i| i.id).collect::<Vec<_>>(), &themes.iter().map(|t| t.id).collect::<Vec<_>>()))
}

fn theme_or_err(db: &cts_core::Db, id: i64) -> Result<Theme, String> {
    db.get_theme(id).map_err(err)?.ok_or_else(|| format!("theme {id} not found"))
}

/// What the last review found vague, for the next reads.
fn vague_points(db: &cts_core::Db, theme: i64) -> Result<Vec<String>, String> {
    let Some(last) = db.feynman_attempts(Subject::Theme(theme)).map_err(err)?.into_iter().next() else { return Ok(Vec::new()) };
    Ok(last.grade.verdicts.iter().filter(|v| v.verdict != feynman::Verdict::Said).map(|v| v.note.clone()).chain(last.grade.questions.clone()).collect())
}

/// A next read Claude picked, and why.
#[derive(Serialize)]
pub struct NextRead {
    input_id: i64,
    why: String,
}

/// Claude's picks of what of the theme to read next.
#[tauri::command(async)]
pub fn next_reads(state: State<AppState>, theme_id: i64) -> Result<Vec<NextRead>, String> {
    let (theme, inputs, vague) = {
        let db = state.db.lock().map_err(err)?;
        let inputs: Vec<_> = db.list_inputs().map_err(err)?.into_iter().filter(|i| i.theme_id == Some(theme_id)).collect();
        (theme_or_err(&db, theme_id)?, inputs, vague_points(&db, theme_id)?)
    };
    let unread: Vec<i64> = inputs.iter().filter(|i| !i.done).map(|i| i.id).collect();
    if unread.is_empty() {
        return Ok(Vec::new());
    }
    let refs: Vec<InputRef> = inputs.iter().map(|i| InputRef { id: i.id, title: &i.title, url: i.links.first().map(|l| l.url.as_str()), done: i.done }).collect();
    let theme_ref = ThemeRef { id: theme.id, name: &theme.name, goal: theme.goal.as_deref() };
    let output = crate::ask::claude(&study::next_prompt(&theme_ref, &refs, &vague), Some(&study::next_schema()), Some(FAST_MODEL), None, false)?;
    Ok(study::parse_next(&output, &unread).into_iter().map(|(input_id, why)| NextRead { input_id, why }).collect())
}

/// A study time's review: questions from the theme's document (none without one).
#[tauri::command(async)]
pub fn review_questions(state: State<AppState>, theme_id: i64) -> Result<Vec<Question>, String> {
    let theme = theme_or_err(&*state.db.lock().map_err(err)?, theme_id)?;
    let Some(doc) = theme.doc_url.as_deref() else { return Ok(Vec::new()) };
    let theme_ref = ThemeRef { id: theme.id, name: &theme.name, goal: theme.goal.as_deref() };
    let output = crate::ask::claude(&study::review_prompt(&theme_ref, doc), Some(&study::review_schema()), Some(FAST_MODEL), None, true)?;
    study::parse_review(&output)
}

/// Grades a review's answers against its questions' points and keeps it (the
/// next review's day goes by its score); its results go into the document behind.
#[tauri::command(async)]
pub fn review_grade(app: AppHandle, state: State<'_, AppState>, theme_id: i64, questions: Vec<Question>, answers: Vec<String>) -> Result<FeynmanAttempt, String> {
    if answers.iter().all(|a| a.trim().is_empty()) {
        return Err("答えを書いてください（話して答えることもできます）".into());
    }
    let theme = theme_or_err(&*state.db.lock().map_err(err)?, theme_id)?;
    let points: Vec<String> = questions.iter().map(|q| q.point.clone()).collect();
    let answered = study::answers_text(&questions, &answers);
    let output = crate::ask::claude(&feynman::grade_prompt(&theme.name, &points, &answered), Some(&feynman::grade_schema()), Some(FAST_MODEL), None, false)?;
    let grade = feynman::parse_grade(&output, points.len())?;
    let score = feynman::score(&grade);
    let attempt = state.db.lock().map_err(err)?.add_feynman_attempt(Subject::Theme(theme_id), &answered, &grade, score).map_err(err)?;
    let result = format!("{answered}\n\n理解度 {score}%\nあいまいだったところ：{}", vague_points(&*state.db.lock().map_err(err)?, theme_id)?.join(" / "));
    write_doc_behind(&app, theme_id, Vec::new(), None, Some(result), Vec::new());
    Ok(attempt)
}

/// 「読み終わった」: what was read (its pages' text) and the conversation with
/// the LLM beside it go into the theme's document (made the first time),
/// behind; the inputs read are marked read once it is written.
#[tauri::command(async)]
pub fn finish_reading(app: AppHandle, theme_id: i64, pages: Vec<Page>, conversation: Option<String>, input_ids: Vec<i64>) -> Result<(), String> {
    if pages.iter().all(|p| p.text.trim().is_empty()) && conversation.as_deref().is_none_or(|c| c.trim().is_empty()) {
        return Err("読めたページがありません".into());
    }
    write_doc_behind(&app, theme_id, pages, conversation, None, input_ids);
    Ok(())
}

/// Writes into the theme's document in a thread (it takes a while): the
/// document's link is kept the first time, as an artifact too; the page is
/// told when it is done.
fn write_doc_behind(app: &AppHandle, theme_id: i64, pages: Vec<Page>, conversation: Option<String>, review: Option<String>, read: Vec<i64>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let result = write_doc(theme_id, &pages, conversation.as_deref(), review.as_deref(), &read);
        let _ = app.emit(THEME_DOC_EVENT, DocWritten { theme_id, error: result.err() });
    });
}

fn write_doc(theme_id: i64, pages: &[Page], conversation: Option<&str>, review: Option<&str>, read: &[i64]) -> Result<(), String> {
    let theme = theme_or_err(&open_db()?, theme_id)?;
    let theme_ref = ThemeRef { id: theme.id, name: &theme.name, goal: theme.goal.as_deref() };
    let prompt = study::doc_prompt(&theme_ref, theme.doc_url.as_deref(), pages, conversation, review);
    let said = crate::ask::claude(&prompt, None, None, None, true)?;
    let db = open_db()?;
    if theme.doc_url.is_none() {
        let url = cts_core::transcript::note_url(said.as_str().unwrap_or_default()).ok_or("ドキュメントの URL が分かりませんでした")?;
        db.update_theme(theme_id, ThemePatch { doc_url: Some(url.clone()), ..Default::default() }).map_err(err)?;
        let title = Some(format!("{} のノート", theme.name));
        db.add_artifact(NewArtifact { url, title, kind: ArtifactKind::Doc, session_id: None, todo_id: None, theme_id: Some(theme_id) }).map_err(err)?;
    }
    for &id in read {
        db.update_input(id, cts_core::InputPatch { done: Some(true), ..Default::default() }).map_err(err)?;
    }
    Ok(())
}

/// A theme's reviews, newest first.
#[tauri::command(async)]
pub fn theme_reviews(app: AppHandle, theme_id: i64) -> Result<Vec<FeynmanAttempt>, String> {
    app.state::<AppState>().db.lock().map_err(err)?.feynman_attempts(Subject::Theme(theme_id)).map_err(err)
}
