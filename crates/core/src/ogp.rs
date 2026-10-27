//! What a linked page says about itself, for showing a todo's attachments
//! and a bookmark (and for sorting it into tags), and what it says in full
//! (a post's links, summed up in the day's digest).
use std::io::Read;
use std::time::Duration;

use ureq::ResponseExt;

const TIMEOUT: Duration = Duration::from_secs(8);
/// Enough of a page to include its <head>; the rest is not read.
const MAX_BYTES: u64 = 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; todo-sessions)";

#[derive(Debug, Default, PartialEq)]
pub struct Meta {
    pub title: Option<String>,
    pub image: Option<String>,
    /// What the page says it is about (`og:description`, else `description`).
    pub description: Option<String>,
}

/// Open Graph title and image of the page at `url`.
pub fn fetch(url: &str) -> Result<Meta, String> {
    fetch_within(url, TIMEOUT)
}

/// `fetch`, given up on after `timeout`. Pages are trusted as macOS trusts
/// them (as the browser does), so a proxy that re-signs them (a company's)
/// does not fail them, as the bundled roots would.
pub fn fetch_within(url: &str, timeout: Duration) -> Result<Meta, String> {
    let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    let config = ureq::Agent::config_builder().timeout_global(Some(timeout)).user_agent(USER_AGENT).tls_config(tls).build();
    let agent = ureq::Agent::new_with_config(config);
    let mut resp = agent.get(url).header("Accept", "text/html").call().map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    resp.body_mut().as_reader().take(MAX_BYTES).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(parse(&String::from_utf8_lossy(&buf)))
}

/// A page as read in full: where it ended up (past redirects and X's short
/// links), its title and its text.
#[derive(Debug, PartialEq)]
pub struct Page {
    pub url: String,
    pub title: Option<String>,
    pub text: String,
}

/// Enough of a page for its article.
const PAGE_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// X's short links' host, whose page (to a browser) goes on with a refresh.
const SHORT_LINK_HOST: &str = "t.co";

/// The page at `url` read in full, given up on after `timeout`.
pub fn page(url: &str, timeout: Duration) -> Result<Page, String> {
    let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    let config = ureq::Agent::config_builder().timeout_global(Some(timeout)).user_agent(USER_AGENT).tls_config(tls).build();
    let agent = ureq::Agent::new_with_config(config);
    let get = |url: &str| -> Result<(String, String), String> {
        let mut resp = agent.get(url).header("Accept", "text/html").call().map_err(|e| format!("{url}: {e}"))?;
        let at = resp.get_uri().to_string();
        let mut buf = Vec::new();
        resp.body_mut().as_reader().take(PAGE_MAX_BYTES).read_to_end(&mut buf).map_err(|e| format!("{url}: {e}"))?;
        Ok((at, String::from_utf8_lossy(&buf).into_owned()))
    };
    let (mut at, mut html) = get(url)?;
    if at.split('/').nth(2) == Some(SHORT_LINK_HOST) {
        if let Some(next) = refresh_target(&html) {
            (at, html) = get(&next)?;
        }
    }
    Ok(Page { title: parse(&html).title, text: text_of(&html), url: at })
}

/// Tags that start a line of a page's text.
const BLOCK_TAGS: [&str; 27] = [
    "p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "title", "nav", "section", "article", "header", "footer", "main", "aside", "blockquote", "pre",
    "ul", "ol", "table", "dt", "dd", "figcaption",
];

/// A page's text as it shows: its scripts, styles and comments left out, a
/// line for each block, the spaces of its source as one.
pub fn text_of(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::new();
    let mut at = 0;
    while let Some(i) = lower[at..].find('<').map(|i| at + i) {
        out.push_str(&html[at..i].replace(['\n', '\r', '\t'], " "));
        if lower[i..].starts_with("<!--") {
            at = lower[i..].find("-->").map_or(html.len(), |e| i + e + 3);
            continue;
        }
        let end = lower[i..].find('>').map_or(html.len(), |e| i + e + 1);
        let name: String = lower[i + 1..end].trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        at = end;
        if (name == "script" || name == "style") && !lower[i..].starts_with("</") {
            at = lower[end..].find(&format!("</{name}")).map_or(html.len(), |c| end + c);
        } else if BLOCK_TAGS.contains(&name.as_str()) {
            out.push('\n');
        }
    }
    out.push_str(&html[at..].replace(['\n', '\r', '\t'], " "));
    decode(&out.replace("&nbsp;", " "))
        .split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Where a page's refresh (`<meta http-equiv="refresh" content="0;URL=…">`) goes.
pub fn refresh_target(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<meta").map(|i| from + i) {
        let end = lower[i..].find('>').map_or(html.len(), |e| i + e);
        from = end;
        if !lower[i..end].contains("refresh") {
            continue;
        }
        let content = attr(&html[i..end], "content")?;
        let url = content.to_ascii_lowercase().find("url=").map(|u| &content[u + "url=".len()..])?;
        return Some(url.trim().trim_matches(['\'', '"']).to_string());
    }
    None
}

