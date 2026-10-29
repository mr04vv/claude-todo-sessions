//! A post's video on X as a file macOS's own player can play: the in-app
//! browser's Chromium is built without H.264, which X's videos (and GIFs) are.
//! X's embed service gives a post's video files without a login.
use std::time::Duration;

use serde_json::Value;

const EMBED_URL: &str = "https://cdn.syndication.twimg.com/tweet-result";
// ponytail: any token is taken for now; react-tweet's ((id / 1e15) * π) in base 36 if X starts checking it.
const EMBED_TOKEN: &str = "a";
/// 720p's: sharp enough for a video in a timeline, and quick to start.
const MAX_BITRATE: u64 = 2_500_000;
const TIMEOUT: Duration = Duration::from_secs(8);

/// The mp4 of post `id`'s video (or GIF), or its quoted post's; None if neither has one.
pub fn mp4_of_post(id: &str) -> Result<Option<String>, String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("not a post id: {id:?}"));
    }
    // Trusted as macOS trusts it, so a proxy that re-signs it (a company's) does not fail it.
    let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    let config = ureq::Agent::config_builder().timeout_global(Some(TIMEOUT)).tls_config(tls).build();
    let post: Value = ureq::Agent::new_with_config(config)
        .get(format!("{EMBED_URL}?id={id}&token={EMBED_TOKEN}"))
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_json()
        .map_err(|e| e.to_string())?;
    Ok(mp4_of(&post))
}

/// The sharpest mp4 of the post's first video or GIF up to `MAX_BITRATE`
/// (else the least sharp), else its quoted post's.
fn mp4_of(post: &Value) -> Option<String> {
    let own = post["mediaDetails"].as_array().into_iter().flatten().find_map(|media| {
        let mp4s: Vec<_> = media["video_info"]["variants"].as_array()?.iter().filter(|v| v["content_type"] == "video/mp4").collect();
        let bitrate = |v: &&&Value| v["bitrate"].as_u64().unwrap_or(0);
        let mp4 = mp4s.iter().filter(|v| bitrate(v) <= MAX_BITRATE).max_by_key(bitrate).or_else(|| mp4s.iter().min_by_key(bitrate))?;
        mp4["url"].as_str().map(String::from)
    });
    own.or_else(|| post.get("quoted_tweet").and_then(mp4_of))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn video(variants: Value) -> Value {
        json!({ "type": "video", "video_info": { "variants": variants } })
    }

    #[test]
    fn the_sharpest_mp4_of_the_post_s_video() {
        let post = json!({ "mediaDetails": [
            { "type": "photo" },
            video(json!([
                { "content_type": "application/x-mpegURL", "url": "https://v/pl.m3u8" },
                { "content_type": "video/mp4", "bitrate": 832000, "url": "https://v/360.mp4" },
                { "content_type": "video/mp4", "bitrate": 2176000, "url": "https://v/720.mp4" },
            ])),
        ]});
        assert_eq!(mp4_of(&post).as_deref(), Some("https://v/720.mp4"));
    }

    #[test]
    fn no_sharper_than_720p_so_it_starts_soon() {
        let post = json!({ "mediaDetails": [video(json!([
            { "content_type": "video/mp4", "bitrate": 832000, "url": "https://v/360.mp4" },
            { "content_type": "video/mp4", "bitrate": 2176000, "url": "https://v/720.mp4" },
            { "content_type": "video/mp4", "bitrate": 10368000, "url": "https://v/1080.mp4" },
        ]))]});
        assert_eq!(mp4_of(&post).as_deref(), Some("https://v/720.mp4"));
        let only_sharp = json!({ "mediaDetails": [video(json!([
            { "content_type": "video/mp4", "bitrate": 10368000, "url": "https://v/1080.mp4" },
            { "content_type": "video/mp4", "bitrate": 5000000, "url": "https://v/900.mp4" },
        ]))]});
        assert_eq!(mp4_of(&only_sharp).as_deref(), Some("https://v/900.mp4"), "else the least sharp");
    }

    #[test]
    fn a_gif_is_an_mp4_too() {
        let post = json!({ "mediaDetails": [{ "type": "animated_gif", "video_info": { "variants": [
            { "content_type": "video/mp4", "bitrate": 0, "url": "https://v/gif.mp4" },
        ]}}]});
        assert_eq!(mp4_of(&post).as_deref(), Some("https://v/gif.mp4"));
    }

    #[test]
    fn the_quoted_post_s_video_when_the_post_has_none() {
        let post = json!({ "mediaDetails": [{ "type": "photo" }], "quoted_tweet": { "mediaDetails": [
            video(json!([{ "content_type": "video/mp4", "bitrate": 1, "url": "https://v/q.mp4" }])),
        ]}});
        assert_eq!(mp4_of(&post).as_deref(), Some("https://v/q.mp4"));
        assert_eq!(mp4_of(&json!({ "text": "no media" })), None);
    }
}
