//! Slack through the user's own Slack app and user token (#17's decision E):
//! the mentions of the user and of their user groups, outside DMs and group
//! DMs (#27), and the threads they are in (#28). They come as they are
//! posted through Socket Mode (the app's own token), and a search catches
//! what came while the app was closed.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const API: &str = "https://slack.com/api";
const TIMEOUT: Duration = Duration::from_secs(20);
/// Matches asked of a search: the newest, enough between two checks.
pub const SEARCH_COUNT: &str = "20";

/// Who the token is: the user, and their workspace's address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Me {
    pub user_id: String,
    pub team_url: String,
}

/// A user group the user is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub id: String,
    pub handle: String,
}

/// A message a search found, in a channel (never a DM).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub channel: String,
    pub channel_name: String,
    pub ts: String,
    /// The thread it replies in; None for a message in the channel itself.
    pub thread_ts: Option<String>,
    pub user: String,
    pub user_name: String,
    /// As Slack writes it (`plain` makes it readable).
    pub text: String,
    pub permalink: String,
}

/// A message of a thread, its head first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Message {
    /// Empty for a bot's.
    pub user: String,
    /// The name it came with (a bot's); a user's is looked up.
    pub user_name: Option<String>,
    pub text: String,
    pub ts: String,
}

/// Slack's answer to a call, or why it failed (Slack answers 200 with
/// `ok: false`).
fn answer(v: Value) -> Result<Value, String> {
    if v["ok"].as_bool() == Some(true) {
        return Ok(v);
    }
    let error = v["error"].as_str().unwrap_or("unknown_error");
    Err(match v["needed"].as_str() {
        Some(scope) => format!("Slack: {error}（{scope} が要ります）"),
        None => format!("Slack: {error}"),
    })
}

/// Calls Web API `method` with the user's token.
fn call(token: &str, method: &str, args: &[(&str, &str)]) -> Result<Value, String> {
    let mut req = ureq::get(format!("{API}/{method}")).header("Authorization", format!("Bearer {token}")).config().timeout_global(Some(TIMEOUT)).build();
    for (k, v) in args {
        req = req.query(*k, *v);
    }
    let v: Value = req.call().map_err(|e| format!("Slack {method}: {e}"))?.body_mut().read_json().map_err(|e| format!("Slack {method}: {e}"))?;
    answer(v)
}

pub fn parse_me(v: &Value) -> Result<Me, String> {
    let user_id = v["user_id"].as_str().ok_or("Slack: auth.test にユーザーがありません")?;
    Ok(Me { user_id: user_id.into(), team_url: v["url"].as_str().unwrap_or_default().into() })
}

/// The user groups (not deleted) whose members include `me`.
pub fn my_groups(v: &Value, me: &str) -> Vec<Group> {
    v["usergroups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|g| g["date_delete"].as_i64().unwrap_or(0) == 0)
        .filter(|g| g["users"].as_array().is_some_and(|users| users.iter().any(|u| u.as_str() == Some(me))))
        .filter_map(|g| Some(Group { id: g["id"].as_str()?.into(), handle: g["handle"].as_str().unwrap_or_default().into() }))
        .collect()
}

/// A DM or a group DM, which #27 leaves out.
fn is_dm(channel: &Value) -> bool {
    channel["is_im"].as_bool() == Some(true) || channel["is_mpim"].as_bool() == Some(true) || channel["id"].as_str().is_some_and(|id| id.starts_with('D'))
}

/// The thread a message's permalink says it replies in.
pub fn thread_of(permalink: &str) -> Option<String> {
    let query = permalink.split_once('?')?.1;
    query.split('&').find_map(|kv| kv.strip_prefix("thread_ts=")).map(String::from)
}

/// search.messages' matches, DMs and group DMs left out.
pub fn parse_search(v: &Value) -> Vec<Hit> {
    v["messages"]["matches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| !is_dm(&m["channel"]))
        .filter_map(|m| {
            let permalink = m["permalink"].as_str().unwrap_or_default().to_string();
            Some(Hit {
                channel: m["channel"]["id"].as_str()?.into(),
                channel_name: m["channel"]["name"].as_str().unwrap_or_default().into(),
                ts: m["ts"].as_str()?.into(),
                thread_ts: thread_of(&permalink),
                user: m["user"].as_str().unwrap_or_default().into(),
                user_name: m["username"].as_str().unwrap_or_default().into(),
                text: m["text"].as_str().unwrap_or_default().into(),
                permalink,
            })
        })
        .collect()
}

/// conversations.replies' messages: the thread's head, then its replies.
pub fn parse_replies(v: &Value) -> Vec<Message> {
    v["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            Some(Message {
                user: m["user"].as_str().unwrap_or_default().into(),
                user_name: m["username"].as_str().map(String::from),
                text: m["text"].as_str().unwrap_or_default().into(),
                ts: m["ts"].as_str()?.into(),
            })
        })
        .collect()
}

