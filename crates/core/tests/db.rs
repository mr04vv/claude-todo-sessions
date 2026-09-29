use cts_core::{parse_todo_marker, Db, Error, NewTodo, NoticeKind, SessionState, Status, TodoPatch};

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
    assert_eq!(cts_core::launch::start_prompt(t.id, &t.prompt_body()), format!("/grilling Fix login [todo:{}]", t.id));
    let u = db.update_todo(t.id, TodoPatch { prompt: Some("まず計画を立てて".into()), ..Default::default() }).unwrap();
    assert_eq!(u.prompt.as_deref(), Some("まず計画を立てて"));
    assert_eq!(u.prompt_body(), "まず計画を立てて");
    let u = db.update_todo(t.id, TodoPatch { prompt: Some("  ".into()), ..Default::default() }).unwrap();
    assert_eq!(u.prompt, None);
}

#[test]
fn issue_state_change_reports_previous_value() {
    let (_d, db) = open();
    let t = db.create_todo(NewTodo { title: "a".into(), issue_url: Some("https://github.com/o/r/issues/1".into()), ..Default::default() }).unwrap();
    assert_eq!(t.issue_state, None);
    assert_eq!(db.set_issue_state(t.id, "open").unwrap(), None);
    assert_eq!(db.set_issue_state(t.id, "closed").unwrap().as_deref(), Some("open"));
    assert_eq!(db.get_todo(t.id).unwrap().unwrap().issue_state.as_deref(), Some("closed"));
    // Changing the URL forgets the old state.
    let u = db.update_todo(t.id, TodoPatch { issue_url: Some("https://github.com/o/r/issues/2".into()), ..Default::default() }).unwrap();
    assert_eq!(u.issue_state, None);
}

#[test]
fn todo_keeps_one_pr_and_its_state() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("a")).unwrap();
    let u = db.update_todo(t.id, TodoPatch { pr_url: Some("https://github.com/o/r/pull/5".into()), ..Default::default() }).unwrap();
    assert_eq!(u.pr_url.as_deref(), Some("https://github.com/o/r/pull/5"));
    assert_eq!(db.set_pr_state(t.id, "review_requested").unwrap(), None);
    assert_eq!(db.set_pr_state(t.id, "merged").unwrap().as_deref(), Some("review_requested"));
    let u = db.update_todo(t.id, TodoPatch { pr_url: Some(String::new()), ..Default::default() }).unwrap();
    assert_eq!((u.pr_url, u.pr_state), (None, None));
}

#[test]
fn queue_orders_and_records_runner_and_errors() {
    let (_d, db) = open();
    let a = db.create_todo(new_todo("a")).unwrap();
    let b = db.create_todo(new_todo("b")).unwrap();
    db.enqueue(b.id, "local").unwrap();
    db.enqueue(a.id, "cloud").unwrap();
    let q: Vec<(i64, String)> = db.queued().unwrap().into_iter().map(|t| (t.id, t.queue_runner.unwrap())).collect();
    assert_eq!(q, vec![(b.id, "local".into()), (a.id, "cloud".into())]);
    db.move_in_queue(a.id, -1).unwrap();
    assert_eq!(db.queued().unwrap()[0].id, a.id);
    db.set_queue_error(a.id, Some("no repo")).unwrap();
    assert_eq!(db.get_todo(a.id).unwrap().unwrap().queue_error.as_deref(), Some("no repo"));
    db.dequeue(a.id).unwrap();
    let t = db.get_todo(a.id).unwrap().unwrap();
    assert_eq!((t.queue_runner, t.queue_error), (None, None));
    assert_eq!(db.queued().unwrap().len(), 1);
}

#[test]
fn kind_picks_the_default_prompt() {
    let (_d, db) = open();
    let t = db.create_todo(NewTodo { title: "Fix login".into(), memo: Some("see logs".into()), ..Default::default() }).unwrap();
    assert_eq!(t.kind, cts_core::Kind::Implementation);
    assert_eq!(t.prompt_body(), "/grilling Fix login\n\nsee logs");
    let r = db.update_todo(t.id, TodoPatch { kind: Some(cts_core::Kind::Research), ..Default::default() }).unwrap();
    assert_eq!(r.kind, cts_core::Kind::Research);
    let body = r.prompt_body();
    assert!(body.starts_with("調査: Fix login"), "{body}");
    assert!(body.contains("完了条件") && body.contains("出力条件"), "{body}");
    // A custom prompt wins over the kind's default.
    let c = db.update_todo(t.id, TodoPatch { prompt: Some("自由に".into()), ..Default::default() }).unwrap();
    assert_eq!(c.prompt_body(), "自由に");
}

