//! Batched GitHub status lookups: one GraphQL query for many issues and PRs.

use serde_json::Value;

/// URLs per GraphQL query; GitHub limits how many nodes one query may touch.
pub const BATCH_SIZE: usize = 50;

/// The checks of a PR's last commit, for its CI.
const CI_FIELDS: &str = "commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes { __typename ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } } }";

/// A PR's CI: "pending", "success" or "failure", and the checks that failed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Ci {
    pub state: String,
    pub failed: Vec<String>,
}

/// Check run conclusions and status states that fail a PR's checks.
const FAILED: [&str; 6] = ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "CANCELLED", "ERROR"];

/// The CI of a PR node with CI_FIELDS; None when its last commit has no checks.
pub fn ci_of(pr: &Value) -> Option<Ci> {
    let rollup = &pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"];
    let state = match rollup["state"].as_str()? {
        "SUCCESS" => "success",
        "FAILURE" | "ERROR" => "failure",
        _ => "pending",
    };
    let failed = rollup["contexts"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| match c["__typename"].as_str() {
            Some("CheckRun") => c["conclusion"].as_str().filter(|x| FAILED.contains(x)).and(c["name"].as_str()),
            Some("StatusContext") => c["state"].as_str().filter(|x| FAILED.contains(x)).and(c["context"].as_str()),
            _ => None,
        })
        .map(Into::into)
        .collect();
    Some(Ci { state: state.into(), failed })
}

/// A `gh api graphql` query asking for the state of every URL, one alias each.
pub fn status_query(urls: &[String]) -> String {
    let fields = format!("__typename ... on Issue {{ state }} ... on PullRequest {{ state isDraft reviewDecision reviewRequests {{ totalCount }} {CI_FIELDS} }}");
    let aliases: Vec<String> = urls
        .iter()
        .enumerate()
        .map(|(i, url)| format!("u{i}: resource(url: {}) {{ {fields} }}", serde_json::to_string(url).unwrap_or_default()))
        .collect();
    format!("query {{ {} }}", aliases.join(" "))
}

/// An issue's or PR's state, as `parse_statuses` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemStatus {
    pub url: String,
    /// "open"/"closed" for an issue, a review stage (see `launch::pr_state`) for a PR.
    pub state: String,
    /// A PR's CI.
    pub ci: Option<Ci>,
}

/// State per URL from the query's response.
pub fn parse_statuses(response: &Value, urls: &[String]) -> Vec<ItemStatus> {
    urls.iter()
        .enumerate()
        .filter_map(|(i, url)| {
            let node = &response["data"][format!("u{i}")];
            let (state, ci) = match node["__typename"].as_str()? {
                "Issue" => (node["state"].as_str()?.to_lowercase(), None),
                "PullRequest" => (crate::launch::pr_state(node).to_string(), ci_of(node)),
                _ => return None,
            };
            Some(ItemStatus { url: url.clone(), state, ci })
        })
        .collect()
}

/// The user's open PRs, leaving out archived repositories' (they can no longer move).
pub const MY_PRS_QUERY: &str = concat!(
    "query { search(query: \"is:pr is:open author:@me archived:false\", type: ISSUE, first: 50) { nodes { ... on PullRequest { ",
    "number title url isDraft updatedAt state reviewDecision repository { nameWithOwner } ",
    "reviewRequests(first: 30) { totalCount nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } } ",
    "latestReviews(first: 30) { nodes { author { login } state } } ",
    "commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes { __typename ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } } } ",
    "} } } }"
);

/// An open PR of the user's, for the PR page.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MyPr {
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub is_draft: bool,
    pub updated_at: String,
    /// Its review stage (see `launch::pr_state`).
    pub stage: String,
    pub ci: Option<Ci>,
    /// Whom it asks for a review (a user's login or a team's slug), and who reviewed it.
    pub reviewers: Vec<String>,
}

