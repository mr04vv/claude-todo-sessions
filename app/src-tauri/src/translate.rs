// Pages translated where they are (cts_core::translate): browser_page.js
// sends a tab's blocks of text a batch at a time, Claude translates the ones
// not kept yet (a fast model, a low effort), and the page swaps them in.
// The translations are kept (a page read again shows at once), and so are
// the pages translated, which are translated again as they open.

use std::collections::HashMap;
use std::sync::Mutex;

use cts_core::translate;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{cef_browser, err, load_kept, save_kept, tab_id};

const MODEL: &str = "haiku";
const EFFORT: &str = "low";
const TRANSLATIONS_FILE: &str = "translations.json";
const PAGES_FILE: &str = "translated-pages.json";
/// Translations kept at most; past it they start over.
// ponytail: forgets them all at the cap, an LRU if it comes up often.
const KEPT_MAX: usize = 20_000;
/// `{tab, on}` when a tab's page is translated or put back.
const BROWSER_TRANSLATED_EVENT: &str = "browser-translated";

/// The translations kept (text → Japanese) and the pages translated (by address).
pub struct Kept {
    texts: Mutex<HashMap<String, String>>,
    pages: Mutex<HashMap<String, bool>>,
}

impl Kept {
    pub fn load() -> Kept {
        Kept { texts: Mutex::new(load_kept(TRANSLATIONS_FILE)), pages: Mutex::new(load_kept(PAGES_FILE)) }
    }
}

#[derive(Clone, Serialize)]
struct Translated {
    tab: String,
    on: bool,
}

/// An address without its fragment: the page translated.
fn page_of(url: &str) -> &str {
    url.split('#').next().unwrap_or(url)
}

/// The tab's page was translated or put back (the page says so): kept, and the pane told.
pub fn on_translated(app: &AppHandle, tab: &str, on: bool) {
    if let Some(url) = cef_browser::url(app, tab) {
        let kept = app.state::<Kept>();
        let pages = kept.pages.lock();
        if let Ok(mut pages) = pages {
            if on {
                pages.insert(page_of(&url).to_string(), true);
            } else {
                pages.remove(page_of(&url));
            }
            save_kept(PAGES_FILE, &pages);
        }
    }
    let _ = app.emit(BROWSER_TRANSLATED_EVENT, Translated { tab: tab.to_string(), on });
}

/// A page translated before is translated again as it opens.
pub fn on_load(app: &AppHandle, tab: &str, url: &str) {
    let again = app.state::<Kept>().pages.lock().is_ok_and(|p| p.contains_key(page_of(url)));
    if again {
        let _ = cef_browser::eval(app, tab, "window.__todoSessionsTranslate?.(true)");
    }
}

/// Translates `texts`: the ones kept at once, the rest asked of Claude.
fn translate_all(app: &AppHandle, texts: &[String]) -> Result<Vec<Option<String>>, String> {
    let kept = app.state::<Kept>();
    let mut out: Vec<Option<String>> = {
        let known = kept.texts.lock().map_err(err)?;
        texts.iter().map(|t| known.get(t).cloned()).collect()
    };
    let asked: Vec<usize> = (0..texts.len()).filter(|&i| out[i].is_none() && translate::needs_translation(&texts[i])).collect();
    if asked.is_empty() {
        return Ok(out);
    }
    let batch: Vec<String> = asked.iter().map(|&i| texts[i].clone()).collect();
    let answer = crate::ask::claude(&translate::prompt(&batch), Some(&translate::schema()), Some(MODEL), Some(EFFORT), false)?;
    let got = translate::parse(&answer, batch.len()).ok_or("訳の数が合いませんでした")?;
    let mut known = kept.texts.lock().map_err(err)?;
    if known.len() + got.len() > KEPT_MAX {
        known.clear();
    }
    for (&i, ja) in asked.iter().zip(got) {
        known.insert(texts[i].clone(), ja.clone());
        out[i] = Some(ja);
    }
    save_kept(TRANSLATIONS_FILE, &known);
    Ok(out)
}

/// A batch of a page's blocks (`[[block, text], ...]`), translated behind
/// and handed back to the page.
pub fn on_blocks(app: &AppHandle, tab: &str, batch: &str) {
    let Ok(pairs) = serde_json::from_str::<Vec<(String, String)>>(batch) else { return };
    let (app, tab) = (app.clone(), tab.to_string());
    std::thread::spawn(move || {
        let texts: Vec<String> = pairs.iter().map(|(_, t)| t.clone()).collect();
        match translate_all(&app, &texts) {
            Ok(out) => {
                let done: Vec<(String, String)> = pairs.into_iter().zip(out).filter_map(|((id, _), ja)| ja.map(|ja| (id, ja))).collect();
                let json = serde_json::to_string(&done).unwrap_or_default();
                let _ = cef_browser::eval(&app, &tab, &format!("window.__todoSessionsTranslated?.({json})"));
            }
            Err(e) => eprintln!("translate: {e}"),
        }
    });
}

/// A selection's translation, for the bubble under it (`id` names the bubble).
pub fn on_selection(app: &AppHandle, tab: &str, id: u64, text: String) {
    let (app, tab) = (app.clone(), tab.to_string());
    std::thread::spawn(move || {
        let said = match translate_all(&app, std::slice::from_ref(&text)) {
            Ok(mut out) => out.pop().flatten().unwrap_or(text),
            Err(e) => format!("訳せませんでした：{e}"),
        };
        let json = serde_json::to_string(&said).unwrap_or_default();
        let _ = cef_browser::eval(&app, &tab, &format!("window.__todoSessionsSelectionTranslated?.({id}, {json})"));
    });
}

/// The pane's 「原文 / 日本語」: translates the tab's page, or puts it back.
#[tauri::command(async)]
pub fn browser_translate(app: AppHandle, tab: String, on: bool) -> Result<(), String> {
    cef_browser::eval(&app, tab_id(&tab)?, &format!("window.__todoSessionsTranslate?.({on})"))
}
