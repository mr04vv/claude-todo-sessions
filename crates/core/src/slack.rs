//! Slack through the user's own Slack app and user token (#17's decision E):
//! the mentions of the user and of their user groups, outside DMs and group
//! DMs (#27), and the threads they are in (#28). They come as they are
//! posted through Socket Mode (the app's own token), and a search catches
//! what came while the app was closed.

use std::sync::LazyLock;
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

/// The client for Slack, checking certificates with the system's verifier
/// (as ogp.rs does): a proxy that inspects TLS (Netskope) signs slack.com
/// with its own root, which only the system trusts.
static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    ureq::Agent::new_with_config(ureq::Agent::config_builder().timeout_global(Some(TIMEOUT)).tls_config(tls).build())
});

/// Calls Web API `method` with the user's token.
fn call(token: &str, method: &str, args: &[(&str, &str)]) -> Result<Value, String> {
    let mut req = AGENT.get(format!("{API}/{method}")).header("Authorization", format!("Bearer {token}"));
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

/// The user groups not deleted, whose members pass `keep`.
fn live_groups(v: &Value, keep: impl Fn(&Value) -> bool) -> Vec<Group> {
    v["usergroups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|g| g["date_delete"].as_i64().unwrap_or(0) == 0 && keep(&g["users"]))
        .filter_map(|g| Some(Group { id: g["id"].as_str()?.into(), handle: g["handle"].as_str().unwrap_or_default().into() }))
        .collect()
}

/// The user groups (not deleted) whose members include `me`.
pub fn my_groups(v: &Value, me: &str) -> Vec<Group> {
    live_groups(v, |users| users.as_array().is_some_and(|users| users.iter().any(|u| u.as_str() == Some(me))))
}

/// Every user group not deleted, to mention.
pub fn parse_groups(v: &Value) -> Vec<Group> {
    live_groups(v, |_| true)
}

/// Someone to mention: their name as Slack shows it, their handle and full name to find them by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Member {
    pub id: String,
    pub name: String,
    pub handle: String,
    pub real_name: Option<String>,
    pub image: Option<String>,
}

/// users.list's people, bots, Slackbot and the deactivated left out.
pub fn parse_members(v: &Value) -> Vec<Member> {
    v["members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["deleted"].as_bool() != Some(true) && m["is_bot"].as_bool() != Some(true) && m["id"].as_str() != Some("USLACKBOT"))
        .filter_map(|m| {
            let person = parse_person(&serde_json::json!({ "user": m }))?;
            Some(Member { id: m["id"].as_str()?.into(), name: person.name, handle: m["name"].as_str().unwrap_or_default().into(), real_name: m["real_name"].as_str().filter(|n| !n.is_empty()).map(String::from), image: person.image })
        })
        .collect()
}

/// A channel the user is in, to post in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub private: bool,
}

/// A page of users.conversations' channels, named.
pub fn parse_channels(v: &Value) -> Vec<Channel> {
    v["channels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| Some(Channel { id: c["id"].as_str()?.into(), name: c["name"].as_str()?.into(), private: c["is_private"].as_bool().unwrap_or(false) }))
        .collect()
}

/// chat.postMessage's ts for the message it posted.
pub fn parse_posted_ts(v: &Value) -> Option<String> {
    v["ts"].as_str().map(String::from)
}

/// The ids of a page of users.conversations.
pub fn parse_conversation_ids(v: &Value) -> Vec<String> {
    v["channels"].as_array().into_iter().flatten().filter_map(|c| c["id"].as_str().map(String::from)).collect()
}

/// The cursor to the next page, if there is one.
pub fn next_cursor(v: &Value) -> Option<String> {
    v["response_metadata"]["next_cursor"].as_str().filter(|c| !c.is_empty()).map(String::from)
}

/// The channels the user muted, from users.prefs.get (a method Slack does
/// not document; its prefs carry `muted_channels` as "C1,C2").
pub fn parse_muted(v: &Value) -> Vec<String> {
    v["prefs"]["muted_channels"].as_str().unwrap_or_default().split(',').filter(|c| !c.is_empty()).map(String::from).collect()
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

/// A user as the app shows them: their name, and their picture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Person {
    pub name: String,
    pub image: Option<String>,
}

/// users.info's user: named as they show in Slack.
pub fn parse_person(v: &Value) -> Option<Person> {
    let user = &v["user"];
    let name = [&user["profile"]["display_name"], &user["profile"]["real_name"], &user["real_name"], &user["name"]].into_iter().filter_map(|n| n.as_str()).find(|n| !n.is_empty())?;
    Some(Person { name: name.into(), image: user["profile"]["image_72"].as_str().map(String::from) })
}

/// The user's groups' mentions (`<!subteam^S1>`) given their handles
/// (`<!subteam^S1|@web-team>`).
pub fn label_groups(text: &str, groups: &[Group]) -> String {
    groups.iter().fold(text.to_string(), |text, g| text.replace(&format!("<!subteam^{}>", g.id), &format!("<!subteam^{}|@{}>", g.id, g.handle)))
}

/// The user mentions (`<@U1>`) given the names `name_of` knows
/// (`<@U1|森>`), so the page can show them without asking.
pub fn label_mentions(text: &str, name_of: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find("<@") {
        let Some(close) = rest[at..].find('>') else { break };
        let inner = &rest[at + 2..at + close];
        out.push_str(&rest[..at]);
        match (inner.contains('|'), name_of(inner)) {
            (false, Some(name)) => out.push_str(&format!("<@{inner}|{name}>")),
            _ => out.push_str(&rest[at..at + close + 1]),
        }
        rest = &rest[at + close + 1..];
    }
    out.push_str(rest);
    out
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
    let v: Value = AGENT
        .post(format!("{API}/apps.connections.open"))
        .header("Authorization", format!("Bearer {app_token}"))
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

/// Pages of `method` (each `limit` long), followed by their cursors.
fn pages(token: &str, method: &str, args: &[(&str, &str)], mut each: impl FnMut(&Value)) -> Result<(), String> {
    let mut cursor = String::new();
    loop {
        let mut all = args.to_vec();
        if !cursor.is_empty() {
            all.push(("cursor", &cursor));
        }
        let v = call(token, method, &all)?;
        each(&v);
        match next_cursor(&v) {
            Some(next) => cursor = next,
            None => return Ok(()),
        }
    }
}

/// The public and private channels the user is in.
pub fn member_channels(token: &str) -> Result<std::collections::HashSet<String>, String> {
    Ok(channels(token)?.into_iter().map(|c| c.id).collect())
}

/// The public and private channels the user is in, named, to post in.
pub fn channels(token: &str) -> Result<Vec<Channel>, String> {
    let mut all = Vec::new();
    pages(token, "users.conversations", &[("types", "public_channel,private_channel"), ("exclude_archived", "true"), ("limit", "1000")], |v| all.extend(parse_channels(v)))?;
    Ok(all)
}

/// The channels the user muted (users.prefs.get, undocumented: it may refuse).
pub fn muted_channels(token: &str) -> Result<Vec<String>, String> {
    Ok(parse_muted(&call(token, "users.prefs.get", &[])?))
}

/// The workspace's people, to mention.
pub fn members(token: &str) -> Result<Vec<Member>, String> {
    let mut all = Vec::new();
    pages(token, "users.list", &[("limit", "200")], |v| all.extend(parse_members(v)))?;
    Ok(all)
}

/// Every user group, to mention.
pub fn all_groups(token: &str) -> Result<Vec<Group>, String> {
    Ok(parse_groups(&call(token, "usergroups.list", &[])?))
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

/// Posts `text` as the user (`chat:write`): in a thread (#30), or in the
/// channel itself. Returns the posted message's ts.
pub fn post_message(token: &str, channel: &str, thread_ts: Option<&str>, text: &str) -> Result<String, String> {
    let mut body = serde_json::json!({ "channel": channel, "text": text });
    if let Some(thread) = thread_ts {
        body["thread_ts"] = serde_json::json!(thread);
    }
    let v: Value = AGENT
        .post(format!("{API}/chat.postMessage"))
        .header("Authorization", format!("Bearer {token}"))
        .send_json(body)
        .map_err(|e| format!("Slack chat.postMessage: {e}"))?
        .body_mut()
        .read_json()
        .map_err(|e| format!("Slack chat.postMessage: {e}"))?;
    parse_posted_ts(&answer(v)?).ok_or_else(|| "Slack chat.postMessage: ts がありません".into())
}

pub fn person(token: &str, user: &str) -> Result<Option<Person>, String> {
    Ok(parse_person(&call(token, "users.info", &[("user", user)])?))
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
        let name = |v: Value| parse_person(&v).map(|p| p.name);
        assert_eq!(name(user(json!({"display_name": "鈴木", "real_name": "Suzuki Taro"}))).as_deref(), Some("鈴木"));
        assert_eq!(name(user(json!({"display_name": "", "real_name": "Suzuki Taro"}))).as_deref(), Some("Suzuki Taro"));
        assert_eq!(name(json!({"ok": true, "user": {"id": "U2", "name": "suzuki.t"}})).as_deref(), Some("suzuki.t"));
    }

    #[test]
    fn a_users_picture_comes_with_their_name() {
        let v = json!({"ok": true, "user": {"id": "U2", "name": "suzuki.t", "profile": {"display_name": "鈴木", "image_48": "https://avatars.slack-edge.com/a_48.png", "image_72": "https://avatars.slack-edge.com/a_72.png"}}});
        assert_eq!(parse_person(&v), Some(Person { name: "鈴木".into(), image: Some("https://avatars.slack-edge.com/a_72.png".into()) }));
        assert_eq!(parse_person(&json!({"ok": true, "user": {"name": "x"}})).unwrap().image, None);
    }

    #[test]
    fn the_channels_the_user_is_in_come_page_by_page() {
        let page = json!({"ok": true, "channels": [{"id": "C1"}, {"id": "G1"}], "response_metadata": {"next_cursor": "dXNlcjpVMEc5V0ZYTlo="}});
        assert_eq!(parse_conversation_ids(&page), vec!["C1".to_string(), "G1".to_string()]);
        assert_eq!(next_cursor(&page).as_deref(), Some("dXNlcjpVMEc5V0ZYTlo="));
        assert_eq!(next_cursor(&json!({"ok": true, "channels": [], "response_metadata": {"next_cursor": ""}})), None, "the last page");
    }

    #[test]
    fn the_channels_to_post_in_come_with_their_names() {
        let page = json!({"ok": true, "channels": [{"id": "C1", "name": "dev-web", "is_private": false}, {"id": "G1", "name": "secret", "is_private": true}, {"id": "C2"}]});
        assert_eq!(
            parse_channels(&page),
            vec![Channel { id: "C1".into(), name: "dev-web".into(), private: false }, Channel { id: "G1".into(), name: "secret".into(), private: true }],
            "one without a name is left out"
        );
    }

    #[test]
    fn a_posted_message_tells_its_ts() {
        assert_eq!(parse_posted_ts(&json!({"ok": true, "channel": "C1", "ts": "1700000000.000100", "message": {}})).as_deref(), Some("1700000000.000100"));
        assert_eq!(parse_posted_ts(&json!({"ok": true})), None);
    }

    #[test]
    fn the_muted_channels_come_from_the_users_prefs() {
        assert_eq!(parse_muted(&json!({"ok": true, "prefs": {"muted_channels": "C1,C2"}})), vec!["C1".to_string(), "C2".to_string()]);
        assert!(parse_muted(&json!({"ok": true, "prefs": {"muted_channels": ""}})).is_empty());
        assert!(parse_muted(&json!({"ok": true, "prefs": {}})).is_empty());
    }

    #[test]
    fn the_people_to_mention_leave_out_bots_and_the_gone() {
        let v = json!({"ok": true, "members": [
            {"id": "U1", "name": "mori", "real_name": "Mori Takuto", "profile": {"display_name": "森", "image_72": "https://a/1.png"}},
            {"id": "U2", "name": "bot", "is_bot": true, "profile": {}},
            {"id": "U3", "name": "gone", "deleted": true, "profile": {}},
            {"id": "USLACKBOT", "name": "slackbot", "profile": {}}
        ]});
        assert_eq!(parse_members(&v), vec![Member { id: "U1".into(), name: "森".into(), handle: "mori".into(), real_name: Some("Mori Takuto".into()), image: Some("https://a/1.png".into()) }]);
    }

    #[test]
    fn every_live_user_group_can_be_mentioned() {
        let v = json!({"ok": true, "usergroups": [
            {"id": "S1", "handle": "soc", "users": []},
            {"id": "S2", "handle": "old", "date_delete": 1446748865}
        ]});
        assert_eq!(parse_groups(&v), vec![Group { id: "S1".into(), handle: "soc".into() }]);
    }

    #[test]
    fn the_users_groups_get_their_handles() {
        let groups = vec![Group { id: "S1".into(), handle: "web-team".into() }];
        assert_eq!(label_groups("<!subteam^S1> と <!subteam^S2> と <!subteam^S1|@web>", &groups), "<!subteam^S1|@web-team> と <!subteam^S2> と <!subteam^S1|@web>");
    }

    #[test]
    fn mentions_get_the_names_they_lack() {
        let names = |id: &str| (id == "U1").then(|| "森".to_string());
        assert_eq!(label_mentions("<@U1> と <@U9> と <@U1|もり>", names), "<@U1|森> と <@U9> と <@U1|もり>", "an unknown user and a labelled one stay");
        assert_eq!(label_mentions("<https://x.example|x> <!here>", names), "<https://x.example|x> <!here>");
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
