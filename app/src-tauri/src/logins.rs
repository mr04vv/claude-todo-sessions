// Logins kept for the in-app browser: one per site (host), in the Keychain
// through /usr/bin/security (as the Claude credentials are; the framework
// itself would ask for access after every rebuild). The secret goes in on
// security's stdin, never in its arguments.

use std::io::Write;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

const SECURITY: &str = "/usr/bin/security";
/// The Keychain items' service; the account is the site's host.
const SERVICE: &str = "todo-sessions-login";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Login {
    pub user: String,
    pub password: String,
}

/// A word for `security -i`, which reads `\"` and `\\` inside double quotes.
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// What `find-generic-password -w` printed: the login as kept, or as hex
/// when it holds bytes security will not print.
fn read_secret(out: &str) -> Option<Login> {
    let out = out.trim();
    serde_json::from_str(out).ok().or_else(|| {
        let bytes = (0..out.len()).step_by(2).map(|i| out.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok())).collect::<Option<Vec<u8>>>()?;
        serde_json::from_slice(&bytes).ok()
    })
}

/// The login kept for `host`, if any.
pub fn load(host: &str) -> Option<Login> {
    let out = Command::new(SECURITY).args(["find-generic-password", "-s", SERVICE, "-a", host, "-w"]).output().ok()?;
    out.status.success().then(|| read_secret(&String::from_utf8_lossy(&out.stdout))).flatten()
}

/// Keeps (or replaces) the login for `host`.
pub fn save(host: &str, login: &Login) -> Result<(), String> {
    let secret = serde_json::to_string(login).map_err(|e| e.to_string())?;
    let mut child = Command::new(SECURITY).arg("-i").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let line = format!("add-generic-password -U -s {} -a {} -w {}\n", quote(SERVICE), quote(host), quote(&secret));
    child.stdin.take().ok_or("security の入力を開けません")?.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let said = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() || said.contains("error") {
        return Err(format!("Keychain に保存できませんでした: {}", said.trim()));
    }
    Ok(())
}

/// The sites with a login kept, from `security dump-keychain` (its items'
/// attributes only: no secret is read, and nothing is asked).
pub fn sites() -> Vec<String> {
    Command::new(SECURITY).arg("dump-keychain").output().map(|out| sites_in(&String::from_utf8_lossy(&out.stdout))).unwrap_or_default()
}

/// The accounts (sites) of SERVICE's items in a keychain dump.
fn sites_in(dump: &str) -> Vec<String> {
    let attr = |item: &str, name: &str| {
        let key = format!("\"{name}\"<blob>=\"");
        item.lines().find_map(|l| l.trim().strip_prefix(&key).and_then(|v| v.strip_suffix('"')).map(String::from))
    };
    dump.split("keychain: ").filter(|item| attr(item, "svce").as_deref() == Some(SERVICE)).filter_map(|item| attr(item, "acct")).collect()
}

/// Takes the login for `host` out of the Keychain.
pub fn delete(host: &str) -> Result<(), String> {
    let out = Command::new(SECURITY).args(["delete-generic-password", "-s", SERVICE, "-a", host]).output().map_err(|e| e.to_string())?;
    out.status.success().then_some(()).ok_or_else(|| "このサイトのログインは保存されていません".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_for_security_interactive_mode() {
        assert_eq!(quote(r#"a"b\c d'e$x"#), r#""a\"b\\c d'e$x""#);
    }

    #[test]
    fn finds_the_sites_kept_in_a_keychain_dump() {
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
        assert_eq!(sites_in(dump), vec!["github.com".to_string(), "localhost:3000".to_string()]);
    }

    #[test]
    fn reads_what_security_prints_back() {
        let kept = Login { user: "me@example.com".into(), password: "p\"w".into() };
        let stored = serde_json::to_string(&kept).unwrap();
        assert_eq!(read_secret(&format!("{stored}\n")), Some(kept.clone()));
        // A value with bytes it will not print comes back as hex.
        let hex: String = stored.bytes().map(|b| format!("{b:02x}")).collect();
        assert_eq!(read_secret(&hex), Some(kept));
        assert_eq!(read_secret("not json"), None);
    }
}
