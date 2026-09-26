use cts_core::{parse_todo_marker, Db, Error, NewTodo, SessionState, Status, TodoPatch};

fn open() -> (tempfile::TempDir, Db) {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(&dir.path().join("db.sqlite")).unwrap();
    (dir, db)
}

fn new_todo(title: &str) -> NewTodo {
    NewTodo {
        title: title.into(),
        ..Default::default()
    }
}

#[test]
fn create_and_get_todo() {
    let (_d, db) = open();
    let t = db
        .create_todo(NewTodo {
            title: "fix bug".into(),
            issue_url: Some("https://github.com/o/r/issues/1".into()),
            cwd: Some("/tmp/r".into()),
            memo: Some("memo".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(t.status, Status::Todo);
    assert_eq!(db.get_todo(t.id).unwrap(), Some(t));
}

#[test]
fn list_todos_filters_by_status() {
    let (_d, db) = open();
    let a = db.create_todo(new_todo("a")).unwrap();
    db.create_todo(new_todo("b")).unwrap();
    db.update_todo(a.id, TodoPatch { status: Some(Status::Done), ..Default::default() })
        .unwrap();
    assert_eq!(db.list_todos(None).unwrap().len(), 2);
    let done = db.list_todos(Some(Status::Done)).unwrap();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].title, "a");
}

#[test]
fn update_todo_changes_only_given_fields() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("a")).unwrap();
    let u = db
        .update_todo(t.id, TodoPatch { memo: Some("m".into()), ..Default::default() })
        .unwrap();
    assert_eq!(u.title, "a");
    assert_eq!(u.memo.as_deref(), Some("m"));
}

#[test]
fn update_missing_todo_is_error() {
    let (_d, db) = open();
    assert!(matches!(
        db.update_todo(99, TodoPatch::default()),
        Err(Error::TodoNotFound(99))
    ));
}

#[test]
fn record_session_upserts_state() {
    let (_d, db) = open();
    db.record_session("s1", "/w", SessionState::Idle).unwrap();
    db.record_session("s1", "/w", SessionState::Running).unwrap();
    let s = db.get_session("s1").unwrap().unwrap();
    assert_eq!(s.state, SessionState::Running);
    assert_eq!(s.todo_id, None);
    assert_eq!(db.unlinked_sessions().unwrap().len(), 1);
}

#[test]
fn link_session_sets_todo_doing() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("a")).unwrap();
    db.record_session("s1", "/w", SessionState::Idle).unwrap();
    db.link_session("s1", t.id).unwrap();
    assert_eq!(db.get_todo(t.id).unwrap().unwrap().status, Status::Doing);
    assert_eq!(db.sessions_for_todo(t.id).unwrap().len(), 1);
    assert!(db.unlinked_sessions().unwrap().is_empty());

    db.unlink_session("s1").unwrap();
    assert!(db.sessions_for_todo(t.id).unwrap().is_empty());
}

#[test]
fn link_rejects_unknown_session_or_todo() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("a")).unwrap();
    assert!(matches!(db.link_session("nope", t.id), Err(Error::SessionNotFound(_))));
    db.record_session("s1", "/w", SessionState::Idle).unwrap();
    assert!(matches!(db.link_session("s1", 99), Err(Error::TodoNotFound(99))));
}

#[test]
fn delete_todo_unlinks_sessions() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("a")).unwrap();
    db.record_session("s1", "/w", SessionState::Idle).unwrap();
    db.link_session("s1", t.id).unwrap();
    db.delete_todo(t.id).unwrap();
    assert_eq!(db.get_todo(t.id).unwrap(), None);
    assert_eq!(db.get_session("s1").unwrap().unwrap().todo_id, None);
}

#[test]
fn parses_marker() {
    assert_eq!(parse_todo_marker("[todo:12] fix it"), Some(12));
    assert_eq!(parse_todo_marker("please [todo:3]"), Some(3));
    assert_eq!(parse_todo_marker("[todo:] x"), None);
    assert_eq!(parse_todo_marker("[todo:1x]"), None);
    assert_eq!(parse_todo_marker("no marker"), None);
}

#[test]
fn prompt_with_marker_links_unlinked_session() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("a")).unwrap();
    let linked = db.on_prompt("s1", "/w", &format!("[todo:{}] go", t.id)).unwrap();
    assert_eq!(linked, Some(t.id));
    let s = db.get_session("s1").unwrap().unwrap();
    assert_eq!(s.todo_id, Some(t.id));
    assert_eq!(s.state, SessionState::Running);
}

