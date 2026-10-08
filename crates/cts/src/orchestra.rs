//! What a parent todo's planning session (its orchestrator) does to its
//! subtasks through the MCP server: start them, answer them, have them fix
//! their PRs, and hand them to the user. It runs in a herdr pane on the Mac,
//! so herdr's CLI talks to the herdr session it is in.

use std::path::PathBuf;
use std::process::Command;

use cts_core::launch::{self, StartOptions};
use cts_core::{Agent, Db, Session, Todo};

/// Characters of an answer kept in the parent's 経過.
const EVENT_TEXT_MAX: usize = 80;

fn herdr(args: &[&str]) -> Result<String, String> {
    let out = Command::new("herdr").args(args).output().map_err(|e| format!("herdr: {e}"))?;
    if !out.status.success() {
        return Err(format!("herdr {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into())
}

fn todo(db: &Db, id: i64) -> Result<Todo, String> {
    db.get_todo(id).map_err(|e| e.to_string())?.ok_or_else(|| format!("todo {id} not found"))
}

/// Records what was done under the subtask's parent (or the todo itself).
fn log(db: &Db, t: &Todo, text: &str) -> Result<(), String> {
    db.add_event(t.parent_id.unwrap_or(t.id), text).map_err(|e| e.to_string())
}

/// A subtask's folder: its own, else its first GitHub repository's ghq
/// checkout, else the home folder.
fn cwd_of(t: &Todo) -> String {
    let checkout = || {
        let repo = launch::github_repos(&t.repos).into_iter().next()?;
        let out = Command::new("ghq").arg("root").output().ok()?;
        let root = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        launch::ghq_cwd(&root, &format!("https://github.com/{repo}")).map(|p| p.to_string_lossy().into_owned())
    };
    t.cwd.clone().or_else(checkout).unwrap_or_else(|| std::env::var("HOME").unwrap_or_default())
}

pub fn start_subtask(id: i64, cloud: Option<bool>, agent: Option<&str>, model: Option<String>, effort: Option<String>) -> Result<String, String> {
    let db = crate::open_db()?;
    let t = todo(&db, id)?;
    let agent = if agent == Some("codex") { Agent::Codex } else { Agent::Claude };
    let opts = StartOptions { model, effort, plan: false, agent };
    let (place, session) = if launch::subtask_on_cloud(&t.repos, agent, cloud) {
        let mut repos = launch::github_repos(&t.repos);
        repos.extend(t.issue_url.as_deref().and_then(launch::repo_key).filter(|r| !repos.contains(r)));
        let body = db.session_prompt(&t, false).map_err(|e| e.to_string())?;
        ("Cloud", Some(cts_core::cloud::create_session(&db, t.id, &repos, &t.title, &body, &opts)?))
    } else {
        ("herdr", launch::start_todo_in_herdr(&db, &t, &opts, &cwd_of(&t), None, herdr)?)
    };
    log(&db, &t, &format!("#{} {} を {place} で始めました", t.id, t.title))?;
    Ok(format!("started todo {} on {place}{}", t.id, session.map(|s| format!(" (session {s})")).unwrap_or_default()))
}

/// The subtask's latest session.
fn latest_session(db: &Db, id: i64) -> Result<Session, String> {
    db.sessions_for_todo(id).map_err(|e| e.to_string())?.into_iter().next().ok_or_else(|| format!("todo {id} has no session yet: start_subtask first"))
}

/// Sends `text` to the herdr pane running the session, or false when herdr does not host it.
fn prompt_pane(session_id: &str, text: &str) -> Result<bool, String> {
    let agents: serde_json::Value = serde_json::from_str(&herdr(&["agent", "list"])?).map_err(|e| format!("herdr output: {e}"))?;
    let Some(pane) = cts_core::herdr::find_pane(&agents, session_id) else { return Ok(false) };
    herdr(&["agent", "prompt", &pane, text]).map(|_| true)
}

pub fn reply(id: i64, text: &str) -> Result<String, String> {
    let db = crate::open_db()?;
    let t = todo(&db, id)?;
    let s = latest_session(&db, id)?;
    if launch::is_cloud_session(&s.session_id) {
        return Err("Cloud のサブタスクには送れません。escalate で、答えの案を添えて人に回してください".into());
    }
    if !prompt_pane(&s.session_id, text)? {
        return Err("このサブタスクのセッションは herdr で動いていません".into());
    }
    let short: String = text.chars().take(EVENT_TEXT_MAX).collect();
    log(&db, &t, &format!("#{} に答えました：{short}", t.id))?;
    Ok(format!("sent to todo {}", t.id))
}

pub fn fix(id: i64) -> Result<String, String> {
    let db = crate::open_db()?;
    let t = todo(&db, id)?;
    if t.fix_count >= cts_core::MAX_FIXES {
        return escalate(id, &format!("{} 回直させても CI が通りません", t.fix_count));
    }
    let pr = t.pr_url.as_deref().ok_or("この todo には PR がありません")?;
    let ci = (t.ci_state.as_deref() == Some("failure")).then_some(t.ci_failed.as_slice());
    let prompt = launch::fix_prompt(pr, ci, t.pr_state.as_deref() == Some("changes_requested"));
    let s = latest_session(&db, id)?;
    if launch::is_cloud_session(&s.session_id) {
        return escalate(id, "Cloud のサブタスクには送れないので、「再開して直させる」を押してください");
    }
    if !prompt_pane(&s.session_id, &prompt)? {
        // Not running any more: resumed with the request, in a workspace not shown.
        let program = if s.agent == Agent::Codex { "codex resume" } else { "claude --resume" };
        let command = format!("{program} {} {}", s.session_id, launch::shell_quote(&prompt));
        cts_core::herdr::start_workspace(herdr, None, &s.cwd, &t.title, &command, false)?;
    }
    let n = db.count_fix(id).map_err(|e| e.to_string())?;
    log(&db, &t, &format!("#{} に PR を直させました（{n} 回目）", t.id))?;
    Ok(format!("sent todo {} what to fix ({n} of {})", t.id, cts_core::MAX_FIXES))
}

pub fn escalate(id: i64, why: &str) -> Result<String, String> {
    let db = crate::open_db()?;
    let t = todo(&db, id)?;
    db.escalate(id, Some(why)).map_err(|e| e.to_string())?;
    log(&db, &t, &format!("#{} をあなたに回しました：{why}", t.id))?;
    Ok(format!("handed todo {} to the user: they are notified, and it waits on them", t.id))
}
