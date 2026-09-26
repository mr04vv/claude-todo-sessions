use std::time::{SystemTime, UNIX_EPOCH};

use cts_core::{Db, SessionState};
use serde_json::{json, Value};

// Undocumented API used by `claude --teleport`; it may change without notice.
const API_BASE: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
/// OAuth client id of Claude Code, taken from the CLI.
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const OAUTH_KEY: &str = "claudeAiOauth";
// ponytail: first page only; paginate with `cursor` if more than 100 live sessions matter.
const LIST_LIMIT: u32 = 100;
/// Events come newest first and `cursor` is an exclusive upper bound on
/// sequence_num, so a small cursor returns the head of the session.
const EVENTS_HEAD_CURSOR: u32 = 20;
const REFRESH_MARGIN_MS: i64 = 60_000;

pub fn map_state(session: &Value) -> SessionState {
    if session["status"] == "archived" {
        return SessionState::Ended;
    }
    match session["worker_status"].as_str() {
        Some("running") => SessionState::Running,
        Some("requires_action") => SessionState::NeedsInput,
        _ => SessionState::Idle,
    }
}

/// `bridge` sessions are Remote Control mirrors of local sessions, which the
/// hooks already track (and whose events need a trusted device).
pub fn is_cloud(session: &Value) -> bool {
    session["environment_kind"] == "anthropic_cloud"
}

pub fn repo_url(session: &Value) -> Option<String> {
    session["config"]["sources"]
        .as_array()?
        .iter()
        .find(|s| s["type"] == "git_repository")?["url"]
        .as_str()
        .map(Into::into)
}

fn message_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => blocks
            .iter()
            .find(|b| b["type"] == "text")
            .and_then(|b| b["text"].as_str())
            .map(Into::into),
        _ => None,
    }
}

pub fn first_user_prompt(events: &Value) -> Option<String> {
    events["data"]
        .as_array()?
        .iter()
        .filter(|e| e["payload"]["type"] == "user")
        .filter_map(|e| {
            let seq: i64 = e["sequence_num"].as_str()?.parse().ok()?;
            Some((seq, message_text(&e["payload"]["message"]["content"])?))
        })
        .min_by_key(|(seq, _)| *seq)
        .map(|(_, text)| text)
}

pub fn needs_refresh(expires_at_ms: i64, now_ms: i64) -> bool {
    now_ms + REFRESH_MARGIN_MS >= expires_at_ms
}

pub fn apply_refresh(creds: &Value, resp: &Value, now_ms: i64) -> Result<Value, String> {
    let access = resp["access_token"].as_str().ok_or("refresh response has no access_token")?;
    let expires_in = resp["expires_in"].as_i64().ok_or("refresh response has no expires_in")?;
    let mut out = creds.clone();
    let oauth = &mut out[OAUTH_KEY];
    oauth["accessToken"] = json!(access);
    if let Some(r) = resp["refresh_token"].as_str() {
        oauth["refreshToken"] = json!(r);
    }
    oauth["expiresAt"] = json!(now_ms + expires_in * 1000);
    Ok(out)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn keychain_account() -> Result<String, String> {
    std::env::var("USER").map_err(|_| "USER is not set".into())
}

fn load_creds() -> Result<Value, String> {
    let raw = security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, &keychain_account()?)
        .map_err(|e| format!("read keychain {KEYCHAIN_SERVICE}: {e}"))?;
    serde_json::from_slice(&raw).map_err(|e| format!("parse credentials: {e}"))
}

fn save_creds(creds: &Value) -> Result<(), String> {
    let raw = serde_json::to_vec(creds).map_err(|e| e.to_string())?;
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, &keychain_account()?, &raw)
        .map_err(|e| format!("write keychain {KEYCHAIN_SERVICE}: {e}"))
}

fn expires_at(creds: &Value) -> i64 {
    creds[OAUTH_KEY]["expiresAt"].as_i64().unwrap_or(0)
}

fn access_token(creds: &Value) -> Result<String, String> {
    creds[OAUTH_KEY]["accessToken"]
        .as_str()
        .map(Into::into)
        .ok_or_else(|| "credentials have no accessToken".into())
}