/// The PRs of MY_PRS_QUERY's response.
pub fn parse_my_prs(response: &Value) -> Vec<MyPr> {
    response["data"]["search"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|n| {
            let asked = n["reviewRequests"]["nodes"].as_array().into_iter().flatten().filter_map(|r| r["requestedReviewer"]["login"].as_str().or_else(|| r["requestedReviewer"]["slug"].as_str()));
            let reviewed = n["latestReviews"]["nodes"].as_array().into_iter().flatten().filter_map(|r| r["author"]["login"].as_str());
            let mut reviewers: Vec<String> = Vec::new();
            for r in asked.chain(reviewed) {
                if !reviewers.iter().any(|x| x == r) {
                    reviewers.push(r.into());
                }
            }
            Some(MyPr {
                repo: n["repository"]["nameWithOwner"].as_str()?.into(),
                number: n["number"].as_i64()?,
                title: n["title"].as_str()?.into(),
                url: n["url"].as_str()?.into(),
                is_draft: n["isDraft"] == true,
                updated_at: n["updatedAt"].as_str().unwrap_or_default().into(),
                stage: crate::launch::pr_state(n).into(),
                ci: ci_of(n),
                reviewers,
            })
        })
        .collect()
}

/// How a review session's work ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewOutcome {
    /// The user's review went in: APPROVED, CHANGES_REQUESTED or COMMENTED.
    Submitted(String),
    /// The PR was merged or closed meanwhile.
    PrClosed,
}