/// users.info's name for a user: as they show in Slack.
pub fn parse_user_name(v: &Value) -> Option<String> {
    let user = &v["user"];
    [&user["profile"]["display_name"], &user["profile"]["real_name"], &user["real_name"], &user["name"]]
        .into_iter()
        .filter_map(|n| n.as_str())
        .find(|n| !n.is_empty())
        .map(String::from)
}

/// Slack's markup (`<@U1>`, `<#C1|name>`, `<url|label>`, `&lt;`…) as plain
/// text; users by the names `name_of` knows.
pub fn plain(text: &str, name_of: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        let Some(close) = rest[open..].find('>') else { break };
        out.push_str(&rest[..open]);
        let inner = &rest[open + 1..open + close];
        let (target, label) = match inner.split_once('|') {
            Some((t, l)) => (t, Some(l)),
            None => (inner, None),
        };
        let shown = if let Some(user) = target.strip_prefix('@') {
            format!("@{}", name_of(user).or(label.map(String::from)).unwrap_or_else(|| user.into()))
        } else if let Some(group) = target.strip_prefix("!subteam^") {
            label.map(String::from).unwrap_or_else(|| format!("@{group}"))
        } else if let Some(special) = target.strip_prefix('!') {
            format!("@{special}")
        } else if let Some(channel) = target.strip_prefix('#') {
            format!("#{}", label.unwrap_or(channel))
        } else {
            label.unwrap_or(target).into()
        };
        out.push_str(&shown);
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    out.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// The search for mentions of the user.
pub fn mentions_of(user: &str) -> String {
    format!("<@{user}>")
}

/// The search for mentions of a user group.
pub fn mentions_of_group(group: &str) -> String {
    format!("<!subteam^{group}>")
}

/// A Socket Mode message.
#[derive(Debug, PartialEq)]
pub enum Envelope {
    Hello,
    /// Slack is about to close the connection (to refresh it, mostly): connect again.
    Disconnect,
    /// An Events API event, to acknowledge.
    Event { envelope_id: String, event: Value },
    /// Anything else, acknowledged when it has an id.
    Other(Option<String>),
}

pub fn parse_envelope(text: &str) -> Envelope {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Envelope::Other(None) };
    let id = v["envelope_id"].as_str().map(String::from);
    match (v["type"].as_str(), id) {
        (Some("hello"), _) => Envelope::Hello,
        (Some("disconnect"), _) => Envelope::Disconnect,
        (Some("events_api"), Some(envelope_id)) => Envelope::Event { envelope_id, event: v["payload"]["event"].clone() },
        (_, id) => Envelope::Other(id),
    }
}

/// What tells Slack an envelope came.
pub fn ack(envelope_id: &str) -> String {
    serde_json::json!({ "envelope_id": envelope_id }).to_string()
}

/// A message posted in a channel, as an event brings it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Posted {
    pub channel: String,
    /// Empty for a bot's.
    pub user: String,
    /// The name it came with (a bot's).
    pub user_name: Option<String>,
    pub text: String,
    pub ts: String,
    /// The thread it replies in; None for a message in the channel itself.
    pub thread_ts: Option<String>,
}

/// Message subtypes that are someone saying something (the rest are edits,
/// deletions, joins and the like).
const SAID: [&str; 4] = ["bot_message", "thread_broadcast", "file_share", "me_message"];

