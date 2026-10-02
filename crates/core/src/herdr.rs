//! Reading herdr's CLI output: which named sessions run, and which pane
//! hosts a given Claude Code session.

use serde_json::Value;

/// Names of running sessions from `herdr session list` (a text table with
/// name, status, directory and socket columns).
pub fn running_sessions(table: &str) -> Vec<String> {
    table
        .lines()
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            let name = cols.next()?;
            (cols.next() == Some("running")).then(|| name.to_string())
        })
        .collect()
}

/// herdr's unnamed session, which `herdr` without `--session` talks to.
pub const DEFAULT_SESSION: &str = "default";

/// The running session new workspaces go to: the one picked, else the
/// default one, else the first running one. None when herdr is not running.
pub fn pick_session(running: &[String], picked: Option<&str>) -> Option<String> {
    let is_running = |name: &str| running.iter().any(|r| r == name);
    picked
        .filter(|p| is_running(p))
        .or_else(|| is_running(DEFAULT_SESSION).then_some(DEFAULT_SESSION))
        .map(Into::into)
        .or_else(|| running.first().cloned())
}

/// Pane id of the agent whose Claude session id matches, from
/// `herdr agent list` JSON.
pub fn find_pane(agents: &Value, session_id: &str) -> Option<String> {
    agents["result"]["agents"]
        .as_array()?
        .iter()
        .find(|a| a["agent_session"]["value"] == session_id)?["pane_id"]
        .as_str()
        .map(Into::into)
}

/// Live state of every Claude agent herdr hosts, from `herdr agent list`:
/// (session id, cwd, state). herdr watches the terminal, so this is current
/// even for sessions without our hooks. Unknown statuses are skipped.
/// A Claude agent herdr hosts, as `herdr agent list` reports it.
pub struct AgentState {
    pub session_id: String,
    pub cwd: String,
    pub state: crate::SessionState,
    /// herdr's "done": the turn ended and the pane has not been looked at since.
    pub unseen: bool,
}

pub fn agent_states(agents: &Value) -> Vec<AgentState> {
    use crate::SessionState::*;
    agents["result"]["agents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["agent"] == "claude")
        .filter_map(|a| {
            let id = a["agent_session"]["value"].as_str()?;
            let status = a["agent_status"].as_str()?;
            let state = match status {
                "working" => Running,
                "idle" | "done" => Idle,
                "blocked" | "waiting" => NeedsInput,
                _ => return None,
            };
            Some(AgentState { session_id: id.to_string(), cwd: a["cwd"].as_str().unwrap_or_default().to_string(), state, unseen: status == "done" })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_chosen_running_session_else_default_else_first() {
        let running: Vec<String> = ["implement", "review"].map(String::from).to_vec();
        assert_eq!(pick_session(&running, Some("review")).as_deref(), Some("review"));
        // A pick that is no longer running falls back.
        assert_eq!(pick_session(&running, Some("gone")).as_deref(), Some("implement"));
        let with_default: Vec<String> = ["implement", "default"].map(String::from).to_vec();
        assert_eq!(pick_session(&with_default, None).as_deref(), Some("default"));
        assert_eq!(pick_session(&[], Some("review")), None);
    }
    use serde_json::json;

    #[test]
    fn maps_herdr_agent_statuses() {
        use crate::SessionState::*;
        let agents = json!({"result": {"agents": [
            {"agent": "claude", "agent_session": {"value": "a"}, "agent_status": "working", "cwd": "/w/a"},
            {"agent": "claude", "agent_session": {"value": "b"}, "agent_status": "idle", "cwd": "/w/b"},
            {"agent": "claude", "agent_session": {"value": "c"}, "agent_status": "blocked", "cwd": "/w/c"},
            {"agent": "claude", "agent_session": {"value": "d"}, "agent_status": "waiting", "cwd": "/w/d"},
            {"agent": "claude", "agent_session": {"value": "e"}, "agent_status": "unknown", "cwd": "/w/e"},
            {"agent": "claude", "agent_session": {"value": "g"}, "agent_status": "done", "cwd": "/w/g"},
            {"agent": "codex", "agent_session": {"value": "f"}, "agent_status": "working", "cwd": "/w/f"},
            {"agent": "claude", "agent_status": "working"}
        ]}});
        let got: Vec<(String, crate::SessionState, bool)> = agent_states(&agents).into_iter().map(|a| (a.session_id, a.state, a.unseen)).collect();
        // "done" is a finished turn not looked at yet, "idle" one looked at.
        assert_eq!(
            got,
            vec![("a".into(), Running, false), ("b".into(), Idle, false), ("c".into(), NeedsInput, false), ("d".into(), NeedsInput, false), ("g".into(), Idle, true)]
        );
    }

    #[test]
    fn running_sessions_from_table() {
        let table = "name                 status   directory   socket\n\
                     default              stopped  /a          /a/herdr.sock\n\
                     implement            running  /b          /b/herdr.sock\n\
                     review               running  /c          /c/herdr.sock\n";
        assert_eq!(running_sessions(table), vec!["implement", "review"]);
        assert!(running_sessions("").is_empty());
    }

    #[test]
    fn finds_pane_by_agent_session() {
        let agents = json!({"result": {"agents": [
            {"pane_id": "w1:p1", "agent_session": {"agent": "claude", "value": "aaa"}},
            {"pane_id": "w3:p1", "agent_session": {"agent": "claude", "value": "bbb"}},
            {"pane_id": "w4:p1"}
        ]}});
        assert_eq!(find_pane(&agents, "bbb").as_deref(), Some("w3:p1"));
        assert_eq!(find_pane(&agents, "zzz"), None);
        assert_eq!(find_pane(&json!({}), "aaa"), None);
    }
}
