//! Whether a page fits what the focus mode is for, asked of TypeSafe's Jev
//! (a System One model: typed answers with probabilities, no text): the
//! state it is given, the question, reading its answer, and its API key.
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const MODEL: &str = "jev-latest";
const TIMEOUT: Duration = Duration::from_secs(10);
/// The API key's Keychain item (this one only), set from the app.
const KEYCHAIN_SERVICE: &str = "todo-sessions-jev";
/// The key when the Keychain has none.
const KEY_ENV: &str = "TYPESAFE_API_KEY";
/// Shown when there is no key; the app offers to set one when it sees it.
pub const NO_KEY: &str = "Jev の API キーが設定されていません";
/// The todo's memo is cut to this many characters.
const MEMO_MAX: usize = 600;
/// At most this many of the pages already open are listed.
const PAGES_MAX: usize = 10;
/// The answer's id in the request and the response.
const QUESTION_ID: &str = "related";
const QUESTION: &str = "Someone is studying or working in a focus mode, keeping away from distractions. \
The state gives their current work (a todo's title and memo, when there is one), the pages they have open, \
and a page they are about to open (its URL, the text of the link that leads to it, and the page's title, when known). \
The text may be in Japanese. \
Is the page about to be opened relevant to the current work: material on the same topic, such as documentation, \
articles, references or research that helps with it? \
It is not when it is unrelated to the work or likely to distract (social media, videos, news or shopping that have \
nothing to do with the work), nor when what it is about cannot be told.";

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
    /// How likely the page is the work's own, in percent.
    pub score: u8,
    /// The page's title, read before asking.
    pub title: Option<String>,
}