#[test]
fn prompt_marker_does_not_relink_or_fail_on_missing_todo() {
    let (_d, db) = open();
    let a = db.create_todo(new_todo("a")).unwrap();
    let b = db.create_todo(new_todo("b")).unwrap();
    db.on_prompt("s1", "/w", &format!("[todo:{}]", a.id)).unwrap();
    assert_eq!(db.on_prompt("s1", "/w", &format!("[todo:{}]", b.id)).unwrap(), None);
    assert_eq!(db.get_session("s1").unwrap().unwrap().todo_id, Some(a.id));

    assert_eq!(db.on_prompt("s2", "/w", "[todo:999]").unwrap(), None);
    assert_eq!(db.get_session("s2").unwrap().unwrap().state, SessionState::Running);
}

#[test]
fn marker_check_is_remembered() {
    let (_d, db) = open();
    assert!(!db.marker_checked("cse_1").unwrap());
    db.mark_marker_checked("cse_1").unwrap();
    db.mark_marker_checked("cse_1").unwrap();
    assert!(db.marker_checked("cse_1").unwrap());
}

#[test]
fn link_by_marker_links_recorded_session_without_changing_state() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("a")).unwrap();
    db.record_session("cse_1", "https://github.com/o/r", SessionState::Idle).unwrap();
    assert_eq!(db.link_by_marker("cse_1", &format!("[todo:{}] x", t.id)).unwrap(), Some(t.id));
    let s = db.get_session("cse_1").unwrap().unwrap();
    assert_eq!((s.todo_id, s.state), (Some(t.id), SessionState::Idle));
}

#[test]
fn open_adds_title_column_to_old_sessions_table() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, todo_id INTEGER, cwd TEXT NOT NULL,
         state TEXT NOT NULL, state_at INTEGER NOT NULL);
         INSERT INTO sessions VALUES ('s1', NULL, '/w', 'idle', 0);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    assert_eq!(db.get_session("s1").unwrap().unwrap().title, None);
    db.set_session_title("s1", "t").unwrap();
    assert_eq!(db.get_session("s1").unwrap().unwrap().title.as_deref(), Some("t"));
}

#[test]
fn first_prompt_becomes_title_without_marker() {
    let (_d, db) = open();
    db.on_prompt("s1", "/w", "[todo:9]  fix the login bug").unwrap();
    db.on_prompt("s1", "/w", "second prompt").unwrap();
    assert_eq!(db.get_session("s1").unwrap().unwrap().title.as_deref(), Some("fix the login bug"));

    let long = "あ".repeat(200);
    db.on_prompt("s2", "/w", &long).unwrap();
    let t = db.get_session("s2").unwrap().unwrap().title.unwrap();
    assert_eq!(t.chars().count(), cts_core::TITLE_MAX_CHARS);
}

#[test]
fn patch_sets_and_clears_issue_url_and_cwd() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("a")).unwrap();
    let set = TodoPatch { issue_url: Some("https://github.com/o/r/issues/1".into()), cwd: Some("/w".into()), ..Default::default() };
    let u = db.update_todo(t.id, set).unwrap();
    assert_eq!((u.issue_url.as_deref(), u.cwd.as_deref()), (Some("https://github.com/o/r/issues/1"), Some("/w")));
    let clear = TodoPatch { issue_url: Some(String::new()), cwd: Some(String::new()), ..Default::default() };
    let u = db.update_todo(t.id, clear).unwrap();
    assert_eq!((u.issue_url, u.cwd), (None, None));
}

#[test]
fn linked_needs_input_lists_only_linked_waiting_sessions() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("a")).unwrap();
    db.record_session("linked-wait", "/w", SessionState::NeedsInput).unwrap();
    db.link_session("linked-wait", t.id).unwrap();
    db.record_session("linked-run", "/w", SessionState::Running).unwrap();
    db.link_session("linked-run", t.id).unwrap();
    db.record_session("inbox-wait", "/w", SessionState::NeedsInput).unwrap();
    let ids: Vec<String> = db.linked_needs_input().unwrap().into_iter().map(|s| s.session_id).collect();
    assert_eq!(ids, vec!["linked-wait"]);
}

#[test]
fn issue_urls_already_imported() {
    let (_d, db) = open();
    db.create_todo(NewTodo { title: "a".into(), issue_url: Some("https://github.com/o/r/issues/1".into()), ..Default::default() }).unwrap();
    db.create_todo(new_todo("b")).unwrap();
    let urls = db.issue_urls().unwrap();
    assert_eq!(urls, vec!["https://github.com/o/r/issues/1".to_string()]);
}

