//! A day's X bookmarks summed up in a Claude Docs document (in claude.ai):
//! the posts kept that day and the pages they link to, read in full, for
//! Claude to sum up as closely as it can, theme by theme.
use crate::ogp::Page;
use crate::Reading;

/// The line Claude ends with, naming the document it made.
const DOC_LINE: &str = "DOC_URL:";
/// Enough of a linked page's text for a close summary.
const PAGE_TEXT_MAX_CHARS: usize = 20_000;

/// A post kept that day, and what its links led to (a page read, or why not).
pub struct Post<'a> {
    pub reading: &'a Reading,
    pub links: Vec<Result<Page, String>>,
}

/// What Claude is asked: the day's posts and their pages, to make the document from.
pub fn prompt(day: &str, posts: &[Post]) -> String {
    let mut out = format!(
        "{day} に X（Twitter）でブックマークした投稿 {n} 件と、投稿のリンク先のページの本文を下に渡します。\n\
         これを読んで、Claude Docs のドキュメントを 1 つ新しく作ってください。\n\
         \n\
         - タイトルは「X のブックマーク {day}」。\n\
         - 最初に、その日のブックマーク全体の要点を 3〜5 行で。\n\
         - 投稿をテーマごとに分けて（タグを手がかりに）、テーマの見出しの下に投稿ごとの節を作る。\n\
         - 投稿ごとの節には、投稿者、投稿の要点、元の投稿の URL を書く。リンク先のページがあれば、そのタイトルと URL を書き、\
         ページの内容をできるだけ詳しく要約する（背景、主張、具体的な手順・コード・数字、結論。大事な点を落とさない）。\
         そこから得られることや、仕事にどう活かせるかも一言添える。\n\
         - 本文を読めなかったリンクは、読めなかったと書く。中身を推測で書かない。\n\
         - 中身の薄い投稿（日常の話など）は、最後の「軽いもの」にまとめて短く。\n\
         - 日本語で書く。\n\
         \n\
         作り終えたら、最後に作ったドキュメントの URL を 1 行で「{DOC_LINE} <URL>」と書いてください。\n",
        n = posts.len(),
    );
    for (i, post) in posts.iter().enumerate() {
        let r = post.reading;
        out.push_str(&format!("\n## 投稿 {}\nURL: {}\n見出し: {}\n", i + 1, r.url, r.title));
        if let Some(tags) = r.tags.as_ref().filter(|t| !t.is_empty()) {
            out.push_str(&format!("タグ: {}\n", tags.join("、")));
        }
        out.push_str(&format!("本文:\n{}\n", r.text.as_deref().unwrap_or("（なし）")));
        for (j, link) in post.links.iter().enumerate() {
            match link {
                Ok(page) => {
                    let text: String = page.text.chars().take(PAGE_TEXT_MAX_CHARS).collect();
                    out.push_str(&format!("\n### リンク {}: {}\nタイトル: {}\n本文:\n{text}\n", j + 1, page.url, page.title.as_deref().unwrap_or("（不明）")));
                }
                Err(why) => out.push_str(&format!("\n### リンク {}: 読めませんでした（{why}）\n", j + 1)),
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
    fn asks_for_a_document_of_the_day_s_posts_and_their_pages() {
        let r = post("Void を触ってみた");
        let page = Page { url: "https://ashunar0.dev/posts/try-void".into(), title: Some("Void".into()), text: "ゑ".repeat(PAGE_TEXT_MAX_CHARS + 10) };
        let p = prompt("2026-10-18", &[Post { reading: &r, links: vec![Ok(page), Err("timeout".into())] }]);
        assert!(p.contains("「X のブックマーク 2026-10-18」"));
        assert!(p.contains("URL: https://x.com/ashunar0/status/1") && p.contains("タグ: AI/LLM") && p.contains("Void を触ってみた"));
        assert!(p.contains("### リンク 1: https://ashunar0.dev/posts/try-void\nタイトル: Void"));
        assert_eq!(p.matches('ゑ').count(), PAGE_TEXT_MAX_CHARS, "a page's text is cut");
        assert!(p.contains("### リンク 2: 読めませんでした（timeout）"));
        assert!(p.contains("DOC_URL: <URL>"));
    }

    #[test]
    fn finds_the_document_on_the_last_line() {
        assert_eq!(doc_url("作りました。\nDOC_URL: https://claude.ai/artifact/abc123").as_deref(), Some("https://claude.ai/artifact/abc123"));
        assert_eq!(doc_url("DOC_URL: [X のブックマーク](https://claude.ai/artifact/def456)").as_deref(), Some("https://claude.ai/artifact/def456"));
        assert_eq!(doc_url("作れませんでした"), None);
    }
}
