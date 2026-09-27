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

pub fn desktop_new_url(cwd: Option<&str>, prompt: &str) -> String {
    match cwd {
        Some(cwd) => format!("claude://code/new?folder={}&q={}", encode(cwd), encode(prompt)),
        None => format!("claude://code/new?q={}", encode(prompt)),
    }
}

/// A todo's repo list may hold free group names ("調査"); only `owner/repo`
/// entries are GitHub repositories a cloud session can work on.
pub fn github_repos(repos: &[String]) -> Vec<String> {
    repos.iter().filter(|r| r.contains('/')).cloned().collect()
}

/// First prompt of a session started from a todo. A slash command must lead
/// the prompt to run, so then the marker goes last.
pub fn start_prompt(todo_id: i64, body: &str) -> String {
    if body.starts_with('/') {
        format!("{body} [todo:{todo_id}]")
    } else {
        format!("[todo:{todo_id}] {body}")
    }
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

/// `owner/repo` for grouping: from a GitHub URL (issue, PR, repo or git
/// remote) or a path laid out like ghq (`…/github.com/<owner>/<repo>/…`).
pub fn repo_key(url_or_path: &str) -> Option<String> {
    if let Some(url) = github_repo_url(url_or_path) {
        return url.strip_prefix(GITHUB_HTTPS).map(Into::into);
    }
    let rest = &url_or_path[url_or_path.find("github.com/")? + "github.com/".len()..];
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    let owner = parts.next()?;
    let repo = parts.next()?;
    Some(format!("{owner}/{repo}"))
}

/// `<ghq root>/github.com/<owner>/<repo>` when that checkout exists.
pub fn ghq_cwd(root: &Path, repo_url: &str) -> Option<PathBuf> {
    let path = github_repo_url(repo_url)?;
    let owner_repo = path.strip_prefix(GITHUB_HTTPS)?;
    let dir = root.join("github.com").join(owner_repo);
    dir.is_dir().then_some(dir)
}

/// Review stage of a pull request from
/// `gh pr view --json state,isDraft,reviewDecision,reviewRequests`.
pub fn pr_state(pr: &Value) -> &'static str {
    match pr["state"].as_str() {
        Some("MERGED") => return "merged",
        Some("CLOSED") => return "closed",
        _ => {}
    }
    if pr["isDraft"] == true {
        return "draft";
    }
    match pr["reviewDecision"].as_str() {
        Some("CHANGES_REQUESTED") => "changes_requested",
        Some("APPROVED") => "approved",
        // `gh pr view` lists requests; GraphQL gives a totalCount.
        _ if pr["reviewRequests"].as_array().is_some_and(|r| !r.is_empty())
            || pr["reviewRequests"]["totalCount"].as_i64().unwrap_or(0) > 0 =>
        {
            "review_requested"
        }
        Some("REVIEW_REQUIRED") => "review_requested",
        _ => "open",
    }
}

/// The pull request whose branch was made for this todo (`claude/todo-<id>-…`,
/// as cloud sessions started from the app name it), from
/// `gh pr list --json url,headRefName`.
pub fn pr_for_todo(prs: &Value, todo_id: i64) -> Option<String> {
    let prefix = format!("claude/todo-{todo_id}-");
    prs.as_array()?
        .iter()
        .find(|p| p["headRefName"].as_str().is_some_and(|h| h.starts_with(&prefix)))?["url"]
        .as_str()
        .map(Into::into)
}

pub fn is_default_branch(branch: &str) -> bool {
    matches!(branch, "main" | "master" | "develop" | "HEAD" | "")
}

