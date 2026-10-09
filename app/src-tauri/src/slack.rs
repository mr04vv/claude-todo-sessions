// Slack (#27): the user's token and the app's (for Socket Mode) in the
// Keychain (logins.rs); the mentions of the user and of their user groups
// (cts_core::slack) taken as they are posted through Socket Mode, and a
// search that catches what came while the app was closed (or all of them,
// without the app's token). The user's own are notified. What is read is
// the app's own; Slack's read marks stay as they are.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cts_core::slack::{self, Envelope, Group, Hit, Me};
use cts_core::{Db, NewSlackMessage, SlackMessage};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{err, load_kept, logins, open_db, post_banner, save_kept, show_window, AppState};

/// The tokens' Keychain items: the user's (`xoxp-…`) and the app's (`xapp-…`).
const SERVICE: &str = "todo-sessions-slack";
const ACCOUNT: &str = "token";
const APP_ACCOUNT: &str = "app-token";
/// Between two checks without Socket Mode: each makes a search per user
/// group besides the user's, and search.messages allows about 20 a minute (Tier 2).
const EVERY: Duration = Duration::from_secs(120);
/// Between two checks while Socket Mode brings the messages: only to catch
/// what it missed.
const CATCH_UP: Duration = Duration::from_secs(600);
/// How long a read of the socket waits, so a changed token is noticed.
const SOCKET_READ_TIMEOUT: Duration = Duration::from_secs(15);
/// Waits before connecting again after a failure, doubling up to the last.
const SOCKET_RETRY_FIRST: Duration = Duration::from_secs(5);
const SOCKET_RETRY_MAX: Duration = Duration::from_secs(300);
const WSS_PORT: u16 = 443;
/// The user groups are looked up again every this many checks (an hour).
const GROUPS_EVERY: u32 = 30;
/// Users' names by id, kept across launches.
const NAMES_FILE: &str = "slack-users.json";
/// The messages the board carries, newest first.
const BOARD_MESSAGES: i64 = 100;
/// A notification's text is cut to this many characters.
const BANNER_CHARS: usize = 120;
/// `{channel, ts}` from a notification's click: the Slack page on that message.
const OPEN_SLACK_EVENT: &str = "open-slack";

pub struct Slack {
    connected: AtomicBool,
    /// Socket Mode is connected: the messages come as they are posted.
    live: AtomicBool,
    /// Why the last check failed, for the Slack page.
    error: Mutex<Option<String>>,
    /// Why Socket Mode could not connect.
    socket_error: Mutex<Option<String>>,
    /// Who the token is, once asked.
    me: Mutex<Option<Me>>,
    /// The user's groups, once asked (asked again hourly).
    groups: Mutex<Option<Vec<Group>>>,
    names: Mutex<HashMap<String, String>>,
    /// Channels' names by id, from the searches or asked.
    channels: Mutex<HashMap<String, String>>,
    /// Changed with the tokens: the socket connects again.
    generation: AtomicU64,
    wake: Mutex<Sender<()>>,
}

impl Slack {
    pub fn new(wake: Sender<()>) -> Slack {
        Slack {
            connected: AtomicBool::new(token().is_some()),
            live: AtomicBool::new(false),
            error: Mutex::new(None),
            socket_error: Mutex::new(None),
            me: Mutex::new(None),
            groups: Mutex::new(None),
            names: Mutex::new(load_kept(NAMES_FILE)),
            channels: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
            wake: Mutex::new(wake),
        }
    }

    /// The user's groups, asked of Slack when not known.
    fn groups(&self, token: &str, me: &str) -> Result<Vec<Group>, String> {
        if let Some(groups) = self.groups.lock().map_err(err)?.clone() {
            return Ok(groups);
        }
        let groups = slack::groups(token, me)?;
        *self.groups.lock().map_err(err)? = Some(groups.clone());
        Ok(groups)
    }

    fn remember_channel(&self, channel: &str, name: &str) {
        if let Ok(mut channels) = self.channels.lock() {
            channels.insert(channel.into(), name.into());
        }
    }

