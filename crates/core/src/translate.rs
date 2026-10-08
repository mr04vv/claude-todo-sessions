//! Translating a page where it is: its paragraphs (the ones on screen first)
//! asked of Claude in batches, the answers kept so a page read again shows
//! at once. What is already Japanese, or has no words, is left as it is.

use serde_json::{json, Value};

/// Paragraphs at or above this share of Japanese letters are left as they are.
const JAPANESE_SHARE: f64 = 0.2;

fn is_japanese(c: char) -> bool {
    matches!(c, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{ff66}'..='\u{ff9f}')
}

/// Whether a paragraph is worth translating: it has words, and is not Japanese already.
pub fn needs_translation(text: &str) -> bool {
    let letters: Vec<char> = text.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() < 2 {
        return false;
    }
    let japanese = letters.iter().filter(|c| is_japanese(**c)).count();
    (japanese as f64) / (letters.len() as f64) < JAPANESE_SHARE
}

/// What Claude is asked for a batch of paragraphs, numbered so the answer keeps their order.
pub fn prompt(texts: &[String]) -> String {
    let numbered: Vec<String> = texts.iter().enumerate().map(|(i, t)| format!("[{}]\n{t}", i + 1)).collect();
    format!(
        "次の {} 個の段落を、自然な日本語に訳してください。段落ごとに、同じ順で 1 つずつ訳を返します。コード、URL、コマンド、人や製品の名前はそのままにし、説明や前置きは付けないでください。\n\n{}",
        texts.len(),
        numbered.join("\n\n")
    )
}

/// The answer's shape: one translation per paragraph, in order.
pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": { "translations": { "type": "array", "items": { "type": "string" } } },
        "required": ["translations"]
    })
}

/// The translations of `n` paragraphs, when the answer has one for each.
pub fn parse(output: &Value, n: usize) -> Option<Vec<String>> {
    let list: Vec<String> = output["translations"].as_array()?.iter().map(|t| t.as_str().map(String::from)).collect::<Option<_>>()?;
    (list.len() == n).then_some(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn japanese_and_wordless_paragraphs_are_left_alone() {
        assert!(needs_translation("Ownership is Rust's most unique feature."));
        assert!(!needs_translation("所有権は Rust の最も特徴的な機能です。"));
        assert!(!needs_translation("1, 2, 3 — 42%"));
        assert!(needs_translation("この API (the borrow checker) checks every reference at compile time and rejects bad code."), "a little Japanese in English");
    }

    #[test]
    fn the_prompt_numbers_the_paragraphs() {
        let p = prompt(&["First.".into(), "Second.".into()]);
        assert!(p.contains("2 個") && p.contains("[1]\nFirst.") && p.contains("[2]\nSecond."), "{p}");
    }

    #[test]
    fn an_answer_with_one_translation_each_is_taken() {
        let out = json!({"translations": ["一つ目。", "二つ目。"]});
        assert_eq!(parse(&out, 2), Some(vec!["一つ目。".to_string(), "二つ目。".to_string()]));
        assert_eq!(parse(&out, 3), None, "one missing");
        assert_eq!(parse(&json!({}), 1), None);
    }
}