/// A message posted in a channel (not a DM or group DM), if the event is one.
pub fn parse_posted(event: &Value) -> Option<Posted> {
    if event["type"].as_str() != Some("message") || !matches!(event["channel_type"].as_str(), Some("channel" | "group")) {
        return None;
    }
    if event["subtype"].as_str().is_some_and(|s| !SAID.contains(&s)) {
        return None;
    }
    let ts: String = event["ts"].as_str()?.into();
    Some(Posted {
        channel: event["channel"].as_str()?.into(),
        user: event["user"].as_str().unwrap_or_default().into(),
        user_name: event["username"].as_str().map(String::from),
        text: event["text"].as_str().unwrap_or_default().into(),
        thread_ts: event["thread_ts"].as_str().filter(|t| *t != ts).map(String::from),
        ts,
    })
}

/// Whom a message mentions of those the user follows: Some(None) for the
/// user, Some(Some(handle)) for one of their user groups.
pub fn mention_in(text: &str, me: &str, groups: &[Group]) -> Option<Option<String>> {
    let mentions = |prefix: String| text.match_indices(&prefix).any(|(i, _)| matches!(text[i + prefix.len()..].chars().next(), Some('>' | '|')));
    if mentions(format!("<@{me}")) {
        return Some(None);
    }
    groups.iter().find(|g| mentions(format!("<!subteam^{}", g.id))).map(|g| Some(g.handle.clone()))
}

/// A message's link, as Slack makes them: `ts` without its dot, and the
/// thread for a reply.
pub fn permalink(team_url: &str, channel: &str, ts: &str, thread_ts: Option<&str>) -> String {
    let base = format!("{}/archives/{channel}/p{}", team_url.trim_end_matches('/'), ts.replace('.', ""));
    match thread_ts {
        Some(thread) => format!("{base}?thread_ts={thread}&cid={channel}"),
        None => base,
    }
}

pub fn parse_channel_name(v: &Value) -> Option<String> {
    v["channel"]["name"].as_str().map(String::from)
}

pub fn parse_socket_url(v: &Value) -> Result<String, String> {
    v["url"].as_str().map(String::from).ok_or_else(|| "Slack: apps.connections.open に接続先がありません".into())
}

