//! Picking the model (and effort) a todo's session starts with, from what it
//! is asked to do: Claude (haiku) reads the todo and answers in a JSON schema.

use serde::Serialize;
use serde_json::{json, Value};

use crate::models::Model;

/// The families a session may start with, cheapest first, and when each fits.
const TIERS: [(&str, &str); 4] = [
    ("haiku", "小さく決まった作業（誤字・設定値・短い文書の直し、1ファイルの小さな変更）"),
    ("sonnet", "ふつうの実装やバグ修正（1つのリポジトリで、やることがはっきりしている）"),
    ("opus", "込み入った実装・調査・設計（複数ファイルにまたがる、原因の分からない不具合、方針から考える）"),
    ("fable", "いちばん難しいもの（大きな設計の変更、複数リポジトリにまたがる計画、安全性に関わる判断）"),
];
pub const EFFORTS: [&str; 4] = ["low", "medium", "high", "xhigh"];

/// What was picked, and why in a line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Pick {
    pub model: String,
    pub effort: String,
    pub reason: String,
}

/// The models offered (`models`' of each tier's family), cheapest first, and when each fits.
fn offered(models: &[Model]) -> Vec<(&str, &str)> {
    TIERS.iter().filter_map(|(family, when)| models.iter().find(|m| m.family == *family).map(|m| (m.id.as_str(), *when))).collect()
}

/// The ask: the todo (its title, memo and first prompt) and the models to pick from.
pub fn prompt(title: &str, memo: &str, first: &str, plan: bool, models: &[Model]) -> String {
    let models = offered(models).iter().map(|(id, when)| format!("- {id}: {when}")).collect::<Vec<_>>().join("\n");
    format!(
        "Claude Code のセッションを始めます。次の作業に合うモデルと effort（考える深さ）を、費用を抑えつつ選んでください。\n\
         足りるならより安いモデル・低い effort を選びます。迷ったら1段上を選びます。\n\n\
         モデル（安い順）:\n{models}\n\neffort: {efforts}\n\n\
         {kind}\n<todo>\nタイトル: {title}\nメモ: {memo}\n最初のプロンプト: {first}\n</todo>\n\n\
         reason は日本語の1文（30字以内）で。",
        efforts = EFFORTS.join(" / "),
        kind = if plan { "この作業は、サブタスクに分けて進める計画のセッションです。" } else { "この作業は、そのまま実装するセッションです。" },
    )
}

pub fn schema(models: &[Model]) -> Value {
    json!({
        "type": "object",
        "properties": {
            "model": { "type": "string", "enum": offered(models).iter().map(|(id, _)| *id).collect::<Vec<_>>() },
            "effort": { "type": "string", "enum": EFFORTS },
            "reason": { "type": "string" }
        },
        "required": ["model", "effort", "reason"],
        "additionalProperties": false
    })
}

/// The answer, if it names a model and an effort offered.
pub fn parse(answer: &Value, models: &[Model]) -> Option<Pick> {
    let model = answer["model"].as_str().filter(|m| offered(models).iter().any(|(id, _)| id == m))?;
    let effort = answer["effort"].as_str().filter(|e| EFFORTS.contains(e))?;
    Some(Pick { model: model.into(), effort: effort.into(), reason: answer["reason"].as_str().unwrap_or_default().trim().into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models() -> Vec<Model> {
        crate::models::latest(&json!({}))
    }

    #[test]
    fn an_answer_naming_an_offered_model_and_effort_is_the_pick() {
        let pick = parse(&json!({"model": "claude-sonnet-5", "effort": "medium", "reason": " ふつうのバグ修正 "}), &models()).unwrap();
        assert_eq!(pick, Pick { model: "claude-sonnet-5".into(), effort: "medium".into(), reason: "ふつうのバグ修正".into() });
    }

    #[test]
    fn a_model_or_effort_not_offered_is_no_pick() {
        assert_eq!(parse(&json!({"model": "gpt-5", "effort": "medium", "reason": ""}), &models()), None);
        assert_eq!(parse(&json!({"model": "claude-opus-5-5", "effort": "max", "reason": ""}), &models()), None);
    }

    #[test]
    fn the_ask_says_whether_it_plans() {
        assert!(prompt("t", "", "", true, &models()).contains("計画のセッション"));
        assert!(prompt("t", "", "", false, &models()).contains("そのまま実装"));
    }

    #[test]
    fn the_newest_of_each_family_is_offered() {
        let newer = crate::models::latest(&json!({"modelAccessCache": [{"apiName": "claude-sonnet-5-5", "entitled": true}]}));
        assert!(prompt("t", "", "", false, &newer).contains("- claude-sonnet-5-5: ふつう"));
        assert_eq!(parse(&json!({"model": "claude-sonnet-5", "effort": "low", "reason": ""}), &newer), None);
    }
}
