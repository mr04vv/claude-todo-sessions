//! What a session is doing now, read from its messages: the JSONL
//! transcript of a local session, or the events of a cloud one. Both hold
//! `{"type": "assistant", "message": {…}}` entries in the Messages API shape.

use serde::Serialize;
use serde_json::Value;

/// Tool calls kept for "直近の操作", newest first.
pub const RECENT_TOOLS: usize = 5;
/// Characters kept of the last message and of a tool call's summary.
const TEXT_MAX_CHARS: usize = 800;
const TOOL_SUMMARY_MAX_CHARS: usize = 100;
/// Input fields that say what a tool call touched, in order of preference.
const TOOL_SUMMARY_KEYS: &[&str] = &["file_path", "command", "pattern", "url", "query", "description", "prompt", "path"];

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct ToolCall {
    pub name: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Detail {
    pub model: Option<String>,
    /// Tokens the last request sent: the context the session carries now.
    pub context_tokens: Option<u64>,
    pub last_text: Option<String>,
    /// Newest first.
    pub tools: Vec<ToolCall>,
}

/// Summarizes entries given oldest first.
pub fn detail<'a>(entries: impl IntoIterator<Item = &'a Value>) -> Detail {
    let mut d = Detail::default();
    let mut tools = Vec::new();
    for e in entries.into_iter().filter(|e| e["type"] == "assistant") {
        let message = &e["message"];
        if let Some(m) = message["model"].as_str() {
            d.model = Some(m.into());
        }
        let usage = &message["usage"];
        let sent: u64 = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
            .iter()
            .filter_map(|k| usage[k].as_u64())
            .sum();
        if sent > 0 {
            d.context_tokens = Some(sent);
        }
        for block in message["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("text") => {
                    if let Some(t) = block["text"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                        d.last_text = Some(t.chars().take(TEXT_MAX_CHARS).collect());
                    }
                }
                Some("tool_use") => tools.push(ToolCall {
                    name: block["name"].as_str().unwrap_or_default().into(),
                    summary: tool_summary(&block["input"]),
                }),
                _ => {}
            }
        }
    }
    d.tools = tools.into_iter().rev().take(RECENT_TOOLS).collect();
    d
}

/// First line of the input field that best says what the call touched.
fn tool_summary(input: &Value) -> String {
    TOOL_SUMMARY_KEYS
        .iter()
        .find_map(|k| input[k].as_str())
        .and_then(|s| s.lines().next())
        .map(|s| s.chars().take(TOOL_SUMMARY_MAX_CHARS).collect())
        .unwrap_or_default()
}

const ARTIFACT_HOST: &str = "https://claude.ai/";
const ARTIFACT_PAGES: [&str; 2] = ["https://claude.ai/artifact/", "https://claude.ai/code/artifact/"];
/// How the Artifact tool reports a publish: "Published <file> at <url> (…".
const PUBLISHED: &str = "Published ";
const PUBLISHED_AT: &str = " at ";
/// The Docs connector's ack for a new doc: `"artifactUrl":"<url>"`.
const DOC_BORN: &str = "artifactUrl";
/// The line a note session ends its first answer with (launch::note_prompt).
pub const NOTE_LINE: &str = "NOTE_URL: ";

/// The note a session made (the focus mode's "ノート"): the first artifact it
/// published, the first doc it made (shown as it fills), or the one its
/// NOTE_LINE names, in its transcript or events (as text, its quotes escaped
/// once or more). Placeholders and links merely mentioned are not it.
pub fn note_url(text: &str) -> Option<String> {
    let published = text.match_indices(PUBLISHED).find_map(|(i, _)| {
        let line = until_line_end(&text[i + PUBLISHED.len()..]);
        line.find(PUBLISHED_AT).and_then(|j| artifact_at(&line[j + PUBLISHED_AT.len()..]))
    });
    let born = || {
        text.match_indices(DOC_BORN)
            .find_map(|(i, _)| artifact_at(text[i + DOC_BORN.len()..].trim_start_matches(['\\', '"', ':'])))
    };
    // The line is asked for as "NOTE_URL: <url>"; it may come in brackets or
    // as a Markdown link, so the link is looked for on the rest of the line.
    let named = || {
        text.match_indices(NOTE_LINE).find_map(|(i, _)| {
            let line = until_line_end(&text[i + NOTE_LINE.len()..]);
            line.find(ARTIFACT_HOST).and_then(|j| artifact_at(&line[j..]))
        })
    };
    published.or_else(born).or_else(named)
}

