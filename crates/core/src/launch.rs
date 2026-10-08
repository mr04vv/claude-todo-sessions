use std::path::{Path, PathBuf};

use serde_json::Value;

const CLOUD_PREFIX: &str = "cse_";

pub fn is_cloud_session(id: &str) -> bool {
    id.starts_with(CLOUD_PREFIX)
}

const CLOUD_WEB: &str = "https://claude.ai/code/";

/// claude.ai page of a cloud session; the web names `cse_…` as `session_…`.
pub fn web_url(session_id: &str) -> Option<String> {
    session_id.strip_prefix(CLOUD_PREFIX).map(|rest| format!("{CLOUD_WEB}session_{rest}"))
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

/// Model and effort picked for a new session; None (or blank) keeps the default.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
pub struct StartOptions {
    pub model: Option<String>,
    pub effort: Option<String>,
    /// The session plans the todo, splitting it into subtasks, instead of
    /// implementing it (Claude in herdr: it reaches the Mac's MCP server).
    #[serde(default)]
    pub plan: bool,
    /// What runs it (a terminal session; Cloud and Desktop are Claude's).
    #[serde(default)]
    pub agent: crate::Agent,
}

/// A todo's first prompt for Codex: without a leading Claude skill
/// (`/grilling …`) and the AskUserQuestion sentence, which only Claude reads.
pub fn codex_body(body: &str) -> String {
    let body = body.replace(crate::ASK_INSTRUCTIONS, "").replace("AskUserQuestion で", "");
    let body = match body.strip_prefix('/') {
        Some(rest) => rest.split_once(char::is_whitespace).map_or("", |(_, r)| r).to_string(),
        None => body,
    };
    body.trim().to_string()
}

impl StartOptions {
    fn given(v: &Option<String>) -> Option<&str> {
        v.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }

    pub fn model(&self) -> Option<&str> {
        Self::given(&self.model)
    }

    pub fn effort(&self) -> Option<&str> {
        Self::given(&self.effort)
    }

    /// `claude` flags for a terminal session.
    pub fn claude_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(m) = self.model() {
            args.extend(["--model".to_string(), m.into()]);
        }
        if let Some(e) = self.effort() {
            args.extend(["--effort".to_string(), e.into()]);
        }
        args
    }

    /// `codex` flags: its model, and its reasoning effort as a config value.
    pub fn codex_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(m) = self.model() {
            args.extend(["-m".to_string(), m.into()]);
        }
        if let Some(e) = self.effort() {
            args.extend(["-c".to_string(), format!("model_reasoning_effort=\"{e}\"")]);
        }
        args
    }
}

/// What a session is sent to fix its PR: the CI's failed checks (`ci`,
/// with their names when known) and the changes a reviewer asked for.
pub fn fix_prompt(pr_url: &str, ci: Option<&[String]>, changes: bool) -> String {
    let mut parts = Vec::new();
    if changes {
        parts.push(format!(
            "PR {pr_url} に修正の依頼が来ています。`gh pr view {pr_url} --comments` とレビューのコメント（`gh api` で PR の review comments）を読んで直し、push して、依頼してきた人に再レビューを頼んでください。"
        ));
    }
    if let Some(failed) = ci {
        let which = if failed.is_empty() { String::new() } else { format!("（{}）", failed.join("、")) };
        parts.push(format!(
            "PR {pr_url} の CI が失敗しています{which}。`gh pr checks {pr_url}` と、失敗したジョブのログ（`gh run view <run-id> --log-failed`）を見て原因を直し、push してください。"
        ));
    }
    parts.join("\n\n")
}

/// How a review session that submits on its own is told so; its prompt is
/// known by it again (`review_of_prompt`).
pub const AUTO_SUBMIT: &str = "レビューが終わったら、確認せずに GitHub に提出してください。ブロッカー（マージ前に直すべき問題）があれば Request changes、なければ Approve で、ブロッカーでない指摘はコメントとして添えてください。";
const REVIEW_SUBMIT_HOW: &str = "指摘はインラインコメントと本文にまとめて提出してください（gh pr review、使えなければ GitHub のツール）。";
const CLAUDE_REVIEW: &str = "/review ";
const CODEX_REVIEW: (&str, &str) = ("PR ", " をレビューしてください。");