    /// A channel's name: known from a search, else asked (its id when it cannot be).
    fn channel_name(&self, token: &str, channel: &str) -> String {
        if let Some(name) = self.channels.lock().ok().and_then(|c| c.get(channel).cloned()) {
            return name;
        }
        match slack::channel_name(token, channel) {
            Ok(Some(name)) => {
                self.remember_channel(channel, &name);
                name
            }
            other => {
                if let Err(e) = other {
                    eprintln!("{e}");
                }
                channel.into()
            }
        }
    }

    fn set_socket_error(&self, error: Option<String>) {
        if let Ok(mut e) = self.socket_error.lock() {
            *e = error;
        }
    }

    /// The tokens changed: the socket connects again.
    fn renew_socket(&self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.set_socket_error(None);
    }

    /// A user's name as Slack shows it, asked once and kept.
    fn name_of(&self, token: &str, user: &str) -> Option<String> {
        if user.is_empty() {
            return None;
        }
        if let Some(name) = self.names.lock().ok()?.get(user) {
            return Some(name.clone());
        }
        let name = slack::user_name(token, user).map_err(|e| eprintln!("{e}")).ok().flatten()?;
        let mut names = self.names.lock().ok()?;
        names.insert(user.into(), name.clone());
        save_kept(NAMES_FILE, &names);
        Some(name)
    }

    fn plain(&self, token: &str, text: &str) -> String {
        slack::plain(text, |user| self.name_of(token, user))
    }

    fn set_error(&self, error: Option<String>) {
        if let Ok(mut e) = self.error.lock() {
            *e = error;
        }
    }

    /// Who the token is, asked of Slack the first time.
    fn me(&self, token: &str) -> Result<Me, String> {
        if let Some(me) = self.me.lock().map_err(err)?.clone() {
            return Ok(me);
        }
        let me = slack::auth_test(token)?;
        *self.me.lock().map_err(err)? = Some(me.clone());
        Ok(me)
    }

    /// Starts over: who the token is (and their groups) asked again, the
    /// socket connected again, and the loop checks now.
    fn restart(&self) {
        if let Ok(mut me) = self.me.lock() {
            *me = None;
        }
        if let Ok(mut groups) = self.groups.lock() {
            *groups = None;
        }
        self.renew_socket();
        if let Ok(wake) = self.wake.lock() {
            let _ = wake.send(());
        }
    }
}

fn token() -> Option<String> {
    logins::load_secret(SERVICE, ACCOUNT).filter(|t| !t.is_empty())
}

fn app_token() -> Option<String> {
    logins::load_secret(SERVICE, APP_ACCOUNT).filter(|t| !t.is_empty())
}

fn token_or_err() -> Result<String, String> {
    token().ok_or_else(|| "Slack とつながっていません".into())
}

/// Slack on the board.
#[derive(Serialize)]
pub struct SlackView {
    connected: bool,
    /// Socket Mode brings the messages as they are posted.
    live: bool,
    error: Option<String>,
    messages: Vec<SlackMessage>,
}

pub fn view(slack: &Slack, db: &Db) -> Result<SlackView, String> {
    let error = slack.error.lock().map_err(err)?.clone();
    let socket_error = slack.socket_error.lock().map_err(err)?.clone().map(|e| format!("リアルタイム（Socket Mode）：{e}"));
    Ok(SlackView {
        connected: slack.connected.load(Ordering::Relaxed),
        live: slack.live.load(Ordering::Relaxed),
        error: error.or(socket_error),
        messages: db.slack_messages(BOARD_MESSAGES).map_err(err)?,
    })
}

/// Who the token is, for the settings.
#[derive(Serialize)]
pub struct SlackAccount {
    team_url: String,
    user_id: String,
    /// The app's token is kept (Socket Mode).
    realtime: bool,
}