fn refresh(creds: &Value) -> Result<Value, String> {
    // The CLI may have refreshed already; its fresh token wins over ours.
    let latest = load_creds()?;
    if !needs_refresh(expires_at(&latest), now_ms()) && latest != *creds {
        return Ok(latest);
    }
    let oauth = &latest[OAUTH_KEY];
    let scope = oauth["scopes"]
        .as_array()
        .map(|s| s.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    let body = json!({
        "grant_type": "refresh_token",
        "refresh_token": oauth["refreshToken"].as_str().ok_or("credentials have no refreshToken")?,
        "client_id": CLIENT_ID,
        "scope": scope,
    });
    let resp: Value = ureq::post(TOKEN_URL)
        .send_json(&body)
        .map_err(|e| format!("token refresh: {e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| format!("token refresh response: {e}"))?;
    let updated = apply_refresh(&latest, &resp, now_ms())?;
    save_creds(&updated)?;
    Ok(updated)
}

fn api_get(token: &str, path: &str) -> Result<Value, ureq::Error> {
    ureq::get(format!("{API_BASE}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", ANTHROPIC_VERSION)
        .call()?
        .body_mut()
        .read_json()
}

struct Client {
    creds: Value,
}

impl Client {
    fn new() -> Result<Client, String> {
        let mut creds = load_creds()?;
        if needs_refresh(expires_at(&creds), now_ms()) {
            creds = refresh(&creds)?;
        }
        Ok(Client { creds })
    }

    fn get(&mut self, path: &str) -> Result<Value, String> {
        match api_get(&access_token(&self.creds)?, path) {
            Err(ureq::Error::StatusCode(401)) => {
                self.creds = refresh(&self.creds)?;
                api_get(&access_token(&self.creds)?, path).map_err(|e| format!("GET {path}: {e}"))
            }
            r => r.map_err(|e| format!("GET {path}: {e}")),
        }
    }
}

enum Outcome {
    Skipped,
    Recorded,
    Linked,
}

fn sync_one(db: &Db, client: &mut Client, s: &Value) -> Result<Outcome, String> {
    let id = s["id"].as_str().ok_or("session without id")?;
    let state = map_state(s);
    let known = db.get_session(id).map_err(|e| e.to_string())?;
    // Archived sessions we never saw would only clutter the inbox.
    if known.is_none() && state == SessionState::Ended {
        return Ok(Outcome::Skipped);
    }
    db.record_session(id, &repo_url(s).unwrap_or_default(), state).map_err(|e| e.to_string())?;
    let unlinked = known.is_none_or(|k| k.todo_id.is_none());
    if !unlinked || db.marker_checked(id).map_err(|e| e.to_string())? {
        return Ok(Outcome::Recorded);
    }
    let events = client.get(&format!("/v1/code/sessions/{id}/events?cursor={EVENTS_HEAD_CURSOR}"))?;
    // No user event yet means the session is still starting: look again next time.
    let Some(prompt) = first_user_prompt(&events) else { return Ok(Outcome::Recorded) };
    let linked = db.link_by_marker(id, &prompt).map_err(|e| e.to_string())?.is_some();
    db.mark_marker_checked(id).map_err(|e| e.to_string())?;
    Ok(if linked { Outcome::Linked } else { Outcome::Recorded })
}

/// Records cloud sessions' states and links unlinked ones whose first prompt
/// carries a `[todo:<id>]` marker. One session failing does not stop the rest.
fn sync(db: &Db) -> Result<(usize, usize, usize, Vec<String>), String> {
    let mut client = Client::new()?;
    let list = client.get(&format!("/v1/code/sessions?limit={LIST_LIMIT}"))?;
    let sessions: Vec<Value> = list["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| is_cloud(s))
        .cloned()
        .collect();
    let (mut recorded, mut linked, mut errors) = (0, 0, Vec::new());
    for s in &sessions {
        match sync_one(db, &mut client, s) {
            Ok(Outcome::Skipped) => {}
            Ok(Outcome::Recorded) => recorded += 1,
            Ok(Outcome::Linked) => {
                recorded += 1;
                linked += 1;
            }
            Err(e) => errors.push(e),
        }
    }
    Ok((sessions.len(), recorded, linked, errors))
}

pub fn run() -> Result<(), String> {
    let db = crate::open_db()?;
    let (seen, recorded, linked, errors) = sync(&db)?;
    println!("{seen} cloud sessions seen, {recorded} recorded, {linked} linked");
    if errors.is_empty() {
        return Ok(());
    }
    Err(format!("{} session(s) failed: {}", errors.len(), errors.join("; ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_worker_status_and_archive() {
        let s = |status: &str, worker: Option<&str>| json!({"status": status, "worker_status": worker});
        assert_eq!(map_state(&s("active", Some("running"))), SessionState::Running);
        assert_eq!(map_state(&s("active", Some("requires_action"))), SessionState::NeedsInput);
        assert_eq!(map_state(&s("active", Some("idle"))), SessionState::Idle);
        assert_eq!(map_state(&s("active", None)), SessionState::Idle);
        assert_eq!(map_state(&s("archived", Some("running"))), SessionState::Ended);
    }

    #[test]
    fn only_anthropic_cloud_sessions_are_cloud() {
        assert!(is_cloud(&json!({"environment_kind": "anthropic_cloud"})));
        // Remote Control mirrors of local sessions, already tracked by hooks.
        assert!(!is_cloud(&json!({"environment_kind": "bridge"})));
    }

    #[test]
    fn finds_git_repository_source() {
        let s = json!({"config": {"sources": [
            {"type": "other"},
            {"type": "git_repository", "url": "https://github.com/o/r"}
        ]}});
        assert_eq!(repo_url(&s).as_deref(), Some("https://github.com/o/r"));
        assert_eq!(repo_url(&json!({})), None);
    }

    #[test]
    fn first_user_prompt_takes_lowest_sequence_user_event() {
        let ev = |seq: &str, ty: &str, content: Value| {
            json!({"sequence_num": seq, "payload": {"type": ty, "message": {"content": content}}})
        };
        let events = json!({"data": [
            ev("10", "user", json!("later prompt")),
            ev("3", "assistant", json!("hi")),
            ev("2", "user", json!([{"type": "image"}, {"type": "text", "text": "[todo:4] first"}])),
            ev("1", "system", json!(null)),
        ]});
        assert_eq!(first_user_prompt(&events).as_deref(), Some("[todo:4] first"));
        assert_eq!(first_user_prompt(&json!({"data": [ev("1", "system", json!(null))]})), None);
    }

    #[test]
    fn refreshes_shortly_before_expiry() {
        assert!(needs_refresh(1_000_000, 1_000_000));
        assert!(needs_refresh(1_000_000, 1_000_000 - 1_000));
        assert!(!needs_refresh(1_000_000, 0));
    }

    #[test]
    fn apply_refresh_keeps_other_fields() {
        let creds = json!({"claudeAiOauth": {
            "accessToken": "old", "refreshToken": "r1", "expiresAt": 1, "scopes": ["a"]
        }, "other": true});
        let resp = json!({"access_token": "new", "refresh_token": "r2", "expires_in": 3600});
        let got = apply_refresh(&creds, &resp, 1_000).unwrap();
        assert_eq!(got["claudeAiOauth"]["accessToken"], "new");
        assert_eq!(got["claudeAiOauth"]["refreshToken"], "r2");
        assert_eq!(got["claudeAiOauth"]["expiresAt"], 3_601_000);
        assert_eq!(got["claudeAiOauth"]["scopes"], json!(["a"]));
        assert_eq!(got["other"], true);

        let no_rotate = json!({"access_token": "new", "expires_in": 10});
        assert_eq!(apply_refresh(&creds, &no_rotate, 0).unwrap()["claudeAiOauth"]["refreshToken"], "r1");
        assert!(apply_refresh(&creds, &json!({}), 0).is_err());
    }
}
