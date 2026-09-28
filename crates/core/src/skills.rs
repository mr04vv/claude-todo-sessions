//! Skills a new session can start with, most likely first.

use std::path::Path;

use serde::Serialize;

/// Commands Claude Code has without any skill installed.
pub const BUILTIN: &[(&str, &str)] = &[
    ("review", "PR をレビューする"),
    ("code-review", "差分のバグを探す"),
    ("simplify", "差分を整理する"),
    ("security-review", "差分のセキュリティを見る"),
];
const SKILL_FILE: &str = "SKILL.md";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Skill {
    /// What follows the `/`: `grilling`, or `plugin:skill` for a plugin's.
    pub name: String,
    pub description: String,
}

/// `name` and `description` from a SKILL.md front matter.
pub fn parse_front_matter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    for line in lines.take_while(|l| l.trim() != "---") {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        match key.trim() {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }
    (name, description)
}

/// Skills under `dir/<skill>/SKILL.md`, named `<prefix>:<name>` when a
/// prefix (a plugin name) is given.
pub fn read_dir(dir: &Path, prefix: Option<&str>) -> Vec<Skill> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let text = std::fs::read_to_string(entry.path().join(SKILL_FILE)).ok()?;
            let (name, description) = parse_front_matter(&text);
            let name = name.unwrap_or_else(|| entry.file_name().to_string_lossy().into());
            Some(Skill {
                name: prefix.map_or(name.clone(), |p| format!("{p}:{name}")),
                description: description.unwrap_or_default(),
            })
        })
        .collect()
}

/// The built-in commands as skills.
pub fn builtin() -> Vec<Skill> {
    BUILTIN.iter().map(|(n, d)| Skill { name: (*n).into(), description: (*d).into() }).collect()
}

/// Orders skills by how often past first prompts started with them, then
/// the built-in ones, then by name. Duplicate names keep the first.
pub fn rank(skills: Vec<Skill>, prompts: &[String]) -> Vec<Skill> {
    let uses = |name: &str| {
        prompts
            .iter()
            .filter(|p| p.strip_prefix('/').and_then(|r| r.split_whitespace().next()) == Some(name))
            .count()
    };
    let mut seen = std::collections::HashSet::new();
    let mut ranked: Vec<(usize, bool, Skill)> = skills
        .into_iter()
        .filter(|s| seen.insert(s.name.clone()))
        .map(|s| (uses(&s.name), BUILTIN.iter().any(|(n, _)| *n == s.name), s))
        .collect();
    ranked.sort_by(|(ua, ba, a), (ub, bb, b)| ub.cmp(ua).then((*ub == 0 && *bb).cmp(&(*ua == 0 && *ba))).then(a.name.cmp(&b.name)));
    ranked.into_iter().map(|(_, _, s)| s).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str) -> Skill {
        Skill { name: name.into(), description: String::new() }
    }

    #[test]
    fn reads_name_and_description_from_front_matter() {
        let text = "---\nname: grilling\ndescription: \"Grill the user\"\nother: x\n---\n# body\ndescription: not this";
        assert_eq!(parse_front_matter(text), (Some("grilling".into()), Some("Grill the user".into())));
        assert_eq!(parse_front_matter("# no front matter"), (None, None));
    }

    #[test]
    fn reads_skill_folders_with_plugin_prefix() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a")).unwrap();
        std::fs::write(dir.path().join("a").join(SKILL_FILE), "---\nname: alpha\ndescription: first\n---\n").unwrap();
        std::fs::create_dir_all(dir.path().join("b")).unwrap();
        std::fs::write(dir.path().join("b").join(SKILL_FILE), "no front matter").unwrap();
        std::fs::create_dir_all(dir.path().join("empty")).unwrap();
        let mut got = read_dir(dir.path(), Some("plug"));
        got.sort_by(|x, y| x.name.cmp(&y.name));
        assert_eq!(got, [Skill { name: "plug:alpha".into(), description: "first".into() }, Skill { name: "plug:b".into(), description: String::new() }]);
        assert!(read_dir(&dir.path().join("missing"), None).is_empty());
    }

    #[test]
    fn ranks_by_past_use_then_builtin_then_name() {
        let prompts = vec!["/grilling a".to_string(), "/grilling b".into(), "/html c".into(), "plain".into(), "/review x".into()];
        let skills = vec![skill("zeta"), skill("html"), skill("review"), skill("grilling"), skill("alpha"), skill("simplify"), skill("html")];
        let names: Vec<String> = rank(skills, &prompts).into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["grilling", "html", "review", "simplify", "alpha", "zeta"]);
    }
}
