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
