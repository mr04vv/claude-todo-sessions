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

#[cfg(test)]
mod tests {
    use super::*;
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