/// The address of a new Socket Mode connection, for the app's own token
/// (`xapp-…`, with `connections:write`).
pub fn socket_url(app_token: &str) -> Result<String, String> {
    let v: Value = ureq::post(format!("{API}/apps.connections.open"))
        .header("Authorization", format!("Bearer {app_token}"))
        .config()
        .timeout_global(Some(TIMEOUT))
        .build()
        .send_empty()
        .map_err(|e| format!("Slack apps.connections.open: {e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| format!("Slack apps.connections.open: {e}"))?;
    parse_socket_url(&answer(v)?)
}

/// A channel's name (needs `channels:read` / `groups:read`).
pub fn channel_name(token: &str, channel: &str) -> Result<Option<String>, String> {
    Ok(parse_channel_name(&call(token, "conversations.info", &[("channel", channel)])?))
}

pub fn auth_test(token: &str) -> Result<Me, String> {
    parse_me(&call(token, "auth.test", &[])?)
}

pub fn groups(token: &str, me: &str) -> Result<Vec<Group>, String> {
    Ok(my_groups(&call(token, "usergroups.list", &[("include_users", "true")])?, me))
}

/// The newest messages matching `query`, outside DMs.
pub fn search(token: &str, query: &str) -> Result<Vec<Hit>, String> {
    Ok(parse_search(&call(token, "search.messages", &[("query", query), ("count", SEARCH_COUNT), ("sort", "timestamp"), ("sort_dir", "desc")])?))
}

/// A thread's messages, its head first.
pub fn replies(token: &str, channel: &str, thread_ts: &str) -> Result<Vec<Message>, String> {
    Ok(parse_replies(&call(token, "conversations.replies", &[("channel", channel), ("ts", thread_ts)])?))
}

pub fn user_name(token: &str, user: &str) -> Result<Option<String>, String> {
    Ok(parse_user_name(&call(token, "users.info", &[("user", user)])?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Shapes from the method pages on docs.slack.dev (auth.test,
    // usergroups.list, search.messages, conversations.replies, users.info).

    #[test]
    fn the_user_and_their_workspace_come_from_auth_test() {
        let me = parse_me(&json!({"ok": true, "url": "https://acme.slack.com/", "team": "Acme", "user": "mori", "team_id": "T1", "user_id": "U1"})).unwrap();
        assert_eq!(me, Me { user_id: "U1".into(), team_url: "https://acme.slack.com/".into() });
        assert!(parse_me(&json!({"ok": true})).is_err());
    }

    #[test]
    fn only_the_user_groups_the_user_is_in_count() {
        let v = json!({"ok": true, "usergroups": [
            {"id": "S1", "handle": "web-team", "users": ["U2", "U1"]},
            {"id": "S2", "handle": "admins", "users": ["U3"]},
            {"id": "S3", "handle": "old", "users": ["U1"], "date_delete": 1446748865}
        ]});
        assert_eq!(my_groups(&v, "U1"), vec![Group { id: "S1".into(), handle: "web-team".into() }], "not another's, not a deleted one");
    }

    fn hit(channel: Value, permalink: &str) -> Value {
        json!({"channel": channel, "permalink": permalink, "text": "<@U1> 見てもらえますか", "ts": "1508284197.000015", "user": "U2", "username": "suzuki"})
    }

    #[test]
    fn search_matches_become_hits_with_their_thread() {
        let v = json!({"ok": true, "messages": {"matches": [
            hit(json!({"id": "C1", "name": "dev-web", "is_private": false, "is_mpim": false}), "https://acme.slack.com/archives/C1/p1508284197000015?thread_ts=1508284100.000010&cid=C1"),
            hit(json!({"id": "G1", "name": "secret", "is_private": true, "is_mpim": false}), "https://acme.slack.com/archives/G1/p1508284197000015"),
        ]}});
        let hits = parse_search(&v);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].channel, "C1");
        assert_eq!(hits[0].channel_name, "dev-web");
        assert_eq!(hits[0].ts, "1508284197.000015");
        assert_eq!(hits[0].thread_ts.as_deref(), Some("1508284100.000010"), "a reply in a thread");
        assert_eq!(hits[0].user, "U2");
        assert_eq!(hits[0].user_name, "suzuki");
        assert_eq!(hits[1].thread_ts, None, "not in a thread");
        assert_eq!(hits[1].channel_name, "secret");
    }

    #[test]
    fn dms_and_group_dms_are_left_out_of_the_hits() {
        let v = json!({"ok": true, "messages": {"matches": [
            hit(json!({"id": "D1", "name": "U2", "is_im": true}), "https://acme.slack.com/archives/D1/p1"),
            hit(json!({"id": "G2", "name": "mpdm-a--b-1", "is_mpim": true}), "https://acme.slack.com/archives/G2/p1"),
            hit(json!({"id": "D2", "name": "U3"}), "https://acme.slack.com/archives/D2/p1"),
        ]}});
        assert!(parse_search(&v).is_empty());
    }

    #[test]
    fn a_reply_names_its_thread_but_a_thread_head_does_not() {
        assert_eq!(thread_of("https://a.slack.com/archives/C1/p1508284197000015?thread_ts=1508284100.000010&cid=C1").as_deref(), Some("1508284100.000010"));
        assert_eq!(thread_of("https://a.slack.com/archives/C1/p1508284197000015?cid=C1&thread_ts=1508284100.000010").as_deref(), Some("1508284100.000010"));
        assert_eq!(thread_of("https://a.slack.com/archives/C1/p1508284197000015"), None);
    }

    #[test]
    fn a_threads_messages_come_in_order_with_its_head_first() {
        let v = json!({"ok": true, "messages": [
            {"type": "message", "user": "U2", "text": "決済のタイムアウト", "thread_ts": "100.0", "reply_count": 2, "latest_reply": "102.0", "ts": "100.0"},
            {"type": "message", "user": "U1", "text": "見ます", "thread_ts": "100.0", "parent_user_id": "U2", "ts": "101.0"},
            {"type": "message", "bot_id": "B1", "username": "ci", "text": "失敗しました", "thread_ts": "100.0", "ts": "102.0"}
        ]});
        let messages = parse_replies(&v);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0], Message { user: "U2".into(), user_name: None, text: "決済のタイムアウト".into(), ts: "100.0".into() });
        assert_eq!(messages[2].user, "", "a bot has no user");
        assert_eq!(messages[2].user_name.as_deref(), Some("ci"), "but its name");
    }

    #[test]
    fn a_users_name_is_their_display_name_else_their_real_name() {
        let user = |profile: Value| json!({"ok": true, "user": {"id": "U2", "name": "suzuki.t", "real_name": "Suzuki Taro", "profile": profile}});
        assert_eq!(parse_user_name(&user(json!({"display_name": "鈴木", "real_name": "Suzuki Taro"}))).as_deref(), Some("鈴木"));
        assert_eq!(parse_user_name(&user(json!({"display_name": "", "real_name": "Suzuki Taro"}))).as_deref(), Some("Suzuki Taro"));
        assert_eq!(parse_user_name(&json!({"ok": true, "user": {"id": "U2", "name": "suzuki.t"}})).as_deref(), Some("suzuki.t"));
    }

    #[test]
    fn slack_markup_reads_as_plain_text() {
        let names = |id: &str| (id == "U1").then(|| "森".to_string());
        assert_eq!(plain("<@U1> と <@U9> へ", names), "@森 と @U9 へ", "an unknown user stays as their id");
        assert_eq!(plain("<@U9|tanaka> さん", names), "@tanaka さん");
        assert_eq!(plain("<!subteam^S1|@web-team> 日程を", names), "@web-team 日程を");
        assert_eq!(plain("<!subteam^S1> へ", names), "@S1 へ");
        assert_eq!(plain("<!here> <!channel|@channel> <!everyone>", names), "@here @channel @everyone");
        assert_eq!(plain("<#C1|dev-web> で", names), "#dev-web で");
        assert_eq!(plain("<https://github.com/acme/web/pull/57|PR #57> と <https://example.com>", names), "PR #57 と https://example.com");
        assert_eq!(plain("a &lt; b &amp;&amp; c &gt; d", names), "a < b && c > d");
        assert_eq!(plain("閉じない < のまま", names), "閉じない < のまま");
    }

    #[test]
    fn the_queries_name_the_user_and_the_group() {
        assert_eq!(mentions_of("U1"), "<@U1>");
        assert_eq!(mentions_of_group("S1"), "<!subteam^S1>");
    }

    // Socket Mode's messages, as docs.slack.dev's Socket Mode page shows them.

    #[test]
    fn socket_messages_are_told_apart() {
        assert_eq!(parse_envelope(r#"{"type": "hello", "num_connections": 1}"#), Envelope::Hello);
        assert_eq!(parse_envelope(r#"{"type": "disconnect", "reason": "refresh_requested"}"#), Envelope::Disconnect);
        let event = r#"{"envelope_id": "e1", "type": "events_api", "accepts_response_payload": false,
            "payload": {"type": "event_callback", "event": {"type": "message", "channel": "C1", "user": "U2", "text": "hi", "ts": "1.0", "channel_type": "channel"}}}"#;
        match parse_envelope(event) {
            Envelope::Event { envelope_id, event } => {
                assert_eq!(envelope_id, "e1");
                assert_eq!(event["channel"], "C1");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(parse_envelope(r#"{"envelope_id": "e2", "type": "slash_commands", "payload": {}}"#), Envelope::Other(Some("e2".into())), "acknowledged, not used");
        assert_eq!(parse_envelope("not json"), Envelope::Other(None));
    }

    #[test]
    fn an_envelope_is_acknowledged_by_its_id() {
        assert_eq!(serde_json::from_str::<Value>(&ack("e1")).unwrap(), json!({"envelope_id": "e1"}));
    }

    fn posted(fields: Value) -> Value {
        let mut event = json!({"type": "message", "channel": "C1", "user": "U2", "text": "<@U1> 見て", "ts": "1700000000.000200", "channel_type": "channel"});
        event.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
        event
    }

    #[test]
    fn a_message_posted_in_a_channel_is_taken() {
        let p = parse_posted(&posted(json!({"thread_ts": "1700000000.000100"}))).unwrap();
        assert_eq!(p, Posted { channel: "C1".into(), user: "U2".into(), user_name: None, text: "<@U1> 見て".into(), ts: "1700000000.000200".into(), thread_ts: Some("1700000000.000100".into()) });
        assert!(parse_posted(&posted(json!({"channel_type": "group"}))).is_some(), "a private channel");
        assert_eq!(parse_posted(&posted(json!({"thread_ts": "1700000000.000200"}))).unwrap().thread_ts, None, "a thread's head is in the channel");
        let bot = parse_posted(&posted(json!({"subtype": "bot_message", "user": null, "username": "github"}))).unwrap();
        assert_eq!((bot.user.as_str(), bot.user_name.as_deref()), ("", Some("github")), "a bot's message counts");
    }

    #[test]
    fn dms_edits_and_the_rest_are_not_taken() {
        assert!(parse_posted(&posted(json!({"channel_type": "im"}))).is_none());
        assert!(parse_posted(&posted(json!({"channel_type": "mpim"}))).is_none());
        assert!(parse_posted(&posted(json!({"subtype": "message_changed"}))).is_none(), "an edit");
        assert!(parse_posted(&posted(json!({"subtype": "message_deleted"}))).is_none());
        assert!(parse_posted(&posted(json!({"subtype": "channel_join"}))).is_none());
        assert!(parse_posted(&json!({"type": "reaction_added"})).is_none());
    }

    #[test]
    fn a_mention_is_of_the_user_or_of_one_of_their_groups() {
        let groups = vec![Group { id: "S1".into(), handle: "web-team".into() }];
        assert_eq!(mention_in("<@U1> 見て", "U1", &groups), Some(None));
        assert_eq!(mention_in("<@U1|mori> 見て", "U1", &groups), Some(None));
        assert_eq!(mention_in("<!subteam^S1|@web-team> 日程", "U1", &groups), Some(Some("web-team".into())));
        assert_eq!(mention_in("<@U1> と <!subteam^S1>", "U1", &groups), Some(None), "the user's own first");
        assert_eq!(mention_in("<@U12> へ", "U1", &groups), None, "another user whose id starts the same");
        assert_eq!(mention_in("<!subteam^S2> へ", "U1", &groups), None, "a group the user is not in");
        assert_eq!(mention_in("<!here> 全員", "U1", &groups), None);
    }

    #[test]
    fn a_messages_permalink_is_made_from_the_workspace() {
        assert_eq!(permalink("https://acme.slack.com/", "C1", "1700000000.000200", None), "https://acme.slack.com/archives/C1/p1700000000000200");
        assert_eq!(
            permalink("https://acme.slack.com/", "C1", "1700000000.000200", Some("1700000000.000100")),
            "https://acme.slack.com/archives/C1/p1700000000000200?thread_ts=1700000000.000100&cid=C1"
        );
    }

    #[test]
    fn a_channels_name_and_a_sockets_address_are_read() {
        assert_eq!(parse_channel_name(&json!({"ok": true, "channel": {"id": "C1", "name": "dev-web"}})).as_deref(), Some("dev-web"));
        assert_eq!(parse_socket_url(&json!({"ok": true, "url": "wss://wss-primary.slack.com/link/?ticket=x"})).unwrap(), "wss://wss-primary.slack.com/link/?ticket=x");
        assert!(parse_socket_url(&json!({"ok": true})).is_err());
    }

    #[test]
    fn slack_says_why_a_call_failed() {
        assert_eq!(answer(json!({"ok": false, "error": "invalid_auth"})).unwrap_err(), "Slack: invalid_auth");
        assert_eq!(answer(json!({"ok": false, "error": "missing_scope", "needed": "usergroups:read"})).unwrap_err(), "Slack: missing_scope（usergroups:read が要ります）");
        assert!(answer(json!({"ok": true})).is_ok());
    }
}
