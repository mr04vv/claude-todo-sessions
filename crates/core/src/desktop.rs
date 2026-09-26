use std::path::Path;

/// Finds the Desktop session id (`local_…`) whose record points at the given
/// CLI session id. Records live at `<root>/<account>/<org>/local_*.json`.
pub fn find_local_id(root: &Path, cli_session_id: &str) -> Option<String> {
    let dirs = std::fs::read_dir(root).ok()?.flatten().flat_map(|a| std::fs::read_dir(a.path()).into_iter().flatten().flatten());
    for org in dirs {
        for f in std::fs::read_dir(org.path()).into_iter().flatten().flatten() {
            let name = f.file_name();
            let name = name.to_string_lossy();
            if !(name.starts_with("local_") && name.ends_with(".json")) {
                continue;
            }
            let Ok(raw) = std::fs::read(f.path()) else { continue };
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) else { continue };
            if v["cliSessionId"] == cli_session_id {
                return v["sessionId"].as_str().map(Into::into);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_record_by_cli_session_id() {
        let dir = tempfile::tempdir().unwrap();
        let org = dir.path().join("acct").join("org");
        std::fs::create_dir_all(&org).unwrap();
        std::fs::write(org.join("local_a.json"), r#"{"sessionId":"local_a","cliSessionId":"cli-1"}"#).unwrap();
        std::fs::write(org.join("local_b.json"), r#"{"sessionId":"local_b","cliSessionId":"cli-2"}"#).unwrap();
        std::fs::write(org.join("scheduled-tasks.json"), "[]").unwrap();
        assert_eq!(find_local_id(dir.path(), "cli-2").as_deref(), Some("local_b"));
        assert_eq!(find_local_id(dir.path(), "nope"), None);
        assert_eq!(find_local_id(&dir.path().join("missing"), "cli-1"), None);
    }
}
