//! Plan usage limits as the OAuth usage API (`/api/oauth/usage`) reports them.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Limit {
    /// "セッション（5時間）", "週間", "Fable（週間）"
    pub label: String,
    pub percent: f64,
    /// RFC 3339, as the API gives it.
    pub resets_at: Option<String>,
    /// "normal", or a warning level when close to the limit.
    pub severity: String,
}

/// The limits the plan has, in the order the API lists them.
pub fn parse_limits(usage: &Value) -> Vec<Limit> {
    usage["limits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| {
            let label = match l["kind"].as_str()? {
                "session" => "セッション（5時間）".to_string(),
                "weekly_all" => "週間".to_string(),
                "weekly_scoped" => format!("{}（週間）", l["scope"]["model"]["display_name"].as_str()?),
                _ => return None,
            };
            Some(Limit {
                label,
                percent: l["percent"].as_f64()?,
                resets_at: l["resets_at"].as_str().map(Into::into),
                severity: l["severity"].as_str().unwrap_or("normal").into(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn labels_session_weekly_and_model_scoped_limits() {
        let v = json!({"limits": [
            {"kind": "session", "percent": 35, "severity": "normal", "resets_at": "2026-09-28T07:40:00+00:00"},
            {"kind": "weekly_all", "percent": 74, "severity": "normal", "resets_at": "2026-09-30T20:00:00+00:00"},
            {"kind": "weekly_scoped", "percent": 59.5, "severity": "warning", "resets_at": null,
             "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null}},
            {"kind": "something_new", "percent": 1}
        ]});
        let l = parse_limits(&v);
        let labels: Vec<&str> = l.iter().map(|x| x.label.as_str()).collect();
        assert_eq!(labels, ["セッション（5時間）", "週間", "Fable（週間）"]);
        assert_eq!(l[0].percent, 35.0);
        assert_eq!(l[0].resets_at.as_deref(), Some("2026-09-28T07:40:00+00:00"));
        assert_eq!((l[2].percent, l[2].severity.as_str(), l[2].resets_at.as_deref()), (59.5, "warning", None));
    }

    #[test]
    fn no_limits_is_empty() {
        assert!(parse_limits(&json!({})).is_empty());
    }
}
