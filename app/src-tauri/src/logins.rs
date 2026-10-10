// Secrets in the Keychain for Shosai alone: the Slack tokens and the logins
// kept for the in-app browser (one per site, the host its account). They go
// in and come out through the Security framework, so each item trusts only
// this app (signed the same way at every build, scripts/bundle-cef.sh) and
// another program reading one is asked about first.
//
// They were kept through /usr/bin/security before, which any program could
// read without asking; `migrate` moves those over once. Until an old one has
// moved, it is still read from where it was.

use std::process::Command;

use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};
use serde::{Deserialize, Serialize};

/// The logins' service, and where /usr/bin/security kept them before.
const SERVICE: &str = "shosai-login";
const OLD_SERVICE: &str = "todo-sessions-login";
const SECURITY: &str = "/usr/bin/security";
/// errSecItemNotFound.
const NOT_FOUND: i32 = -25300;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Login {
    pub user: String,
    pub password: String,
}

/// The secret kept as `service`'s `account`, if any.
pub fn load_secret(service: &str, account: &str) -> Option<String> {
    get_generic_password(service, account).ok().and_then(|bytes| String::from_utf8(bytes).ok())
}

/// Keeps (or replaces) a secret as `service`'s `account`.
pub fn save_secret(service: &str, account: &str, secret: &str) -> Result<(), String> {
    set_generic_password(service, account, secret.as_bytes()).map_err(|e| format!("Keychain に保存できませんでした: {e}"))
}

/// Takes `service`'s `account` out of the Keychain; false when none was kept.
pub fn delete_secret(service: &str, account: &str) -> Result<bool, String> {
    match delete_generic_password(service, account) {
        Ok(()) => Ok(true),
        Err(e) if e.code() == NOT_FOUND => Ok(false),
        Err(e) => Err(format!("Keychain から消せませんでした: {e}")),
    }
}

/// The accounts kept under `service` (their attributes only: no secret is read).
fn accounts(service: &str) -> Vec<String> {
    let found = ItemSearchOptions::new().class(ItemClass::generic_password()).service(service).load_attributes(true).limit(Limit::All).search();
    found.unwrap_or_default().iter().filter_map(|r| r.simplify_dict()?.remove("acct")).collect()
}

/// What `find-generic-password -w` printed: the secret, or its hex when it
/// holds bytes security will not print (UTF-8 beyond ASCII among them).
fn decode_printed(out: &str) -> String {
    let out = out.trim();
    let hex = !out.is_empty() && out.len() % 2 == 0 && out.bytes().all(|b| b.is_ascii_hexdigit());
    let bytes = hex.then(|| (0..out.len()).step_by(2).map(|i| u8::from_str_radix(&out[i..i + 2], 16).ok()).collect::<Option<Vec<u8>>>()).flatten();
    bytes.and_then(|b| String::from_utf8(b).ok()).unwrap_or_else(|| out.to_string())
}

/// A secret /usr/bin/security kept before (not moved yet).
pub fn old_secret(service: &str, account: &str) -> Option<String> {
    let out = Command::new(SECURITY).args(["find-generic-password", "-s", service, "-a", account, "-w"]).output().ok()?;
    out.status.success().then(|| decode_printed(&String::from_utf8_lossy(&out.stdout)))
}

/// Takes out what /usr/bin/security kept; false when it kept nothing.
pub fn old_delete(service: &str, account: &str) -> bool {
    Command::new(SECURITY).args(["delete-generic-password", "-s", service, "-a", account]).output().is_ok_and(|o| o.status.success())
}

/// The accounts /usr/bin/security kept under `service`, from `security
/// dump-keychain` (its items' attributes only: no secret is read, and nothing is asked).
fn old_accounts(service: &str) -> Vec<String> {
    Command::new(SECURITY).arg("dump-keychain").output().map(|out| accounts_in(&String::from_utf8_lossy(&out.stdout), service)).unwrap_or_default()
}

