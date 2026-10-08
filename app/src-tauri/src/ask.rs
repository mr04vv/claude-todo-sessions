// Claude asked once through `claude -p`, without a session or the built-in
// tools: translations, the learning themes' sorting, picks and reviews (in
// a JSON schema), and writing a theme's document (with the Claude Docs
// connector's tools).
use std::io::{Read, Write};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::err;

/// How long one answer may take (the points of eight pages take a while).
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(240);

/// The MCP server whose tools a theme's document is read and written with.
const DOCS_TOOLS: &str = "mcp__claude_ai_Claude_Docs";

/// Asks Claude once, without a session or the built-in tools, for an answer
/// in `schema` (its structured output), or without one for its text (a
/// string). `docs` lets it use the Claude Docs connector; otherwise no MCP
/// server loads. The prompt goes in on stdin (a long one would not fit in
/// an argument).
pub fn claude(prompt: &str, schema: Option<&Value>, model: Option<&str>, effort: Option<&str>, docs: bool) -> Result<Value, String> {
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
            None if started.elapsed() > CLAUDE_TIMEOUT => {
                let _ = child.kill();
                return Err("claude の答えを待ちきれませんでした".into());
            }
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