/// Whether a review session's work is over: the PR (`gh pr view --json
/// state,reviews`) got a review from `me` submitted since `since` (ISO
/// 8601, as GitHub writes it; the last one says how), or it is merged or
/// closed. None while it is not.
pub fn review_outcome(view: &Value, me: &str, since: &str) -> Option<ReviewOutcome> {
    let mine = view["reviews"].as_array().into_iter().flatten().filter(|r| r["author"]["login"] == me && r["submittedAt"].as_str().is_some_and(|at| at >= since));
    if let Some(last) = mine.max_by_key(|r| r["submittedAt"].as_str().unwrap_or_default().to_string()) {
        return Some(ReviewOutcome::Submitted(last["state"].as_str().unwrap_or_default().into()));
    }
    (view["state"] != "OPEN").then_some(ReviewOutcome::PrClosed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_review_is_done_once_the_user_submits_one_or_the_pr_closes() {
        let view = |state: &str, reviews: serde_json::Value| serde_json::json!({"state": state, "reviews": reviews});
        let mine = serde_json::json!([
            {"author": {"login": "me"}, "submittedAt": "2026-10-05T10:00:00Z", "state": "COMMENTED"},
            {"author": {"login": "me"}, "submittedAt": "2026-10-05T10:05:00Z", "state": "CHANGES_REQUESTED"}
        ]);
        assert_eq!(review_outcome(&view("OPEN", mine.clone()), "me", "2026-10-05T09:00:00Z"), Some(ReviewOutcome::Submitted("CHANGES_REQUESTED".into())), "the last one says how it went in");
        assert_eq!(review_outcome(&view("OPEN", mine.clone()), "me", "2026-10-05T11:00:00Z"), None, "a review from before the session is not its");
        assert_eq!(review_outcome(&view("OPEN", serde_json::json!([{"author": {"login": "you"}, "submittedAt": "2026-10-05T10:00:00Z", "state": "APPROVED"}])), "me", "2026-10-05T09:00:00Z"), None);
        assert_eq!(review_outcome(&view("MERGED", serde_json::json!([])), "me", "2026-10-05T09:00:00Z"), Some(ReviewOutcome::PrClosed));
        assert_eq!(review_outcome(&view("CLOSED", serde_json::json!([])), "me", "2026-10-05T09:00:00Z"), Some(ReviewOutcome::PrClosed));
    }

    use serde_json::json;

    #[test]
    fn query_aliases_every_url() {
        let urls = vec!["https://github.com/o/r/issues/1".to_string(), "https://github.com/o/r/pull/2".to_string()];
        let q = status_query(&urls);
        assert!(q.contains(r#"u0: resource(url: "https://github.com/o/r/issues/1")"#), "{q}");
        assert!(q.contains(r#"u1: resource(url: "https://github.com/o/r/pull/2")"#), "{q}");
        assert!(q.contains("... on PullRequest"));
    }

    #[test]
    fn parses_issue_and_pr_states() {
        let urls = vec!["https://github.com/o/r/issues/1".to_string(), "https://github.com/o/r/pull/2".to_string(), "https://github.com/o/r/pull/3".to_string()];
        let resp = json!({"data": {
            "u0": {"__typename": "Issue", "state": "CLOSED"},
            "u1": {"__typename": "PullRequest", "state": "OPEN", "isDraft": false, "reviewDecision": "REVIEW_REQUIRED", "reviewRequests": {"totalCount": 1}},
            "u2": null
        }});
        assert_eq!(
            parse_statuses(&resp, &urls),
            vec![
                ItemStatus { url: "https://github.com/o/r/issues/1".into(), state: "closed".into(), ci: None },
                ItemStatus { url: "https://github.com/o/r/pull/2".into(), state: "review_requested".into(), ci: None },
            ]
        );
    }

    fn rollup(state: &str, contexts: Value) -> Value {
        json!({"commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": state, "contexts": {"nodes": contexts}}}}]}})
    }

    #[test]
    fn ci_is_the_last_commits_checks() {
        assert_eq!(ci_of(&json!({"commits": {"nodes": [{"commit": {"statusCheckRollup": null}}]}})), None, "no checks, no CI");
        assert_eq!(ci_of(&json!({})), None);
        assert_eq!(ci_of(&rollup("SUCCESS", json!([]))), Some(Ci { state: "success".into(), failed: vec![] }));
        assert_eq!(ci_of(&rollup("PENDING", json!([]))), Some(Ci { state: "pending".into(), failed: vec![] }));
        assert_eq!(ci_of(&rollup("EXPECTED", json!([]))).unwrap().state, "pending");
        let failing = rollup(
            "FAILURE",
            json!([
                {"__typename": "CheckRun", "name": "test-api", "conclusion": "FAILURE", "status": "COMPLETED"},
                {"__typename": "CheckRun", "name": "lint", "conclusion": "SUCCESS", "status": "COMPLETED"},
                {"__typename": "CheckRun", "name": "e2e", "conclusion": "TIMED_OUT", "status": "COMPLETED"},
                {"__typename": "CheckRun", "name": "build", "conclusion": null, "status": "IN_PROGRESS"},
                {"__typename": "StatusContext", "context": "ci/circleci", "state": "ERROR"},
                {"__typename": "StatusContext", "context": "netlify", "state": "SUCCESS"}
            ]),
        );
        assert_eq!(ci_of(&failing), Some(Ci { state: "failure".into(), failed: vec!["test-api".into(), "e2e".into(), "ci/circleci".into()] }));
        assert_eq!(ci_of(&rollup("ERROR", json!([]))).unwrap().state, "failure");
    }

    #[test]
    fn statuses_carry_a_prs_ci() {
        let urls = vec!["https://github.com/o/r/pull/2".to_string()];
        let mut node = rollup("FAILURE", json!([{"__typename": "CheckRun", "name": "test", "conclusion": "FAILURE"}]));
        node["__typename"] = json!("PullRequest");
        node["state"] = json!("OPEN");
        node["reviewDecision"] = json!("CHANGES_REQUESTED");
        let got = parse_statuses(&json!({"data": {"u0": node}}), &urls);
        assert_eq!(got, vec![ItemStatus { url: urls[0].clone(), state: "changes_requested".into(), ci: Some(Ci { state: "failure".into(), failed: vec!["test".into()] }) }]);
        assert!(status_query(&urls).contains("statusCheckRollup"));
    }

    #[test]
    fn my_prs_have_their_stage_ci_and_reviewers() {
        let mut pr = rollup("SUCCESS", json!([]));
        for (k, v) in [
            ("number", json!(5)), ("title", json!("Fix")), ("url", json!("https://github.com/o/a/pull/5")), ("isDraft", json!(false)),
            ("updatedAt", json!("2026-10-08T10:00:00Z")), ("state", json!("OPEN")), ("reviewDecision", json!("REVIEW_REQUIRED")),
            ("repository", json!({"nameWithOwner": "o/a"})),
            ("reviewRequests", json!({"totalCount": 1, "nodes": [{"requestedReviewer": {"login": "alice"}}]})),
            ("latestReviews", json!({"nodes": [{"author": {"login": "bob"}, "state": "COMMENTED"}]})),
        ] {
            pr[k] = v;
        }
        let resp = json!({"data": {"search": {"nodes": [pr, {}]}}});
        assert_eq!(parse_my_prs(&resp), vec![MyPr {
            repo: "o/a".into(), number: 5, title: "Fix".into(), url: "https://github.com/o/a/pull/5".into(), is_draft: false,
            updated_at: "2026-10-08T10:00:00Z".into(), stage: "review_requested".into(),
            ci: Some(Ci { state: "success".into(), failed: vec![] }),
            reviewers: vec!["alice".into(), "bob".into()],
        }], "reviewers asked and the ones who reviewed; an empty node is skipped");
        assert!(MY_PRS_QUERY.contains("author:@me") && MY_PRS_QUERY.contains("is:open") && MY_PRS_QUERY.contains("archived:false"));
    }
}
