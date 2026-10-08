//! Learning by theme: Claude sorts what waits unsorted into themes, picks
//! what to read next, asks the review's questions from a theme's document
//! (read through the Claude Docs connector), and writes what was read into
//! that document. The prompts and the answers' parsing are here; the app
//! asks through `claude -p`.

use serde_json::{json, Value};

use crate::feynman::{excerpt, Page, MAX_PAGES, PAGE_CHARS};

/// Questions a review asks.
pub const REVIEW_QUESTIONS_MIN: usize = 2;
pub const REVIEW_QUESTIONS_MAX: usize = 3;
/// The line a document's writer ends with, naming it (as transcript::note_url reads it).
pub const DOC_LINE: &str = "NOTE_URL: ";
/// Characters of the LLM conversation beside the reading that go into the document's prompt.
const CONVERSATION_CHARS: usize = 12_000;

/// A theme as a prompt names it.
pub struct ThemeRef<'a> {
    pub id: i64,
    pub name: &'a str,
    pub goal: Option<&'a str>,
}

/// An input as a prompt lists it.
pub struct InputRef<'a> {
    pub id: i64,
    pub title: &'a str,
    pub url: Option<&'a str>,
    pub done: bool,
}

fn theme_line(t: &ThemeRef) -> String {
    format!("- [{}] {}{}", t.id, t.name, t.goal.map(|g| format!("（目標：{g}）")).unwrap_or_default())
}

fn input_line(i: &InputRef) -> String {
    format!("- [{}] {}{}{}", i.id, i.title, i.url.map(|u| format!(" {u}")).unwrap_or_default(), if i.done { "（読み終わった）" } else { "" })
}

/// Asks where each unsorted input belongs: one of the themes, or a new one.
pub fn sort_prompt(themes: &[ThemeRef], inputs: &[InputRef]) -> String {
    let themes = if themes.is_empty() { "（まだありません）".to_string() } else { themes.iter().map(theme_line).collect::<Vec<_>>().join("\n") };
    format!(
        "学びたいものを「テーマ」でまとめています。まだテーマに入っていない記事や本の章を、どのテーマに入れるかを決めてください。\n\
         - 合うテーマがあればその番号を theme に、なければ new_theme に新しいテーマの名前（短く）を入れる（theme は null）。\n\
         - 似たものは同じ新しいテーマにまとめる。\n\
         - why に一言の理由。\n\n## テーマ\n{themes}\n\n## まだテーマにないもの\n{}",
        inputs.iter().map(input_line).collect::<Vec<_>>().join("\n")
    )
}

pub fn sort_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "placements": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "input": { "type": "integer" },
                        "theme": { "type": ["integer", "null"] },
                        "new_theme": { "type": ["string", "null"] },
                        "why": { "type": "string" }
                    },
                    "required": ["input", "why"]
                }
            }
        },
        "required": ["placements"]
    })
}

/// Where an input goes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Place {
    Theme(i64),
    NewTheme(String),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Placement {
    pub input: i64,
    pub place: Place,
    pub why: String,
}

/// The placements answered, for the inputs and themes asked about only.
pub fn parse_sort(output: &Value, inputs: &[i64], themes: &[i64]) -> Vec<Placement> {
    output["placements"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let input = p["input"].as_i64().filter(|i| inputs.contains(i))?;
            let place = match p["theme"].as_i64() {
                Some(t) if themes.contains(&t) => Place::Theme(t),
                _ => Place::NewTheme(p["new_theme"].as_str().map(str::trim).filter(|n| !n.is_empty())?.to_string()),
            };
            Some(Placement { input, place, why: p["why"].as_str().unwrap_or_default().to_string() })
        })
        .collect()
}

/// Asks what of a theme's inputs to read next, given what the last review
/// found vague (`vague`).
pub fn next_prompt(theme: &ThemeRef, inputs: &[InputRef], vague: &[String]) -> String {
    let vague = if vague.is_empty() { "（まだ復習していないか、あいまいなところはありませんでした）".to_string() } else { vague.iter().map(|v| format!("- {v}")).collect::<Vec<_>>().join("\n") };
    format!(
        "テーマ「{}」{}を学んでいます。次に読むものを、まだ読み終わっていないものから 1〜3 個選んでください。\n\
         - 前回の復習であいまいだったところを埋めるものを先に。\n\
         - 基礎から応用へ。why に一言の理由。\n\n## 読むもの\n{}\n\n## 前回の復習であいまいだったところ\n{vague}",
        theme.name,
        theme.goal.map(|g| format!("（目標：{g}）")).unwrap_or_default(),
        inputs.iter().map(input_line).collect::<Vec<_>>().join("\n")
    )
}

