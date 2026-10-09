// Slack (#27): the user's token in the Keychain (logins.rs), and a loop that
// keeps the mentions of the user and of their user groups (cts_core::slack),
// notifying the user's own. What is read is the app's own; Slack's read
// marks stay as they are.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use cts_core::slack::{self, Group, Hit, Me};
use cts_core::{Db, NewSlackMessage, SlackMessage};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{err, load_kept, logins, open_db, post_banner, save_kept, show_window, AppState};

/// The token's Keychain item.
const SERVICE: &str = "todo-sessions-slack";
const ACCOUNT: &str = "token";
/// Between two checks: each makes a search per user group besides the
/// user's, and search.messages allows about 20 a minute (Tier 2).
const EVERY: Duration = Duration::from_secs(120);
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
    /// Why the last check failed, for the Slack page.
    error: Mutex<Option<String>>,
    /// Who the token is, once asked.
    me: Mutex<Option<Me>>,
    names: Mutex<HashMap<String, String>>,
    wake: Mutex<Sender<()>>,
}

impl Slack {
    pub fn new(wake: Sender<()>) -> Slack {
        Slack { connected: AtomicBool::new(token().is_some()), error: Mutex::new(None), me: Mutex::new(None), names: Mutex::new(load_kept(NAMES_FILE)), wake: Mutex::new(wake) }
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

    /// Starts over: who the token is is asked again, and the loop checks now.
    fn restart(&self) {
        if let Ok(mut me) = self.me.lock() {
            *me = None;
        }
        if let Ok(wake) = self.wake.lock() {
            let _ = wake.send(());
        }
    }
}

fn token() -> Option<String> {
    logins::load_secret(SERVICE, ACCOUNT).filter(|t| !t.is_empty())
}

fn token_or_err() -> Result<String, String> {
    token().ok_or_else(|| "Slack とつながっていません".into())
}

/// Slack on the board.
#[derive(Serialize)]
pub struct SlackView {
    connected: bool,
    error: Option<String>,
    messages: Vec<SlackMessage>,
}

pub fn view(slack: &Slack, db: &Db) -> Result<SlackView, String> {
    Ok(SlackView {
        connected: slack.connected.load(Ordering::Relaxed),
        error: slack.error.lock().map_err(err)?.clone(),
        messages: db.slack_messages(BOARD_MESSAGES).map_err(err)?,
    })
}

/// Who the token is, for the settings.
#[derive(Serialize)]
pub struct SlackAccount {
    team_url: String,
    user_id: String,
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
    Ok(SlackAccount { team_url: me.team_url, user_id: me.user_id })
}

/// Who the kept token is; None without one.
#[tauri::command(async)]
pub fn slack_account(slack: State<Slack>) -> Result<Option<SlackAccount>, String> {
    let Some(token) = token() else { return Ok(None) };
    let me = slack.me(&token)?;
    Ok(Some(SlackAccount { team_url: me.team_url, user_id: me.user_id }))
}

/// Lets Slack go: the token out of the Keychain, its messages forgotten.
#[tauri::command(async)]
pub fn slack_disconnect(state: State<AppState>, slack: State<Slack>) -> Result<(), String> {
    logins::delete_secret(SERVICE, ACCOUNT)?;
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

/// One check: the mentions of the user, then of each of their user groups
/// (the user's own messages left out), kept; the user's new ones notified.
/// The user groups are looked up when `groups` is None; failing that, the
/// user's mentions are still kept, and the failure said.
fn check(app: &AppHandle, db: &Db, slack: &Slack, token: &str, groups: &mut Option<Vec<Group>>) -> Result<(), String> {
    let me = slack.me(token)?;
    let mut trouble = None;
    if groups.is_none() {
        match slack::groups(token, &me.user_id) {
            Ok(g) => *groups = Some(g),
            Err(e) => trouble = Some(e),
        }
    }
    let mut found: Vec<NewSlackMessage> = slack::search(token, &slack::mentions_of(&me.user_id))?.into_iter().filter(|h| h.user != me.user_id).map(|h| to_message(slack, token, h, None)).collect();
    for g in groups.iter().flatten() {
        found.extend(slack::search(token, &slack::mentions_of_group(&g.id))?.into_iter().filter(|h| h.user != me.user_id).map(|h| to_message(slack, token, h, Some(&g.handle))));
    }
    let quiet = !db.has_slack_messages().map_err(err)?;
    let kept = db.add_slack_messages(&found, quiet).map_err(err)?;
    for m in kept.into_iter().filter(|m| !quiet && m.via.is_none()) {
        let text: String = m.text.chars().take(BANNER_CHARS).collect();
        let open = OpenSlack { channel: m.channel, ts: m.ts };
        post_banner(app, "Slack のメンション", format!("#{} {}：{text}", m.channel_name, m.user_name), None, move |app| {
            show_window(app);
            app.emit(OPEN_SLACK_EVENT, open).map_err(err)
        });
    }
    trouble.map_or(Ok(()), Err)
}

/// Checks Slack every EVERY while a token is kept, and at once when woken.
pub fn run(app: AppHandle, wake: Receiver<()>) {
    let db = match open_db() {
        Ok(db) => db,
        Err(e) => return eprintln!("slack loop stopped: {e}"),
    };
    let mut groups: Option<Vec<Group>> = None;
    let mut tick: u32 = 0;
    loop {
        let slack = app.state::<Slack>();
        if let Some(token) = token() {
            if tick % GROUPS_EVERY == 0 {
                groups = None;
            }
            let result = check(&app, &db, &slack, &token, &mut groups);
            if let Err(e) = &result {
                eprintln!("slack: {e}");
            }
            slack.set_error(result.err());
            tick = tick.wrapping_add(1);
        }
        match wake.recv_timeout(EVERY) {
            Ok(()) => {
                groups = None;
                tick = 0;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}