/// Up to the end of the line, also where the line is a JSON string's.
fn until_line_end(s: &str) -> &str {
    &s[..s.find(['\n', '"', '\\']).unwrap_or(s.len())]
}

/// Where a link ends in text: a space, a quote, a bracket, an escape.
const LINK_END: &[char] = &['"', '\'', '`', '(', ')', '<', '>', '[', ']', '\\', ','];

/// The artifact link `s` starts with. Its last part is `[<title>-]<id>`, the
/// title in any letters; the id is letters and digits, so what follows it
/// (a "。") is left out.
fn artifact_at(s: &str) -> Option<String> {
    let page = ARTIFACT_PAGES.iter().find(|p| s.starts_with(**p))?;
    let rest = &s[page.len()..];
    let end = rest.find(|c: char| c.is_whitespace() || LINK_END.contains(&c)).unwrap_or(rest.len());
    let id = rest[..end].trim_end_matches(|c: char| !c.is_ascii_alphanumeric());
    (!id.is_empty()).then(|| format!("{page}{id}"))
}

/// Entries of a JSONL transcript. The first line may be cut off when only
/// the tail of the file was read, and is skipped when it does not parse.
pub fn parse_jsonl(text: &str) -> Vec<Value> {
    text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// Entries of a cloud session's events page, which lists newest first.
pub fn from_events(events: &Value) -> Vec<Value> {
    let mut entries: Vec<Value> = events["data"].as_array().into_iter().flatten().map(|e| e["payload"].clone()).collect();
    entries.reverse();
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assistant(content: Value, usage: Value) -> Value {
        json!({"type": "assistant", "message": {"model": "claude-opus-5-5", "content": content, "usage": usage}})
    }

    #[test]
    fn takes_last_text_context_and_recent_tools() {
        let entries = [
            json!({"type": "user", "message": {"content": "go"}}),
            assistant(json!([{"type": "text", "text": "first"}]), json!({"input_tokens": 1, "cache_read_input_tokens": 10, "cache_creation_input_tokens": 5})),
            assistant(json!([{"type": "tool_use", "name": "Read", "input": {"file_path": "/a/b.rs"}}]), json!({"input_tokens": 2, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 3})),
            assistant(json!([{"type": "tool_use", "name": "Bash", "input": {"command": "cargo test\n--all"}}]), json!({"input_tokens": 2, "cache_read_input_tokens": 200, "cache_creation_input_tokens": 3})),
            assistant(json!([{"type": "thinking", "thinking": ""}, {"type": "text", "text": "どちらにしますか？"}]), json!({"input_tokens": 2, "cache_read_input_tokens": 300, "cache_creation_input_tokens": 4})),
        ];
        let d = detail(&entries);
        assert_eq!(d.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(d.context_tokens, Some(306));
        assert_eq!(d.last_text.as_deref(), Some("どちらにしますか？"));
        assert_eq!(
            d.tools,
            [ToolCall { name: "Bash".into(), summary: "cargo test".into() }, ToolCall { name: "Read".into(), summary: "/a/b.rs".into() }]
        );
    }

    #[test]
    fn keeps_only_the_newest_tools() {
        let entries: Vec<Value> = (0..RECENT_TOOLS + 3)
            .map(|i| assistant(json!([{"type": "tool_use", "name": format!("T{i}"), "input": {}}]), json!({})))
            .collect();
        let d = detail(&entries);
        assert_eq!(d.tools.len(), RECENT_TOOLS);
        assert_eq!(d.tools[0].name, format!("T{}", RECENT_TOOLS + 2));
        assert_eq!(d.tools[0].summary, "");
    }

    #[test]
    fn empty_transcript_has_nothing() {
        assert_eq!(detail(&[]), Detail::default());
    }

    #[test]
    fn jsonl_skips_a_cut_first_line_and_blank_lines() {
        let v = parse_jsonl("e\": 1}\n{\"type\": \"user\"}\n\n{\"type\": \"assistant\"}\n");
        assert_eq!(v, [json!({"type": "user"}), json!({"type": "assistant"})]);
    }

    #[test]
    fn the_note_is_the_first_artifact_published() {
        let text = concat!(
            r#"{"type":"user","message":{"content":"see https://claude.ai/artifact/{id} and https://claude.ai/artifact/abc123 in the docs"}}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"Published /tmp/note.html at https://claude.ai/artifact/1UnAnmsD3RX7oDxWBD5q9c (Version 1)\n\nLive subscription"}]}}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"Published /tmp/other.html at https://claude.ai/artifact/Zz9 (Version 1)"}]}}"#,
        );
        assert_eq!(note_url(text).as_deref(), Some("https://claude.ai/artifact/1UnAnmsD3RX7oDxWBD5q9c"));
    }

    #[test]
    fn a_doc_is_known_from_its_birth() {
        // The Docs connector's ack, a JSON string inside the transcript's line.
        let text = r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"{\"created\":{\"minted\":\"e1e7\"},\"frame\":{\"url\":\"https://claude.ai/code/artifact/e1e71452-f7a7\",\"artifactUrl\":\"https://claude.ai/code/artifact/e1e71452-f7a7\"}}"}]}}"#;
        assert_eq!(note_url(text).as_deref(), Some("https://claude.ai/code/artifact/e1e71452-f7a7"));
        // As events serialized again, the quotes are escaped once more.
        assert_eq!(note_url(&serde_json::to_string(text).unwrap()).as_deref(), Some("https://claude.ai/code/artifact/e1e71452-f7a7"));
    }

    #[test]
    fn the_note_line_names_it_too() {
        let text = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"できました。\nNOTE_URL: https://claude.ai/code/artifact/8574c0b4-3336-416f"}]}}"#;
        assert_eq!(note_url(text).as_deref(), Some("https://claude.ai/code/artifact/8574c0b4-3336-416f"));
        assert_eq!(note_url("Published /a at https://claude.ai/artifact/ (Version 1)"), None);
        // A doc's link may lead with its title, and a sentence may follow it.
        assert_eq!(
            note_url("NOTE_URL: https://claude.ai/artifact/Rust-の所有権-3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90。").as_deref(),
            Some("https://claude.ai/artifact/Rust-の所有権-3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90")
        );
        assert_eq!(note_url("NOTE_URL: <https://claude.ai/code/artifact/Q3-plan%E3%81%AE-abcDEF0123456789abcdef>").as_deref(), Some("https://claude.ai/code/artifact/Q3-plan%E3%81%AE-abcDEF0123456789abcdef"));
        // Cloud sessions write it as a Markdown link.
        assert_eq!(
            note_url("NOTE_URL: [Server Components ノート](https://claude.ai/artifact/Ab3dEf6hIj9kLm2nOp5qRs)\n").as_deref(),
            Some("https://claude.ai/artifact/Ab3dEf6hIj9kLm2nOp5qRs")
        );
        assert_eq!(note_url("NOTE_URL: まだありません\nhttps://claude.ai/artifact/Ab3dEf6hIj9kLm2nOp5qRs"), None);
        assert_eq!(note_url("nothing published"), None);
    }

    #[test]
    fn events_come_back_oldest_first_as_payloads() {
        let events = json!({"data": [
            {"sequence_num": "2", "payload": {"type": "assistant", "message": {"content": [{"type": "text", "text": "late"}]}}},
            {"sequence_num": "1", "payload": {"type": "assistant", "message": {"content": [{"type": "text", "text": "early"}]}}}
        ]});
        let e = from_events(&events);
        assert_eq!(e.len(), 2);
        assert_eq!(detail(&e).last_text.as_deref(), Some("late"));
    }
}
