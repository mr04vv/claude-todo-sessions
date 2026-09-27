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
pub fn agent_states(agents: &Value) -> Vec<(String, String, crate::SessionState)> {
    use crate::SessionState::*;
    agents["result"]["agents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["agent"] == "claude")
        .filter_map(|a| {
            let id = a["agent_session"]["value"].as_str()?;
            let state = match a["agent_status"].as_str()? {
                "working" => Running,
                "idle" | "done" => Idle,
                "blocked" | "waiting" => NeedsInput,
                _ => return None,
            };
            Some((id.to_string(), a["cwd"].as_str().unwrap_or_default().to_string(), state))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
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
            {"agent": "codex", "agent_session": {"value": "f"}, "agent_status": "working", "cwd": "/w/f"},
            {"agent": "claude", "agent_status": "working"}
        ]}});
        let got: Vec<(String, crate::SessionState)> = agent_states(&agents).into_iter().map(|(id, _, st)| (id, st)).collect();
        assert_eq!(got, vec![("a".into(), Running), ("b".into(), Idle), ("c".into(), NeedsInput), ("d".into(), NeedsInput)]);
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
