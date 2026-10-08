//! What a session is doing now, read from its messages: the JSONL
//! transcript of a local session, or the events of a cloud one. Both hold
//! `{"type": "assistant", "message": {…}}` entries in the Messages API shape.

use serde_json::Value;

/// Characters kept of what a session asks (a list's one line).
pub const QUESTION_MAX_CHARS: usize = 200;
const ASK_TOOL: &str = "AskUserQuestion";

/// What a session waiting for a reply asks, in one line: the questions of
/// its last AskUserQuestion, or else (when a message came after it) the first
/// line of its last message. Entries oldest first.
pub fn question<'a>(entries: impl IntoIterator<Item = &'a Value>) -> Option<String> {
    let mut asked = None;
    for e in entries.into_iter().filter(|e| e["type"] == "assistant") {
        for block in e["message"]["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("text") => {
                    if let Some(line) = block["text"].as_str().and_then(|t| t.lines().map(str::trim).find(|l| !l.is_empty())) {
                        asked = Some(line.to_string());
                    }
                }
                Some("tool_use") if block["name"] == ASK_TOOL => {
                    let questions: Vec<&str> = block["input"]["questions"].as_array().into_iter().flatten().filter_map(|q| q["question"].as_str()).collect();
                    if !questions.is_empty() {
                        asked = Some(questions.join(" / "));
                    }
                }
                _ => {}
            }
        }
    }
    asked.map(|q| q.chars().take(QUESTION_MAX_CHARS).collect())
}

const ARTIFACT_HOST: &str = "https://claude.ai/";
const ARTIFACT_PAGES: [&str; 2] = ["https://claude.ai/artifact/", "https://claude.ai/code/artifact/"];
/// How the Artifact tool reports a publish: "Published <file> at <url> (…".
const PUBLISHED: &str = "Published ";
const PUBLISHED_AT: &str = " at ";
/// The Docs connector's ack for a new doc: `"artifactUrl":"<url>"`.
const DOC_BORN: &str = "artifactUrl";
/// The line a theme's document's writer ends with (study::doc_prompt).
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

/// An artifact or a doc a session made, as its record tells it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub url: String,
    /// A published artifact's file name, without its extension.
    pub title: Option<String>,
    /// A Claude Docs document (else an artifact).
    pub doc: bool,
}

/// Every artifact a session published and every doc it made, in its
/// transcript or events, once each (a new version is the same one), in the
/// order made. Links merely mentioned are not them.
pub fn artifacts(text: &str) -> Vec<Found> {
    let mut found: Vec<(usize, Found)> = Vec::new();
    for (i, _) in text.match_indices(PUBLISHED) {
        let line = until_line_end(&text[i + PUBLISHED.len()..]);
        let Some(j) = line.find(PUBLISHED_AT) else { continue };
        let Some(url) = artifact_at(&line[j + PUBLISHED_AT.len()..]) else { continue };
        let file = line[..j].rsplit('/').next().unwrap_or_default();
        let title = file.rsplit_once('.').map_or(file, |(stem, _)| stem).trim();
        found.push((i, Found { url, title: (!title.is_empty()).then(|| title.to_string()), doc: false }));
    }
    for (i, _) in text.match_indices(DOC_BORN) {
        if let Some(url) = artifact_at(text[i + DOC_BORN.len()..].trim_start_matches(['\\', '"', ':'])) {
            found.push((i, Found { url, title: None, doc: true }));
        }
    }
    found.sort_by_key(|(i, _)| *i);
    let mut seen = std::collections::HashSet::new();
    found.into_iter().map(|(_, f)| f).filter(|f| seen.insert(f.url.clone())).collect()
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
    fn the_question_is_what_ask_user_question_asks() {
        let entries = [
            assistant(json!([{"type": "text", "text": "調べました。"}]), json!({})),
            assistant(
                json!([{"type": "tool_use", "name": "AskUserQuestion", "input": {"questions": [
                    {"question": "どちらの方式にしますか？", "header": "方式", "options": []},
                    {"question": "テストも書きますか？", "header": "テスト", "options": []}
                ]}}]),
                json!({}),
            ),
        ];
        assert_eq!(question(&entries).as_deref(), Some("どちらの方式にしますか？ / テストも書きますか？"));
    }

    #[test]
    fn without_a_question_it_is_the_last_messages_first_line() {
        let entries = [
            assistant(json!([{"type": "tool_use", "name": "AskUserQuestion", "input": {"questions": [{"question": "前の質問"}]}}]), json!({})),
            assistant(json!([{"type": "text", "text": "\n実装しました。PR を作りますか？\n詳細は下に。"}]), json!({})),
        ];
        assert_eq!(question(&entries).as_deref(), Some("実装しました。PR を作りますか？"));
        assert_eq!(question(&[]), None);
    }

    #[test]
    fn a_long_question_is_cut() {
        let long = "あ".repeat(QUESTION_MAX_CHARS + 50);
        let entries = [assistant(json!([{"type": "text", "text": long}]), json!({}))];
        assert_eq!(question(&entries).unwrap().chars().count(), QUESTION_MAX_CHARS);
    }

    #[test]
    fn every_artifact_and_doc_a_session_made_is_found_once() {
        let text = concat!(
            r#"{"type":"user","message":{"content":"see https://claude.ai/artifact/abc123 in the docs"}}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"Published /tmp/work/比較表.html at https://claude.ai/artifact/1UnAnmsD3RX7 (Version 1)"}]}}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"{\"frame\":{\"artifactUrl\":\"https://claude.ai/code/artifact/e1e71452-f7a7\"}}"}]}}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"Published /tmp/work/比較表.html at https://claude.ai/artifact/1UnAnmsD3RX7 (Version 2)"}]}}"#,
        );
        assert_eq!(
            artifacts(text),
            vec![
                Found { url: "https://claude.ai/artifact/1UnAnmsD3RX7".into(), title: Some("比較表".into()), doc: false },
                Found { url: "https://claude.ai/code/artifact/e1e71452-f7a7".into(), title: None, doc: true },
            ],
            "a link merely mentioned is not one, and a new version is the same one"
        );
        assert!(artifacts("nothing").is_empty());
    }

    #[test]
    fn events_come_back_oldest_first_as_payloads() {
        let events = json!({"data": [
            {"sequence_num": "2", "payload": {"type": "assistant", "message": {"content": [{"type": "text", "text": "late"}]}}},
            {"sequence_num": "1", "payload": {"type": "assistant", "message": {"content": [{"type": "text", "text": "early"}]}}}
        ]});
        let e = from_events(&events);
        assert_eq!(e.len(), 2);
        assert_eq!(question(&e).as_deref(), Some("late"));
    }
}
