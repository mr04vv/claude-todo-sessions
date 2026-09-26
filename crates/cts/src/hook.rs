use std::io::Read;

use cts_core::{Db, SessionState};
use serde::Deserialize;

#[derive(Deserialize)]
struct Input {
    session_id: String,
    cwd: String,
    prompt: Option<String>,
}

pub fn run(event: &str) -> Result<(), String> {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).map_err(|e| e.to_string())?;
    let input: Input = serde_json::from_str(&raw).map_err(|e| format!("hook input: {e}"))?;
    let db = crate::open_db()?;
    if let Some(context) = handle(&db, event, &input)? {
        print!("{context}");
    }
    Ok(())
}

/// Returns text to add to the session context (SessionStart only).
fn handle(db: &Db, event: &str, i: &Input) -> Result<Option<String>, String> {
    let state = match event {
        "session-start" => SessionState::Idle,
        "user-prompt-submit" => {
            let prompt = i.prompt.as_deref().unwrap_or_default();
            db.on_prompt(&i.session_id, &i.cwd, prompt).map_err(|e| e.to_string())?;
            return Ok(None);
        }
        "notification" => SessionState::NeedsInput,
        "stop" => SessionState::Idle,
        "session-end" => SessionState::Ended,
        other => return Err(format!("unknown hook event: {other}")),
    };
    db.record_session(&i.session_id, &i.cwd, state).map_err(|e| e.to_string())?;
    Ok((event == "session-start").then(|| {
        format!(
            "claude-todo-sessions: this session's session_id is {}. Pass it as session_id when calling the link_session tool.",
            i.session_id
        )
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(prompt: Option<&str>) -> Input {
        Input { session_id: "s1".into(), cwd: "/w".into(), prompt: prompt.map(Into::into) }
    }

    #[test]
    fn events_map_to_states_and_only_session_start_prints() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("db.sqlite")).unwrap();
        let ctx = handle(&db, "session-start", &input(None)).unwrap().unwrap();
        assert!(ctx.contains("s1"));
        for (event, want) in [
            ("user-prompt-submit", SessionState::Running),
            ("notification", SessionState::NeedsInput),
            ("stop", SessionState::Idle),
            ("session-end", SessionState::Ended),
        ] {
            assert_eq!(handle(&db, event, &input(Some("hi"))).unwrap(), None);
            assert_eq!(db.get_session("s1").unwrap().unwrap().state, want, "{event}");
        }
        assert!(handle(&db, "bogus", &input(None)).is_err());
    }
}