/// Keeps the user's token once Slack takes it, and checks at once. Starts
/// over: what was kept from another token is forgotten, and the first check
/// only records what is there.
#[tauri::command(async)]
pub fn slack_connect(state: State<AppState>, slack: State<Slack>, token: String) -> Result<SlackAccount, String> {
    let token = token.trim();
    if !token.starts_with("xoxp-") {
        return Err("ユーザートークン（xoxp- で始まるもの）を入れてください".into());
    }
    let me = slack::auth_test(token)?;
    logins::save_secret(SERVICE, ACCOUNT, token)?;
    state.db.lock().map_err(err)?.clear_slack().map_err(err)?;
    slack.connected.store(true, Ordering::Relaxed);
    slack.set_error(None);
    slack.restart();
    Ok(SlackAccount { team_url: me.team_url, user_id: me.user_id, realtime: app_token().is_some() })
}

/// Who the kept token is; None without one.
#[tauri::command(async)]
pub fn slack_account(slack: State<Slack>) -> Result<Option<SlackAccount>, String> {
    let Some(token) = token() else { return Ok(None) };
    let me = slack.me(&token)?;
    Ok(Some(SlackAccount { team_url: me.team_url, user_id: me.user_id, realtime: app_token().is_some() }))
}

/// Keeps the app's token (`xapp-…` with `connections:write`) once Slack
/// opens a socket with it: the messages then come as they are posted.
#[tauri::command(async)]
pub fn slack_set_app_token(slack: State<Slack>, token: String) -> Result<(), String> {
    let token = token.trim();
    if !token.starts_with("xapp-") {
        return Err("アプリのトークン（xapp- で始まるもの）を入れてください".into());
    }
    slack::socket_url(token)?;
    logins::save_secret(SERVICE, APP_ACCOUNT, token)?;
    slack.renew_socket();
    Ok(())
}

/// Takes the app's token out: back to checking every EVERY.
#[tauri::command(async)]
pub fn slack_forget_app_token(slack: State<Slack>) -> Result<(), String> {
    logins::delete_secret(SERVICE, APP_ACCOUNT)?;
    slack.renew_socket();
    slack.restart();
    Ok(())
}

/// Lets Slack go: both tokens out of the Keychain, its messages forgotten.
#[tauri::command(async)]
pub fn slack_disconnect(state: State<AppState>, slack: State<Slack>) -> Result<(), String> {
    logins::delete_secret(SERVICE, ACCOUNT)?;
    logins::delete_secret(SERVICE, APP_ACCOUNT)?;
    state.db.lock().map_err(err)?.clear_slack().map_err(err)?;
    slack.connected.store(false, Ordering::Relaxed);
    slack.set_error(None);
    slack.restart();
    Ok(())
}

#[tauri::command(async)]
pub fn slack_read(state: State<AppState>, channel: String, ts: String) -> Result<(), String> {
    state.db.lock().map_err(err)?.mark_slack_read(&channel, &ts).map_err(err)
}

/// A message of a thread, as the page shows it.
#[derive(Serialize)]
pub struct ThreadMessage {
    user_name: String,
    text: String,
    ts: String,
    mine: bool,
}

/// The thread `thread_ts` of `channel` (a message not in a thread is its own), its head first.
#[tauri::command(async)]
pub fn slack_thread(slack: State<Slack>, channel: String, thread_ts: String) -> Result<Vec<ThreadMessage>, String> {
    let token = token_or_err()?;
    let me = slack.me(&token)?;
    Ok(slack::replies(&token, &channel, &thread_ts)?
        .into_iter()
        .map(|m| ThreadMessage {
            user_name: slack.name_of(&token, &m.user).or(m.user_name).unwrap_or_else(|| m.user.clone()),
            text: slack.plain(&token, &m.text),
            mine: m.user == me.user_id,
            ts: m.ts,
        })
        .collect())
}

#[derive(Clone, Serialize)]
struct OpenSlack {
    channel: String,
    ts: String,
}

/// A hit as kept: its sender by name and its text made plain.
fn to_message(slack: &Slack, token: &str, hit: Hit, via: Option<&str>) -> NewSlackMessage {
    slack.remember_channel(&hit.channel, &hit.channel_name);
    NewSlackMessage {
        user_name: slack.name_of(token, &hit.user).unwrap_or(hit.user_name),
        text: slack.plain(token, &hit.text),
        channel: hit.channel,
        ts: hit.ts,
        thread_ts: hit.thread_ts,
        channel_name: hit.channel_name,
        permalink: hit.permalink,
        via: via.map(String::from),
    }
}

