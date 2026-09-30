//! What a linked page says about itself, for showing a todo's attachments.
use std::io::Read;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(8);
/// Enough of a page to include its <head>; the rest is not read.
const MAX_BYTES: u64 = 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; todo-sessions)";

#[derive(Debug, Default, PartialEq)]
pub struct Meta {
    pub title: Option<String>,
    pub image: Option<String>,
}

/// Open Graph title and image of the page at `url`.
pub fn fetch(url: &str) -> Result<Meta, String> {
    fetch_within(url, TIMEOUT)
}

/// `fetch`, given up on after `timeout`.
pub fn fetch_within(url: &str, timeout: Duration) -> Result<Meta, String> {
    let config = ureq::Agent::config_builder().timeout_global(Some(timeout)).user_agent(USER_AGENT).build();
    let agent = ureq::Agent::new_with_config(config);
    let mut resp = agent.get(url).header("Accept", "text/html").call().map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    resp.body_mut().as_reader().take(MAX_BYTES).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(parse(&String::from_utf8_lossy(&buf)))
}

/// `og:title` and `og:image` from a page's HTML, with <title> as the
/// fallback title.
pub fn parse(html: &str) -> Meta {
    let mut og_title = None;
    let mut image = None;
    let mut rest = html;
    while let Some(i) = rest.find("<meta") {
        let tag = &rest[i..];
        let end = tag.find('>').unwrap_or(tag.len());
        let tag = &tag[..end];
        let key = attr(tag, "property").or_else(|| attr(tag, "name"));
        match key.as_deref() {
            Some("og:title") if og_title.is_none() => og_title = attr(tag, "content"),
            Some("og:image") | Some("og:image:url") if image.is_none() => image = attr(tag, "content"),
            _ => {}
        }
        rest = &rest[i + end..];
    }
    let title = og_title.or_else(|| title_tag(html)).map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    Meta { title, image: image.filter(|i| !i.is_empty()) }
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
        assert_eq!(parse(html), Meta { title: Some("OG & Title".into()), image: Some("https://x/y.png".into()) });
    }

    #[test]
    fn falls_back_to_the_title_tag() {
        let m = parse("<title> Fallback &amp; more </title><meta name='viewport' content='w'>");
        assert_eq!(m, Meta { title: Some("Fallback & more".into()), image: None });
        assert_eq!(parse("nothing here"), Meta::default());
        assert_eq!(parse("<meta property=\"og:title\" content=\"\">").title, None);
    }
}