#[test]
fn session_branch_is_stored() {
    let (_d, db) = open();
    db.record_session("cse_1", "https://github.com/o/r", SessionState::Idle).unwrap();
    db.set_session_branch("cse_1", "claude/todo-1-ab").unwrap();
    assert_eq!(db.get_session("cse_1").unwrap().unwrap().branch.as_deref(), Some("claude/todo-1-ab"));
}

#[test]
fn linked_sessions_lists_live_linked_ones() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("a")).unwrap();
    for (id, st) in [("a", SessionState::Running), ("b", SessionState::Ended), ("c", SessionState::Idle)] {
        db.record_session(id, "/w", st).unwrap();
        if id != "c" {
            db.link_session(id, t.id).unwrap();
        }
    }
    let ids: Vec<String> = db.linked_sessions().unwrap().into_iter().map(|s| s.session_id).collect();
    assert_eq!(ids, vec!["a"]);
}

#[test]
fn children_finish_their_parent() {
    let (_d, db) = open();
    let parent = db.create_todo(NewTodo { title: "p".into(), repos: vec!["o/a".into(), "o/b".into()], ..Default::default() }).unwrap();
    assert!(parent.is_orchestrator());
    let a = db.create_todo(NewTodo { title: "a".into(), repos: vec!["o/a".into()], parent_id: Some(parent.id), ..Default::default() }).unwrap();
    let b = db.create_todo(NewTodo { title: "b".into(), repos: vec!["o/b".into()], parent_id: Some(parent.id), ..Default::default() }).unwrap();
    assert_eq!(a.parent_id, Some(parent.id));
    assert_eq!(db.children(parent.id).unwrap().len(), 2);
    db.update_todo(a.id, TodoPatch { status: Some(Status::Done), ..Default::default() }).unwrap();
    assert_ne!(db.get_todo(parent.id).unwrap().unwrap().status, Status::Done);
    db.update_todo(b.id, TodoPatch { status: Some(Status::Done), ..Default::default() }).unwrap();
    assert_eq!(db.get_todo(parent.id).unwrap().unwrap().status, Status::Done);
}

#[test]
fn orchestrator_prompt_plans_child_todos() {
    let (_d, db) = open();
    let p = db.create_todo(NewTodo { title: "横断改修".into(), repos: vec!["o/a".into(), "o/b".into()], ..Default::default() }).unwrap();
    let body = p.prompt_body();
    assert!(body.starts_with("/grilling 横断改修"), "{body}");
    assert!(body.contains(&format!("parent_id={}", p.id)) && body.contains("o/a") && body.contains("o/b"), "{body}");
}

#[test]
fn implementation_prompt_asks_the_pr_to_close_the_issue() {
    let (_d, db) = open();
    let url = "https://github.com/o/r/issues/7";
    let t = db.create_todo(NewTodo { title: "fix".into(), issue_url: Some(url.into()), ..Default::default() }).unwrap();
    assert!(t.prompt_body().contains(&format!("Closes {url}")), "{}", t.prompt_body());
    let c = db.update_todo(t.id, TodoPatch { prompt: Some("自由に".into()), ..Default::default() }).unwrap();
    assert!(c.prompt_body().starts_with("自由に") && c.prompt_body().contains(&format!("Closes {url}")));
    let r = db.update_todo(t.id, TodoPatch { kind: Some(cts_core::Kind::Research), prompt: Some(String::new()), ..Default::default() }).unwrap();
    assert!(!r.prompt_body().contains("Closes"), "{}", r.prompt_body());
}

#[test]
fn migrated_integer_columns_read_back_as_integers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
         issue_url TEXT, cwd TEXT, memo TEXT, updated_at INTEGER NOT NULL);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    let p = db.create_todo(new_todo("p")).unwrap();
    let c = db.create_todo(NewTodo { title: "c".into(), parent_id: Some(p.id), ..Default::default() }).unwrap();
    assert_eq!(c.parent_id, Some(p.id));
    db.enqueue(c.id, "auto").unwrap();
    assert_eq!(db.get_todo(c.id).unwrap().unwrap().queue_pos, Some(1));
}