/// Notifies the user's own mentions just kept (not their groups').
fn notify(app: &AppHandle, kept: Vec<SlackMessage>) {
    for m in kept.into_iter().filter(|m| m.via.is_none()) {
        let text: String = m.text.chars().take(BANNER_CHARS).collect();
        let open = OpenSlack { channel: m.channel, ts: m.ts };
        post_banner(app, "Slack のメンション", format!("#{} {}：{text}", m.channel_name, m.user_name), None, move |app| {
            show_window(app);
            app.emit(OPEN_SLACK_EVENT, open).map_err(err)
        });
    }
}

/// One check: the mentions of the user, then of each of their user groups
/// (the user's own messages left out), kept; the user's new ones notified.
/// Failing to know the groups, the user's mentions are still kept, and the
/// failure said.
fn check(app: &AppHandle, db: &Db, slack: &Slack, token: &str) -> Result<(), String> {
    let me = slack.me(token)?;
    let (groups, trouble) = match slack.groups(token, &me.user_id) {
        Ok(g) => (g, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    let mut found: Vec<NewSlackMessage> = slack::search(token, &slack::mentions_of(&me.user_id))?.into_iter().filter(|h| h.user != me.user_id).map(|h| to_message(slack, token, h, None)).collect();
    for g in &groups {
        found.extend(slack::search(token, &slack::mentions_of_group(&g.id))?.into_iter().filter(|h| h.user != me.user_id).map(|h| to_message(slack, token, h, Some(&g.handle))));
    }
    let quiet = !db.has_slack_messages().map_err(err)?;
    let kept = db.add_slack_messages(&found, quiet).map_err(err)?;
    if !quiet {
        notify(app, kept);
    }
    trouble.map_or(Ok(()), Err)
}

/// Checks Slack while a token is kept: every EVERY, or every CATCH_UP while
/// Socket Mode brings the messages; at once when woken.
pub fn run(app: AppHandle, wake: Receiver<()>) {
    let db = match open_db() {
        Ok(db) => db,
        Err(e) => return eprintln!("slack loop stopped: {e}"),
    };
    let mut tick: u32 = 0;
    loop {
        let slack = app.state::<Slack>();
        if let Some(token) = token() {
            if tick % GROUPS_EVERY == 0 {
                if let Ok(mut groups) = slack.groups.lock() {
                    *groups = None;
                }
            }
            let result = check(&app, &db, &slack, &token);
            if let Err(e) = &result {
                eprintln!("slack: {e}");
            }
            slack.set_error(result.err());
            tick = tick.wrapping_add(1);
        }
        let every = if slack.live.load(Ordering::Relaxed) { CATCH_UP } else { EVERY };
        match wake.recv_timeout(every) {
            Ok(()) => tick = 0,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

type Socket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>;

/// A TLS WebSocket to `url` (`wss://host/…`), checked as ureq checks
/// (the system's verifier), whose reads wait SOCKET_READ_TIMEOUT.
fn connect(url: &str) -> Result<Socket, String> {
    let host = url.strip_prefix("wss://").and_then(|rest| rest.split(['/', '?']).next()).ok_or_else(|| format!("WebSocket の接続先が読めません: {url}"))?;
    let stream = TcpStream::connect((host, WSS_PORT)).map_err(|e| format!("{host}: {e}"))?;
    stream.set_read_timeout(Some(SOCKET_READ_TIMEOUT)).map_err(err)?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = rustls_platform_verifier::Verifier::new(provider.clone()).map_err(err)?;
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(err)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let (socket, _) = tungstenite::client_tls_with_config(url, stream, None, Some(tungstenite::Connector::Rustls(Arc::new(config)))).map_err(|e| format!("WebSocket: {e}"))?;
    Ok(socket)
}

/// A message posted where the user is: kept (and notified) when it
/// mentions them or one of their groups, and is not theirs.
fn on_event(app: &AppHandle, db: &Db, slack: &Slack, token: &str, event: &serde_json::Value) -> Result<(), String> {
    let Some(posted) = slack::parse_posted(event) else { return Ok(()) };
    let me = slack.me(token)?;
    if posted.user == me.user_id {
        return Ok(());
    }
    let groups = slack.groups(token, &me.user_id).unwrap_or_default();
    let Some(via) = slack::mention_in(&posted.text, &me.user_id, &groups) else { return Ok(()) };
    let message = NewSlackMessage {
        channel_name: slack.channel_name(token, &posted.channel),
        user_name: slack.name_of(token, &posted.user).or(posted.user_name).unwrap_or_else(|| posted.user.clone()),
        text: slack.plain(token, &posted.text),
        permalink: slack::permalink(&me.team_url, &posted.channel, &posted.ts, posted.thread_ts.as_deref()),
        channel: posted.channel,
        ts: posted.ts,
        thread_ts: posted.thread_ts,
        via,
    };
    notify(app, db.add_slack_messages(&[message], false).map_err(err)?);
    Ok(())
}

/// One Socket Mode connection, until Slack closes it, it fails, or the
/// tokens change (`generation` moves on).
fn socket_session(app: &AppHandle, slack: &Slack, token: &str, app_token: &str, generation: u64) -> Result<(), String> {
    let db = open_db()?;
    let mut socket = connect(&slack::socket_url(app_token)?)?;
    slack.live.store(true, Ordering::Relaxed);
    slack.set_socket_error(None);
    let result = loop {
        if slack.generation.load(Ordering::Relaxed) != generation {
            let _ = socket.close(None);
            break Ok(());
        }
        let text = match socket.read() {
            Ok(tungstenite::Message::Text(text)) => text,
            Ok(tungstenite::Message::Close(_)) => break Ok(()),
            Ok(_) => continue,
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => continue,
            Err(e) => break Err(format!("WebSocket: {e}")),
        };
        match slack::parse_envelope(text.as_str()) {
            Envelope::Hello => {}
            Envelope::Disconnect => break Ok(()),
            Envelope::Event { envelope_id, event } => {
                if let Err(e) = socket.send(tungstenite::Message::text(slack::ack(&envelope_id))) {
                    break Err(format!("WebSocket: {e}"));
                }
                if let Err(e) = on_event(app, &db, slack, token, &event) {
                    eprintln!("slack event: {e}");
                }
            }
            Envelope::Other(Some(id)) => {
                if let Err(e) = socket.send(tungstenite::Message::text(slack::ack(&id))) {
                    break Err(format!("WebSocket: {e}"));
                }
            }
            Envelope::Other(None) => {}
        }
    };
    slack.live.store(false, Ordering::Relaxed);
    result
}

/// Keeps a Socket Mode connection while both tokens are kept: connected
/// again when Slack closes it or the tokens change, after a growing wait
/// when it fails.
pub fn socket_run(app: AppHandle) {
    let mut retry = SOCKET_RETRY_FIRST;
    loop {
        let slack = app.state::<Slack>();
        let generation = slack.generation.load(Ordering::Relaxed);
        let wait = match (token(), app_token()) {
            (Some(token), Some(app_token)) => match socket_session(&app, &slack, &token, &app_token, generation) {
                Ok(()) => {
                    retry = SOCKET_RETRY_FIRST;
                    Duration::ZERO
                }
                Err(e) => {
                    eprintln!("slack socket: {e}");
                    slack.set_socket_error(Some(e));
                    retry = (retry * 2).min(SOCKET_RETRY_MAX);
                    retry
                }
            },
            // Nothing to connect with: wait for the tokens to change.
            _ => Duration::MAX,
        };
        // Sleeps in steps, so a change of the tokens cuts the wait short.
        let mut waited = Duration::ZERO;
        while waited < wait && slack.generation.load(Ordering::Relaxed) == generation {
            std::thread::sleep(SOCKET_RETRY_FIRST.min(wait - waited));
            waited += SOCKET_RETRY_FIRST;
        }
    }
}
