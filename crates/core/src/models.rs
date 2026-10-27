//! The Claude models to start a session with: the newest of each family the
//! account may use, as Claude Code last fetched them into its config (its
//! `modelAccessCache`), so a new model shows once Claude Code has seen it.

use serde_json::Value;

/// Claude Code's config, under home.
pub const CONFIG: &str = ".claude.json";

/// The families offered, in the order shown, and each one's model when the
/// config has none of it.
const FAMILIES: [(&str, &str); 4] = [("opus", "claude-opus-5-5"), ("fable", "claude-fable-5-1"), ("sonnet", "claude-sonnet-5"), ("haiku", "claude-haiku-4-5-20251001")];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Model {
    pub id: String,
    pub label: String,
    /// opus, fable, sonnet or haiku.
    pub family: String,
}

/// A family's model id (`claude-sonnet-5-5`, `claude-haiku-4-5-20251001`):
/// its family and version. Others (`claude-3-opus-…`, `…-claude-ai`) are not.
fn parse(id: &str) -> Option<(&str, (u32, u32))> {
    let rest = id.strip_prefix("claude-")?;
    let (family, version) = rest.split_once('-')?;
    let mut parts = version.split('-');
    let major = parts.next()?.parse().ok()?;
    let mut minor = 0;
    for (i, p) in parts.enumerate() {
        match (i, p.len(), p.parse::<u32>()) {
            (0, 1..=2, Ok(n)) => minor = n,
            (_, 8, Ok(_)) => {}
            _ => return None,
        }
    }
    Some((family, (major, minor)))
}

fn model(id: &str) -> Option<Model> {
    let (family, (major, minor)) = parse(id)?;
    let name = family[..1].to_uppercase() + &family[1..];
    let label = if minor == 0 { format!("{name} {major}") } else { format!("{name} {major}.{minor}") };
    Some(Model { id: id.into(), label, family: family.into() })
}

/// The newest model of each family the account may use, from Claude Code's config.
pub fn latest(config: &Value) -> Vec<Model> {
    let entitled: Vec<&str> = config["modelAccessCache"].as_array().into_iter().flatten().filter(|m| m["entitled"] == true).filter_map(|m| m["apiName"].as_str()).collect();
    FAMILIES
        .iter()
        .filter_map(|(family, fallback)| {
            let newest = entitled.iter().filter_map(|id| parse(id).filter(|(f, _)| f == family).map(|(_, v)| (v, *id))).max();
            model(newest.map_or(*fallback, |(_, id)| id))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_newest_of_each_family_the_account_may_use() {
        let ids = ["claude-3-opus-20240229", "claude-opus-4-1-20250805-claude-ai", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5", "claude-fable-5-1"];
        let mut cache: Vec<Value> = ids.iter().map(|id| json!({"apiName": id, "entitled": true})).collect();
        cache.push(json!({"apiName": "claude-opus-6", "entitled": false}));
        let got = latest(&json!({ "modelAccessCache": cache }));
        let pairs: Vec<(&str, &str)> = got.iter().map(|m| (m.id.as_str(), m.label.as_str())).collect();
        assert_eq!(pairs, [("claude-opus-5-5", "Opus 5.5"), ("claude-fable-5-1", "Fable 5.1"), ("claude-sonnet-5-5", "Sonnet 5.5"), ("claude-haiku-5-5", "Haiku 5.5")]);
    }

    #[test]
    fn without_the_config_the_models_known_here() {
        let got = latest(&json!({}));
        assert_eq!(got.iter().map(|m| m.label.as_str()).collect::<Vec<_>>(), ["Opus 5.5", "Fable 5.1", "Sonnet 5", "Haiku 4.5"]);
    }
}
