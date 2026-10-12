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
/// How it reports one made from an Artifact type, and a later write to one.
const MADE_AT: [&str; 2] = ["Created a new Artifact at ", "Updated the Artifact at "];
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

/// The tools whose results tell what a session made: the Artifact tool, and
/// the Docs connector's writes (its reads name docs too, made by anyone).
const ARTIFACT_TOOL: &str = "Artifact";
const DOCS_WRITES: [&str; 3] = ["Claude_Docs__create", "Claude_Docs__batch", "Claude_Docs__update"];

fn makes_artifacts(tool: &str) -> bool {
    tool == ARTIFACT_TOOL || DOCS_WRITES.iter().any(|w| tool.ends_with(w))
}

/// Every artifact a session published and every doc it made, as those
/// tools' results tell (a result whose call is not among the entries is
/// left out), once each (a new version is the same one), in the order made.
/// What other tools show (a page read, code holding such a line) is not them.
pub fn artifacts(entries: &[Value]) -> Vec<Found> {
    let mut tools = std::collections::HashMap::new();
    let mut found = Vec::new();
    for block in entries.iter().flat_map(|e| e["message"]["content"].as_array().into_iter().flatten()) {
        match block["type"].as_str() {
            Some("tool_use") => {
                if let (Some(id), Some(name)) = (block["id"].as_str(), block["name"].as_str()) {
                    tools.insert(id, name);
                }
            }
            Some("tool_result") if block["tool_use_id"].as_str().and_then(|id| tools.get(id)).is_some_and(|t| makes_artifacts(t)) => {
                found.extend(made_in(&result_text(block)));
            }
            _ => {}
        }
    }
    let mut seen = std::collections::HashSet::new();
    found.into_iter().filter(|f| seen.insert(f.url.clone())).collect()
}

/// A tool result's text: its content, or its text blocks.
fn result_text(block: &Value) -> String {
    match &block["content"] {
        Value::String(s) => s.clone(),
        v => v.as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
    }
}

/// What one result of those tools tells made, in its order.
fn made_in(text: &str) -> Vec<Found> {
    let mut found: Vec<(usize, Found)> = Vec::new();
    for (i, _) in text.match_indices(PUBLISHED) {
        let line = until_line_end(&text[i + PUBLISHED.len()..]);
        let Some(j) = line.find(PUBLISHED_AT) else { continue };
        let Some(url) = artifact_at(&line[j + PUBLISHED_AT.len()..]) else { continue };
        let file = line[..j].rsplit('/').next().unwrap_or_default();
        let title = file.rsplit_once('.').map_or(file, |(stem, _)| stem).trim();
        found.push((i, Found { url, title: (!title.is_empty()).then(|| title.to_string()), doc: false }));
    }
    for made in MADE_AT {
        for (i, _) in text.match_indices(made) {
            if let Some(url) = artifact_at(&text[i + made.len()..]) {
                found.push((i, Found { url, title: None, doc: false }));
            }
        }
    }
    for (i, _) in text.match_indices(DOC_BORN) {
        if let Some(url) = artifact_at(text[i + DOC_BORN.len()..].trim_start_matches(['\\', '"', ':'])) {
            found.push((i, Found { url, title: None, doc: true }));
        }
    }
    found.sort_by_key(|(i, _)| *i);
    found.into_iter().map(|(_, f)| f).collect()
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

    /// A tool called (by id) and what it gave back.
    fn tool(id: &str, name: &str, result: Value) -> [Value; 2] {
        [
            assistant(json!([{"type": "tool_use", "id": id, "name": name, "input": {}}]), json!({})),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": id, "content": result}]}}),
        ]
    }

    #[test]
    fn every_artifact_and_doc_a_session_made_is_found_once() {
        let doc = json!([{"type": "text", "text": "{\"frame\":{\"artifactUrl\":\"https://claude.ai/code/artifact/e1e71452-f7a7\"}}"}]);
        let entries: Vec<Value> = [
            vec![json!({"type": "user", "message": {"content": "see https://claude.ai/artifact/abc123 in the docs"}})],
            tool("t1", "Artifact", json!("Published /tmp/work/比較表.html at https://claude.ai/artifact/1UnAnmsD3RX7 (Version 1)\n\nLive subscription")).to_vec(),
            tool("t2", "mcp__claude_ai_Claude_Docs__batch", doc).to_vec(),
            tool("t3", "Artifact", json!("Published /tmp/work/比較表.html at https://claude.ai/artifact/1UnAnmsD3RX7 (Version 2)")).to_vec(),
        ]
        .concat();
        assert_eq!(
            artifacts(&entries),
            vec![
                Found { url: "https://claude.ai/artifact/1UnAnmsD3RX7".into(), title: Some("比較表".into()), doc: false },
                Found { url: "https://claude.ai/code/artifact/e1e71452-f7a7".into(), title: None, doc: true },
            ],
            "a link merely mentioned is not one, and a new version is the same one"
        );
        assert!(artifacts(&[]).is_empty());
    }

    #[test]
    fn an_artifact_made_from_a_type_is_found_too() {
        let entries: Vec<Value> = [
            tool("t1", "Artifact", json!("Created a new Artifact at https://claude.ai/artifact/RPPwKWPE6T (version 1791448708-1c76) from the Artifact type https://claude.ai/artifact/QKN21svewx (release 1).")),
            tool("t2", "Artifact", json!("Updated the Artifact at https://claude.ai/artifact/RPPwKWPE6T (Version 2, version id 1) with /tmp/a.json")),
            tool("t3", "Artifact", json!("Updated the Artifact at https://claude.ai/artifact/Older9 (Version 5, version id 1) with /tmp/b.json")),
        ]
        .concat();
        assert_eq!(
            artifacts(&entries),
            vec![
                Found { url: "https://claude.ai/artifact/RPPwKWPE6T".into(), title: None, doc: false },
                Found { url: "https://claude.ai/artifact/Older9".into(), title: None, doc: false },
            ],
            "the type it is made from is not one of them"
        );
    }

    #[test]
    fn what_other_tools_show_of_artifacts_is_not_made() {
        let entries: Vec<Value> = [
            tool("t1", "Bash", json!("Published /tmp/a.html at https://claude.ai/artifact/Fake1 (Version 1)")),
            tool("t2", "Read", json!("Created a new Artifact at https://claude.ai/artifact/Fake2 (version 1)")),
            tool("t3", "mcp__claude_ai_Claude_Docs__read", json!([{"type": "text", "text": "{\"artifactUrl\":\"https://claude.ai/code/artifact/someone-else\"}"}])),
        ]
        .concat();
        assert!(artifacts(&entries).is_empty(), "a page read, or code that holds such a line, is not made by the session");
        let orphan = json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "gone", "content": "Published /tmp/a.html at https://claude.ai/artifact/Cut1 (Version 1)"}]}});
        assert!(artifacts(&[orphan]).is_empty(), "a result whose call was cut off is not known to be one");
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
