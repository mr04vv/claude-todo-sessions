use std::time::{SystemTime, UNIX_EPOCH};

use crate::launch::StartOptions;
use crate::{Db, SessionState};
use serde_json::{json, Value};

// Undocumented API used by `claude --teleport`; it may change without notice.
const API_BASE: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
/// OAuth client id of Claude Code, taken from the CLI.
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const OAUTH_KEY: &str = "claudeAiOauth";
const LIST_LIMIT: u32 = 100;
/// Pages of the session list to walk per sync; the ordering is undocumented,
/// so every page is read.
const MAX_LIST_PAGES: usize = 10;
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

/// Branches a cloud session is on, as (repo or "", branch), leaving out
/// default branches no PR comes from.
pub fn current_branches(session: &Value) -> Vec<(String, String)> {
    session["external_metadata"]["current_branches"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(repo, b)| Some((repo.clone(), b.as_str()?.to_string())))
        .filter(|(_, b)| !crate::launch::is_default_branch(b))
        .collect()
}

/// `owner/repo` list of a session: the push targets (outcomes), or every
/// source when nothing is pushed, e.g. a read-only investigation.
pub fn repo_keys(session: &Value) -> Vec<String> {
    let git = |v: &Value, kind: &str| {
        v.as_array()
            .into_iter()
            .flatten()
            .filter(|x| x["type"] == "git_repository")
            .filter_map(|x| match kind {
                "outcomes" => x["git_info"]["repo"].as_str().map(Into::into),
                _ => x["url"].as_str().and_then(crate::launch::repo_key),
            })
            .collect::<Vec<String>>()
    };
    let outcomes = git(&session["config"]["outcomes"], "outcomes");
    if !outcomes.is_empty() {
        return outcomes;
    }
    git(&session["config"]["sources"], "sources")
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

/// `repos` are `owner/repo`; every one becomes a source and a push target
/// on the same branch name. No repos means a session with no checkout, for
/// research that needs none.
pub fn create_body(env_id: &str, repos: &[String], branch: &str, prompt: &str, title: &str, uuid: &str) -> Value {
    let sources: Vec<Value> = repos
        .iter()
        .map(|r| json!({"type": "git_repository", "url": format!("https://github.com/{r}")}))
        .collect();
    let outcomes: Vec<Value> = repos
        .iter()
        .map(|r| json!({"type": "git_repository", "git_info": {"type": "github", "repo": r, "branches": [branch]}}))
        .collect();
    json!({
        "title": title,
        "events": [{"type": "event", "data": {
            "uuid": uuid, "session_id": "", "type": "user", "parent_tool_use_id": null,
            "message": {"role": "user", "content": prompt},
        }}],
        "session_context": {
            "sources": sources,
            "outcomes": outcomes,
            "environment_variables": {},
        },
        "environment_id": env_id,
    })
}

/// Sets the model and effort a cloud session runs with, as the sessions
/// list reports them in `config.model` and `config.effort_level`.
pub fn apply_options(body: &mut Value, opts: &StartOptions) {
    if let Some(m) = opts.model() {
        body["session_context"]["model"] = json!(m);
    }
    if let Some(e) = opts.effort() {
        body["session_context"]["effort_level"] = json!(e);
    }
}

/// The create API answers `session_…`; the code-sessions API lists the same
/// session as `cse_…`.
pub fn code_session_id(created_id: &str) -> Option<String> {
    if created_id.starts_with("cse_") {
        return Some(created_id.into());
    }
    created_id.strip_prefix("session_").map(|rest| format!("cse_{rest}"))
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

/// The credentials item was created by the `security` CLI (that is how
/// Claude Code stores it), so that CLI is on its access list and reads it
/// without a prompt. Our own binaries are not, and an ad-hoc signed build
/// changes identity every time, so going through Security.framework asked
/// for permission after each rebuild.
fn security(args: &[&str]) -> Result<Vec<u8>, String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(args)
        .output()
        .map_err(|e| format!("security: {e}"))?;
    if !out.status.success() {
        return Err(format!("security {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(out.stdout)
}

fn load_creds() -> Result<Value, String> {
    let raw = security(&["find-generic-password", "-a", &keychain_account()?, "-s", KEYCHAIN_SERVICE, "-w"])
        .map_err(|e| format!("read keychain {KEYCHAIN_SERVICE}: {e}"))?;
    serde_json::from_slice(String::from_utf8_lossy(&raw).trim().as_bytes()).map_err(|e| format!("parse credentials: {e}"))
}

fn save_creds(creds: &Value) -> Result<(), String> {
    let raw = serde_json::to_string(creds).map_err(|e| e.to_string())?;
    // -U updates the existing item in place, keeping its access list.
    security(&["add-generic-password", "-a", &keychain_account()?, "-s", KEYCHAIN_SERVICE, "-w", &raw, "-U"])
        .map(|_| ())
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

/// Header set the sessions create API needs on top of the OAuth ones.
const CREATE_BETA: &str = "ccr-byoc-2025-07-29";
/// Plan usage limits, as `/usage` in Claude Code shows them.
const USAGE_PATH: &str = "/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const CLAUDE_JSON: &str = ".claude.json";
const RECENT_SESSIONS_FOR_ENV: u32 = 20;
/// Branch Claude pushes to, like the ones the CLI and Desktop create.
const BRANCH_PREFIX: &str = "claude/";
const BRANCH_SUFFIX_LEN: usize = 6;

fn api_post(token: &str, path: &str, org: &str, body: &Value) -> Result<Value, ureq::Error> {
    ureq::post(format!("{API_BASE}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", CREATE_BETA)
        .header("x-organization-uuid", org)
        .send_json(body)?
        .body_mut()
        .read_json()
}

/// `POST {path}` with no body to read back, as the archive API answers.
fn api_post_empty(token: &str, path: &str, org: &str) -> Result<(), ureq::Error> {
    ureq::post(format!("{API_BASE}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", CREATE_BETA)
        .header("x-organization-uuid", org)
        .send_json(json!({}))?;
    Ok(())
}

fn organization_uuid() -> Result<String, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let path = std::path::Path::new(&home).join(CLAUDE_JSON);
    let raw = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let v: Value = serde_json::from_slice(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    v["oauthAccount"]["organizationUuid"]
        .as_str()
        .map(Into::into)
        .ok_or_else(|| format!("{} has no oauthAccount.organizationUuid", path.display()))
}

fn api_get(token: &str, path: &str) -> Result<Value, ureq::Error> {
    let mut req = ureq::get(format!("{API_BASE}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-version", ANTHROPIC_VERSION);
    // The usage API answers only with the OAuth beta header.
    if path == USAGE_PATH {
        req = req.header("anthropic-beta", OAUTH_BETA);
    }
    req.call()?
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
        self.get_opt(path)?.ok_or_else(|| format!("GET {path}: not found"))
    }

    /// Like `get`, but a 404 is `None` rather than an error.
    fn get_opt(&mut self, path: &str) -> Result<Option<Value>, String> {
        let mut result = api_get(&access_token(&self.creds)?, path);
        if let Err(ureq::Error::StatusCode(401)) = result {
            self.creds = refresh(&self.creds)?;
            result = api_get(&access_token(&self.creds)?, path);
        }
        match result {
            Ok(v) => Ok(Some(v)),
            Err(ureq::Error::StatusCode(404)) => Ok(None),
            Err(e) => Err(format!("GET {path}: {e}")),
        }
    }

    /// Every session the list API returns, across pages.
    fn list_sessions(&mut self) -> Result<Vec<Value>, String> {
        let mut all = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_LIST_PAGES {
            let path = match &cursor {
                Some(c) => format!("/v1/code/sessions?limit={LIST_LIMIT}&cursor={c}"),
                None => format!("/v1/code/sessions?limit={LIST_LIMIT}"),
            };
            let page = self.get(&path)?;
            all.extend(page["data"].as_array().into_iter().flatten().cloned());
            cursor = page["next_cursor"].as_str().map(Into::into);
            if cursor.is_none() {
                break;
            }
        }
        Ok(all)
    }

    /// Archives a session; one archived already (409) counts as done.
    fn archive(&mut self, id: &str, org: &str) -> Result<(), String> {
        let path = format!("/v1/code/sessions/{id}/archive");
        let mut result = api_post_empty(&access_token(&self.creds)?, &path, org);
        if let Err(ureq::Error::StatusCode(401)) = result {
            self.creds = refresh(&self.creds)?;
            result = api_post_empty(&access_token(&self.creds)?, &path, org);
        }
        match result {
            Ok(()) | Err(ureq::Error::StatusCode(409)) => Ok(()),
            Err(e) => Err(format!("POST {path}: {e}")),
        }
    }

    fn post(&mut self, path: &str, org: &str, body: &Value) -> Result<Value, String> {
        match api_post(&access_token(&self.creds)?, path, org, body) {
            Err(ureq::Error::StatusCode(401)) => {
                self.creds = refresh(&self.creds)?;
                api_post(&access_token(&self.creds)?, path, org, body).map_err(|e| format!("POST {path}: {e}"))
            }
            r => r.map_err(|e| format!("POST {path}: {e}")),
        }
    }
}

/// Creates a cloud session whose first prompt is `[todo:<id>] <title>` and
/// links it right away. Returns the `cse_…` id.
// ponytail: reuses the environment of the latest cloud session; add an
// environment picker if more than one environment is in use.
pub fn create_session(db: &Db, todo_id: i64, repos: &[String], title: &str, prompt_body: &str, opts: &StartOptions) -> Result<String, String> {
    let prompt = crate::launch::start_prompt(todo_id, prompt_body);
    let id = create_unlinked(db, repos, title, &prompt, &format!("todo-{todo_id}"), opts)?;
    db.link_session(&id, todo_id).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Creates a cloud session with no checkout, linked to no todo (an input's note).
pub fn create_loose_session(db: &Db, title: &str, prompt: &str) -> Result<String, String> {
    create_unlinked(db, &[], title, prompt, "note", &StartOptions::default())
}

/// Creates a cloud session reviewing a PR of `repo`, linked to no todo.
pub fn create_review_session(db: &Db, repo: &str, title: &str, prompt: &str) -> Result<String, String> {
    create_unlinked(db, &[repo.to_string()], title, prompt, "review", &StartOptions::default())
}

/// Creates a cloud session with `prompt` first, pushing to a
/// `claude/<branch_stem>-<suffix>` branch, and records it here.
fn create_unlinked(db: &Db, repos: &[String], title: &str, prompt: &str, branch_stem: &str, opts: &StartOptions) -> Result<String, String> {
    let repo_url = repos.first().map(|main| format!("https://github.com/{main}")).unwrap_or_default();
    let mut client = Client::new()?;
    let uuid = uuid::Uuid::new_v4().to_string();
    let branch = format!("{BRANCH_PREFIX}{branch_stem}-{}", &uuid[..BRANCH_SUFFIX_LEN]);
    let org = organization_uuid()?;
    let post = |client: &mut Client, env_id: &str| {
        let mut body = create_body(env_id, repos, &branch, prompt, title, &uuid);
        apply_options(&mut body, opts);
        client.post("/v1/sessions", &org, &body)
    };
    let created = match remembered_environment() {
        // A remembered environment may have gone away: when the API rejects
        // the request (4xx, so nothing was created), look it up again once.
        Some(env) => match post(&mut client, &env) {
            Ok(created) => created,
            Err(e) if !e.contains(CLIENT_ERROR) => return Err(e),
            Err(_) => {
                let env = fetch_environment(&mut client)?;
                post(&mut client, &env)?
            }
        },
        None => {
            let env = fetch_environment(&mut client)?;
            post(&mut client, &env)?
        }
    };
    let id = created["id"]
        .as_str()
        .and_then(code_session_id)
        .ok_or("create response has no session id")?;
    db.record_session(&id, &repo_url, SessionState::Idle).map_err(|e| e.to_string())?;
    db.set_session_repos(&id, repos).map_err(|e| e.to_string())?;
    db.set_session_title(&id, title).map_err(|e| e.to_string())?;
    db.mark_marker_checked(&id).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Environment of the newest cloud session (the list API gives newest
/// first), which new sessions reuse.
pub fn latest_environment(sessions: &[Value]) -> Option<String> {
    sessions.iter().find(|s| is_cloud(s)).and_then(|s| s["environment_id"].as_str()).map(Into::into)
}

/// How ureq words a 4xx answer in the errors `Client` returns.
const CLIENT_ERROR: &str = "http status: 4";

/// The environment the last sync saw, so starting a session skips listing
/// sessions again (about half a second).
static ENVIRONMENT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn remember_environment(env: Option<String>) {
    if let (Some(env), Ok(mut slot)) = (env, ENVIRONMENT.lock()) {
        *slot = Some(env);
    }
}

fn remembered_environment() -> Option<String> {
    ENVIRONMENT.lock().ok()?.clone()
}

fn fetch_environment(client: &mut Client) -> Result<String, String> {
    let recent = client.get(&format!("/v1/code/sessions?limit={RECENT_SESSIONS_FOR_ENV}"))?;
    let env = latest_environment(recent["data"].as_array().map(Vec::as_slice).unwrap_or_default())
        .ok_or("no cloud session to take an environment from; start one on claude.ai/code first")?;
    remember_environment(Some(env.clone()));
    Ok(env)
}

/// The plan's usage limits (session, weekly, per model).
pub fn usage() -> Result<Vec<crate::usage::Limit>, String> {
    Ok(crate::usage::parse_limits(&Client::new()?.get(USAGE_PATH)?))
}

/// The latest messages of a cloud session, oldest first.
pub fn recent_entries(session_id: &str) -> Result<Vec<Value>, String> {
    Ok(crate::transcript::from_events(&Client::new()?.get(&format!("/v1/code/sessions/{session_id}/events"))?))
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
    db.set_session_repos(id, &repo_keys(s)).map_err(|e| e.to_string())?;
    if let Some((_, branch)) = current_branches(s).into_iter().next() {
        db.set_session_branch(id, &branch).map_err(|e| e.to_string())?;
    }
    if let Some(title) = s["title"].as_str().filter(|t| !t.is_empty()) {
        db.set_session_title(id, title).map_err(|e| e.to_string())?;
    }
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
fn sync_all(db: &Db) -> Result<(usize, usize, usize, Vec<String>), String> {
    let mut client = Client::new()?;
    let sessions: Vec<Value> = client.list_sessions()?.into_iter().filter(|s| is_cloud(s)).collect();
    remember_environment(latest_environment(&sessions));
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
    // A recorded session the list no longer returns was deleted (or fell out
    // of the pages read): fetch it alone, and treat "not found" as ended.
    let listed: std::collections::HashSet<&str> = sessions.iter().filter_map(|s| s["id"].as_str()).collect();
    for known in db.live_cloud_sessions().map_err(|e| e.to_string())? {
        if listed.contains(known.session_id.as_str()) {
            continue;
        }
        match client.get_opt(&format!("/v1/code/sessions/{}", known.session_id)) {
            Ok(Some(s)) => {
                if let Err(e) = db.record_session(&known.session_id, &known.cwd, map_state(&s)) {
                    errors.push(e.to_string());
                }
            }
            Ok(None) => {
                if let Err(e) = db.record_session(&known.session_id, &known.cwd, SessionState::Ended) {
                    errors.push(e.to_string());
                }
            }
            Err(e) => errors.push(e),
        }
    }
    Ok((sessions.len(), recorded, linked, errors))
}

/// Archives cloud sessions (`cse_…`) as the CLI does, marking them ended
/// here right away. Returns the errors of the ones that failed.
pub fn archive_sessions(db: &Db, ids: &[String]) -> Result<Vec<String>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut client = Client::new()?;
    let org = organization_uuid()?;
    let mut errors = Vec::new();
    for id in ids {
        let archived = client.archive(id, &org).and_then(|()| match db.get_session(id).map_err(|e| e.to_string())? {
            Some(s) => db.record_session(id, &s.cwd, SessionState::Ended).map_err(|e| e.to_string()),
            None => Ok(()),
        });
        if let Err(e) = archived {
            errors.push(e);
        }
    }
    Ok(errors)
}

/// Archives the cloud sessions of Done todos (see `Db::cloud_sessions_to_archive`).
pub fn archive_done(db: &Db) -> Result<Vec<String>, String> {
    let ids: Vec<String> = db.cloud_sessions_to_archive().map_err(|e| e.to_string())?.into_iter().map(|s| s.session_id).collect();
    archive_sessions(db, &ids)
}

pub struct SyncReport {
    pub seen: usize,
    pub recorded: usize,
    pub linked: usize,
    pub errors: Vec<String>,
}

pub fn sync(db: &Db) -> Result<SyncReport, String> {
    let (seen, recorded, linked, errors) = sync_all(db)?;
    Ok(SyncReport { seen, recorded, linked, errors })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn latest_environment_is_the_newest_cloud_sessions() {
        let sessions = vec![
            json!({"environment_kind": "bridge", "environment_id": "env_local"}),
            json!({"environment_kind": "anthropic_cloud", "environment_id": "env_new"}),
            json!({"environment_kind": "anthropic_cloud", "environment_id": "env_old"}),
        ];
        assert_eq!(latest_environment(&sessions).as_deref(), Some("env_new"));
        assert_eq!(latest_environment(&[]), None);
    }

    #[test]
    fn current_branches_skip_default_branches() {
        let s = json!({"external_metadata": {"current_branches": {"o/r": "claude/todo-1-ab", "": "fix-x", "o/s": "main"}}});
        let mut got = current_branches(&s);
        got.sort();
        assert_eq!(got, vec![("".to_string(), "fix-x".to_string()), ("o/r".to_string(), "claude/todo-1-ab".to_string())]);
        assert!(current_branches(&json!({})).is_empty());
    }

    #[test]
    fn repo_keys_prefer_push_targets_over_sources() {
        let s = json!({"config": {
            "sources": [{"type": "git_repository", "url": "https://github.com/o/a"}, {"type": "git_repository", "url": "https://github.com/o/shared"}],
            "outcomes": [{"type": "git_repository", "git_info": {"type": "github", "repo": "o/a"}}],
        }});
        assert_eq!(repo_keys(&s), vec!["o/a"]);
        let only_sources = json!({"config": {"sources": [{"type": "git_repository", "url": "https://github.com/o/a"}, {"type": "git_repository", "url": "https://github.com/o/b"}], "outcomes": []}});
        assert_eq!(repo_keys(&only_sources), vec!["o/a", "o/b"]);
        assert!(repo_keys(&json!({})).is_empty());
    }

    #[test]
    fn create_body_without_repos_has_no_checkout() {
        let b = create_body("env_1", &[], "claude/todo-2-ab12", "[todo:2] look into it", "look", "u-1");
        assert_eq!(b["session_context"]["sources"], json!([]));
        assert_eq!(b["session_context"]["outcomes"], json!([]));
        assert_eq!(b["events"][0]["data"]["message"]["content"], "[todo:2] look into it");
    }

    #[test]
    fn create_body_carries_marker_prompt_and_repo() {
        let b = create_body("env_1", &["o/r".into()], "claude/todo-2-ab12", "[todo:2] go", "go", "u-1");
        assert_eq!(b["environment_id"], "env_1");
        assert_eq!(b["title"], "go");
        assert_eq!(b["session_context"]["sources"][0], json!({"type": "git_repository", "url": "https://github.com/o/r"}));
        let ev = &b["events"][0];
        assert_eq!(ev["type"], "event");
        assert_eq!(ev["data"]["type"], "user");
        assert_eq!(ev["data"]["uuid"], "u-1");
        assert_eq!(ev["data"]["message"], json!({"role": "user", "content": "[todo:2] go"}));
        // Without an outcome the session has no GitHub repo/branch to work on.
        assert_eq!(
            b["session_context"]["outcomes"][0],
            json!({"type": "git_repository", "git_info": {"type": "github", "repo": "o/r", "branches": ["claude/todo-2-ab12"]}})
        );
    }

    #[test]
    fn start_options_set_model_and_effort_only_when_given() {
        let mut b = create_body("env_1", &[], "claude/x", "p", "t", "u");
        apply_options(&mut b, &StartOptions::default());
        assert!(b["session_context"].get("model").is_none() && b["session_context"].get("effort_level").is_none());
        apply_options(&mut b, &StartOptions { model: Some("claude-opus-5-5".into()), effort: Some("high".into()), ..Default::default() });
        assert_eq!(b["session_context"]["model"], "claude-opus-5-5");
        assert_eq!(b["session_context"]["effort_level"], "high");
    }

    #[test]
    fn create_body_lists_every_repo() {
        let b = create_body("env_1", &["o/a".into(), "o/b".into()], "claude/x", "p", "t", "u");
        assert_eq!(b["session_context"]["sources"].as_array().unwrap().len(), 2);
        assert_eq!(b["session_context"]["sources"][1]["url"], "https://github.com/o/b");
        assert_eq!(b["session_context"]["outcomes"][1]["git_info"]["repo"], "o/b");
        assert_eq!(b["session_context"]["outcomes"][1]["git_info"]["branches"], json!(["claude/x"]));
    }

    #[test]
    fn created_session_id_maps_to_code_session_id() {
        assert_eq!(code_session_id("session_013cYH").as_deref(), Some("cse_013cYH"));
        assert_eq!(code_session_id("cse_1").as_deref(), Some("cse_1"));
        assert_eq!(code_session_id("weird"), None);
    }

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
