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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