/// Last `gitBranch` recorded in a Claude Code transcript (jsonl), skipping
/// default branches. Only the tail is read; transcripts grow large.
pub fn last_git_branch(transcript_tail: &str) -> Option<String> {
    const KEY: &str = "\"gitBranch\":\"";
    let start = transcript_tail.rfind(KEY)? + KEY.len();
    let branch = &transcript_tail[start..start + transcript_tail[start..].find('"')?];
    (!is_default_branch(branch)).then(|| branch.to_string())
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
            desktop_new_url(Some("/a b/c"), "[todo:1] 直す"),
            "claude://code/new?folder=%2Fa%20b%2Fc&q=%5Btodo%3A1%5D%20%E7%9B%B4%E3%81%99"
        );
        // No folder: Desktop starts the session in a scratch workspace.
        assert_eq!(desktop_new_url(None, "[todo:1] x"), "claude://code/new?q=%5Btodo%3A1%5D%20x");
        assert_eq!(start_prompt(3, "Fix it"), "[todo:3] Fix it");
        // A slash command must lead the prompt, so the marker goes last.
        assert_eq!(start_prompt(3, "/grilling Fix it"), "/grilling Fix it [todo:3]");
    }

    #[test]
    fn github_repos_are_the_entries_with_a_slash() {
        let repos = vec!["調査".to_string(), "o/r".to_string(), "個人".to_string()];
        assert_eq!(github_repos(&repos), vec!["o/r"]);
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
    fn repo_key_from_urls_and_paths() {
        assert_eq!(repo_key("https://github.com/o/r/issues/12").as_deref(), Some("o/r"));
        assert_eq!(repo_key("https://github.com/o/r").as_deref(), Some("o/r"));
        assert_eq!(repo_key("git@github.com:o/r.git").as_deref(), Some("o/r"));
        assert_eq!(repo_key("/Users/t/src/github.com/o/r").as_deref(), Some("o/r"));
        assert_eq!(repo_key("/Users/t/src/github.com/o/r/sub/dir").as_deref(), Some("o/r"));
        assert_eq!(repo_key("/Users/t/other/project"), None);
        assert_eq!(repo_key(""), None);
    }

    #[test]
    fn reads_root_pane_id() {
        let v = json!({"result": {"root_pane": {"pane_id": "w4:p1"}}});
        assert_eq!(herdr_pane_id(&v).as_deref(), Some("w4:p1"));
        assert_eq!(herdr_pane_id(&json!({})), None);
    }
}

#[cfg(test)]
mod pr_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pr_state_from_gh_view() {
        let v = |state: &str, draft: bool, decision: &str, requests: usize| {
            json!({"state": state, "isDraft": draft, "reviewDecision": decision,
                   "reviewRequests": vec![json!({"login": "x"}); requests]})
        };
        assert_eq!(pr_state(&v("MERGED", false, "APPROVED", 0)), "merged");
        assert_eq!(pr_state(&v("CLOSED", false, "", 0)), "closed");
        assert_eq!(pr_state(&v("OPEN", true, "", 1)), "draft");
        assert_eq!(pr_state(&v("OPEN", false, "CHANGES_REQUESTED", 1)), "changes_requested");
        assert_eq!(pr_state(&v("OPEN", false, "APPROVED", 0)), "approved");
        assert_eq!(pr_state(&v("OPEN", false, "REVIEW_REQUIRED", 1)), "review_requested");
        assert_eq!(pr_state(&v("OPEN", false, "", 0)), "open");
    }

    #[test]
    fn last_git_branch_from_transcript() {
        let t = r#"{"gitBranch":"main"}
{"gitBranch":"feat/x"}
"#;
        assert_eq!(last_git_branch(t).as_deref(), Some("feat/x"));
        assert_eq!(last_git_branch(r#"{"gitBranch":"main"}"#), None);
        assert_eq!(last_git_branch("nothing"), None);
    }

    #[test]
    fn pr_for_todo_branch() {
        let prs = json!([
            {"url": "https://github.com/o/r/pull/1", "headRefName": "claude/todo-12-ab12cd"},
            {"url": "https://github.com/o/r/pull/2", "headRefName": "claude/todo-1-ff00aa"},
        ]);
        assert_eq!(pr_for_todo(&prs, 1).as_deref(), Some("https://github.com/o/r/pull/2"));
        assert_eq!(pr_for_todo(&prs, 3), None);
    }
}
