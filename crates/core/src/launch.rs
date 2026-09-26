use std::path::{Path, PathBuf};

use serde_json::Value;

const CLOUD_PREFIX: &str = "cse_";

pub fn is_cloud_session(id: &str) -> bool {
    id.starts_with(CLOUD_PREFIX)
}

/// Deep link that opens a session in Claude Desktop. A local session Desktop
/// already knows opens by its `local_…` id; otherwise it is imported by resume.
pub fn jump_url(session_id: &str, desktop_local_id: Option<&str>) -> String {
    if is_cloud_session(session_id) {
        return format!("claude://code/{session_id}");
    }
    match desktop_local_id {
        Some(local) => format!("claude://code/continue?session={local}"),
        None => format!("claude://resume?session={session_id}"),
    }
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn desktop_new_url(cwd: &str, prompt: &str) -> String {
    format!("claude://code/new?folder={}&q={}", encode(cwd), encode(prompt))
}

pub fn start_prompt(todo_id: i64, title: &str) -> String {
    format!("[todo:{todo_id}] {title}")
}

const GITHUB_HTTPS: &str = "https://github.com/";
const GITHUB_SSH: &str = "git@github.com:";

/// `https://github.com/<owner>/<repo>` from an issue/PR URL or a git remote.
pub fn github_repo_url(url: &str) -> Option<String> {
    let path = url.strip_prefix(GITHUB_HTTPS).or_else(|| url.strip_prefix(GITHUB_SSH))?;
    let mut parts = path.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().map(|r| r.trim_end_matches(".git")).filter(|s| !s.is_empty())?;
    Some(format!("{GITHUB_HTTPS}{owner}/{repo}"))
}

/// `<ghq root>/github.com/<owner>/<repo>` when that checkout exists.
pub fn ghq_cwd(root: &Path, repo_url: &str) -> Option<PathBuf> {
    let path = github_repo_url(repo_url)?;
    let owner_repo = path.strip_prefix(GITHUB_HTTPS)?;
    let dir = root.join("github.com").join(owner_repo);
    dir.is_dir().then_some(dir)
}

pub fn herdr_pane_id(created: &Value) -> Option<String> {
    created["result"]["root_pane"]["pane_id"].as_str().map(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jump_urls_by_session_kind() {
        assert!(is_cloud_session("cse_01abc"));
        assert!(!is_cloud_session("289bbb74-3a03"));
        assert_eq!(jump_url("cse_01abc", None), "claude://code/cse_01abc");
        assert_eq!(jump_url("u-1", Some("local_x")), "claude://code/continue?session=local_x");
        assert_eq!(jump_url("u-1", None), "claude://resume?session=u-1");
    }

    #[test]
    fn desktop_new_url_encodes_query() {
        assert_eq!(
            desktop_new_url("/a b/c", "[todo:1] 直す"),
            "claude://code/new?folder=%2Fa%20b%2Fc&q=%5Btodo%3A1%5D%20%E7%9B%B4%E3%81%99"
        );
        assert_eq!(start_prompt(3, "Fix it"), "[todo:3] Fix it");
    }

    #[test]
    fn repo_url_from_issue_or_remote() {
        assert_eq!(github_repo_url("https://github.com/o/r/issues/12").as_deref(), Some("https://github.com/o/r"));
        assert_eq!(github_repo_url("https://github.com/o/r/pull/3").as_deref(), Some("https://github.com/o/r"));
        assert_eq!(github_repo_url("git@github.com:o/r.git").as_deref(), Some("https://github.com/o/r"));
        assert_eq!(github_repo_url("https://github.com/o/r.git").as_deref(), Some("https://github.com/o/r"));
        assert_eq!(github_repo_url("https://example.com/x"), None);
    }

    #[test]
    fn ghq_cwd_when_checkout_exists() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("github.com").join("o").join("r");
        std::fs::create_dir_all(&repo).unwrap();
        assert_eq!(ghq_cwd(dir.path(), "https://github.com/o/r"), Some(repo));
        assert_eq!(ghq_cwd(dir.path(), "https://github.com/o/missing"), None);
        assert_eq!(ghq_cwd(dir.path(), "https://example.com/o/r"), None);
    }

    #[test]
    fn reads_root_pane_id() {
        let v = json!({"result": {"root_pane": {"pane_id": "w4:p1"}}});
        assert_eq!(herdr_pane_id(&v).as_deref(), Some("w4:p1"));
        assert_eq!(herdr_pane_id(&json!({})), None);
    }
}
