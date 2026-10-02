//! The Input mode's 「説明する」 (the Feynman technique): the key points of
//! what was read, made once; the user's own explanation of them, graded point
//! by point; and when to explain again. Claude is asked through `claude -p`
//! with a JSON schema; the prompts and the answers' parsing are here.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// A page's text as the app read it from its tab (or fetched it).
#[derive(Deserialize, Debug, Clone)]
pub struct Page {
    pub url: String,
    pub title: Option<String>,
    pub text: String,
}

/// How much of each page goes into the prompt, and how many pages.
pub const PAGE_CHARS: usize = 12_000;
pub const MAX_PAGES: usize = 8;
/// How many points are asked for.
const POINTS_MIN: usize = 5;
const POINTS_MAX: usize = 8;

/// The first `max` characters of `text`, with "…" when it was longer.
pub fn excerpt(text: &str, max: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_string(),
    }
}

/// Asks for the key points of the pages read for `title`.
pub fn points_prompt(title: &str, pages: &[Page]) -> String {
    let pages: String = pages
        .iter()
        .take(MAX_PAGES)
        .map(|p| format!("### {}\n{}\n\n{}\n\n", p.title.as_deref().unwrap_or(&p.url), p.url, excerpt(&p.text, PAGE_CHARS)))
        .collect();
    format!(
        "インプット: {title}\n\n次のページを読んだ人が、内容を理解したと言えるために「自分の言葉で説明できるべき要点」を {POINTS_MIN}〜{POINTS_MAX} 個挙げてください。\n\
         - 1つの要点は1文で、具体的に（「〜である」「〜だから〜する」）。用語の名前だけ挙げない。\n\
         - 大事な順に並べる。\n\
         - 日本語で書く。\n\n## ページ\n\n{pages}"
    )
}

pub fn points_schema() -> Value {
    json!({ "type": "object", "properties": { "points": { "type": "array", "items": { "type": "string" } } }, "required": ["points"] })
}

/// The points Claude answered with (its structured output).
pub fn parse_points(output: &Value) -> Result<Vec<String>, String> {
    let points: Vec<String> = output["points"]
        .as_array()
        .ok_or("要点が返ってきませんでした")?
        .iter()
        .filter_map(|p| p.as_str().map(str::trim).filter(|s| !s.is_empty()).map(Into::into))
        .collect();
    if points.is_empty() {
        return Err("要点が返ってきませんでした".into());
    }
    Ok(points)
}

/// How well one point was explained.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Said,
    Vague,
    Missing,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct PointVerdict {
    /// Index into the points.
    pub point: usize,
    pub verdict: Verdict,
    /// What was said of it, or what was off.
    pub note: String,
}

/// What Claude found in an explanation.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug, Default)]
pub struct Grade {
    pub verdicts: Vec<PointVerdict>,
    /// Things said that are wrong.
    pub mistakes: Vec<String>,
    /// Terms used without being explained.
    pub jargon: Vec<String>,
    /// Questions that probe the gaps.
    pub questions: Vec<String>,
}

/// Asks for the grading of `explanation` against the points.
pub fn grade_prompt(title: &str, points: &[String], explanation: &str) -> String {
    let list: String = points.iter().enumerate().map(|(i, p)| format!("{i}. {p}\n")).collect();
    format!(
        "インプット: {title}\n\n読んだ人が、何も見ずに自分の言葉で内容を説明しました（ファインマン・テクニック）。要点ごとに、説明できているかを判定してください。\n\n\
         ## 要点\n{list}\n## 説明\n{explanation}\n\n\
         ## 判定の仕方\n\
         - 要点ごとに said（自分の言葉で正しく言えている）/ vague（触れてはいるが曖昧、または言い換えただけ）/ missing（触れていない）のどれかを付け、note に一言（何が言えていて何が足りないか）を書く。要点の番号は上の番号。\n\
         - mistakes: 説明の中の、事実として間違っているところ（なければ空）。\n\
         - jargon: 説明せずに使っている専門用語（なければ空）。\n\
         - questions: 理解の穴を突く質問を2〜3個。「なぜ」「どうなる」で、答えると穴が埋まるもの。\n\
         - すべて日本語で、相手を子どもに教える先生のつもりで、厳しく、しかし具体的に。"
    )
}

pub fn grade_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "verdicts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "point": { "type": "integer" },
                        "verdict": { "type": "string", "enum": ["said", "vague", "missing"] },
                        "note": { "type": "string" }
                    },
                    "required": ["point", "verdict", "note"]
                }
            },
            "mistakes": { "type": "array", "items": { "type": "string" } },
            "jargon": { "type": "array", "items": { "type": "string" } },
            "questions": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["verdicts", "mistakes", "jargon", "questions"]
    })
}

