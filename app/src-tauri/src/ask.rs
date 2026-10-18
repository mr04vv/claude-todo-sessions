// Claude asked once through `claude -p`, without a session or the built-in
// tools: the in-place translations (in a JSON schema), without MCP servers;
// the day's X digest, with the Claude Docs connector to write it.
use std::io::{Read, Write};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::err;

/// How long one answer may take.
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(240);
/// The Claude Docs connector's tools (claude.ai's), allowed without asking.
const DOCS_TOOLS: &str = "mcp__claude_ai_Claude_Docs";

/// Asks Claude once, without a session or the built-in tools, for an answer
/// in `schema` (its structured output), or without one for its text (a
/// string). The prompt goes in on stdin (a long one would not fit in an
/// argument).
pub fn claude(prompt: &str, schema: Option<&Value>, model: Option<&str>, effort: Option<&str>) -> Result<Value, String> {
    run(prompt, schema, model, effort, false, CLAUDE_TIMEOUT)
}

/// Asks Claude once with the Claude Docs connector (claude.ai's MCP server,
/// its tools allowed) to write a document; its answer's text.
pub fn claude_docs(prompt: &str, timeout: Duration) -> Result<String, String> {
    Ok(run(prompt, None, None, None, true, timeout)?.as_str().unwrap_or_default().to_string())
}

fn run(prompt: &str, schema: Option<&Value>, model: Option<&str>, effort: Option<&str>, docs: bool, timeout: Duration) -> Result<Value, String> {
    let mut cmd = crate::cli("claude");
    cmd.args(["-p", "--output-format", "json", "--tools", "", "--no-session-persistence"]);
    if let Some(schema) = schema {
        cmd.args(["--json-schema", &schema.to_string()]);
    }
    if docs {
        cmd.args(["--allowedTools", DOCS_TOOLS]);
    } else {
        cmd.arg("--strict-mcp-config");
    }
    if let Some(model) = model {
        cmd.args(["--model", model]);
    }
    if let Some(effort) = effort {
        cmd.args(["--effort", effort]);
    }
    cmd.current_dir(crate::home()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("claude を起動できません: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("claude の入力を開けません")?;
    let prompt = prompt.to_string();
    std::thread::spawn(move || drop(stdin.write_all(prompt.as_bytes())));
    let mut stdout = child.stdout.take().ok_or("claude の出力を開けません")?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(err)? {
            Some(status) => {
                let out = reader.join().map_err(|_| "claude の出力を読めませんでした")?;
                let mut stderr = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut stderr);
                }
                let answer: Value = serde_json::from_slice(&out).map_err(|_| {
                    let said = String::from_utf8_lossy(&out);
                    format!("claude の答えが読めませんでした ({status}): {}{}", said.trim(), stderr.trim())
                })?;
                if answer["is_error"].as_bool() == Some(true) {
                    return Err(format!("claude: {}", answer["result"].as_str().unwrap_or("error")));
                }
                if schema.is_none() {
                    return Ok(answer["result"].clone());
                }
                return match answer.get("structured_output") {
                    Some(output) if output.is_object() => Ok(output.clone()),
                    _ => Err("claude が決まった形で答えませんでした".into()),
                };
            }
            None if started.elapsed() > timeout => {
                let _ = child.kill();
                return Err("claude の答えを待ちきれませんでした".into());
            }
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