#[test]
fn links_attach_to_a_todo_and_go_with_it() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("a")).unwrap();
    let l = db.add_link(t.id, "https://example.com/x").unwrap();
    assert_eq!((l.todo_id, l.url.as_str(), l.title.as_deref()), (t.id, "https://example.com/x", None));
    db.set_link_meta(l.id, Some("Example"), Some("https://example.com/og.png")).unwrap();
    let links = db.links_for(t.id).unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!((links[0].title.as_deref(), links[0].image.as_deref()), (Some("Example"), Some("https://example.com/og.png")));
    assert!(matches!(db.add_link(999, "https://example.com"), Err(Error::TodoNotFound(999))));
    db.remove_link(l.id).unwrap();
    assert!(db.links_for(t.id).unwrap().is_empty());
    db.add_link(t.id, "https://example.com/y").unwrap();
    db.delete_todo(t.id).unwrap();
    assert!(db.links_for(t.id).unwrap().is_empty());
}

#[test]
fn sessions_keep_the_time_they_started() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, todo_id INTEGER,
         cwd TEXT NOT NULL, state TEXT NOT NULL, state_at INTEGER NOT NULL);
         INSERT INTO sessions VALUES ('s1', NULL, '/w', 'idle', 5);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    // Sessions from before start times were kept fall back to their last state change.
    assert_eq!(db.get_session("s1").unwrap().unwrap().started_at, 5);
    db.record_session("s1", "/w", SessionState::Running).unwrap();
    let s1 = db.get_session("s1").unwrap().unwrap();
    assert_eq!(s1.started_at, 5);
    assert!(s1.state_at > 5);
    db.record_session("s2", "/w", SessionState::Idle).unwrap();
    let s2 = db.get_session("s2").unwrap().unwrap();
    assert_eq!(s2.started_at, s2.state_at);
}

#[test]
fn review_status_works_on_databases_made_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
         issue_url TEXT, cwd TEXT, memo TEXT, updated_at INTEGER NOT NULL);
         INSERT INTO todos (title, status, updated_at) VALUES ('keep me', 'doing', 5);
         CREATE TABLE sessions (session_id TEXT PRIMARY KEY, todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
         cwd TEXT NOT NULL, state TEXT NOT NULL, state_at INTEGER NOT NULL);
         INSERT INTO sessions VALUES ('s1', 1, '/w', 'idle', 0);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    let t = db.update_todo(1, TodoPatch { status: Some(Status::Review), ..Default::default() }).unwrap();
    assert_eq!((t.title.as_str(), t.status), ("keep me", Status::Review));
    assert_eq!(db.get_session("s1").unwrap().unwrap().todo_id, Some(1));
    assert_eq!(db.list_todos(Some(Status::Review)).unwrap().len(), 1);
}

#[test]
fn set_parent_moves_a_todo_under_another_and_back() {
    let (_d, db) = open();
    let p = db.create_todo(new_todo("p")).unwrap();
    let c = db.create_todo(new_todo("c")).unwrap();
    assert_eq!(db.set_parent(c.id, Some(p.id)).unwrap().parent_id, Some(p.id));
    assert_eq!(db.children(p.id).unwrap().len(), 1);
    assert_eq!(db.set_parent(c.id, None).unwrap().parent_id, None);
    assert!(db.children(p.id).unwrap().is_empty());
}

#[test]
fn set_parent_keeps_one_level() {
    let (_d, db) = open();
    let p = db.create_todo(new_todo("p")).unwrap();
    let c = db.create_todo(NewTodo { title: "c".into(), parent_id: Some(p.id), ..Default::default() }).unwrap();
    let x = db.create_todo(new_todo("x")).unwrap();
    // Under a subtask would make a second level.
    assert!(matches!(db.set_parent(x.id, Some(c.id)), Err(Error::InvalidParent(_))));
    // A todo with subtasks cannot become one.
    assert!(matches!(db.set_parent(p.id, Some(x.id)), Err(Error::InvalidParent(_))));
    assert!(matches!(db.set_parent(x.id, Some(x.id)), Err(Error::InvalidParent(_))));
    assert!(matches!(db.set_parent(x.id, Some(999)), Err(Error::TodoNotFound(999))));
}

