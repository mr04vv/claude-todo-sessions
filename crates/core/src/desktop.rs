use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;

/// The fields read from a Desktop record; the rest of it (the conversation)
/// is skipped rather than parsed.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Record {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "cliSessionId")]
    cli_session_id: Option<String>,
    #[serde(rename = "isArchived", default)]
    is_archived: bool,
}

/// Every `local_*.json` file under `<root>/<account>/<org>/`.
fn record_paths(root: &Path) -> Vec<PathBuf> {
    let accounts = std::fs::read_dir(root).into_iter().flatten().flatten();
    accounts
        .flat_map(|a| std::fs::read_dir(a.path()).into_iter().flatten().flatten())
        .flat_map(|org| std::fs::read_dir(org.path()).into_iter().flatten().flatten())
        .filter(|f| {
            let name = f.file_name();
            let name = name.to_string_lossy();
            name.starts_with("local_") && name.ends_with(".json")
        })
        .map(|f| f.path())
        .collect()
}

fn read_record(path: &Path) -> Option<Record> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Finds the Desktop session id (`local_…`) whose record points at the given
/// CLI session id. Records live at `<root>/<account>/<org>/local_*.json`.
pub fn find_local_id(root: &Path, cli_session_id: &str) -> Option<String> {
    record_paths(root)
        .iter()
        .filter_map(|p| read_record(p))
        .find(|r| r.cli_session_id.as_deref() == Some(cli_session_id) && !r.is_archived)
        .and_then(|r| r.session_id)
}

/// CLI session ids whose Desktop record is archived. Archiving in Desktop
/// does not stop a terminal session, so these are hidden rather than ended.
pub fn archived_cli_ids(root: &Path) -> HashSet<String> {
    archived(record_paths(root).iter().filter_map(|p| read_record(p)))
}

fn archived(records: impl IntoIterator<Item = Record>) -> HashSet<String> {
    records.into_iter().filter(|r| r.is_archived).filter_map(|r| r.cli_session_id).collect()
}

/// Keeps what each Desktop record says, reading a file again only when its
/// size or modification time changed. The records are large (the whole
/// conversation), and the watch loop asks every few seconds.
#[derive(Default)]
pub struct RecordCache {
    files: HashMap<PathBuf, (SystemTime, u64, Record)>,
}

impl RecordCache {
    pub fn archived_cli_ids(&mut self, root: &Path) -> HashSet<String> {
        let mut seen = HashMap::new();
        for path in record_paths(root) {
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            let (modified, len) = (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len());
            let record = match self.files.remove(&path) {
                Some((m, l, r)) if m == modified && l == len => r,
                _ => read_record(&path).unwrap_or_default(),
            };
            seen.insert(path, (modified, len, record));
        }
        // Files that went away are dropped with the old map.
        self.files = seen;
        archived(self.files.values().map(|(_, _, r)| r.clone()))
    }
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
    fn cache_rereads_only_changed_records() {
        let dir = tempfile::tempdir().unwrap();
        let org = dir.path().join("acct").join("org");
        std::fs::create_dir_all(&org).unwrap();
        let a = org.join("local_a.json");
        std::fs::write(&a, r#"{"sessionId":"local_a","cliSessionId":"cli-1","isArchived":true ,"big":[1,2,3]}"#).unwrap();
        let mut cache = RecordCache::default();
        assert_eq!(cache.archived_cli_ids(dir.path()), HashSet::from(["cli-1".to_string()]));
        // Same size and modification time: taken from the cache, not read again.
        let mtime = std::fs::metadata(&a).unwrap().modified().unwrap();
        std::fs::write(&a, r#"{"sessionId":"local_a","cliSessionId":"cli-1","isArchived":false,"big":[1,2,3]}"#).unwrap();
        std::fs::File::options().write(true).open(&a).unwrap().set_modified(mtime).unwrap();
        assert_eq!(cache.archived_cli_ids(dir.path()), HashSet::from(["cli-1".to_string()]));
        // A changed record is read again; a removed one drops out.
        std::fs::File::options().write(true).open(&a).unwrap().set_modified(mtime + std::time::Duration::from_secs(5)).unwrap();
        std::fs::write(org.join("local_b.json"), r#"{"sessionId":"local_b","cliSessionId":"cli-2","isArchived":true}"#).unwrap();
        assert_eq!(cache.archived_cli_ids(dir.path()), HashSet::from(["cli-2".to_string()]));
        std::fs::remove_file(org.join("local_b.json")).unwrap();
        assert!(cache.archived_cli_ids(dir.path()).is_empty());
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
        // An archived record does not open by continue; resume unarchives it instead.
        std::fs::write(org.join("local_c.json"), r#"{"sessionId":"local_c","cliSessionId":"cli-3","isArchived":true}"#).unwrap();
        assert_eq!(find_local_id(dir.path(), "cli-3"), None);
    }
}
