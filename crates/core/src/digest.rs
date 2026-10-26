//! A day's readings summed up (its 日報) in an HTML artifact (in claude.ai):
//! what was kept that day (articles, posts on X, books) and the pages they
//! are or link to, read in full, are written into a brief for a Claude Code
//! session, which sums them up as closely as it can, theme by theme, with
//! pictures, and publishes the page (the Artifact tool is a session's alone).
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

/// The session's brief: what to make, then the day's readings and their pages.
pub fn brief(day: &str, items: &[Item]) -> String {
    let mut out = format!(
        "# 読みものの日報 {day}\n\
         \n\
         {day} に保存した読みもの {n} 件（記事、X の投稿、本）と、そのページ（記事そのもの、投稿のリンク先）の本文を下に渡します。\n\
         これを読んで、HTML のアーティファクトを 1 つ作り、Artifact ツールで公開してください（書く前に artifact-design スキルを読む）。\n\
         \n\
         - タイトルは「読みものの日報 {day}」。\n\
         - 一番上に、その日に保存したもの全体の要点（3〜5 行）と、テーマ（タグ）ごとの件数が一目で分かる小さなグラフ。\n\
         - テーマごとのまとまりに分けて、1 件ずつカードにする。カードには種類（記事・X の投稿・本）の印、タイトル（投稿なら投稿者）、元の URL へのリンク、要約。\n\
         - 要約はできるだけ詳しく（背景、主張、具体的な手順・コード・数字、結論。大事な点を落とさない）。投稿はリンク先のページも同じように。\
         本は説明と目次から、何についての本か。手順や仕組み、比べている内容は、図（流れ図・比較表・関係図）にできるところは図にする。\
         得られることや、仕事にどう活かせるかも一言添える。\n\
         - 本文を読めなかったページは、読めなかったと書く。中身を推測で書かない。\n\
         - 中身の薄いもの（日常の話など）は、最後の「軽いもの」に短くまとめる。\n\
         - 日本語で書く。\n\
         - 公開したら終わり。ほかのことはしない。\n",
        n = items.len(),
    );
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
        let b = brief("2026-10-18", &[Item { reading: &r, pages: vec![Ok(page), Err("timeout".into())] }, Item { reading: &book, pages: vec![] }]);
        assert!(b.contains("「読みものの日報 2026-10-18」") && b.contains("HTML のアーティファクト") && b.contains("artifact-design"));
        assert!(b.contains("## 2 件目（本）") && b.contains("目次:\nReplication"));
        assert!(b.contains("## 1 件目（X の投稿）\nURL: https://x.com/ashunar0/status/1") && b.contains("タグ: AI/LLM") && b.contains("Void を触ってみた"));
        assert!(b.contains("### ページ 1: https://ashunar0.dev/posts/try-void\nタイトル: Void"));
        assert_eq!(b.matches('ゑ').count(), PAGE_TEXT_MAX_CHARS, "a page's text is cut");
        assert!(b.contains("### ページ 2: 読めませんでした（timeout）"));
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
