//! Readings summed up (a 日報) in an HTML artifact (in claude.ai): a day's
//! (what was kept that day), or the ones picked by hand. The readings
//! (articles, posts on X, books) and the pages they are or link to, read in
//! full, are written into a brief for a Claude Code session, which sums them
//! up as closely as it can, theme by theme, in pictures, and publishes the page
//! (the Artifact tool is a session's alone). A page may also play a podcast of
//! them, read aloud from a script Claude writes (tts.rs).
use crate::launch::shell_quote;
use crate::ogp::Page;
use crate::{Reading, ReadingKind};

/// What the session may do without asking: read its brief, write the page,
/// read the artifact skill and publish.
const SESSION_TOOLS: &str = "Read,Write,Skill,ToolSearch,Artifact";
/// Enough of a page's text for a close summary.
const PAGE_TEXT_MAX_CHARS: usize = 20_000;

/// A reading kept that day, and its pages as read (an article's own, a post's
/// links'; a book's, behind a login, none), or why one was not.
pub struct Item<'a> {
    pub reading: &'a Reading,
    pub pages: Vec<Result<Page, String>>,
}

/// What a reading is, as the brief names it.
fn kind_name(kind: ReadingKind) -> &'static str {
    match kind {
        ReadingKind::Article => "記事",
        ReadingKind::Post => "X の投稿",
        ReadingKind::Book => "本",
    }
}

/// The session's brief: what to make, then the readings and their pages.
pub fn brief(title: &str, items: &[Item], podcast: Option<&Podcast>) -> String {
    let mut out = format!(
        "# {title}\n\
         \n\
         読みもの {n} 件（記事、X の投稿、本）と、そのページ（記事そのもの、投稿のリンク先）の本文を下に渡します。\n\
         これを読んで、HTML のアーティファクトを 1 つ作り、Artifact ツールで公開してください（書く前に artifact-design スキルを読む）。\n\
         \n\
         - タイトルは「{title}」。\n\
         - 文章を読ませるページではなく、見て分かるページにする。どのカードも文章だけにしない。\n\
         - 一番上に、全体の要点（3〜5 行）と、テーマ（タグ）ごとの件数が一目で分かる小さなグラフ。\n\
         - テーマごとのまとまりに分けて、1 件ずつカードにする。カードには種類（記事・X の投稿・本）の印、タイトル（投稿なら投稿者）、元の URL へのリンク、要約。\n\
         - 要約はできるだけ詳しく（背景、主張、具体的な手順・コード・数字、結論。大事な点を落とさない）。投稿はリンク先のページも同じように。\
         本は説明と目次から、何についての本か。\n\
         - 要約は短い段落と箇条書きにし、中身に合わせて図にする：手順や処理の流れは流れ図（mermaid でよい）、比べている内容は比較表、\
         構成や関係は関係図、測った数字や前後の差は大きく見せる数字か小さなグラフ。\n\
         - 得られることや、仕事にどう活かせるかも一言添える。\n\
         - 本文を読めなかったページは、読めなかったと書く。中身を推測で書かない。\n\
         - 中身の薄いもの（日常の話など）は、最後の「軽いもの」に短くまとめる。\n\
         - 日本語で書く。\n",
        n = items.len(),
    );
    if let Some(podcast) = podcast {
        let chapters: String = podcast.chapters.iter().map(|(at, title)| format!("  - {} {title}（{at:.1} 秒）\n", clock(*at))).collect();
        out.push_str(&format!(
            "- 一番上（要点の上）に、この読みものを 1 件ずつ解説するポッドキャストのプレーヤーを置く。\
             音声は {file} にある。Artifact ツールの files で podcast.mp3 として公開し、<audio controls src=\"podcast.mp3\"> で再生する。\
             プレーヤーの下に、記事ごとの頭出しボタン（押すとその秒から再生）を並べ、各カードにも同じ頭出しボタンを置く。各記事の始まり:\n{chapters}",
            file = podcast.file,
        ));
    }
    out.push_str("- 公開したら終わり。ほかのことはしない。\n");
    out.push_str(&readings(items));
    out
}

/// The readings and their pages, one by one.
fn readings(items: &[Item]) -> String {
    let mut out = String::new();
    for (i, item) in items.iter().enumerate() {
        let r = item.reading;
        out.push_str(&format!("\n## {} 件目（{}）\nURL: {}\nタイトル: {}\n", i + 1, kind_name(r.kind), r.url, r.title));
        if let Some(tags) = r.tags.as_ref().filter(|t| !t.is_empty()) {
            out.push_str(&format!("タグ: {}\n", tags.join("、")));
        }
        out.push_str(&format!("本文・説明:\n{}\n", r.text.as_deref().unwrap_or("（なし）")));
        if !r.chapters.is_empty() {
            out.push_str(&format!("目次:\n{}\n", r.chapters.iter().map(|c| c.title.as_str()).collect::<Vec<_>>().join("\n")));
        }
        for (j, page) in item.pages.iter().enumerate() {
            match page {
                Ok(page) => {
                    let text: String = page.text.chars().take(PAGE_TEXT_MAX_CHARS).collect();
                    out.push_str(&format!("\n### ページ {}: {}\nタイトル: {}\n本文:\n{text}\n", j + 1, page.url, page.title.as_deref().unwrap_or("（不明）")));
                }
                Err(why) => out.push_str(&format!("\n### ページ {}: 読めませんでした（{why}）\n", j + 1)),
            }
        }
    }
    out
}