pub fn next_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "picks": { "type": "array", "items": { "type": "object", "properties": { "input": { "type": "integer" }, "why": { "type": "string" } }, "required": ["input", "why"] } } },
        "required": ["picks"]
    })
}

/// The picks answered, among the unread inputs asked about.
pub fn parse_next(output: &Value, unread: &[i64]) -> Vec<(i64, String)> {
    output["picks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p["input"].as_i64().filter(|i| unread.contains(i))?, p["why"].as_str().unwrap_or_default().to_string())))
        .collect()
}

/// A review's question, and the point an answer should make.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Question {
    pub question: String,
    pub point: String,
}

/// Asks for a review's questions from the theme's document, which Claude reads itself.
pub fn review_prompt(theme: &ThemeRef, doc_url: &str) -> String {
    format!(
        "テーマ「{}」{}の学習ノートが Claude Docs のドキュメント {doc_url} にあります。Claude Docs のツールで読み、書かれている内容から「何も見ずに自分の言葉で説明してみて」という復習の質問を {REVIEW_QUESTIONS_MIN}〜{REVIEW_QUESTIONS_MAX} 個作ってください。\n\
         - 「なぜ」「どうなる」「どう違う」で、丸暗記では答えられないもの。\n\
         - 前の復習であいまいだったところ（ノートに書いてあれば）を優先する。\n\
         - point に、答えに入っているべき要点を1文で。\n\
         - ドキュメントは書き換えない。",
        theme.name,
        theme.goal.map(|g| format!("（目標：{g}）")).unwrap_or_default()
    )
}

pub fn review_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "questions": { "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string" }, "point": { "type": "string" } }, "required": ["question", "point"] } } },
        "required": ["questions"]
    })
}