/// First prompt of a review of the PR at `url`. Claude runs its /review
/// skill (which answers in English unless asked otherwise); Codex, without
/// one, reads the PR with gh. With `auto` it submits on its own, else it asks
/// how to submit first.
pub fn review_prompt(url: &str, agent: crate::Agent, auto: bool) -> String {
    let codex = agent == crate::Agent::Codex;
    let head = if codex {
        format!("{}{url}{}gh pr view と gh pr diff で説明と差分を読み、必要ならリポジトリのコードも読みます。レビューは日本語で行い、指摘や結果もすべて日本語で書いてください。", CODEX_REVIEW.0, CODEX_REVIEW.1)
    } else {
        format!("{CLAUDE_REVIEW}{url} レビューは日本語で行い、指摘や結果もすべて日本語で書いてください。")
    };
    let submit = if auto {
        AUTO_SUBMIT.to_string()
    } else {
        format!(
            "レビューが終わったら、GitHub への提出方法を{}私に聞いてください。ブロッカー（マージ前に直すべき問題）があれば Request changes を、なければ Comment か Approve を選択肢に出し、おすすめを先頭にしてください。私が選ぶまでは提出しないでください。",
            if codex { "" } else { " AskUserQuestion で" }
        )
    };
    [head, submit, REVIEW_SUBMIT_HOW.to_string()].join("\n\n")
}

/// The PR a review's first prompt is for, and whether it submits on its own.
pub fn review_of_prompt(prompt: &str) -> Option<(String, bool)> {
    let rest = prompt.strip_prefix(CLAUDE_REVIEW).or_else(|| prompt.strip_prefix(CODEX_REVIEW.0).filter(|r| r.contains(CODEX_REVIEW.1)))?;
    let url = rest.split_whitespace().next()?;
    (url.starts_with(GITHUB_HTTPS) && url.contains("/pull/")).then(|| (url.to_string(), prompt.contains(AUTO_SUBMIT)))
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

/// What the focus mode's note is made as: a web page, a Claude Docs
/// document, a slide deck or a design, all of them commentable on claude.ai.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteFormat {
    Page,
    Docs,
    Slides,
    Design,
}

impl NoteFormat {
    pub const ALL: [NoteFormat; 4] = [NoteFormat::Page, NoteFormat::Docs, NoteFormat::Slides, NoteFormat::Design];

    /// What to make, and what becomes of the comments on it.
    fn instructions(self) -> (&'static str, &'static str) {
        const BY_ARTIFACT: &str = "できたあとも、このセッションでノートへのコメントを待ちます。Claude 宛てのコメントが来たら、ArtifactComments でそのスレッドに返信します。理解に大事な内容は、ノートの該当する箇所にも書き足して公開し直します（URL は変えない）。";
        match self {
            NoteFormat::Page => (
                "ノートは Artifact ツールで公開する HTML のページにします。記事全体を見出しごとに整理し直し、元の記事の代わりに読める密度で書きます（要点だけに縮めない）。図や表が分かりやすくなるところでは使います。",
                BY_ARTIFACT,
            ),
            NoteFormat::Docs => (
                "ノートは Claude Docs のドキュメントにします（docs のスキルか Claude Docs のツールで作る）。記事全体を見出しごとに整理し直し、元の記事の代わりに読める密度で書きます（要点だけに縮めない）。表が分かりやすくなるところでは使います。",
                // claude.ai's Claude answers the comments on a doc itself.
                "ドキュメントへのコメントには claude.ai の Claude が答えるので、できたらこのセッションの作業は終わりです。",
            ),
            NoteFormat::Slides => (
                "ノートは Artifact ツールのスライドにします（quickstart の intent は slides）。記事全体を章ごとに整理し直し、1枚に1つの話題で、記事を読まなくても流れが分かる枚数にします。",
                BY_ARTIFACT,
            ),
            NoteFormat::Design => (
                "ノートは Artifact ツールのデザインにします（quickstart の intent は design）。記事全体の構造と考え方の関係を、図解したキャンバスに整理し直します。",
                BY_ARTIFACT,
            ),
        }
    }
}