/// `og:title`, `og:image` and `og:description` from a page's HTML, with
/// <title> and the plain description as the fallbacks.
pub fn parse(html: &str) -> Meta {
    let mut og_title = None;
    let mut image = None;
    let mut og_description = None;
    let mut description = None;
    let mut rest = html;
    while let Some(i) = rest.find("<meta") {
        let tag = &rest[i..];
        let end = tag.find('>').unwrap_or(tag.len());
        let tag = &tag[..end];
        let key = attr(tag, "property").or_else(|| attr(tag, "name"));
        match key.as_deref() {
            Some("og:title") if og_title.is_none() => og_title = attr(tag, "content"),
            Some("og:image") | Some("og:image:url") if image.is_none() => image = attr(tag, "content"),
            Some("og:description") if og_description.is_none() => og_description = attr(tag, "content"),
            Some("description") if description.is_none() => description = attr(tag, "content"),
            _ => {}
        }
        rest = &rest[i + end..];
    }
    let title = og_title.or_else(|| title_tag(html)).map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let description = og_description.or(description).map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    Meta { title, image: image.filter(|i| !i.is_empty()), description }
}

fn title_tag(html: &str) -> Option<String> {
    let start = html.find("<title")?;
    let start = start + html[start..].find('>')? + 1;
    let end = html[start..].find("</title")?;
    Some(decode(&html[start..start + end]))
}

/// Value of the attribute `name` in one tag, whatever the attribute order.
fn attr(tag: &str, name: &str) -> Option<String> {
    let mut rest = tag;
    while let Some(i) = rest.find(name) {
        let preceded_by_space = i > 0 && rest.as_bytes()[i - 1].is_ascii_whitespace();
        let after = rest[i + name.len()..].trim_start();
        if preceded_by_space && after.starts_with('=') {
            let value = after[1..].trim_start();
            let quote = value.chars().next()?;
            if quote == '"' || quote == '\'' {
                let value = &value[1..];
                return value.find(quote).map(|e| decode(&value[..e]));
            }
            return Some(decode(value.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("")));
        }
        rest = &rest[i + name.len()..];
    }
    None
}

/// The few entities that show up in titles.
fn decode(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn og_tags_win_over_the_title_tag() {
        let html = r#"<html><head><title>Fallback</title>
          <meta content="OG &amp; Title" property="og:title">
          <meta property='og:image' content='https://x/y.png'/>
          <meta name="description" content="d"></head></html>"#;
        assert_eq!(parse(html), Meta { title: Some("OG & Title".into()), image: Some("https://x/y.png".into()), description: Some("d".into()) });
    }

    #[test]
    fn og_description_wins_over_the_description() {
        let html = r#"<meta name="description" content="plain"><meta property="og:description" content="OG">"#;
        assert_eq!(parse(html).description.as_deref(), Some("OG"));
    }

    #[test]
    fn a_page_s_text_is_what_it_shows() {
        let html = r#"<html><head><title>T</title><style>p{color:red}</style><script>var x = "<p>no</p>";</script></head>
          <body><nav>Menu</nav><h1>Title &amp; more</h1><p>First
          line.</p><p>Second&nbsp;one.</p><!-- note --></body></html>"#;
        assert_eq!(text_of(html), "T\nMenu\nTitle & more\nFirst line.\nSecond one.");
    }

    #[test]
    fn a_short_link_s_page_says_where_it_goes() {
        let html = r#"<head><noscript><META http-equiv="refresh" content="0;URL=https://example.com/a?b=1&amp;c=2"></noscript></head>"#;
        assert_eq!(refresh_target(html).as_deref(), Some("https://example.com/a?b=1&c=2"));
        assert_eq!(refresh_target("<p>none</p>"), None);
    }

    #[test]
    fn falls_back_to_the_title_tag() {
        let m = parse("<title> Fallback &amp; more </title><meta name='viewport' content='w'>");
        assert_eq!(m, Meta { title: Some("Fallback & more".into()), image: None, description: None });
        assert_eq!(parse("nothing here"), Meta::default());
        assert_eq!(parse("<meta property=\"og:title\" content=\"\">").title, None);
    }
}
