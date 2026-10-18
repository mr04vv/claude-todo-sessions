//! Sorting a reading (an article, a post, a book) into the tags below with TypeSafe's Jev
//! (https://docs.typesafe.ai/api): one yes/no (noul) question per tag, asked
//! at once, and the tags likely enough are kept (several may be).
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

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const MODEL: &str = "jev-latest";
/// A tag is kept when the model thinks it this likely to fit.
const TAG_PROBABILITY: f64 = 0.5;
/// Enough of what a reading says to tell what it is about.
const TEXT_MAX_CHARS: usize = 2000;
const TIMEOUT: Duration = Duration::from_secs(30);

/// Question names are made of the tag's place in TAGS.
fn question_name(i: usize) -> String {
    format!("t{i}")
}

/// The Jev request asking, for each tag, whether the reading is about it.
pub fn request(title: &str, url: &str, text: Option<&str>) -> Value {
    let text: String = text.unwrap_or_default().chars().take(TEXT_MAX_CHARS).collect();
    let questions: serde_json::Map<String, Value> = TAGS
        .iter()
        .enumerate()
        .map(|(i, (tag, about))| (question_name(i), json!({ "type": "noul", "instructions": format!("この読みものは「{tag}」（{about}）について書かれたものか。") })))
        .collect();
    let mut state = json!({ "title": title, "url": url });
    if !text.is_empty() {
        state["text"] = text.into();
    }
    json!({ "model": MODEL, "state": state, "questions": questions })
}

/// The tags the answers give, in TAGS's order.
pub fn tags_of(response: &Value) -> Result<Vec<String>, String> {
    let answers = response["answers"].as_object().ok_or_else(|| format!("Jev の答えが読めません: {response}"))?;
    let likely = |name: &str| answers.get(name).and_then(|a| a["noul"].as_f64()).is_some_and(|p| p >= TAG_PROBABILITY);
    Ok(TAGS.iter().enumerate().filter(|(i, _)| likely(&question_name(*i))).map(|(_, (tag, _))| tag.to_string()).collect())
}

/// Asks Jev which tags the reading has (none may fit).
pub fn sort(api_key: &str, title: &str, url: &str, text: Option<&str>) -> Result<Vec<String>, String> {
    let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    // An error's body says why (a wrong key, no access yet): it goes in the error.
    let config = ureq::Agent::config_builder().timeout_global(Some(TIMEOUT)).tls_config(tls).http_status_as_error(false).build();
    let mut response = ureq::Agent::new_with_config(config)
        .post(ENDPOINT)
        .header("Authorization", &format!("Bearer {api_key}"))
        .send_json(request(title, url, text))
        .map_err(|e| format!("Jev: {e}"))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let body = response.body_mut().read_to_string().map_err(|e| format!("Jev {status}: {e}"))?;
        return Err(format!("Jev {status}: {body}"));
    }
    tags_of(&response.body_mut().read_json().map_err(|e| format!("Jev: {e}"))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_once_whether_each_tag_fits() {
        let r = request("Core Web Vitals を改善する", "https://web.dev/vitals", Some("LCP と INP の改善"));
        assert_eq!(r["model"], MODEL);
        assert_eq!(r["state"], json!({ "title": "Core Web Vitals を改善する", "url": "https://web.dev/vitals", "text": "LCP と INP の改善" }));
        let questions = r["questions"].as_object().unwrap();
        assert_eq!(questions.len(), TAGS.len());
        assert_eq!(questions["t5"]["type"], "noul");
        assert!(questions["t5"]["instructions"].as_str().unwrap().contains("パフォーマンス"));
        assert_eq!(request("t", "u", None)["state"], json!({ "title": "t", "url": "u" }), "no text: no text in the state");
    }

    #[test]
    fn a_long_text_goes_cut() {
        let long = "あ".repeat(TEXT_MAX_CHARS + 10);
        let text = request("t", "u", Some(&long))["state"]["text"].as_str().unwrap().to_string();
        assert_eq!(text.chars().count(), TEXT_MAX_CHARS);
    }

    #[test]
    fn keeps_the_tags_likely_enough_in_their_order() {
        let answers = json!({ "model": "jev-1.13.0", "answers": {
            "t5": { "type": "noul", "noul": 0.91 },
            "t0": { "type": "noul", "noul": 0.5 },
            "t1": { "type": "noul", "noul": 0.49 },
        }});
        assert_eq!(tags_of(&answers).unwrap(), ["フロントエンド", "パフォーマンス"]);
        assert_eq!(tags_of(&json!({ "answers": {} })).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn says_so_when_the_answers_are_not_there() {
        assert!(tags_of(&json!({})).unwrap_err().starts_with("Jev"));
    }
}