/// The grade Claude answered with, one verdict per point in order (a point
/// it left out is missing; one it made up is dropped).
pub fn parse_grade(output: &Value, points: usize) -> Result<Grade, String> {
    let mut grade: Grade = serde_json::from_value(output.clone()).map_err(|e| format!("採点が読めませんでした: {e}"))?;
    let given = std::mem::take(&mut grade.verdicts);
    grade.verdicts = (0..points)
        .map(|i| {
            given
                .iter()
                .find(|v| v.point == i)
                .cloned()
                .unwrap_or(PointVerdict { point: i, verdict: Verdict::Missing, note: String::new() })
        })
        .collect();
    Ok(grade)
}

/// How much was understood, in percent: a point said counts 1, a vague one
/// half.
pub fn score(grade: &Grade) -> u8 {
    if grade.verdicts.is_empty() {
        return 0;
    }
    let got: f64 = grade
        .verdicts
        .iter()
        .map(|v| match v.verdict {
            Verdict::Said => 1.0,
            Verdict::Vague => 0.5,
            Verdict::Missing => 0.0,
        })
        .sum();
    (got / grade.verdicts.len() as f64 * 100.0).round() as u8
}

/// After how many days to explain again, by the last score.
pub fn review_after_days(score: u8) -> i64 {
    if score < 60 {
        1
    } else if score < 85 {
        3
    } else {
        7
    }
}

/// A page's readable text from its HTML, when the app could not read it
/// from a tab: scripts and styles out, tags out, entities decoded, blank
/// lines folded.
pub fn text_of_html(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let tag = &rest[i..];
        let name: String = tag[1..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
        let skip_to = match name.as_str() {
            "script" | "style" | "noscript" | "svg" => tag.to_ascii_lowercase().find(&format!("</{name}")).and_then(|j| tag[j..].find('>').map(|k| j + k + 1)),
            _ => tag.find('>').map(|k| k + 1),
        };
        if matches!(name.as_str(), "p" | "div" | "br" | "li" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "tr" | "section" | "article" | "pre" | "blockquote") {
            out.push('\n');
        }
        rest = match skip_to {
            Some(k) => &tag[k..],
            None => "",
        };
    }
    out.push_str(rest);
    let decoded = crate::ogp::decode(&out);
    decoded.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpt_cuts_on_characters() {
        assert_eq!(excerpt("日本語のテキスト", 3), "日本語…");
        assert_eq!(excerpt(" short ", 10), "short");
    }

    #[test]
    fn points_prompt_names_the_pages_and_cuts_their_text() {
        let pages = vec![Page { url: "https://a.b/".into(), title: Some("A".into()), text: "x".repeat(PAGE_CHARS + 5) }];
        let prompt = points_prompt("本", &pages);
        assert!(prompt.contains("### A\nhttps://a.b/\n"));
        assert!(prompt.contains(&format!("{}…", "x".repeat(PAGE_CHARS))));
        assert!(!prompt.contains(&"x".repeat(PAGE_CHARS + 1)));
    }

    #[test]
    fn points_are_the_non_empty_strings() {
        assert_eq!(parse_points(&json!({ "points": ["a", " ", "b "] })).unwrap(), ["a", "b"]);
        assert!(parse_points(&json!({ "points": [] })).is_err());
        assert!(parse_points(&json!({})).is_err());
    }

    #[test]
    fn grade_has_one_verdict_per_point_in_order() {
        let output = json!({
            "verdicts": [
                { "point": 1, "verdict": "said", "note": "ok" },
                { "point": 7, "verdict": "said", "note": "made up" }
            ],
            "mistakes": ["m"], "jargon": [], "questions": ["q1", "q2"]
        });
        let grade = parse_grade(&output, 3).unwrap();
        assert_eq!(grade.verdicts.iter().map(|v| (v.point, v.verdict)).collect::<Vec<_>>(), [(0, Verdict::Missing), (1, Verdict::Said), (2, Verdict::Missing)]);
        assert_eq!(grade.mistakes, ["m"]);
        assert_eq!(score(&grade), 33);
        assert!(parse_grade(&json!({ "verdicts": "no" }), 1).is_err());
    }

    #[test]
    fn score_counts_vague_as_half() {
        let v = |i, verdict| PointVerdict { point: i, verdict, note: String::new() };
        let grade = Grade { verdicts: vec![v(0, Verdict::Said), v(1, Verdict::Vague), v(2, Verdict::Said), v(3, Verdict::Missing)], ..Default::default() };
        assert_eq!(score(&grade), 63);
        assert_eq!(score(&Grade::default()), 0);
    }

    #[test]
    fn review_comes_sooner_the_lower_the_score() {
        assert_eq!(review_after_days(59), 1);
        assert_eq!(review_after_days(60), 3);
        assert_eq!(review_after_days(84), 3);
        assert_eq!(review_after_days(85), 7);
    }

    #[test]
    fn html_becomes_its_text() {
        let html = "<html><head><title>T</title><style>p{}</style><script>var x = '<p>';</script></head><body><h1>見出し</h1><p>本文 &amp; <b>太字</b></p>\n\n<div>次</div></body></html>";
        assert_eq!(text_of_html(html), "T\n見出し\n本文 & 太字\n次");
    }
}
