//! Batched GitHub status lookups: one GraphQL query for many issues and PRs.

use serde_json::Value;

/// URLs per GraphQL query; GitHub limits how many nodes one query may touch.
pub const BATCH_SIZE: usize = 50;

/// A `gh api graphql` query asking for the state of every URL, one alias each.
pub fn status_query(urls: &[String]) -> String {
    let fields = "__typename ... on Issue { state } ... on PullRequest { state isDraft reviewDecision reviewRequests { totalCount } }";
    let aliases: Vec<String> = urls
        .iter()
        .enumerate()
        .map(|(i, url)| format!("u{i}: resource(url: {}) {{ {fields} }}", serde_json::to_string(url).unwrap_or_default()))
        .collect();
    format!("query {{ {} }}", aliases.join(" "))
}

/// State per URL from the query's response: "open"/"closed" for issues, a
/// review stage (see `launch::pr_state`) for pull requests.
pub fn parse_statuses(response: &Value, urls: &[String]) -> Vec<(String, String)> {
    urls.iter()
        .enumerate()
        .filter_map(|(i, url)| {
            let node = &response["data"][format!("u{i}")];
            let state = match node["__typename"].as_str()? {
                "Issue" => node["state"].as_str()?.to_lowercase(),
                "PullRequest" => crate::launch::pr_state(node).to_string(),
                _ => return None,
            };
            Some((url.clone(), state))
        })
        .collect()
}

/// The user's open PRs and the reviewers each still waits on (a review
/// given takes a reviewer off), for the Slack messages asking them; not
/// archived repositories' (they can no longer move).
pub const REVIEW_REQUESTS_QUERY: &str = "query { search(query: \"is:pr is:open author:@me archived:false\", type: ISSUE, first: 100) { nodes { ... on PullRequest { number title url isDraft repository { nameWithOwner } reviewRequests(first: 30) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } } } } } }";

/// An open PR of the user's, and whom it waits on (a user's login or a team's slug).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ReviewRequest {
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub reviewers: Vec<String>,
}

/// The PRs of REVIEW_REQUESTS_QUERY's response that wait on someone; drafts are not asked about yet.
pub fn parse_review_requests(response: &Value) -> Vec<ReviewRequest> {
    response["data"]["search"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| n["isDraft"] != true)
        .filter_map(|n| {
            let reviewers: Vec<String> = n["reviewRequests"]["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| r["requestedReviewer"]["login"].as_str().or_else(|| r["requestedReviewer"]["slug"].as_str()).map(Into::into))
                .collect();
            (!reviewers.is_empty()).then_some(())?;
            Some(ReviewRequest {
                repo: n["repository"]["nameWithOwner"].as_str()?.into(),
                number: n["number"].as_i64()?,
                title: n["title"].as_str()?.into(),
                url: n["url"].as_str()?.into(),
                reviewers,
            })
        })
        .collect()
}

/// Whether a review session's work is over: the PR (`gh pr view --json
/// state,reviews`) got a review from `me` submitted since `since` (ISO
/// 8601, as GitHub writes it), or it is merged or closed.
pub fn review_done(view: &Value, me: &str, since: &str) -> bool {
    view["state"] != "OPEN"
        || view["reviews"].as_array().into_iter().flatten().any(|r| r["author"]["login"] == me && r["submittedAt"].as_str().is_some_and(|at| at >= since))
}

/// Whether a PR (`gh pr view --json state,reviewDecision,mergeStateStatus`)
/// can merge at once; otherwise GitHub's auto-merge waits for it.
pub fn merge_now(view: &Value) -> bool {
    view["state"] == "OPEN" && view["reviewDecision"] == "APPROVED" && view["mergeStateStatus"] == "CLEAN"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_review_is_done_once_the_user_submits_one_or_the_pr_closes() {
        let view = |state: &str, reviews: serde_json::Value| serde_json::json!({"state": state, "reviews": reviews});
        let mine = serde_json::json!([{"author": {"login": "me"}, "submittedAt": "2026-10-05T10:00:00Z"}]);
        assert!(review_done(&view("OPEN", mine.clone()), "me", "2026-10-05T09:00:00Z"));
        assert!(!review_done(&view("OPEN", mine.clone()), "me", "2026-10-05T11:00:00Z"), "a review from before the session is not its");
        assert!(!review_done(&view("OPEN", serde_json::json!([{"author": {"login": "you"}, "submittedAt": "2026-10-05T10:00:00Z"}])), "me", "2026-10-05T09:00:00Z"));
        assert!(review_done(&view("MERGED", serde_json::json!([])), "me", "2026-10-05T09:00:00Z"));
        assert!(review_done(&view("CLOSED", serde_json::json!([])), "me", "2026-10-05T09:00:00Z"));
    }

    #[test]
    fn an_approved_pr_ready_to_go_merges_now_and_others_wait_for_it() {
        let view = |decision: &str, merge: &str| serde_json::json!({"state": "OPEN", "reviewDecision": decision, "mergeStateStatus": merge});
        assert!(merge_now(&view("APPROVED", "CLEAN")));
        assert!(!merge_now(&view("APPROVED", "BLOCKED")), "checks not through yet");
        assert!(!merge_now(&view("REVIEW_REQUIRED", "BLOCKED")));
        assert!(!merge_now(&serde_json::json!({"state": "MERGED", "reviewDecision": "APPROVED", "mergeStateStatus": "CLEAN"})));
    }

    #[test]
    fn review_requests_are_the_open_prs_reviewers_not_yet_heard_from() {
        let resp = serde_json::json!({"data": {"search": {"nodes": [
            {"number": 1, "title": "Fix", "url": "https://github.com/o/a/pull/1", "isDraft": false, "repository": {"nameWithOwner": "o/a"},
             "reviewRequests": {"nodes": [{"requestedReviewer": {"login": "alice"}}, {"requestedReviewer": {"slug": "core"}}]}},
            {"number": 2, "title": "Draft", "url": "https://github.com/o/a/pull/2", "isDraft": true, "repository": {"nameWithOwner": "o/a"},
             "reviewRequests": {"nodes": [{"requestedReviewer": {"login": "bob"}}]}},
            {"number": 3, "title": "Nobody", "url": "https://github.com/o/b/pull/3", "isDraft": false, "repository": {"nameWithOwner": "o/b"},
             "reviewRequests": {"nodes": []}},
            {}
        ]}}});
        let got = parse_review_requests(&resp);
        assert_eq!(got, vec![ReviewRequest {
            repo: "o/a".into(), number: 1, title: "Fix".into(), url: "https://github.com/o/a/pull/1".into(),
            reviewers: vec!["alice".into(), "core".into()],
        }], "drafts and PRs asking no one are left out; a team goes by its slug");
        assert!(REVIEW_REQUESTS_QUERY.contains("author:@me") && REVIEW_REQUESTS_QUERY.contains("is:open") && REVIEW_REQUESTS_QUERY.contains("archived:false"));
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
                ("https://github.com/o/r/issues/1".to_string(), "closed".to_string()),
                ("https://github.com/o/r/pull/2".to_string(), "review_requested".to_string()),
            ]
        );
    }
}
