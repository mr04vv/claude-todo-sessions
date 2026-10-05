//! Codex's sessions: where a session's rollout (its transcript) is, and the
//! prompt it began with (for its title and `[todo:N]` link).

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Where Codex keeps the models it offers (fetched by itself).
pub const MODELS_CACHE: &str = ".codex/models_cache.json";

/// A model Codex offers, and the reasoning efforts it takes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Model {
    pub id: String,
    pub label: String,
    pub efforts: Vec<String>,
}

/// The models Codex lists (the hidden ones aside), from its cache.
pub fn models(cache: &Value) -> Vec<Model> {
    cache["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["visibility"] == "list")
        .filter_map(|m| {
            Some(Model {
                id: m["slug"].as_str()?.into(),
                label: m["display_name"].as_str().or(m["slug"].as_str())?.into(),
                efforts: m["supported_reasoning_levels"].as_array().into_iter().flatten().filter_map(|e| e["effort"].as_str().map(Into::into)).collect(),
            })
        })
        .collect()
}

/// Where Codex keeps its rollouts: `<dir>/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.
pub const SESSIONS_DIR: &str = ".codex/sessions";

/// The rollout of session `id`, the newest days looked at first.
pub fn rollout_path(sessions: &Path, id: &str) -> Option<PathBuf> {
    let suffix = format!("-{id}.jsonl");
    let dirs = |p: &Path| -> Vec<PathBuf> {
        let mut d: Vec<PathBuf> = std::fs::read_dir(p).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        d.sort_by(|a, b| b.cmp(a));
        d
    };
    for year in dirs(sessions) {
        for month in dirs(&year) {
            for day in dirs(&month) {
                let found = std::fs::read_dir(&day).into_iter().flatten().flatten().map(|e| e.path()).find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().ends_with(&suffix)));
                if found.is_some() {
                    return found;
                }
            }
        }
    }
    None
}

/// The first thing the user typed: a user message that is not the context
/// Codex adds itself (AGENTS.md, `<environment_context>`, …).
pub fn first_prompt(rollout: &str) -> Option<String> {
    rollout.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find_map(|entry| {
        let p = &entry["payload"];
        if p["type"] != "message" || p["role"] != "user" {
            return None;
        }
        p["content"].as_array()?.iter().filter_map(|c| c["text"].as_str()).map(str::trim).find(|t| !t.is_empty() && !t.starts_with('#') && !t.starts_with('<')).map(Into::into)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_prompt_is_the_users_not_codexs_context() {
        let lines = [
            r##"{"type":"session_meta","payload":{"id":"abc"}}"##,
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n..."}]}}"##,
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}"##,
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"[todo:7] 直して"}]}}"##,
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"次も"}]}}"##,
        ];
        assert_eq!(first_prompt(&lines.join("\n")).as_deref(), Some("[todo:7] 直して"));
        assert_eq!(first_prompt(lines[0]), None);
    }

    #[test]
    fn models_are_the_listed_ones_with_their_efforts() {
        let cache = serde_json::json!({"models": [
            {"slug": "gpt-5.5", "display_name": "GPT-5.5", "default_reasoning_level": "medium", "visibility": "list",
             "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}]},
            {"slug": "hidden", "display_name": "Hidden", "visibility": "hide", "supported_reasoning_levels": []}
        ]});
        assert_eq!(models(&cache), vec![Model { id: "gpt-5.5".into(), label: "GPT-5.5".into(), efforts: vec!["low".into(), "high".into()] }]);
        assert!(models(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn finds_a_sessions_rollout_by_its_id() {
        let dir = tempfile::tempdir().unwrap();
        let day = dir.path().join("2026/10/05");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join("rollout-2026-10-05T10-00-00-abc-123.jsonl"), "").unwrap();
        std::fs::write(day.join("rollout-2026-10-05T11-00-00-other.jsonl"), "").unwrap();
        assert_eq!(rollout_path(dir.path(), "abc-123"), Some(day.join("rollout-2026-10-05T10-00-00-abc-123.jsonl")));
        assert_eq!(rollout_path(dir.path(), "nope"), None);
    }
}
