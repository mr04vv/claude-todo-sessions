//! A day's readings summed up (its 日報) in a Claude Docs document (in
//! claude.ai): what was kept that day (articles, posts on X, books) and the
//! pages they are or link to, read in full, for Claude to sum up as closely
//! as it can, theme by theme.
use crate::ogp::Page;
use crate::{Reading, ReadingKind};

/// The line Claude ends with, naming the document it made.
const DOC_LINE: &str = "DOC_URL:";
/// Enough of a page's text for a close summary.
const PAGE_TEXT_MAX_CHARS: usize = 20_000;

/// A reading kept that day, and its pages as read (an article's own, a post's
/// links'; a book's, behind a login, none), or why one was not.
pub struct Item<'a> {
    pub reading: &'a Reading,
    pub pages: Vec<Result<Page, String>>,
}

/// What a reading is, as the prompt names it.
fn kind_name(kind: ReadingKind) -> &'static str {
    match kind {
        ReadingKind::Article => "記事",
        ReadingKind::Post => "X の投稿",
        ReadingKind::Book => "本",
    }
}

/// What Claude is asked: the day's readings and their pages, to make the document from.
pub fn prompt(day: &str, items: &[Item]) -> String {
    let mut out = format!(
        "{day} に保存した読みもの {n} 件（記事、X の投稿、本）と、そのページ（記事そのもの、投稿のリンク先）の本文を下に渡します。\n\
         これを読んで、Claude Docs のドキュメントを 1 つ新しく作ってください。\n\
         \n\
         - タイトルは「読みものの日報 {day}」。\n\
         - 最初に、その日に保存したもの全体の要点を 3〜5 行で。\n\
         - 読みものをテーマごとに分けて（タグを手がかりに）、テーマの見出しの下に 1 件ずつ節を作る。\n\
         - 節には、種類、タイトル（投稿なら投稿者）、元の URL を書く。ページの本文があれば、その内容をできるだけ詳しく要約する\
         （背景、主張、具体的な手順・コード・数字、結論。大事な点を落とさない）。投稿はリンク先のページも同じように要約する。\
         本は説明と目次から、何についての本かをまとめる。そこから得られることや、仕事にどう活かせるかも一言添える。\n\
         - 本文を読めなかったページは、読めなかったと書く。中身を推測で書かない。\n\
         - 中身の薄いもの（日常の話など）は、最後の「軽いもの」にまとめて短く。\n\
         - 日本語で書く。\n\
         \n\
         作り終えたら、最後に作ったドキュメントの URL を 1 行で「{DOC_LINE} <URL>」と書いてください。\n",
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

/// The document Claude named on its last line (`DOC_URL: <url>`, maybe as a Markdown link).
pub fn doc_url(said: &str) -> Option<String> {
    let line = said.lines().rev().find_map(|l| l.find(DOC_LINE).map(|i| &l[i + DOC_LINE.len()..]))?;
    crate::transcript::ARTIFACT_PAGES.iter().find_map(|page| line.find(page).and_then(|i| crate::transcript::artifact_at(&line[i..])))
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
    fn asks_for_a_document_of_the_day_s_readings_and_their_pages() {
        let r = post("Void を触ってみた");
        let page = Page { url: "https://ashunar0.dev/posts/try-void".into(), title: Some("Void".into()), text: "ゑ".repeat(PAGE_TEXT_MAX_CHARS + 10) };
        let mut book = post("データ指向アプリケーション設計");
        book.kind = ReadingKind::Book;
        book.chapters = vec![crate::Chapter { position: 1, title: "Replication".into(), url: String::new(), read: false }];
        let p = prompt("2026-10-18", &[Item { reading: &r, pages: vec![Ok(page), Err("timeout".into())] }, Item { reading: &book, pages: vec![] }]);
        assert!(p.contains("「読みものの日報 2026-10-18」"));
        assert!(p.contains("## 2 件目（本）") && p.contains("目次:\nReplication"));
        assert!(p.contains("## 1 件目（X の投稿）\nURL: https://x.com/ashunar0/status/1") && p.contains("タグ: AI/LLM") && p.contains("Void を触ってみた"));
        assert!(p.contains("### ページ 1: https://ashunar0.dev/posts/try-void\nタイトル: Void"));
        assert_eq!(p.matches('ゑ').count(), PAGE_TEXT_MAX_CHARS, "a page's text is cut");
        assert!(p.contains("### ページ 2: 読めませんでした（timeout）"));
        assert!(p.contains("DOC_URL: <URL>"));
    }

    #[test]
    fn finds_the_document_on_the_last_line() {
        assert_eq!(doc_url("作りました。\nDOC_URL: https://claude.ai/artifact/abc123").as_deref(), Some("https://claude.ai/artifact/abc123"));
        assert_eq!(doc_url("DOC_URL: [読みものの日報](https://claude.ai/artifact/def456)").as_deref(), Some("https://claude.ai/artifact/def456"));
        assert_eq!(doc_url("作れませんでした"), None);
    }
}
