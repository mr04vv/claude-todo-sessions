//! What a parent todo's planning session (its orchestrator) does to its
//! subtasks through the MCP server: start them, answer them, have them fix
//! their PRs, and hand them to the user. It runs in a herdr pane on the Mac;
//! the subtasks run in a herdr session of their own beside it (`<its
//! session>-sub`), which the app shows apart from the parent's.

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

/// The herdr session the subtasks run in, started when it does not run yet;
/// None outside herdr (herdr's CLI then talks to its own default).
fn subtasks_session() -> Result<Option<String>, String> {
    let Ok(parent) = std::env::var(HERDR_SESSION_ENV) else { return Ok(None) };
    let name = cts_core::herdr::subtasks_session(&parent);
    cts_core::herdr::ensure_session(&name, || Command::new("herdr"))?;
    Ok(Some(name))
}

/// Set in a herdr pane: the herdr session it is in.
const HERDR_SESSION_ENV: &str = "HERDR_SESSION";

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
    let opts = StartOptions { model, effort, plan: false, agent, permission_mode: None };
    let (place, session) = if launch::subtask_on_cloud(&t.repos, agent, cloud) {
        let mut repos = launch::github_repos(&t.repos);
        repos.extend(t.issue_url.as_deref().and_then(launch::repo_key).filter(|r| !repos.contains(r)));
        let body = launch::cloud_subtask_prompt(&db.session_prompt(&t, false).map_err(|e| e.to_string())?);
        ("Cloud", Some(cts_core::cloud::create_session(&db, t.id, &repos, &t.title, &body, &opts)?))
    } else {
        ("herdr", launch::start_todo_in_herdr(&db, &t, &opts, &cwd_of(&t), subtasks_session()?.as_deref(), herdr)?)
    };
    log(&db, &t, &format!("#{} {} を {place} で始めました", t.id, t.title))?;
    Ok(format!("started todo {} on {place}{}", t.id, session.map(|s| format!(" (session {s})")).unwrap_or_default()))
}

/// The subtask's latest session.
fn latest_session(db: &Db, id: i64) -> Result<Session, String> {
    db.sessions_for_todo(id).map_err(|e| e.to_string())?.into_iter().next().ok_or_else(|| format!("todo {id} has no session yet: start_subtask first"))
}

/// Sends `text` to the herdr pane running the session (in the subtasks'
/// herdr session, or this one), or false when herdr does not host it.
fn prompt_pane(session_id: &str, text: &str) -> Result<bool, String> {
    let sub = subtasks_session()?;
    for session in [sub.as_deref(), None] {
        let on = |args: &[&str]| -> Vec<String> { session.map(|s| vec!["--session".to_string(), s.to_string()]).unwrap_or_default().into_iter().chain(args.iter().map(|a| a.to_string())).collect() };
        let list = on(&["agent", "list"]);
        let agents: serde_json::Value = serde_json::from_str(&herdr(&list.iter().map(String::as_str).collect::<Vec<_>>())?).map_err(|e| format!("herdr output: {e}"))?;
        let Some(pane) = cts_core::herdr::find_pane(&agents, session_id) else { continue };
        let prompt = on(&["agent", "prompt", &pane, text]);
        return herdr(&prompt.iter().map(String::as_str).collect::<Vec<_>>()).map(|_| true);
    }
    Ok(false)
}

pub fn reply(id: i64, text: &str) -> Result<String, String> {
    let db = crate::open_db()?;
    let t = todo(&db, id)?;
    let s = latest_session(&db, id)?;
    if launch::is_cloud_session(&s.session_id) {
        return Err("Cloud のサブタスクには、ここからは送れません。Claude Code の SendMessage で送ってください（宛先は ListAgents に出る、このサブタスクのセッション）".into());
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
    let cloud = launch::is_cloud_session(&s.session_id);
    if !cloud && !prompt_pane(&s.session_id, &prompt)? {
        // Not running any more: resumed with the request, in a workspace not shown.
        let program = if s.agent == Agent::Codex { "codex resume" } else { "claude --resume" };
        let command = format!("{program} {} {}", s.session_id, launch::shell_quote(&prompt));
        cts_core::herdr::start_workspace(herdr, subtasks_session()?.as_deref(), &s.cwd, &t.title, &command, false)?;
    }
    let n = db.count_fix(id).map_err(|e| e.to_string())?;
    log(&db, &t, &format!("#{} に PR を直させました（{n} 回目）", t.id))?;
    if cloud {
        return Ok(format!("todo {} runs on Cloud, which is not sent from here: send its session (ListAgents names it) this with SendMessage ({n} of {}):\n\n{prompt}", t.id, cts_core::MAX_FIXES));
    }
    Ok(format!("sent todo {} what to fix ({n} of {})", t.id, cts_core::MAX_FIXES))
}

pub fn escalate(id: i64, why: &str) -> Result<String, String> {
    let db = crate::open_db()?;
    let t = todo(&db, id)?;
    db.escalate(id, Some(why)).map_err(|e| e.to_string())?;
    log(&db, &t, &format!("#{} をあなたに回しました：{why}", t.id))?;
    Ok(format!("handed todo {} to the user: they are notified, and it waits on them", t.id))
}