/// The accounts of `service`'s items in a keychain dump.
fn accounts_in(dump: &str, service: &str) -> Vec<String> {
    let attr = |item: &str, name: &str| {
        let key = format!("\"{name}\"<blob>=\"");
        item.lines().find_map(|l| l.trim().strip_prefix(&key).and_then(|v| v.strip_suffix('"')).map(String::from))
    };
    dump.split("keychain: ").filter(|item| attr(item, "svce").as_deref() == Some(service)).filter_map(|item| attr(item, "acct")).collect()
}

/// Moves what /usr/bin/security kept under `old` to `new`, for Shosai alone:
/// each one read back before the old goes; one that fails stays where it
/// was (still read from there). Returns what failed.
pub fn migrate(old: &str, new: &str) -> Vec<String> {
    let mut failed = Vec::new();
    for account in old_accounts(old) {
        let Some(secret) = old_secret(old, &account) else {
            failed.push(format!("{old}/{account}: 読めませんでした"));
            continue;
        };
        if let Err(e) = save_secret(new, &account, &secret) {
            failed.push(format!("{old}/{account}: {e}"));
            continue;
        }
        if load_secret(new, &account).as_deref() != Some(secret.as_str()) {
            failed.push(format!("{old}/{account}: 移した先から読み戻せませんでした"));
            continue;
        }
        if !old_delete(old, &account) {
            failed.push(format!("{old}/{account}: 古いほうを消せませんでした"));
        }
    }
    failed
}

/// Moves the logins kept before (see `migrate`).
pub fn migrate_logins() -> Vec<String> {
    migrate(OLD_SERVICE, SERVICE)
}

/// The login kept for `host`, if any.
pub fn load(host: &str) -> Option<Login> {
    load_secret(SERVICE, host).or_else(|| old_secret(OLD_SERVICE, host)).and_then(|s| serde_json::from_str(&s).ok())
}

/// Keeps (or replaces) the login for `host`.
pub fn save(host: &str, login: &Login) -> Result<(), String> {
    save_secret(SERVICE, host, &serde_json::to_string(login).map_err(|e| e.to_string())?)
}

/// The sites with a login kept.
pub fn sites() -> Vec<String> {
    let mut sites = accounts(SERVICE);
    for site in old_accounts(OLD_SERVICE) {
        if !sites.contains(&site) {
            sites.push(site);
        }
    }
    sites
}

/// Takes the login for `host` out of the Keychain.
pub fn delete(host: &str) -> Result<(), String> {
    let gone = delete_secret(SERVICE, host)? | old_delete(OLD_SERVICE, host);
    gone.then_some(()).ok_or_else(|| "このサイトのログインは保存されていません".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_accounts_of_a_service_in_a_keychain_dump() {
        let dump = r#"keychain: "/Users/me/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="todo-sessions-login"
    "acct"<blob>="github.com"
    "svce"<blob>="todo-sessions-login"
keychain: "/Users/me/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="me@example.com"
    "svce"<blob>="Some Other App"
keychain: "/Users/me/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="localhost:3000"
    "svce"<blob>="todo-sessions-login"
"#;
        assert_eq!(accounts_in(dump, "todo-sessions-login"), vec!["github.com".to_string(), "localhost:3000".to_string()]);
        assert_eq!(accounts_in(dump, "Some Other App"), vec!["me@example.com".to_string()]);
    }

    #[test]
    fn reads_what_security_prints_back() {
        let kept = r#"{"user":"森","password":"p\"w"}"#;
        assert_eq!(decode_printed(&format!("{kept}\n")), kept, "printed as it is");
        let hex: String = kept.bytes().map(|b| format!("{b:02x}")).collect();
        assert_eq!(decode_printed(&hex), kept, "printed as hex, for its bytes beyond ASCII");
        assert_eq!(decode_printed("xoxp-1234-abcd"), "xoxp-1234-abcd", "a token is no hex");
    }
}