#[test]
fn title_skips_system_reminder_blocks() {
    let (_d, db) = open();
    let prompt = "<system-reminder>\nThe user started this session without a folder.\n</system-reminder>\n[todo:1] README を直す";
    db.on_prompt("s1", "/w", prompt).unwrap();
    assert_eq!(db.get_session("s1").unwrap().unwrap().title.as_deref(), Some("README を直す"));

    // A prompt that is only injected context leaves the title for a later prompt.
    db.on_prompt("s2", "/w", "<system-reminder>\ncontext only\n</system-reminder>").unwrap();
    assert_eq!(db.get_session("s2").unwrap().unwrap().title, None);
    db.on_prompt("s2", "/w", "real prompt").unwrap();
    assert_eq!(db.get_session("s2").unwrap().unwrap().title.as_deref(), Some("real prompt"));
}

#[test]
fn live_cloud_sessions_excludes_local_and_ended() {
    let (_d, db) = open();
    db.record_session("cse_live", "https://github.com/o/r", SessionState::Idle).unwrap();
    db.record_session("cse_gone", "https://github.com/o/r", SessionState::Ended).unwrap();
    db.record_session("local-uuid", "/w", SessionState::Idle).unwrap();
    let ids: Vec<String> = db.live_cloud_sessions().unwrap().into_iter().map(|s| s.session_id).collect();
    assert_eq!(ids, vec!["cse_live"]);
}

#[test]
fn todos_and_sessions_keep_a_repo_list() {
    let (_d, db) = open();
    let t = db
        .create_todo(NewTodo { title: "a".into(), repos: vec!["o/r".into(), "o/s".into()], ..Default::default() })
        .unwrap();
    assert_eq!(t.repos, vec!["o/r", "o/s"]);
    let u = db.update_todo(t.id, TodoPatch { repos: Some(vec!["o/x".into()]), ..Default::default() }).unwrap();
    assert_eq!(u.repos, vec!["o/x"]);
    let u = db.update_todo(t.id, TodoPatch { repos: Some(vec![]), ..Default::default() }).unwrap();
    assert!(u.repos.is_empty());

    db.record_session("cse_1", "https://github.com/o/r", SessionState::Idle).unwrap();
    assert!(db.get_session("cse_1").unwrap().unwrap().repos.is_empty());
    db.set_session_repos("cse_1", &["o/r".into(), "o/s".into()]).unwrap();
    assert_eq!(db.get_session("cse_1").unwrap().unwrap().repos, vec!["o/r", "o/s"]);
}

#[test]
fn open_adds_repos_columns_to_old_tables() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
         issue_url TEXT, cwd TEXT, memo TEXT, updated_at INTEGER NOT NULL);
         INSERT INTO todos (title, updated_at) VALUES ('old', 0);
         CREATE TABLE sessions (session_id TEXT PRIMARY KEY, todo_id INTEGER, cwd TEXT NOT NULL,
         state TEXT NOT NULL, state_at INTEGER NOT NULL, title TEXT);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    assert!(db.get_todo(1).unwrap().unwrap().repos.is_empty());
}

#[test]
fn live_local_sessions_excludes_cloud_and_ended() {
    let (_d, db) = open();
    db.record_session("local-live", "/w", SessionState::Idle).unwrap();
    db.record_session("local-gone", "/w", SessionState::Ended).unwrap();
    db.record_session("cse_1", "https://github.com/o/r", SessionState::Idle).unwrap();
    let ids: Vec<String> = db.live_local_sessions().unwrap().into_iter().map(|s| s.session_id).collect();
    assert_eq!(ids, vec!["local-live"]);
}

#[test]
fn todo_prompt_is_stored_and_cleared() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("Fix login")).unwrap();
    assert_eq!(t.prompt, None);
    assert_eq!(cts_core::launch::start_prompt(t.id, t.prompt_body()), format!("[todo:{}] Fix login", t.id));
    let u = db.update_todo(t.id, TodoPatch { prompt: Some("まず計画を立てて".into()), ..Default::default() }).unwrap();
    assert_eq!(u.prompt.as_deref(), Some("まず計画を立てて"));
    assert_eq!(u.prompt_body(), "まず計画を立てて");
    let u = db.update_todo(t.id, TodoPatch { prompt: Some("  ".into()), ..Default::default() }).unwrap();
    assert_eq!(u.prompt, None);
}
