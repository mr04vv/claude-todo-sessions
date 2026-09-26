use std::collections::HashSet;
use std::path::Path;

/// Finds the Desktop session id (`local_…`) whose record points at the given
/// CLI session id. Records live at `<root>/<account>/<org>/local_*.json`.
/// Every `local_*.json` record under `<root>/<account>/<org>/`.
fn records(root: &Path) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let accounts = std::fs::read_dir(root).into_iter().flatten().flatten();
    for org in accounts.flat_map(|a| std::fs::read_dir(a.path()).into_iter().flatten().flatten()) {
        for f in std::fs::read_dir(org.path()).into_iter().flatten().flatten() {
            let name = f.file_name();
            let name = name.to_string_lossy();
            if !(name.starts_with("local_") && name.ends_with(".json")) {
                continue;
            }
            let Ok(raw) = std::fs::read(f.path()) else { continue };
            if let Ok(v) = serde_json::from_slice(&raw) {
                out.push(v);
            }
        }
    }
    out
}

pub fn find_local_id(root: &Path, cli_session_id: &str) -> Option<String> {
    records(root)
        .into_iter()
        .find(|v| v["cliSessionId"] == cli_session_id)
        .and_then(|v| v["sessionId"].as_str().map(Into::into))
}

/// CLI session ids whose Desktop record is archived. Archiving in Desktop
/// does not stop a terminal session, so these are hidden rather than ended.
pub fn archived_cli_ids(root: &Path) -> HashSet<String> {
    records(root)
        .into_iter()
        .filter(|v| v["isArchived"] == true)
        .filter_map(|v| v["cliSessionId"].as_str().map(Into::into))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_archived_records() {
        let dir = tempfile::tempdir().unwrap();
        let org = dir.path().join("acct").join("org");
        std::fs::create_dir_all(&org).unwrap();
        std::fs::write(org.join("local_a.json"), r#"{"sessionId":"local_a","cliSessionId":"cli-1","isArchived":true}"#).unwrap();
        std::fs::write(org.join("local_b.json"), r#"{"sessionId":"local_b","cliSessionId":"cli-2","isArchived":false}"#).unwrap();
        std::fs::write(org.join("local_c.json"), r#"{"sessionId":"local_c","cliSessionId":"cli-3"}"#).unwrap();
        assert_eq!(archived_cli_ids(dir.path()), HashSet::from(["cli-1".to_string()]));
        assert!(archived_cli_ids(&dir.path().join("missing")).is_empty());
    }

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