#[test]
fn tray_lists_waiting_then_idle_linked_sessions() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("t")).unwrap();
    for (id, state) in [("run", SessionState::Running), ("idle", SessionState::Idle), ("wait", SessionState::NeedsInput), ("gone", SessionState::Ended)] {
        db.record_session(id, "/w", state).unwrap();
        db.link_session(id, t.id).unwrap();
    }
    db.record_session("loose", "/w", SessionState::Idle).unwrap();
    let ids: Vec<String> = db.tray_sessions().unwrap().into_iter().map(|s| s.session_id).collect();
    assert_eq!(ids, ["wait", "idle"]);
}

#[test]
fn notifications_are_listed_newest_first_until_read() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("t")).unwrap();
    db.record_session("s1", "/w", SessionState::Idle).unwrap();
    db.set_session_title("s1", "fix it").unwrap();
    db.link_session("s1", t.id).unwrap();
    let s1 = db.get_session("s1").unwrap().unwrap();
    let a = db.add_notification(&s1, NoticeKind::Finished).unwrap();
    let b = db.add_notification(&s1, NoticeKind::NeedsInput).unwrap();
    let list = db.notifications().unwrap();
    assert_eq!(list.iter().map(|n| n.id).collect::<Vec<_>>(), [b, a]);
    assert_eq!((list[1].kind, list[1].title.as_str(), list[1].todo_id, list[1].read), (NoticeKind::Finished, "fix it", Some(t.id), false));
    db.mark_notification_read(a).unwrap();
    assert!(db.notifications().unwrap().iter().find(|n| n.id == a).unwrap().read);
    db.mark_all_notifications_read().unwrap();
    assert!(db.notifications().unwrap().iter().all(|n| n.read));
}

#[test]
fn notifications_work_on_databases_made_before_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'review', 'done')),
         issue_url TEXT, cwd TEXT, memo TEXT, updated_at INTEGER NOT NULL);
         CREATE TABLE sessions (session_id TEXT PRIMARY KEY, todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
         cwd TEXT NOT NULL, state TEXT NOT NULL, state_at INTEGER NOT NULL);
         INSERT INTO sessions VALUES ('s1', NULL, '/w', 'idle', 0);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    let s1 = db.get_session("s1").unwrap().unwrap();
    db.add_notification(&s1, NoticeKind::Finished).unwrap();
    assert_eq!(db.notifications().unwrap()[0].title, "s1");
}

#[test]
fn todos_can_be_pending() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("wait for review")).unwrap();
    let t = db.update_todo(t.id, TodoPatch { status: Some(Status::Pending), ..Default::default() }).unwrap();
    assert_eq!(t.status, Status::Pending);
    assert_eq!(db.list_todos(Some(Status::Pending)).unwrap().len(), 1);
}

#[test]
fn pending_works_on_databases_made_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'review', 'done')),
         issue_url TEXT, cwd TEXT, memo TEXT, updated_at INTEGER NOT NULL);
         INSERT INTO todos (title, status, updated_at) VALUES ('keep me', 'review', 5);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    let t = db.update_todo(1, TodoPatch { status: Some(Status::Pending), ..Default::default() }).unwrap();
    assert_eq!((t.title.as_str(), t.status), ("keep me", Status::Pending));
}

#[test]
fn sessions_and_links_come_grouped_by_todo() {
    let (_d, db) = open();
    let a = db.create_todo(new_todo("a")).unwrap();
    let b = db.create_todo(new_todo("b")).unwrap();
    for (id, todo) in [("s1", a.id), ("s2", a.id), ("s3", b.id)] {
        db.record_session(id, "/w", SessionState::Idle).unwrap();
        db.link_session(id, todo).unwrap();
    }
    db.record_session("loose", "/w", SessionState::Idle).unwrap();
    db.add_link(a.id, "https://example.com/1").unwrap();
    db.add_link(b.id, "https://example.com/2").unwrap();
    db.add_link(b.id, "https://example.com/3").unwrap();
    let sessions = db.sessions_by_todo().unwrap();
    for t in [&a, &b] {
        assert_eq!(sessions.get(&t.id).cloned().unwrap_or_default(), db.sessions_for_todo(t.id).unwrap());
    }
    assert_eq!(sessions.values().map(Vec::len).sum::<usize>(), 3);
    let links = db.links_by_todo().unwrap();
    for t in [&a, &b] {
        assert_eq!(links.get(&t.id).cloned().unwrap_or_default(), db.links_for(t.id).unwrap());
    }
}