/// The command starting the session that makes the page of the brief at
/// `brief_path`, in `briefs_dir` (added for its file tools).
pub fn session_command(session_id: &str, briefs_dir: &str, brief_path: &str) -> String {
    // The prompt first: --add-dir and --allowedTools take as many values as follow them.
    format!(
        "claude {} --session-id {session_id} --add-dir {} --allowedTools {}",
        shell_quote(&first_prompt(brief_path)),
        shell_quote(briefs_dir),
        shell_quote(SESSION_TOOLS)
    )
}

/// A podcast of the readings, for the page to play: its recording (a file the
/// session publishes beside the page) and where each reading starts in it.
pub struct Podcast {
    pub file: String,
    pub chapters: Vec<(f64, String)>,
}

/// A reading's part of the podcast's script.
#[derive(Debug, PartialEq)]
pub struct Segment {
    pub title: String,
    pub text: String,
}

/// Seconds as a player shows them: m:ss.
pub fn clock(secs: f64) -> String {
    let secs = secs as u64;
    format!("{}:{:02}", secs / 60, secs % 60)
}

/// A date (YYYY-MM-DD) as it is said: 2026年10月19日.
pub fn spoken_date(day: &str) -> String {
    let parts: Vec<u32> = day.split('-').filter_map(|p| p.parse().ok()).collect();
    match parts[..] {
        [y, m, d] => format!("{y}年{m}月{d}日"),
        _ => day.to_string(),
    }
}

/// What Claude is asked for the podcast's script, and the readings to write it from.
pub fn script_prompt(date: &str, items: &[Item]) -> String {
    format!(
        "下の読みもの {n} 件から、1 人のアナウンサーが読み上げる日本語のポッドキャストの台本を書いてください。音声合成でそのまま読み上げます。\n\
         \n\
         - ニュース番組のように、1 人が淡々と解説する口調（です・ます）。掛け合いや感想、盛り上げはしない。\n\
         - 冒頭は「皆さんこんにちは、{date}の日報です。」の一文だけで、すぐ「1つ目の記事です。」に入る。以降「2つ目の記事です。」と続ける。\n\
         - 各記事の最初に、どこの何か（ブログ名やリポジトリ名、記事のタイトル。投稿ならその投稿者とリンク先）を言う。\n\
         - ストレートに、その記事に書いてある具体的な中身を話す：背景、主張、具体的な手順・仕組み・コードの要点・数字、結論。抽象的な一般論や、意義づけのまとめは入れない。\n\
         - 記事同士を結びつけたり比べたりしない。全体のまとめもしない。最後は「以上、{date}の日報でした。」の一文だけ。\n\
         - 本文に無いことは言わない（推測で補わない）。本文を読めなかったものは、読めなかったと言って次に進む。\n\
         - 耳で聞く文章にする：URL・記号・マークダウン・箇条書きは使わない。コードは読み上げず、何をしているかを言葉で説明する。英語の固有名詞はそのまま書いてよい。\n\
         - 1 件あたり 700〜1,200 字を目安に（多くても 2,500 字）、中身の薄いものは短く。\n\
         - segments に 1 件 1 つ、読みものの順に入れる。title はその記事の短い名前、text は読み上げる文。冒頭の一文は 1 つ目の text の先頭に、締めの一文は最後の text の末尾に入れる。\n{readings}",
        n = items.len(),
        readings = readings(items),
    )
}

/// The script's shape: a segment per reading, in order.
pub fn script_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "segments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"title": {"type": "string"}, "text": {"type": "string"}},
                    "required": ["title", "text"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["segments"],
        "additionalProperties": false
    })
}

/// The script's segments, from Claude's answer in `script_schema`.
pub fn segments_of(answer: &serde_json::Value) -> Result<Vec<Segment>, String> {
    let segments: Vec<Segment> = answer["segments"]
        .as_array()
        .map(|all| {
            all.iter()
                .map(|s| Segment { title: s["title"].as_str().unwrap_or_default().trim().to_string(), text: s["text"].as_str().unwrap_or_default().trim().to_string() })
                .collect()
        })
        .unwrap_or_default();
    if segments.is_empty() || segments.iter().any(|s| s.text.is_empty()) {
        return Err("台本が空でした".into());
    }
    Ok(segments)
}