fn filled(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// What Jev looks at: the work, its pages, and the page asked to open (with
/// `title`, the page's own, when it could be read).
pub fn state(ask: &Ask, title: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(subject) = filled(&ask.subject) {
        out += &format!("Current work: {subject}\n");
    }
    if let Some(memo) = filled(&ask.memo) {
        let memo: String = memo.chars().take(MEMO_MAX).collect();
        out += &format!("Memo on the work:\n{memo}\n");
    }
    if !ask.pages.is_empty() {
        out += "Pages open:\n";
        for p in ask.pages.iter().take(PAGES_MAX) {
            match filled(&p.title) {
                Some(t) => out += &format!("- {t} ({})\n", p.url),
                None => out += &format!("- {}\n", p.url),
            }
        }
    }
    out += &format!("\nPage about to be opened:\nURL: {}\n", ask.url);
    if let Some(text) = filled(&ask.text) {
        out += &format!("Link text: {text}\n");
    }
    if let Some(title) = title.map(str::trim).filter(|t| !t.is_empty()) {
        out += &format!("Page title: {title}\n");
    }
    out
}

/// The request: one yes/no (Noul) question about `state`.
pub fn request(state: &str) -> Value {
    json!({
        "model": MODEL,
        "state": state,
        "questions": { QUESTION_ID: { "type": "noul", "instructions": QUESTION } },
    })
}

/// The probability of yes in Jev's response, as a percentage.
pub fn parse(resp: &Value) -> Result<u8, String> {
    let answer = &resp["answers"][QUESTION_ID];
    let p = ["noul", "value", "probability"]
        .iter()
        .find_map(|k| answer[k].as_f64())
        .ok_or_else(|| format!("Jev の答えを読めません: {resp}"))?;
    Ok((p.clamp(0.0, 1.0) * 100.0).round() as u8)
}

/// How much the page fits the work, by Jev; `title` is the page's own.
pub fn judge(ask: &Ask, title: Option<String>) -> Result<Verdict, String> {
    let key = api_key().ok_or(NO_KEY)?;
    let resp = post(ENDPOINT, &key, &request(&state(ask, title.as_deref())))?;
    Ok(Verdict { score: parse(&resp)?, title })
}

fn post(endpoint: &str, key: &str, body: &Value) -> Result<Value, String> {
    // Errors come with a body that says why.
    let config = ureq::Agent::config_builder().timeout_global(Some(TIMEOUT)).http_status_as_error(false).build();
    // Sent as bytes, so it goes with its Content-Length rather than chunked.
    let body = serde_json::to_vec(body).map_err(|e| e.to_string())?;
    let mut resp = ureq::Agent::new_with_config(config)
        .post(endpoint)
        .header("Authorization", &format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .send(&body[..])
        .map_err(|e| format!("Jev: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.body_mut().read_to_string().map_err(|e| format!("Jev: {e}"))?;
    match status {
        200..=299 => serde_json::from_str(&text).map_err(|e| format!("Jev の応答を読めません: {e}")),
        401 | 403 => Err(format!("Jev の API キーが通りません（{status}）")),
        _ => Err(format!("Jev: {status} {}", text.trim())),
    }
}

/// `security` on the key's own item. Like the Claude credentials (cloud.rs),
/// the item is made by the `security` CLI, which then reads it without a
/// prompt, whatever build of the app asks.
fn keychain(command: &str, extra: &[&str]) -> Result<Vec<u8>, String> {
    let account = std::env::var("USER").map_err(|_| "USER is not set".to_string())?;
    let out = std::process::Command::new("/usr/bin/security")
        .args([command, "-a", &account, "-s", KEYCHAIN_SERVICE])
        .args(extra)
        .output()
        .map_err(|e| format!("security: {e}"))?;
    if !out.status.success() {
        return Err(format!("security {command}: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(out.stdout)
}

/// The key set in the app, else the environment's.
pub fn api_key() -> Option<String> {
    keychain("find-generic-password", &["-w"])
        .ok()
        .map(|raw| String::from_utf8_lossy(&raw).trim().to_string())
        .filter(|k| !k.is_empty())
        .or_else(|| std::env::var(KEY_ENV).ok().filter(|k| !k.is_empty()))
}

/// Keeps `key` in the Keychain; an empty one takes it out.
pub fn set_api_key(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        // Not being there already is fine.
        let _ = keychain("delete-generic-password", &[]);
        return Ok(());
    }
    // -U updates the item in place.
    keychain("add-generic-password", &["-w", key, "-U"]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

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
    fn state_lists_the_work_its_pages_and_the_page_asked() {
        let s = state(&ask(), Some("futures - Rust"));
        assert!(s.starts_with("Current work: Rust の非同期を学ぶ\n"));
        // A blank memo is left out.
        assert!(!s.contains("Memo"));
        assert!(s.contains("- Tutorial | Tokio (https://tokio.rs/tokio/tutorial)\n- https://docs.rs/tokio\n"));
        assert!(s.ends_with("URL: https://docs.rs/futures\nLink text: futures\nPage title: futures - Rust\n"));
    }

    #[test]
    fn state_without_a_todo_goes_by_the_pages() {
        let a = Ask { subject: None, memo: None, text: None, ..ask() };
        let s = state(&a, None);
        assert!(s.starts_with("Pages open:\n"));
        assert!(s.ends_with("URL: https://docs.rs/futures\n"));
    }

    #[test]
    fn request_asks_one_noul_question() {
        let r = request("s");
        assert_eq!(r["model"], MODEL);
        assert_eq!(r["state"], "s");
        assert_eq!(r["questions"][QUESTION_ID]["type"], "noul");
    }

    #[test]
    fn parse_reads_the_probability_as_a_percentage() {
        assert_eq!(parse(&json!({"answers": {"related": {"type": "noul", "noul": 0.934}}})).unwrap(), 93);
        assert_eq!(parse(&json!({"answers": {"related": {"value": 1.2}}})).unwrap(), 100);
        assert!(parse(&json!({"answers": {}})).is_err());
    }

    /// Answers one request with `status` and `body`, handing back what was sent.
    fn serve_once(status: &'static str, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/systemone", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            let mut len = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
                head += &line;
                if line == "\r\n" {
                    break;
                }
            }
            let mut sent = vec![0; len];
            reader.read_exact(&mut sent).unwrap();
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            head + &String::from_utf8(sent).unwrap()
        });
        (url, handle)
    }

    #[test]
    fn post_sends_the_key_and_reads_the_answer() {
        let (url, server) = serve_once("200 OK", r#"{"model":"jev-latest","answers":{"related":{"type":"noul","noul":0.7}}}"#);
        let resp = post(&url, "k1", &request("s")).unwrap();
        assert_eq!(parse(&resp).unwrap(), 70);
        let sent = server.join().unwrap();
        assert!(sent.to_ascii_lowercase().contains("authorization: bearer k1\r\n"));
        assert!(sent.contains(r#""type":"noul""#));
    }

    #[test]
    fn post_reports_a_refused_key_and_other_errors() {
        let (url, server) = serve_once("401 Unauthorized", r#"{"error":"bad key"}"#);
        assert_eq!(post(&url, "k", &request("s")).unwrap_err(), "Jev の API キーが通りません（401）");
        server.join().unwrap();
        let (url, server) = serve_once("400 Bad Request", r#"{"error":"questions"}"#);
        assert_eq!(post(&url, "k", &request("s")).unwrap_err(), r#"Jev: 400 {"error":"questions"}"#);
        server.join().unwrap();
    }
}
