//! Sorting a reading (an article, a post, a book) into the tags below with OpenAI's Decisions API
//! (https://developers.openai.com/api/docs/guides/decisions): one predicate
//! per tag, asked at once, and the tags likely enough are kept (several may be).
use std::time::Duration;

use serde_json::{json, Value};

/// The tags a reading may get, each with what it covers (the model reads it).
pub const TAGS: [(&str, &str); 21] = [
    ("フロントエンド", "ブラウザで動く UI の実装（React・CSS・Web の API など）"),
    ("バックエンド", "サーバー側の実装（API・サーバー・バッチ処理など）"),
    ("モバイル", "iOS・Android のアプリ開発"),
    ("インフラ", "クラウド・ネットワーク・コンテナ・Kubernetes・IaC"),
    ("データベース", "データベース・SQL・データモデリング・ストレージ"),
    ("パフォーマンス", "速さやメモリの計測と改善"),
    ("セキュリティ", "脆弱性・攻撃と防御・暗号"),
    ("認証・認可", "ログイン・OAuth・OIDC・セッション・権限"),
    ("テスト", "テストの書き方・テストの道具・品質保証"),
    ("設計・アーキテクチャ", "設計の原則・アーキテクチャ・ドメイン設計・リファクタリング"),
    ("プログラミング言語", "言語の仕様・型・コンパイラ（Rust・TypeScript・Go など）"),
    ("開発ツール", "エディタ・CLI・ビルドツール・Git など開発の道具"),
    ("運用・CI/CD", "デプロイ・CI/CD・監視・障害対応・SRE"),
    ("AI・LLM", "生成 AI や LLM の仕組みと使い方・プロンプト"),
    ("AI エージェント", "Claude Code などのコーディングエージェント・エージェントの作り方"),
    ("データ・分析", "データ分析・データ基盤・可視化・機械学習"),
    ("デザイン", "UI / UX・ビジュアルデザイン・デザインシステム"),
    ("プロダクト", "プロダクトマネジメント・企画・グロース"),
    ("組織・マネジメント", "チームの運営・採用・評価・1on1"),
    ("キャリア・働き方", "キャリア・学び方・生産性"),
    ("ビジネス", "事業・経営・マーケティング・業界の動き"),
];

const ENDPOINT: &str = "https://api.openai.com/v1/decisions";
const MODEL: &str = "gpt-6-luna";
/// A tag is kept when the model thinks it this likely to fit.
const TAG_PROBABILITY: f64 = 0.5;
/// Enough of what a reading says to tell what it is about.
const TEXT_MAX_CHARS: usize = 2000;
const TIMEOUT: Duration = Duration::from_secs(30);

/// Question names are made of the tag's place in TAGS.
fn question_name(i: usize) -> String {
    format!("t{i}")
}

/// The Decisions API request asking, for each tag, whether the reading is about it.
pub fn request(title: &str, url: &str, text: Option<&str>) -> Value {
    let text: String = text.unwrap_or_default().chars().take(TEXT_MAX_CHARS).collect();
    let questions: Vec<Value> = TAGS
        .iter()
        .enumerate()
        .map(|(i, (tag, about))| {
            json!({
                "type": "predicate",
                "name": question_name(i),
                "instructions": format!("この読みものは「{tag}」（{about}）について書かれたものである。"),
            })
        })
        .collect();
    json!({
        "model": MODEL,
        "input": format!("タイトル: {title}\nURL: {url}\n\n{text}").trim_end(),
        "questions": questions,
    })
}

/// The tags the answers give, in TAGS's order; an error says what the API said instead.
pub fn tags_of(response: &Value) -> Result<Vec<String>, String> {
    if let Some(message) = response["error"]["message"].as_str() {
        return Err(format!("Decisions API: {message}"));
    }
    let answers = response["answers"].as_array().ok_or_else(|| format!("Decisions API の答えが読めません: {response}"))?;
    let likely = |name: &str| {
        answers
            .iter()
            .any(|a| a["type"] == "predicate" && a["name"] == name && a["probability"].as_f64().is_some_and(|p| p >= TAG_PROBABILITY))
    };
    Ok(TAGS.iter().enumerate().filter(|(i, _)| likely(&question_name(*i))).map(|(_, (tag, _))| tag.to_string()).collect())
}

/// Asks the Decisions API which tags the reading has (none may fit).
pub fn sort(api_key: &str, title: &str, url: &str, text: Option<&str>) -> Result<Vec<String>, String> {
    let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    // An error's body says why (a wrong key, the API not enabled): it is read like an answer.
    let config = ureq::Agent::config_builder().timeout_global(Some(TIMEOUT)).tls_config(tls).http_status_as_error(false).build();
    let response: Value = ureq::Agent::new_with_config(config)
        .post(ENDPOINT)
        .header("Authorization", &format!("Bearer {api_key}"))
        .send_json(request(title, url, text))
        .map_err(|e| format!("Decisions API: {e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| format!("Decisions API: {e}"))?;
    tags_of(&response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_once_whether_each_tag_fits() {
        let r = request("Core Web Vitals を改善する", "https://web.dev/vitals", Some("LCP と INP の改善"));
        assert_eq!(r["model"], MODEL);
        assert_eq!(r["input"], "タイトル: Core Web Vitals を改善する\nURL: https://web.dev/vitals\n\nLCP と INP の改善");
        let questions = r["questions"].as_array().unwrap();
        assert_eq!(questions.len(), TAGS.len());
        assert_eq!((questions[5]["type"].as_str(), questions[5]["name"].as_str()), (Some("predicate"), Some("t5")));
        assert!(questions[5]["instructions"].as_str().unwrap().contains("パフォーマンス"));
        assert_eq!(request("t", "u", None)["input"], "タイトル: t\nURL: u", "no text: nothing after the URL");
    }

    #[test]
    fn a_long_text_goes_cut() {
        let long = "あ".repeat(TEXT_MAX_CHARS + 10);
        let input = request("t", "u", Some(&long))["input"].as_str().unwrap().to_string();
        assert_eq!(input.chars().filter(|&c| c == 'あ').count(), TEXT_MAX_CHARS);
    }

    #[test]
    fn keeps_the_tags_likely_enough_in_their_order() {
        let answers = json!({ "answers": [
            { "type": "predicate", "name": "t5", "probability": 0.91 },
            { "type": "predicate", "name": "t0", "probability": 0.5 },
            { "type": "predicate", "name": "t1", "probability": 0.49 },
            { "type": "refusal", "name": "t2" },
        ]});
        assert_eq!(tags_of(&answers).unwrap(), ["フロントエンド", "パフォーマンス"]);
        assert_eq!(tags_of(&json!({ "answers": [] })).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn says_what_the_api_said_when_it_fails() {
        let e = json!({ "error": { "message": "Decision API is not enabled for this user.", "type": "invalid_request_error" } });
        assert_eq!(tags_of(&e).unwrap_err(), "Decisions API: Decision API is not enabled for this user.");
        assert!(tags_of(&json!({})).is_err());
    }
}