/// The session's first prompt: its brief (long; read in parts).
pub fn first_prompt(brief_path: &str) -> String {
    format!("{brief_path} を読んで（長いので何回かに分けて）、そこに書いてあるとおりに読みものの日報を HTML のアーティファクトにして公開してください。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ReadingKind;

    fn post(text: &str) -> Reading {
        Reading {
            id: 1,
            kind: ReadingKind::Post,
            url: "https://x.com/ashunar0/status/1".into(),
            title: "@ashunar0: Void を触ってみた".into(),
            text: Some(text.into()),
            image: None,
            tags: Some(vec!["AI/LLM".into()]),
            chapters: vec![],
            created_at: 0,
            kept: false,
            links: vec!["https://t.co/abc".into()],
        }
    }

    #[test]
    fn briefs_a_session_on_the_day_s_readings_and_their_pages() {
        let r = post("Void を触ってみた");
        let page = Page { url: "https://ashunar0.dev/posts/try-void".into(), title: Some("Void".into()), text: "ゑ".repeat(PAGE_TEXT_MAX_CHARS + 10) };
        let mut book = post("データ指向アプリケーション設計");
        book.kind = ReadingKind::Book;
        book.chapters = vec![crate::Chapter { position: 1, title: "Replication".into(), url: String::new(), read: false }];
        let b = brief("読みものの日報 2026-10-18", &[Item { reading: &r, pages: vec![Ok(page), Err("timeout".into())] }, Item { reading: &book, pages: vec![] }], None);
        assert!(b.contains("「読みものの日報 2026-10-18」") && b.contains("HTML のアーティファクト") && b.contains("artifact-design"));
        assert!(b.contains("## 2 件目（本）") && b.contains("目次:\nReplication"));
        assert!(b.contains("## 1 件目（X の投稿）\nURL: https://x.com/ashunar0/status/1") && b.contains("タグ: AI/LLM") && b.contains("Void を触ってみた"));
        assert!(b.contains("### ページ 1: https://ashunar0.dev/posts/try-void\nタイトル: Void"));
        assert_eq!(b.matches('ゑ').count(), PAGE_TEXT_MAX_CHARS, "a page's text is cut");
        assert!(b.contains("### ページ 2: 読めませんでした（timeout）"));
        assert!(!b.contains("ポッドキャスト"), "no podcast asked for");
    }

    #[test]
    fn briefs_a_session_on_a_page_that_plays_its_podcast() {
        let r = post("Void を触ってみた");
        let podcast = Podcast { file: "/data/digests/picked-3.mp3".into(), chapters: vec![(0.0, "Void を触ってみた".into()), (213.9, "pstack".into())] };
        let b = brief("読みものの日報 2026-10-19（選んだ 2 件）", &[Item { reading: &r, pages: vec![] }], Some(&podcast));
        assert!(b.contains("「読みものの日報 2026-10-19（選んだ 2 件）」"));
        assert!(b.contains("/data/digests/picked-3.mp3") && b.contains("podcast.mp3"), "the recording, published beside the page");
        assert!(b.contains("0:00 Void を触ってみた") && b.contains("3:33 pstack"), "where each reading starts");
    }

    #[test]
    fn says_times_and_dates_as_people_do() {
        assert_eq!((clock(0.0), clock(59.9), clock(213.9), clock(975.8)), ("0:00".into(), "0:59".into(), "3:33".into(), "16:15".into()));
        assert_eq!(spoken_date("2026-10-09"), "2026年10月9日");
    }

    #[test]
    fn asks_for_a_news_like_script_a_segment_per_reading() {
        let r = post("Void を触ってみた");
        let p = script_prompt("2026年10月19日", &[Item { reading: &r, pages: vec![] }]);
        assert!(p.contains("皆さんこんにちは、2026年10月19日の日報です。") && p.contains("1つ目の記事です。") && p.contains("以上、2026年10月19日の日報でした。"));
        assert!(p.contains("## 1 件目（X の投稿）\nURL: https://x.com/ashunar0/status/1"), "the readings, as the brief has them");
        assert_eq!(script_schema()["properties"]["segments"]["type"], "array");
    }

    #[test]
    fn takes_the_script_s_segments_in_order() {
        let answer = serde_json::json!({"segments": [{"title": "Void", "text": "1つ目の記事です。"}, {"title": "pstack", "text": "2つ目の記事です。"}]});
        let segments = segments_of(&answer).unwrap();
        assert_eq!(segments, [Segment { title: "Void".into(), text: "1つ目の記事です。".into() }, Segment { title: "pstack".into(), text: "2つ目の記事です。".into() }]);
        assert!(segments_of(&serde_json::json!({"segments": []})).is_err(), "nothing to read");
        assert!(segments_of(&serde_json::json!({"segments": [{"title": "Void", "text": " "}]})).is_err(), "a blank segment");
    }

    #[test]
    fn the_session_gets_its_prompt_before_the_options_taking_many_values() {
        let c = session_command("sess-1", "/data/digests", "/data/digests/2026-10-18.md");
        let prompt = c.find("/data/digests/2026-10-18.md を読んで").unwrap();
        assert!(prompt < c.find("--add-dir").unwrap() && prompt < c.find("--allowedTools").unwrap(), "a prompt after --allowedTools is taken for a tool, and the session waits");
        assert!(c.starts_with("claude ") && c.contains("--session-id sess-1"));
    }

    #[test]
    fn the_session_is_pointed_at_its_brief() {
        assert!(first_prompt("/tmp/digests/2026-10-18.md").contains("/tmp/digests/2026-10-18.md"));
    }
}
