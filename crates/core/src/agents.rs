//! Sessions reported by `claude agents --json`: every Claude Code session
//! alive on this machine, including ones started before the hooks existed.

use serde_json::Value;

use crate::SessionState;

#[derive(Debug, PartialEq)]
pub struct LiveSession {
    pub session_id: String,
    pub cwd: String,
    pub state: SessionState,
    pub name: Option<String>,
}

/// Interactive sessions report `status` (busy/idle); background ones report
/// `state` (running/blocked/exited).
pub fn parse_agents(json: &Value) -> Vec<LiveSession> {
    json.as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let session_id = a["sessionId"].as_str()?.to_string();
            let state = match (a["status"].as_str(), a["state"].as_str()) {
                (Some("busy"), _) | (_, Some("running")) => SessionState::Running,
                (_, Some("blocked")) => SessionState::NeedsInput,
                (_, Some("exited")) => SessionState::Ended,
                _ => SessionState::Idle,
            };
            Some(LiveSession {
                session_id,
                cwd: a["cwd"].as_str().unwrap_or_default().to_string(),
                state,
                name: a["name"].as_str().map(Into::into),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_interactive_and_background_entries() {
        let v = json!([
            {"sessionId": "a", "cwd": "/w/a", "kind": "interactive", "status": "busy", "name": "a-1"},
            {"sessionId": "b", "cwd": "/w/b", "kind": "interactive", "status": "idle", "name": "b-2"},
            {"sessionId": "c", "cwd": "/w/c", "kind": "background", "state": "blocked", "name": "fix ci"},
            {"sessionId": "d", "cwd": "/w/d", "kind": "background", "state": "running"},
            {"sessionId": "e", "cwd": "/w/e", "kind": "background", "state": "exited"},
            {"cwd": "/no/id"}
        ]);
        let got = parse_agents(&v);
        let states: Vec<(&str, SessionState)> = got.iter().map(|s| (s.session_id.as_str(), s.state)).collect();
        assert_eq!(
            states,
            vec![
                ("a", SessionState::Running),
                ("b", SessionState::Idle),
                ("c", SessionState::NeedsInput),
                ("d", SessionState::Running),
                ("e", SessionState::Ended),
            ]
        );
        assert_eq!(got[0].name.as_deref(), Some("a-1"));
        assert_eq!(got[3].name, None);
        assert!(parse_agents(&json!({})).is_empty());
    }
}
