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
    /// What has been spent against the limit, when the limit is money.
    pub amount: Option<Amount>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Amount {
    pub used: f64,
    pub limit: f64,
    /// ISO 4217, "USD".
    pub currency: String,
}

/// `{"amount_minor": 11087, "exponent": 2}` is 110.87.
fn money(v: &Value) -> Option<f64> {
    Some(v["amount_minor"].as_f64()? / 10f64.powi(v["exponent"].as_i64()? as i32))
}

/// The spending limit plans billed by usage have instead of `limits`.
fn spend(s: &Value) -> Option<Limit> {
    if !s["enabled"].as_bool()? {
        return None;
    }
    Some(Limit {
        // `spend` names no period; it is monthly as `extra_usage.monthly_limit` says.
        label: "利用額（月間）".into(),
        percent: s["percent"].as_f64()?,
        resets_at: None,
        severity: s["severity"].as_str().unwrap_or("normal").into(),
        amount: Some(Amount {
            used: money(&s["used"])?,
            limit: money(&s["limit"])?,
            currency: s["used"]["currency"].as_str()?.into(),
        }),
    })
}

/// The limits the plan has, in the order the API lists them, then the spending limit.
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
                amount: None,
            })
        })
        .chain(spend(&usage["spend"]))
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
    fn spend_is_a_limit_with_its_amounts() {
        let v = json!({"limits": [], "spend": {
            "used": {"amount_minor": 11087, "currency": "USD", "exponent": 2},
            "limit": {"amount_minor": 800000, "currency": "USD", "exponent": 2},
            "percent": 1, "severity": "normal", "enabled": true
        }});
        assert_eq!(
            parse_limits(&v),
            [Limit {
                label: "利用額（月間）".into(),
                percent: 1.0,
                resets_at: None,
                severity: "normal".into(),
                amount: Some(Amount { used: 110.87, limit: 8000.0, currency: "USD".into() }),
            }]
        );
    }

    #[test]
    fn disabled_spend_is_not_shown() {
        let v = json!({"spend": {
            "used": {"amount_minor": 0, "currency": "USD", "exponent": 2},
            "limit": null, "percent": 0, "severity": "normal", "enabled": false
        }});
        assert!(parse_limits(&v).is_empty());
    }

    #[test]
    fn no_limits_is_empty() {
        assert!(parse_limits(&json!({})).is_empty());
    }
}