/// First prompt (after the marker) of a note session: it turns the pages
/// into a commentable note in `format`, names it on a NOTE_LINE for the app
/// to find, and (but for a doc) stays to answer the comments.
pub fn note_prompt(title: &str, urls: &[String], format: NoteFormat) -> String {
    let pages: String = urls.iter().map(|u| format!("- {u}\n")).collect();
    let (make, comments) = format.instructions();
    format!(
        "インプット: {title}\n\n次のページを読んで、内容を整理した「ノート」を作ってください。\n\n{pages}\n\
         - {make}日本語で書きます。\n\
         - できたら、最後の行に「{line}<ノートの URL>」と書いてください。アプリはこの行でノートを見つけて、 Input モードの右に出します。ノートはアプリが開くので、Artifact の open やブラウザでは open しないでください。\n\
         - {comments}\n\
         - ページが読めないとき（ログインが必要など）は、ノートを作らずにそう伝えてください。",
        line = crate::transcript::NOTE_LINE,
    )
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

/// URL of the first PR (as `gh pr list --json url,createdAt` lists them,
/// newest first) opened at or after `not_before`. An older PR on the same
/// branch predates the session and is someone else's work.
pub fn pr_created_after(prs: &Value, not_before: i64) -> Option<String> {
    prs.as_array()?
        .iter()
        .find(|p| p["createdAt"].as_str().and_then(iso_to_epoch).is_some_and(|t| t >= not_before))?["url"]
        .as_str()
        .map(Into::into)
}

/// `YYYY-MM-DDTHH:MM:SSZ` (as GitHub gives times) to Unix seconds.
fn iso_to_epoch(s: &str) -> Option<i64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let [y, m, d]: [i64; 3] = date.split('-').map(|x| x.parse().ok()).collect::<Option<Vec<_>>>()?.try_into().ok()?;
    let [hh, mm, ss]: [i64; 3] = time.split(':').map(|x| x.parse().ok()).collect::<Option<Vec<_>>>()?.try_into().ok()?;
    // Days since 1970-01-01 from a civil date (Howard Hinnant's algorithm).
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + hh * 3600 + mm * 60 + ss)
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
    #[test]
    fn codex_takes_the_model_and_effort_as_its_own_flags() {
        let o = StartOptions { model: Some("gpt-5.5".into()), effort: Some("high".into()), ..Default::default() };
        assert_eq!(o.codex_args(), ["-m", "gpt-5.5", "-c", "model_reasoning_effort=\"high\""]);
        assert!(StartOptions::default().codex_args().is_empty());
    }

    #[test]
    fn codex_starts_with_the_prompt_less_what_only_claude_reads() {
        let body = "/grilling 直す\n\nメモ\n\n質問はすべて AskUserQuestion ツールで聞いてください（本文に質問を書いて待たない）。";
        assert_eq!(codex_body(body), "直す\n\nメモ");
        assert_eq!(codex_body("自由に"), "自由に");
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn a_note_prompt_names_the_pages_and_the_note_line() {
        let urls = ["https://doc.rust-lang.org/book/ch04-01.html".to_string(), "https://example.com/a".to_string()];
        for format in NoteFormat::ALL {
            let p = note_prompt("Rust の所有権", &urls, format);
            assert!(p.starts_with("インプット: Rust の所有権\n"), "{format:?}");
            assert!(p.contains("\n- https://doc.rust-lang.org/book/ch04-01.html\n- https://example.com/a\n"), "{format:?}");
            assert!(p.contains(crate::transcript::NOTE_LINE), "{format:?}");
            assert!(p.contains("open しない"), "{format:?}");
            // A doc through the Docs connector, the others through the Artifact tool.
            let docs = format == NoteFormat::Docs;
            assert_eq!(p.contains("Claude Docs"), docs, "{format:?}");
            assert_eq!(p.contains("ArtifactComments"), !docs, "{format:?}");
            // claude.ai answers a doc's comments; the others wait in the session.
            assert_eq!(p.contains("コメントを待ちます"), !docs, "{format:?}");
        }
        assert!(note_prompt("t", &urls, NoteFormat::Slides).contains("intent は slides"));
        assert!(note_prompt("t", &urls, NoteFormat::Design).contains("intent は design"));
    }

    #[test]
    fn start_options_become_cli_flags() {
        let o = StartOptions { model: Some("claude-fable-5-1".into()), effort: Some("xhigh".into()), ..Default::default() };
        assert_eq!(o.claude_args(), ["--model", "claude-fable-5-1", "--effort", "xhigh"]);
        let blank = StartOptions { model: Some(" ".into()), effort: None, ..Default::default() };
        assert!(blank.claude_args().is_empty());
    }

    #[test]
    fn iso_times_become_unix_seconds() {
        assert_eq!(iso_to_epoch("1970-01-02T00:00:00Z"), Some(86400));
        assert_eq!(iso_to_epoch("2024-02-29T23:59:59Z"), Some(1709251199));
        assert_eq!(iso_to_epoch("2026-08-04T14:09:51Z"), Some(1785852591));
        assert_eq!(iso_to_epoch("2026-08-04"), None);
    }

    #[test]
    fn only_prs_opened_after_the_session_count() {
        let prs = json!([
            {"url": "https://github.com/o/r/pull/9", "createdAt": "2026-09-27T10:00:00Z"},
            {"url": "https://github.com/o/r/pull/1", "createdAt": "2026-08-04T14:09:51Z"},
        ]);
        assert_eq!(pr_created_after(&prs, 1785852591 + 1).as_deref(), Some("https://github.com/o/r/pull/9"));
        assert_eq!(pr_created_after(&prs, 1785852591).as_deref(), Some("https://github.com/o/r/pull/9"));
        assert_eq!(pr_created_after(&json!([prs[1].clone()]), 1785852591 + 1), None);
        assert_eq!(pr_created_after(&json!([{"url": "https://github.com/o/r/pull/2"}]), 0), None);
    }

    #[test]
    fn cloud_sessions_have_a_web_page() {
        assert_eq!(web_url("cse_01abc").as_deref(), Some("https://claude.ai/code/session_01abc"));
        assert_eq!(web_url("5f0c-local"), None);
    }

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

#[cfg(test)]
mod fix_tests {
    use super::*;

    const PR: &str = "https://github.com/acme/api/pull/120";

    #[test]
    fn a_failed_ci_names_its_checks_and_how_to_read_them() {
        let p = fix_prompt(PR, Some(&["test-api".into(), "lint".into()]), false);
        assert!(p.contains(PR) && p.contains("test-api、lint"), "{p}");
        assert!(p.contains("gh pr checks") && p.contains("--log-failed"), "{p}");
        assert!(p.contains("push"), "{p}");
        assert!(!p.contains("修正の依頼"), "{p}");
    }

    #[test]
    fn changes_asked_for_send_it_to_the_review_and_back() {
        let p = fix_prompt(PR, None, true);
        assert!(p.contains("修正の依頼") && p.contains("gh pr view") && p.contains("再レビュー"), "{p}");
        assert!(!p.contains("CI"), "{p}");
    }

    #[test]
    fn a_failure_without_names_still_asks_to_look() {
        let p = fix_prompt(PR, Some(&[]), false);
        assert!(p.contains("CI が失敗") && p.contains("gh pr checks"), "{p}");
    }

    #[test]
    fn both_at_once_ask_for_both() {
        let p = fix_prompt(PR, Some(&["e2e".into()]), true);
        assert!(p.contains("修正の依頼") && p.contains("e2e"), "{p}");
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;
    use crate::Agent;

    const PR: &str = "https://github.com/acme/web/pull/61";

    #[test]
    fn claude_reviews_with_its_skill_and_asks_before_submitting() {
        let p = review_prompt(PR, Agent::Claude, false);
        assert!(p.starts_with(&format!("/review {PR}")), "{p}");
        assert!(p.contains("日本語") && p.contains("AskUserQuestion") && p.contains("私が選ぶまでは提出しないでください"), "{p}");
    }

    #[test]
    fn codex_reads_the_pr_with_gh_and_may_submit_on_its_own() {
        let p = review_prompt(PR, Agent::Codex, true);
        assert!(p.starts_with(&format!("PR {PR} をレビューしてください")), "{p}");
        assert!(p.contains("gh pr diff") && p.contains(AUTO_SUBMIT), "{p}");
        assert!(!p.contains("AskUserQuestion"), "{p}");
    }

    #[test]
    fn a_review_is_known_again_from_its_prompt() {
        for agent in [Agent::Claude, Agent::Codex] {
            for auto in [false, true] {
                assert_eq!(review_of_prompt(&review_prompt(PR, agent, auto)), Some((PR.to_string(), auto)), "{agent:?} {auto}");
            }
        }
        assert_eq!(review_of_prompt("/review"), None);
        assert_eq!(review_of_prompt("PR https://github.com/o/r/pull/1 を見て"), None);
        assert_eq!(review_of_prompt("fix the bug"), None);
    }
}
