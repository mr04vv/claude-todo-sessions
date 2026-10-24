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

/// Characters kept of a session's last reply (a card's two lines).
pub const LAST_MAX_CHARS: usize = 280;

/// What a session's card shows of where it is: its last reply (in one line),
/// the model answering, and how full its context is (tokens, as of its last turn).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Peek {
    pub last: Option<String>,
    pub model: Option<String>,
    pub context_tokens: Option<u64>,
}

/// The peek of a session from its entries, oldest first.
pub fn peek(entries: &[Value]) -> Peek {
    let replies: Vec<&Value> = entries.iter().filter(|e| e["type"] == "assistant").collect();
    let last = replies.iter().rev().find_map(|e| {
        let text: Vec<&str> = e["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
        let line = text.join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
        (!line.is_empty()).then(|| line.chars().take(LAST_MAX_CHARS).collect())
    });
    let model = replies.iter().rev().find_map(|e| e["message"]["model"].as_str().map(String::from));
    let context_tokens = replies.last().map(|e| &e["message"]["usage"]).filter(|u| u.is_object()).map(|u| {
        ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"].iter().map(|k| u[k].as_u64().unwrap_or(0)).sum()
    });
    Peek { last, model, context_tokens }
}

/// Characters of one message a digest keeps.
const DIGEST_LINE_CHARS: usize = 300;
/// Characters of a session's latest messages a summary is made from.
pub const SUMMARY_SOURCE_CHARS: usize = 6000;

/// A session's latest messages as lines, newest last, within `max_chars`:
/// what was asked (依頼), what Claude said, and the tools it used (操作).
pub fn digest(entries: &[Value], max_chars: usize) -> String {
    let clip = |t: &str| t.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(DIGEST_LINE_CHARS).collect::<String>();
    let mut lines = Vec::new();
    for e in entries {
        let content = &e["message"]["content"];
        match e["type"].as_str() {
            Some("user") => {
                let asked = content.as_str().map(String::from).unwrap_or_else(|| content.as_array().into_iter().flatten().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(" "));
                if !asked.trim().is_empty() {
                    lines.push(format!("依頼: {}", clip(&asked)));
                }
            }
            Some("assistant") => {
                for b in content.as_array().into_iter().flatten() {
                    match b["type"].as_str() {
                        Some("text") => {
                            if let Some(t) = b["text"].as_str().filter(|t| !t.trim().is_empty()) {
                                lines.push(format!("Claude: {}", clip(t)));
                            }
                        }
                        Some("tool_use") => lines.push(format!("操作: {}", b["name"].as_str().unwrap_or("?"))),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    let mut kept = Vec::new();
    let mut used = 0;
    for line in lines.iter().rev() {
        let size = line.chars().count() + usize::from(!kept.is_empty());
        if used + size > max_chars {
            break;
        }
        used += size;
        kept.push(line.as_str());
    }
    kept.reverse();
    kept.join("\n")
}

/// The ask for a one-line summary of where a session stands, from its digest.
pub fn summary_prompt(digest: &str) -> String {
    format!(
        "次は、Claude Code のセッションの最近のやり取りです（古い順、最後が最新）。\n\
         このセッションが「いま何をしていて、どこまで進んだか」を、日本語の1文（40字以内）で要約してください。\n\
         - 主語は省き、「〜を実装中。テストは通過」「〜の方針を確認待ち」のように書く\n\
         - 前置き、引用符、絵文字、Markdown は付けない。要約の文だけを返す\n\n\
         <messages>\n{digest}\n</messages>"
    )
}

const ARTIFACT_PAGES: [&str; 2] = ["https://claude.ai/artifact/", "https://claude.ai/code/artifact/"];
/// How the Artifact tool reports a publish: "Published <file> at <url> (…".
const PUBLISHED: &str = "Published ";
const PUBLISHED_AT: &str = " at ";
/// How it reports one made from an Artifact type, and a later write to one.
const MADE_AT: [&str; 2] = ["Created a new Artifact at ", "Updated the Artifact at "];
/// The Docs connector's ack for a new doc: `"artifactUrl":"<url>"`.
const DOC_BORN: &str = "artifactUrl";
/// An artifact or a doc a session made, as its record tells it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub url: String,
    /// A published artifact's file name, without its extension.
    pub title: Option<String>,
    pub kind: crate::ArtifactKind,
}

/// The tools whose results tell what a session made: the Artifact tool, and
/// the Docs connector's writes (its reads name docs too, made by anyone).
const ARTIFACT_TOOL: &str = "Artifact";
const DOCS_WRITES: [&str; 3] = ["Claude_Docs__create", "Claude_Docs__batch", "Claude_Docs__update"];

fn makes_artifacts(tool: &str) -> bool {
    tool == ARTIFACT_TOOL || DOCS_WRITES.iter().any(|w| tool.ends_with(w))
}

/// The skill that writes explanations as HTML files, called as a tool or
/// typed as /html.
const HTML_SKILL: &str = "html";
const HTML_TYPED: &str = "<command-name>/html</command-name>";

/// A document as the html skill names it, `{yyyymmdd}-{what}.html` (a page
/// of an app, index.html, is not one).
fn html_document(path: &str) -> Option<Found> {
    let stem = path.rsplit('/').next()?.strip_suffix(".html")?;
    let (date, rest) = stem.split_at_checked(8)?;
    (date.bytes().all(|b| b.is_ascii_digit()) && rest.len() > 1 && rest.starts_with('-'))
        .then(|| Found { url: path.into(), title: Some(stem.into()), kind: crate::ArtifactKind::File })
}

/// Every artifact a session published and every doc it made, as those
/// tools' results tell (a result whose call is not among the entries is
/// left out), and the documents it wrote once it used the html skill, once
/// each (a new version is the same one), in the order made. What other
/// tools show (a page read, code holding such a line) is not them.
pub fn artifacts(entries: &[Value]) -> Vec<Found> {
    let mut tools = std::collections::HashMap::new();
    let mut found = Vec::new();
    let mut html = false;
    for e in entries {
        html |= e["type"] == "user" && e["message"]["content"].as_str().is_some_and(|t| t.contains(HTML_TYPED));
        for block in e["message"]["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("tool_use") => {
                    let name = block["name"].as_str().unwrap_or_default();
                    if let Some(id) = block["id"].as_str() {
                        tools.insert(id, name);
                    }
                    html |= name == "Skill" && block["input"]["skill"] == HTML_SKILL;
                    if html && name == "Write" {
                        found.extend(block["input"]["file_path"].as_str().and_then(html_document));
                    }
                }
                Some("tool_result") if block["tool_use_id"].as_str().and_then(|id| tools.get(id)).is_some_and(|t| makes_artifacts(t)) => {
                    found.extend(made_in(&result_text(block)));
                }
                _ => {}
            }
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
        found.push((i, Found { url, title: (!title.is_empty()).then(|| title.to_string()), kind: crate::ArtifactKind::Artifact }));
    }
    for made in MADE_AT {
        for (i, _) in text.match_indices(made) {
            if let Some(url) = artifact_at(&text[i + made.len()..]) {
                found.push((i, Found { url, title: None, kind: crate::ArtifactKind::Artifact }));
            }
        }
    }
    for (i, _) in text.match_indices(DOC_BORN) {
        if let Some(url) = artifact_at(text[i + DOC_BORN.len()..].trim_start_matches(['\\', '"', ':'])) {
            found.push((i, Found { url, title: None, kind: crate::ArtifactKind::Doc }));
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
    fn a_peek_is_the_last_reply_its_model_and_the_context_it_fills() {
        let entries = [
            assistant(json!([{"type": "text", "text": "前の返事"}]), json!({"input_tokens": 10, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 5, "output_tokens": 7})),
            json!({"type": "user", "message": {"content": "続けて"}}),
            assistant(
                json!([{"type": "text", "text": "\n  テストが通りました。\nPR を作ります。"}, {"type": "tool_use", "name": "Bash", "input": {}}]),
                json!({"input_tokens": 3, "cache_read_input_tokens": 80_000, "cache_creation_input_tokens": 2_000, "output_tokens": 40}),
            ),
            assistant(json!([{"type": "tool_use", "name": "Bash", "input": {}}]), json!({"input_tokens": 1, "cache_read_input_tokens": 82_100, "cache_creation_input_tokens": 0, "output_tokens": 9})),
        ];
        let p = peek(&entries);
        assert_eq!(p.last.as_deref(), Some("テストが通りました。 PR を作ります。"));
        assert_eq!(p.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(p.context_tokens, Some(82_110));
    }

    #[test]
    fn the_digest_keeps_the_latest_asks_replies_and_tools_newest_last_within_its_size() {
        let entries = [
            json!({"type": "user", "message": {"content": "ログを整理して"}}),
            assistant(json!([{"type": "text", "text": "見ます。"}, {"type": "tool_use", "name": "Read", "input": {}}]), json!({})),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "…"}]}}),
            assistant(json!([{"type": "tool_use", "name": "Bash", "input": {}}, {"type": "text", "text": "テストが通りました。"}]), json!({})),
        ];
        assert_eq!(digest(&entries, 1000), "依頼: ログを整理して\nClaude: 見ます。\n操作: Read\n操作: Bash\nClaude: テストが通りました。");
        assert_eq!(digest(&entries, 30), "操作: Bash\nClaude: テストが通りました。");
    }

    #[test]
    fn nothing_said_yet_peeks_nothing() {
        assert_eq!(peek(&[json!({"type": "user", "message": {"content": "やって"}})]), Peek::default());
    }

    #[test]
    fn jsonl_skips_a_cut_first_line_and_blank_lines() {
        let v = parse_jsonl("e\": 1}\n{\"type\": \"user\"}\n\n{\"type\": \"assistant\"}\n");
        assert_eq!(v, [json!({"type": "user"}), json!({"type": "assistant"})]);
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
                Found { url: "https://claude.ai/artifact/1UnAnmsD3RX7".into(), title: Some("比較表".into()), kind: crate::ArtifactKind::Artifact },
                Found { url: "https://claude.ai/code/artifact/e1e71452-f7a7".into(), title: None, kind: crate::ArtifactKind::Doc },
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
                Found { url: "https://claude.ai/artifact/RPPwKWPE6T".into(), title: None, kind: crate::ArtifactKind::Artifact },
                Found { url: "https://claude.ai/artifact/Older9".into(), title: None, kind: crate::ArtifactKind::Artifact },
            ],
            "the type it is made from is not one of them"
        );
    }

    /// A file written (the Write tool) and its ack.
    fn write(id: &str, path: &str) -> [Value; 2] {
        [
            assistant(json!([{"type": "tool_use", "id": id, "name": "Write", "input": {"file_path": path, "content": "<html></html>"}}]), json!({})),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": id, "content": format!("File created successfully at: {path}")}]}}),
        ]
    }

    #[test]
    fn the_html_skills_documents_are_files_made() {
        let skill = assistant(json!([{"type": "tool_use", "id": "s1", "name": "Skill", "input": {"skill": "html", "args": "OIDC を説明して"}}]), json!({}));
        let entries: Vec<Value> = [
            write("w0", "/w/20261011-before.html").to_vec(),
            vec![skill],
            write("w1", "/w/20261012-oidc-flow.html").to_vec(),
            write("w2", "/w/app/index.html").to_vec(),
            write("w3", "/w/app/20261012-notes.md").to_vec(),
            write("w4", "/w/20261012-oidc-flow.html").to_vec(),
        ]
        .concat();
        assert_eq!(
            artifacts(&entries),
            vec![Found { url: "/w/20261012-oidc-flow.html".into(), title: Some("20261012-oidc-flow".into()), kind: crate::ArtifactKind::File }],
            "only what follows the skill and is named as it names its documents ({{yyyymmdd}}-….html), once"
        );
        let typed = json!({"type": "user", "message": {"content": "<command-message>html</command-message>\n<command-name>/html</command-name>\n<command-args>CSP</command-args>"}});
        let entries: Vec<Value> = [vec![typed], write("w1", "/w/20261012-csp.html").to_vec()].concat();
        assert_eq!(artifacts(&entries).len(), 1, "the skill typed as /html counts too");
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
