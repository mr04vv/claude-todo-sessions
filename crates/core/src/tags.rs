//! What a reading or a post is about, asked of TypeSafe's Jev
//! (https://docs.typesafe.ai/api). A reading (an article, a post, a book) is
//! sorted into the tags below: one yes/no (noul) question per tag, asked at
//! once, and the tags likely enough are kept (several may be). A post on X's
//! timeline is asked whether it is about engineering.
use std::time::Duration;

use serde_json::{json, Value};

/// The tags a reading may get, each with what it covers (the model reads it).
pub const TAGS: [(&str, &str); 10] = [
    ("フロントエンド", "ブラウザで動く UI の実装（React・CSS・Web の API・ビルドなど）"),
    ("バックエンド", "サーバー側の実装（API・データベース・バッチ処理・インフラなど）"),
    ("パフォーマンス", "速さやメモリの計測と改善（Core Web Vitals・プロファイリング・キャッシュなど）"),
    ("アクセシビリティ", "障害のある人も含めて誰もが使えるようにすること（WCAG・WAI-ARIA・スクリーンリーダーなど）"),
    ("Observability/Reliability", "監視・ログ・メトリクス・トレース・SLO・障害対応・SRE"),
    ("セキュリティ", "脆弱性・攻撃と防御・認証と認可・暗号"),
    ("設計", "ソフトウェアの設計・アーキテクチャ・ドメイン設計・リファクタリング"),
    ("組織論・マインドセット", "チームや組織の運営・マネジメント・キャリア・仕事への考え方や姿勢"),
    ("AI/LLM", "生成 AI・LLM・AI エージェントの仕組みと使い方・プロンプト"),
    ("QA", "テスト・品質保証・テストの自動化"),
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

/// Asks Jev which tags the reading has (none may fit), and what that took.
pub fn sort(api_key: &str, title: &str, url: &str, text: Option<&str>) -> Result<(Vec<String>, Usage), String> {
    let response = ask(api_key, request(title, url, text))?;
    Ok((tags_of(&response)?, usage_of(&response)))
}

/// The tokens a request to Jev took.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: i64,
    pub output_tokens: i64,
}

/// What the answer says the request took (none, when it does not say).
pub fn usage_of(response: &Value) -> Usage {
    let tokens = |name: &str| response["usage"][name].as_i64().unwrap_or(0);
    Usage { input_tokens: tokens("input_tokens"), output_tokens: tokens("output_tokens") }
}

/// Jev's price, as TypeSafe's page puts it: $42 a billion input tokens (it
/// prices no output).
const USD_PER_BILLION_INPUT_TOKENS: f64 = 42.0;

/// What `input_tokens` cost, in US dollars.
pub fn cost_usd(input_tokens: i64) -> f64 {
    input_tokens as f64 * USD_PER_BILLION_INPUT_TOKENS / 1e9
}

/// The question's name for whether a post is about engineering.
const ENGINEERING: &str = "engineering";

/// The Jev request asking whether a post on X is about engineering.
pub fn engineering_request(text: &str) -> Value {
    json!({
        "model": MODEL,
        "state": text,
        "questions": { ENGINEERING: {
            "type": "noul",
            "instructions": "Is this post on X (Twitter) related to engineering?",
            "criteria": {
                "true": "The post is about software development, programming, infrastructure, DevOps, developer tools, \
                    ML/AI engineering, hardware engineering, or the careers, teams, and organizations of engineers.",
                "false": "The post is about something else, such as daily life, politics, entertainment, sports, \
                    general news, or marketing unrelated to building technology.",
            },
        }},
    })
}

/// How likely the post is about engineering (0 to 1).
pub fn engineering_of(response: &Value) -> Result<f64, String> {
    response["answers"][ENGINEERING]["noul"].as_f64().ok_or_else(|| format!("Jev の答えが読めません: {response}"))
}

/// Asks Jev how likely a post on X is about engineering, and what that took.
pub fn engineering(api_key: &str, text: &str) -> Result<(f64, Usage), String> {
    let response = ask(api_key, engineering_request(text))?;
    Ok((engineering_of(&response)?, usage_of(&response)))
}

/// Sends a request to Jev; an error says the status and what came back.
fn ask(api_key: &str, request: Value) -> Result<Value, String> {
    let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    // An error's body says why (a wrong key, no access yet): it goes in the error.
    let config = ureq::Agent::config_builder().timeout_global(Some(TIMEOUT)).tls_config(tls).http_status_as_error(false).build();
    let mut response = ureq::Agent::new_with_config(config)
        .post(ENDPOINT)
        .header("Authorization", &format!("Bearer {api_key}"))
        .send_json(request)
        .map_err(|e| format!("Jev: {e}"))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let body = response.body_mut().read_to_string().map_err(|e| format!("Jev {status}: {e}"))?;
        return Err(format!("Jev {status}: {body}"));
    }
    response.body_mut().read_json().map_err(|e| format!("Jev: {e}"))
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
        assert_eq!(questions["t2"]["type"], "noul");
        assert!(questions["t2"]["instructions"].as_str().unwrap().contains("パフォーマンス"));
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
            "t2": { "type": "noul", "noul": 0.91 },
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

    #[test]
    fn asks_whether_a_post_is_about_engineering() {
        let r = engineering_request("Rust 2027 edition is out");
        assert_eq!(r["model"], MODEL);
        assert_eq!(r["state"], "Rust 2027 edition is out");
        let q = &r["questions"][ENGINEERING];
        assert_eq!(q["type"], "noul");
        assert!(q["criteria"]["true"].as_str().unwrap().contains("software development"));
        assert!(q["criteria"]["false"].as_str().unwrap().contains("daily life"));
    }

    #[test]
    fn says_how_many_tokens_a_request_took_and_what_they_cost() {
        let r = json!({ "answers": {}, "usage": { "input_tokens": 1200, "output_tokens": 21 } });
        assert_eq!(usage_of(&r), Usage { input_tokens: 1200, output_tokens: 21 });
        assert_eq!(usage_of(&json!({ "answers": {} })), Usage::default(), "none said: none counted");
        assert!((cost_usd(1_000_000_000) - 42.0).abs() < 1e-9);
        assert!((cost_usd(1_000_000) - 0.042).abs() < 1e-12);
    }

    #[test]
    fn a_post_is_about_engineering_as_likely_as_jev_says() {
        assert_eq!(engineering_of(&json!({ "answers": { ENGINEERING: { "type": "noul", "noul": 0.82 } } })), Ok(0.82));
        assert!(engineering_of(&json!({ "answers": {} })).unwrap_err().starts_with("Jev"));
    }
}
