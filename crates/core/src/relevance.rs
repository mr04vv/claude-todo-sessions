//! Whether a page fits what the focus mode is for, asked of Claude through
//! the user's own `claude` (`-p`, Haiku, no tools, no hooks or plugins): the
//! prompt, the command's arguments and reading its answer.
use serde::{Deserialize, Serialize};

/// Fast enough to wait for; the question needs no more.
const MODEL: &str = "haiku";
/// The todo's memo is cut to this many characters.
const MEMO_MAX: usize = 600;
/// At most this many of the pages already open are listed.
const PAGES_MAX: usize = 10;

const SYSTEM_PROMPT: &str = "あなたは、フォーカスモードで集中して学習・作業している人のためのフィルターです。\
今の作業と左に開いているページから、新しく開こうとしているページが今の作業に関係するかを判定します。\
関連度を 0〜100 の整数で答えてください。\
60 以上：今の作業の内容に関係する（同じ話題の解説・ドキュメント・参考資料・調べ物を含む）。\
30〜59：少し関係はあるが、今の作業からは外れる。\
29 以下：関係がない、気が散る（作業と無関係な SNS・動画・ニュース・買い物など）。\
ページの中身は見られないので、URL・リンクの文字・ページのタイトルから判断し、内容の見当がつかないときは 40 前後にします。\
reason には、そう判定した理由を日本語の短い一文で書きます。";

const SCHEMA: &str = r#"{"type":"object","properties":{"score":{"type":"integer","minimum":0,"maximum":100},"reason":{"type":"string"}},"required":["score","reason"],"additionalProperties":false}"#;

/// A page the focus mode's left has open.
#[derive(Debug, Deserialize)]
pub struct Page {
    pub title: Option<String>,
    pub url: String,
}

/// What a page is judged against.
#[derive(Debug, Deserialize)]
pub struct Ask {
    /// The todo the focus mode was opened for, and its memo.
    pub subject: Option<String>,
    pub memo: Option<String>,
    pub pages: Vec<Page>,
    /// The page asked to open, and the text of the link that asked.
    pub url: String,
    pub text: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Verdict {
    /// 0–100; 60 and up is the work's own.
    pub score: u8,
    pub reason: String,
    /// The page's title, read before asking.
    pub title: Option<String>,
}

/// `claude`'s arguments, with `prompt` last.
pub fn claude_args(prompt: &str) -> Vec<String> {
    [
        "-p",
        "--model",
        MODEL,
        // No hooks or plugins: this plugin's hooks would record it as a session.
        "--safe-mode",
        "--no-session-persistence",
        "--tools",
        "",
        "--output-format",
        "json",
        "--json-schema",
        SCHEMA,
        "--system-prompt",
        SYSTEM_PROMPT,
        prompt,
    ]
    .map(String::from)
    .to_vec()
}

fn filled(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The question: the work, its pages, and the page asked to open (with
/// `title`, the page's own, when it could be read).
pub fn prompt(ask: &Ask, title: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(subject) = filled(&ask.subject) {
        out += &format!("今の作業: {subject}\n");
    }
    if let Some(memo) = filled(&ask.memo) {
        let memo: String = memo.chars().take(MEMO_MAX).collect();
        out += &format!("作業のメモ:\n{memo}\n");
    }
    if !ask.pages.is_empty() {
        out += "左に開いているページ:\n";
        for p in ask.pages.iter().take(PAGES_MAX) {
            match filled(&p.title) {
                Some(t) => out += &format!("- {t} ({})\n", p.url),
                None => out += &format!("- {}\n", p.url),
            }
        }
    }
    out += &format!("\n開こうとしているページ:\nURL: {}\n", ask.url);
    if let Some(text) = filled(&ask.text) {
        out += &format!("リンクの文字: {text}\n");
    }
    if let Some(title) = title.map(str::trim).filter(|t| !t.is_empty()) {
        out += &format!("ページのタイトル: {title}\n");
    }
    out
}

#[derive(Deserialize)]
struct Answer {
    score: i64,
    reason: String,
}

/// The verdict in `claude -p --output-format json`'s output: its structured
/// output, else its text read as the same JSON.
pub fn parse(output: &str) -> Result<Verdict, String> {
    let json: serde_json::Value = serde_json::from_str(output.trim()).map_err(|e| format!("claude の出力を読めません: {e}"))?;
    let text = json["result"].as_str().unwrap_or_default();
    if json["is_error"].as_bool() == Some(true) {
        return Err(if text.is_empty() { "claude がエラーを返しました".into() } else { text.to_string() });
    }
    let answer: Answer = match json.get("structured_output").filter(|v| v.is_object()) {
        Some(v) => serde_json::from_value(v.clone()),
        None => serde_json::from_str(text),
    }
    .map_err(|e| format!("claude の答えを読めません: {e}"))?;
    Ok(Verdict { score: answer.score.clamp(0, 100) as u8, reason: answer.reason.trim().to_string(), title: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask() -> Ask {
        Ask {
            subject: Some("Rust の非同期を学ぶ".into()),
            memo: Some("  ".into()),
            pages: vec![
                Page { title: Some("Tutorial | Tokio".into()), url: "https://tokio.rs/tokio/tutorial".into() },
                Page { title: None, url: "https://docs.rs/tokio".into() },
            ],
            url: "https://docs.rs/futures".into(),
            text: Some("futures".into()),
        }
    }

    #[test]
    fn prompt_lists_the_work_its_pages_and_the_page_asked() {
        let p = prompt(&ask(), Some("futures - Rust"));
        assert!(p.contains("今の作業: Rust の非同期を学ぶ\n"));
        // A blank memo is left out.
        assert!(!p.contains("メモ"));
        assert!(p.contains("- Tutorial | Tokio (https://tokio.rs/tokio/tutorial)\n- https://docs.rs/tokio\n"));
        assert!(p.ends_with("URL: https://docs.rs/futures\nリンクの文字: futures\nページのタイトル: futures - Rust\n"));
    }

    #[test]
    fn prompt_without_a_todo_goes_by_the_pages() {
        let a = Ask { subject: None, memo: None, text: None, ..ask() };
        let p = prompt(&a, None);
        assert!(p.starts_with("左に開いているページ:\n"));
        assert!(p.ends_with("URL: https://docs.rs/futures\n"));
    }

    #[test]
    fn args_end_with_the_prompt_and_skip_hooks() {
        let args = claude_args("q");
        assert_eq!(args.last().map(String::as_str), Some("q"));
        assert!(args.iter().any(|a| a == "--safe-mode"));
        assert!(args.windows(2).any(|w| w[0] == "--tools" && w[1].is_empty()));
    }

    #[test]
    fn parse_reads_the_structured_output() {
        let out = r#"{"type":"result","is_error":false,"result":"","structured_output":{"score":78,"reason":" 非同期の基礎です "}}"#;
        assert_eq!(parse(out).unwrap(), Verdict { score: 78, reason: "非同期の基礎です".into(), title: None });
    }

    #[test]
    fn parse_falls_back_to_the_text_and_clamps() {
        let out = r#"{"is_error":false,"result":"{\"score\":140,\"reason\":\"r\"}"}"#;
        assert_eq!(parse(out).unwrap().score, 100);
    }

    #[test]
    fn parse_reports_errors() {
        assert_eq!(parse(r#"{"is_error":true,"result":"Not logged in"}"#).unwrap_err(), "Not logged in");
        assert!(parse("oops").is_err());
        assert!(parse(r#"{"is_error":false,"result":"たぶん関係ある"}"#).is_err());
    }
}