pub fn parse_review(output: &Value) -> Result<Vec<Question>, String> {
    let questions: Vec<Question> = output["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|q| serde_json::from_value::<Question>(q.clone()).ok())
        .filter(|q| !q.question.trim().is_empty())
        .take(REVIEW_QUESTIONS_MAX)
        .collect();
    if questions.is_empty() {
        return Err("復習の質問が返ってきませんでした".into());
    }
    Ok(questions)
}

/// The answers to a review as one explanation, for grading against the points.
pub fn answers_text(questions: &[Question], answers: &[String]) -> String {
    questions.iter().zip(answers).enumerate().map(|(i, (q, a))| format!("問{} {}\n答え：{}", i + 1, q.question, a.trim())).collect::<Vec<_>>().join("\n\n")
}

/// Asks to write into the theme's document (making it when there is none):
/// the key points of the pages read, where the reader got stuck in the
/// conversation with the LLM beside them, or a review's results.
pub fn doc_prompt(theme: &ThemeRef, doc_url: Option<&str>, pages: &[Page], conversation: Option<&str>, review: Option<&str>) -> String {
    let target = match doc_url {
        Some(url) => format!("Claude Docs のドキュメント {url} に書き足してください（前の内容は消さない）。"),
        None => format!("Claude Docs に「{} のノート」という新しいドキュメントを作って書いてください。", theme.name),
    };
    let pages: String = pages
        .iter()
        .take(MAX_PAGES)
        .map(|p| format!("### {}\n{}\n\n{}\n\n", p.title.as_deref().unwrap_or(&p.url), p.url, excerpt(&p.text, PAGE_CHARS)))
        .collect();
    let mut parts = vec![format!(
        "テーマ「{}」{}の学習ノートを Claude Docs のツールで書きます。{target}",
        theme.name,
        theme.goal.map(|g| format!("（目標：{g}）")).unwrap_or_default()
    )];
    if !pages.is_empty() {
        parts.push(format!("## 読み終わったページ\n\n{pages}"));
        parts.push("今日の日付の見出しの下に、読んだページ（リンク付き）ごとに要点を3〜5個、自分の言葉で書けるように短く書いてください。".into());
    }
    if let Some(c) = conversation.map(str::trim).filter(|c| !c.is_empty()) {
        parts.push(format!("## 読みながら LLM とした会話\n\n{}", excerpt(c, CONVERSATION_CHARS)));
        parts.push("会話から、読む人がつまずいたところ（何が分からず、どう分かったか）を「つまずいたところ」として書いてください。".into());
    }
    if let Some(r) = review.map(str::trim).filter(|r| !r.is_empty()) {
        parts.push(format!("## 復習の結果\n\n{r}"));
        parts.push("今日の日付の「復習」の見出しの下に、質問と答えの要点、あいまいだったところを書いてください。".into());
    }
    parts.push(format!("終わったら、最後の行に {DOC_LINE}<ドキュメントの URL> と書いてください。"));
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEC: ThemeRef = ThemeRef { id: 1, name: "セキュリティ", goal: Some("攻撃と守りを説明できる") };

    #[test]
    fn unsorted_inputs_go_to_a_theme_or_a_new_one() {
        let inputs = [InputRef { id: 7, title: "CSRF とは", url: Some("https://e.com/csrf"), done: false }];
        let p = sort_prompt(&[SEC], &inputs);
        assert!(p.contains("[1] セキュリティ（目標：攻撃と守りを説明できる）") && p.contains("[7] CSRF とは https://e.com/csrf"), "{p}");
        let out = json!({"placements": [
            {"input": 7, "theme": 1, "why": "攻撃の話"},
            {"input": 8, "theme": null, "new_theme": " Rust ", "why": "言語"},
            {"input": 9, "theme": 99, "why": "ない番号"},
            {"input": 8, "theme": 2, "new_theme": null, "why": "x"}
        ]});
        assert_eq!(
            parse_sort(&out, &[7, 8], &[1]),
            vec![
                Placement { input: 7, place: Place::Theme(1), why: "攻撃の話".into() },
                Placement { input: 8, place: Place::NewTheme("Rust".into()), why: "言語".into() },
            ],
            "inputs and themes not asked about are dropped"
        );
    }

    #[test]
    fn the_next_reads_come_from_what_is_not_read_yet() {
        let inputs = [InputRef { id: 1, title: "XSS", url: None, done: true }, InputRef { id: 2, title: "CSRF", url: None, done: false }];
        let p = next_prompt(&SEC, &inputs, &["SameSite の役割".into()]);
        assert!(p.contains("[1] XSS（読み終わった）") && p.contains("SameSite の役割"), "{p}");
        let out = json!({"picks": [{"input": 2, "why": "穴を埋める"}, {"input": 1, "why": "読んだ"}]});
        assert_eq!(parse_next(&out, &[2]), vec![(2, "穴を埋める".to_string())]);
    }

    #[test]
    fn a_review_asks_two_or_three_questions_from_the_document() {
        let p = review_prompt(&SEC, "https://claude.ai/code/artifact/x");
        assert!(p.contains("https://claude.ai/code/artifact/x") && p.contains("2〜3"), "{p}");
        let out = json!({"questions": [
            {"question": "CSRF はなぜ防げる？", "point": "推測できない値を照合する"},
            {"question": "", "point": "x"},
            {"question": "b", "point": "b"}, {"question": "c", "point": "c"}, {"question": "d", "point": "d"}
        ]});
        let qs = parse_review(&out).unwrap();
        assert_eq!(qs.len(), REVIEW_QUESTIONS_MAX);
        assert_eq!(qs[0].question, "CSRF はなぜ防げる？");
        assert!(parse_review(&json!({"questions": []})).is_err());
        assert_eq!(answers_text(&qs[..1], &["照合する".into()]), "問1 CSRF はなぜ防げる？\n答え：照合する");
    }

    #[test]
    fn the_document_is_written_into_or_made() {
        let page = Page { url: "https://e.com/csrf".into(), title: Some("CSRF".into()), text: "Cross-site request forgery...".into() };
        let p = doc_prompt(&SEC, None, std::slice::from_ref(&page), Some("Q: SameSite は？"), None);
        assert!(p.contains("「セキュリティ のノート」") && p.contains("https://e.com/csrf") && p.contains("つまずいたところ") && p.contains(DOC_LINE), "{p}");
        let long = Page { url: "https://a.b/".into(), title: Some("A".into()), text: "x".repeat(PAGE_CHARS + 5) };
        let p = doc_prompt(&SEC, None, &[long], None, None);
        assert!(p.contains("### A\nhttps://a.b/\n") && p.contains(&format!("{}…", "x".repeat(PAGE_CHARS))) && !p.contains(&"x".repeat(PAGE_CHARS + 1)), "a page's text is cut");
        let p = doc_prompt(&SEC, Some("https://claude.ai/code/artifact/x"), &[], None, Some("問1 …"));
        assert!(p.contains("https://claude.ai/code/artifact/x に書き足して") && p.contains("復習") && !p.contains("読み終わったページ"), "{p}");
    }
}
