use cts_core::{parse_todo_marker, Db, Error, InputPatch, NewTodo, NoticeKind, SessionState, Status, Subject, TodoPatch};

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
fn needs_input_sessions_lists_every_waiting_session_linked_or_not() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("a")).unwrap();
    db.record_session("linked-wait", "/w", SessionState::NeedsInput).unwrap();
    db.link_session("linked-wait", t.id).unwrap();
    db.record_session("linked-run", "/w", SessionState::Running).unwrap();
    db.link_session("linked-run", t.id).unwrap();
    db.record_session("inbox-wait", "/w", SessionState::NeedsInput).unwrap();
    // A session put away still comes back when it asks.
    db.record_session("hidden-wait", "/w", SessionState::NeedsInput).unwrap();
    db.hide_session("hidden-wait").unwrap();
    let mut ids: Vec<String> = db.needs_input_sessions().unwrap().into_iter().map(|s| s.session_id).collect();
    ids.sort();
    assert_eq!(ids, vec!["hidden-wait", "inbox-wait", "linked-wait"]);
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
    let start = cts_core::launch::start_prompt(t.id, &t.prompt_body());
    assert!(start.starts_with("/grilling Fix login") && start.ends_with(&format!(" [todo:{}]", t.id)), "{start}");
    let u = db.update_todo(t.id, TodoPatch { prompt: Some("まず計画を立てて".into()), ..Default::default() }).unwrap();
    assert_eq!(u.prompt.as_deref(), Some("まず計画を立てて"));
    assert!(u.prompt_body().starts_with("まず計画を立てて"), "{}", u.prompt_body());
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
    assert!(t.prompt_body().starts_with("/grilling Fix login\n\nsee logs"), "{}", t.prompt_body());
    let r = db.update_todo(t.id, TodoPatch { kind: Some(cts_core::Kind::Research), ..Default::default() }).unwrap();
    assert_eq!(r.kind, cts_core::Kind::Research);
    let body = r.prompt_body();
    assert!(body.starts_with("調査: Fix login"), "{body}");
    assert!(body.contains("完了条件") && body.contains("出力条件"), "{body}");
    // A custom prompt wins over the kind's default.
    let c = db.update_todo(t.id, TodoPatch { prompt: Some("自由に".into()), ..Default::default() }).unwrap();
    assert!(c.prompt_body().starts_with("自由に"), "{}", c.prompt_body());
}

#[test]
fn prompts_ask_through_ask_user_question_and_implementation_asks_whom_to_review() {
    let (_d, db) = open();
    let asks = |body: &str| body.contains("AskUserQuestion");
    let reviewer = |body: &str| body.contains("レビューを誰に頼むか") && body.contains("--add-reviewer");
    let t = db.create_todo(new_todo("fix")).unwrap();
    assert!(asks(&t.prompt_body()) && reviewer(&t.prompt_body()), "{}", t.prompt_body());
    let c = db.update_todo(t.id, TodoPatch { prompt: Some("自由に".into()), ..Default::default() }).unwrap();
    assert!(asks(&c.prompt_body()) && reviewer(&c.prompt_body()), "a custom prompt too: {}", c.prompt_body());
    let r = db.update_todo(t.id, TodoPatch { kind: Some(cts_core::Kind::Research), prompt: Some(String::new()), ..Default::default() }).unwrap();
    assert!(asks(&r.prompt_body()) && !reviewer(&r.prompt_body()), "research makes no PR: {}", r.prompt_body());
    let p = db.create_todo(NewTodo { title: "横断".into(), repos: vec!["o/a".into(), "o/b".into()], ..Default::default() }).unwrap();
    assert!(asks(&p.prompt_body()) && !reviewer(&p.prompt_body()), "an orchestrator makes no PR: {}", p.prompt_body());
}

#[test]
fn inputs_are_kept_apart_from_todos() {
    let (_d, db) = open();
    let todo = db.create_todo(new_todo("fix it")).unwrap();
    let a = db.create_input("Rust の所有権", None).unwrap();
    let b = db.create_input("React の入門", Some("SC から")).unwrap();
    assert_eq!((a.title.as_str(), a.done, a.links.len()), ("Rust の所有権", false, 0));
    assert_eq!(b.memo.as_deref(), Some("SC から"));
    // Not todos: the todos list is the todos' alone.
    assert_eq!(db.list_todos(None).unwrap(), vec![db.get_todo(todo.id).unwrap().unwrap()]);
    let l1 = db.add_input_link(a.id, "https://doc.rust-lang.org/book/ch04-00.html").unwrap();
    db.add_input_link(a.id, "https://doc.rust-lang.org/book/ch04-01.html").unwrap();
    db.set_input_link_meta(l1.id, Some("Understanding Ownership"), None).unwrap();
    let a = db.get_input(a.id).unwrap().unwrap();
    assert_eq!(a.links.iter().map(|l| l.url.as_str()).collect::<Vec<_>>(), ["https://doc.rust-lang.org/book/ch04-00.html", "https://doc.rust-lang.org/book/ch04-01.html"]);
    assert_eq!(a.links[0].title.as_deref(), Some("Understanding Ownership"));
    db.remove_input_link(l1.id).unwrap();
    let a = db.update_input(a.id, InputPatch { title: Some("所有権".into()), done: Some(true), ..Default::default() }).unwrap();
    assert_eq!((a.title.as_str(), a.done, a.links.len()), ("所有権", true, 1));
    // (The latest changed come first: see the migration's test, whose times differ.)
    assert_eq!(db.list_inputs().unwrap().len(), 2);
    db.delete_input(a.id).unwrap();
    assert_eq!(db.list_inputs().unwrap().len(), 1);
    assert!(matches!(db.add_input_link(a.id, "https://x.example/"), Err(Error::InputNotFound(_))));
}

#[test]
fn input_todos_become_inputs_with_their_ids() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'review', 'pending', 'done')),
         issue_url TEXT, cwd TEXT, memo TEXT, updated_at INTEGER NOT NULL, repos TEXT, prompt TEXT, issue_state TEXT,
         pr_url TEXT, pr_state TEXT, queue_runner TEXT, queue_pos INTEGER, queue_error TEXT, kind TEXT,
         parent_id INTEGER REFERENCES todos(id) ON DELETE SET NULL);
         CREATE TABLE links (id INTEGER PRIMARY KEY, todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
         url TEXT NOT NULL, title TEXT, image TEXT, created_at INTEGER NOT NULL);
         INSERT INTO todos (id, title, status, updated_at, kind) VALUES (3, 'fix it', 'doing', 5, 'implementation');
         INSERT INTO todos (id, title, status, memo, updated_at, kind) VALUES (7, 'Rust の所有権', 'todo', 'ch4', 6, 'input');
         INSERT INTO todos (id, title, status, updated_at, kind) VALUES (9, '読んだ', 'done', 7, 'input');
         INSERT INTO links (todo_id, url, title, created_at) VALUES (7, 'https://doc.rust-lang.org/book/ch04-00.html', 'Ownership', 1);
         INSERT INTO links (todo_id, url, created_at) VALUES (3, 'https://example.com/spec', 2);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    assert_eq!(db.list_todos(None).unwrap().iter().map(|t| t.id).collect::<Vec<_>>(), [3]);
    assert_eq!(db.links_for(3).unwrap().len(), 1);
    let inputs = db.list_inputs().unwrap();
    assert_eq!(inputs.iter().map(|i| (i.id, i.title.as_str(), i.done)).collect::<Vec<_>>(), [(9, "読んだ", true), (7, "Rust の所有権", false)]);
    let rust = &inputs[1];
    assert_eq!((rust.memo.as_deref(), rust.updated_at), (Some("ch4"), 6));
    assert_eq!(rust.links.iter().map(|l| (l.url.as_str(), l.title.as_deref())).collect::<Vec<_>>(), [("https://doc.rust-lang.org/book/ch04-00.html", Some("Ownership"))]);
    // Opening again moves nothing twice.
    drop(db);
    assert_eq!(Db::open(&path).unwrap().list_inputs().unwrap().len(), 2);
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
fn backlog_works_on_databases_made_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'review', 'pending', 'done')),
         issue_url TEXT, cwd TEXT, memo TEXT, updated_at INTEGER NOT NULL, repos TEXT, prompt TEXT, issue_state TEXT,
         pr_url TEXT, pr_state TEXT, queue_runner TEXT, queue_pos INTEGER, queue_error TEXT, kind TEXT,
         parent_id INTEGER REFERENCES todos(id) ON DELETE SET NULL);
         INSERT INTO todos (title, status, updated_at, parent_id) VALUES ('plan', 'pending', 5, NULL);
         INSERT INTO todos (title, status, updated_at, parent_id) VALUES ('later', 'todo', 6, 1);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    let t = db.update_todo(2, TodoPatch { status: Some(Status::Backlog), ..Default::default() }).unwrap();
    assert_eq!((t.title.as_str(), t.status, t.parent_id), ("later", Status::Backlog, Some(1)));
    assert_eq!(db.get_todo(1).unwrap().unwrap().status, Status::Pending);
    assert_eq!(db.list_todos(Some(Status::Backlog)).unwrap().len(), 1);
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

#[test]
fn review_requests_are_noticed_once_per_pr() {
    let (_d, db) = open();
    assert!(!db.has_review_notices().unwrap());
    let url = "https://github.com/o/r/pull/1";
    let id = db.add_review_notice(url, "feat: x", false).unwrap();
    assert!(id.is_some());
    assert_eq!(db.add_review_notice(url, "feat: x", false).unwrap(), None);
    assert!(db.has_review_notices().unwrap());
    let n = &db.notifications().unwrap()[0];
    assert_eq!((n.kind, n.url.as_deref(), n.title.as_str(), n.read), (NoticeKind::ReviewRequested, Some(url), "feat: x", false));
    // Ones already waiting when the feature first runs are kept as read.
    db.add_review_notice("https://github.com/o/r/pull/2", "old", true).unwrap();
    assert!(db.notifications().unwrap()[0].read);
}

#[test]
fn review_notices_work_on_databases_made_before_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE notifications (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL,
         todo_id INTEGER, kind TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER);
         INSERT INTO notifications VALUES (1, 's1', NULL, 'finished', 'done', 0, NULL);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    assert_eq!(db.notifications().unwrap()[0].url, None);
    db.add_review_notice("https://github.com/o/r/pull/1", "x", false).unwrap();
    assert_eq!(db.notifications().unwrap().len(), 2);
}

#[test]
fn cloud_sessions_of_done_todos_are_the_ones_to_archive() {
    let (_d, db) = open();
    let done = db.create_todo(new_todo("shipped")).unwrap();
    let open_todo = db.create_todo(new_todo("still going")).unwrap();
    for (id, state, todo) in [
        ("cse_idle", SessionState::Idle, done.id),
        ("cse_wait", SessionState::NeedsInput, done.id),
        ("cse_run", SessionState::Running, done.id),
        ("cse_gone", SessionState::Ended, done.id),
        ("cse_open", SessionState::Idle, open_todo.id),
        ("local", SessionState::Idle, done.id),
    ] {
        db.record_session(id, "/w", state).unwrap();
        db.link_session(id, todo).unwrap();
    }
    // After linking, which moves a todo to Doing.
    db.update_todo(done.id, TodoPatch { status: Some(Status::Done), ..Default::default() }).unwrap();
    let mut ids: Vec<String> = db.cloud_sessions_to_archive().unwrap().into_iter().map(|s| s.session_id).collect();
    ids.sort();
    // A running session is left to finish its turn; ended ones are archived already.
    assert_eq!(ids, ["cse_idle", "cse_wait"]);
}

#[test]
fn feynman_points_and_attempts_are_kept_per_subject() {
    use cts_core::feynman::{Grade, PointVerdict, Verdict};
    let (_d, db) = open();
    let input = db.create_input("article", None).unwrap();
    let subject = Subject::Input(input.id);
    let points = db.set_feynman_points(subject, &["a".into(), "b".into()]).unwrap();
    assert_eq!(points.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    // Made again, the old ones go.
    db.set_feynman_points(subject, &["c".into()]).unwrap();
    assert_eq!(db.feynman_points(subject).unwrap().len(), 1);
    assert!(db.feynman_points(Subject::Todo(input.id)).unwrap().is_empty());
    let grade = Grade {
        verdicts: vec![PointVerdict { point: 0, verdict: Verdict::Vague, note: "ほぼ".into() }],
        mistakes: vec![],
        jargon: vec!["API".into()],
        questions: vec!["なぜ？".into()],
    };
    let first = db.add_feynman_attempt(subject, "説明", &grade, 50).unwrap();
    let second = db.add_feynman_attempt(subject, "説明2", &grade, 100).unwrap();
    let attempts = db.feynman_attempts(subject).unwrap();
    assert_eq!(attempts.iter().map(|a| a.id).collect::<Vec<_>>(), [second.id, first.id], "newest first");
    assert_eq!(attempts[1].grade, grade);
    let summaries = db.feynman_summaries().unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!((summaries[0].subject, summaries[0].score), (subject, 100));
    assert_eq!(summaries[0].due_at, second.created_at + 7 * 86_400, "a high score waits a week");
}

#[test]
fn feynman_review_is_due_once_per_attempt_and_not_for_finished_subjects() {
    use cts_core::feynman::Grade;
    let (_d, db) = open();
    let input = db.create_input("article", None).unwrap();
    let todo = db.create_todo(new_todo("t")).unwrap();
    let (a, b) = (Subject::Input(input.id), Subject::Todo(todo.id));
    let low = db.add_feynman_attempt(a, "x", &Grade::default(), 30).unwrap();
    db.add_feynman_attempt(b, "x", &Grade::default(), 90).unwrap();
    let day = 86_400;
    assert!(db.feynman_due(low.created_at).unwrap().is_empty(), "not yet");
    let due = db.feynman_due(low.created_at + day).unwrap();
    assert_eq!(due.iter().map(|(s, _)| *s).collect::<Vec<_>>(), [a], "a low score is due the next day, a high one not yet");
    assert_eq!(due[0].1, "article");
    db.add_study_notice(a, "article").unwrap();
    assert!(db.feynman_due(low.created_at + day).unwrap().is_empty(), "noticed once");
    assert_eq!(db.notifications().unwrap()[0].kind, NoticeKind::Study);
    assert_eq!(db.notifications().unwrap()[0].input_id, Some(input.id));
    // Done with, it is not asked about again.
    db.update_input(input.id, InputPatch { done: Some(true), ..Default::default() }).unwrap();
    db.add_feynman_attempt(a, "x", &Grade::default(), 30).unwrap();
    db.update_todo(todo.id, TodoPatch { status: Some(Status::Done), ..Default::default() }).unwrap();
    assert!(db.feynman_due(low.created_at + 30 * day).unwrap().is_empty());
}

#[test]
fn feynman_works_on_databases_made_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE notifications (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL,
         todo_id INTEGER, kind TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER, url TEXT);
         INSERT INTO notifications VALUES (1, 's1', NULL, 'finished', 'done', 0, NULL, NULL);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    assert_eq!(db.notifications().unwrap()[0].input_id, None);
    let input = db.create_input("article", None).unwrap();
    db.set_feynman_points(Subject::Input(input.id), &["a".into()]).unwrap();
    db.add_study_notice(Subject::Input(input.id), "article").unwrap();
    assert_eq!(db.notifications().unwrap().len(), 2);
}

#[test]
fn a_session_done_with_its_turn_is_unread_until_seen() {
    let (_d, db) = open();
    let unread = |db: &Db| db.get_session("s1").unwrap().unwrap().unread;
    db.record_session("s1", "/r", SessionState::Running).unwrap();
    assert!(!unread(&db), "still working");
    db.record_session("s1", "/r", SessionState::Idle).unwrap();
    assert!(unread(&db), "its turn ended");
    let at = db.get_session("s1").unwrap().unwrap().state_at;
    db.mark_session_seen("s1", at).unwrap();
    assert!(!unread(&db), "looked at since");
    assert!(!db.unlinked_sessions().unwrap()[0].unread, "the lists say so too");
    // Seen before it ended (an earlier turn), it is unread again.
    db.mark_session_seen("s1", at - 10).unwrap();
    assert!(unread(&db));
    db.record_session("s1", "/r", SessionState::NeedsInput).unwrap();
    assert!(!unread(&db), "waiting for input is its own state, not unread");
}

#[test]
fn sessions_known_before_unread_existed_are_seen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    {
        let db = Db::open(&path).unwrap();
        db.record_session("old", "/r", SessionState::Idle).unwrap();
    }
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch("DROP TABLE session_seen;").unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    assert!(!db.get_session("old").unwrap().unwrap().unread, "not a flood of unread on the first start");
    db.record_session("new", "/r", SessionState::Idle).unwrap();
    assert!(db.get_session("new").unwrap().unwrap().unread);
}

#[test]
fn a_session_says_which_agent_runs_it() {
    let (_d, db) = open();
    db.record_session("c1", "/r", SessionState::Running).unwrap();
    assert_eq!(db.get_session("c1").unwrap().unwrap().agent, cts_core::Agent::Claude, "Claude unless told");
    db.set_session_agent("c1", cts_core::Agent::Codex).unwrap();
    assert_eq!(db.get_session("c1").unwrap().unwrap().agent, cts_core::Agent::Codex);
}

#[test]
fn a_codex_prompt_names_and_links_its_session() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("fix")).unwrap();
    db.record_session("x1", "/r", SessionState::Running).unwrap();
    let linked = db.name_from_prompt("x1", &format!("[todo:{}] fix the login", t.id)).unwrap();
    assert_eq!(linked, Some(t.id));
    let s = db.get_session("x1").unwrap().unwrap();
    assert_eq!((s.todo_id, s.title.as_deref()), (Some(t.id), Some("fix the login")));
}

#[test]
fn agents_work_on_databases_made_before_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, todo_id INTEGER, cwd TEXT NOT NULL,
         state TEXT NOT NULL CHECK (state IN ('running', 'needs_input', 'idle', 'ended')), state_at INTEGER NOT NULL);
         INSERT INTO sessions VALUES ('s1', NULL, '/r', 'idle', 0);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    assert_eq!(db.get_session("s1").unwrap().unwrap().agent, cts_core::Agent::Claude);
}

#[test]
fn a_review_session_keeps_its_pr_and_a_session_can_be_hidden() {
    let (_d, db) = open();
    db.record_session("r1", "/r", SessionState::Running).unwrap();
    db.record_review_session("r1", "https://github.com/o/r/pull/1", false).unwrap();
    let s = db.get_session("r1").unwrap().unwrap();
    assert_eq!(s.review_url.as_deref(), Some("https://github.com/o/r/pull/1"));
    assert!(!s.hidden);
    db.hide_session("r1").unwrap();
    assert!(db.get_session("r1").unwrap().unwrap().hidden);
    assert!(db.unlinked_sessions().unwrap()[0].hidden, "the lists say so too");
}

#[test]
fn a_waiting_session_keeps_what_it_asks() {
    let (_d, db) = open();
    db.record_session("q1", "/w", SessionState::NeedsInput).unwrap();
    assert_eq!(db.get_session("q1").unwrap().unwrap().question, None);
    db.set_session_question("q1", Some("どちらにしますか？")).unwrap();
    assert_eq!(db.get_session("q1").unwrap().unwrap().question.as_deref(), Some("どちらにしますか？"));
    db.set_session_question("q1", None).unwrap();
    assert_eq!(db.get_session("q1").unwrap().unwrap().question, None);
}

#[test]
fn a_review_session_knows_whether_it_submits_on_its_own() {
    let (_d, db) = open();
    db.record_session("auto", "/r", SessionState::Running).unwrap();
    db.record_review_session("auto", "https://github.com/o/r/pull/1", true).unwrap();
    db.record_session("ask", "/r", SessionState::Running).unwrap();
    db.record_review_session("ask", "https://github.com/o/r/pull/2", false).unwrap();
    assert!(db.get_session("auto").unwrap().unwrap().review_auto);
    assert!(!db.get_session("ask").unwrap().unwrap().review_auto);
}

#[test]
fn questions_and_review_modes_work_on_databases_made_before_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, todo_id INTEGER, cwd TEXT NOT NULL,
         state TEXT NOT NULL CHECK (state IN ('running', 'needs_input', 'idle', 'ended')), state_at INTEGER NOT NULL);
         CREATE TABLE review_sessions (session_id TEXT PRIMARY KEY, pr_url TEXT NOT NULL);
         INSERT INTO sessions VALUES ('s1', NULL, '/r', 'needs_input', 0);
         INSERT INTO review_sessions VALUES ('s1', 'https://github.com/o/r/pull/1');",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    let s = db.get_session("s1").unwrap().unwrap();
    assert_eq!((s.question, s.review_auto, s.review_url.as_deref()), (None, false, Some("https://github.com/o/r/pull/1")));
    db.set_session_question("s1", Some("q")).unwrap();
}

#[test]
fn a_todo_keeps_its_prs_ci() {
    let (_d, db) = open();
    let t = db.create_todo(new_todo("ship")).unwrap();
    assert_eq!((t.ci_state.clone(), t.ci_failed.clone()), (None, Vec::<String>::new()));
    let ci = cts_core::github::Ci { state: "failure".into(), failed: vec!["test-api".into(), "lint, fmt".into()] };
    assert_eq!(db.set_ci(t.id, Some(&ci)).unwrap(), None, "nothing before");
    let got = db.get_todo(t.id).unwrap().unwrap();
    assert_eq!((got.ci_state.as_deref(), got.ci_failed.clone()), (Some("failure"), vec!["test-api".to_string(), "lint, fmt".to_string()]));
    assert_eq!(db.set_ci(t.id, None).unwrap().as_deref(), Some("failure"), "the state before comes back");
    let got = db.get_todo(t.id).unwrap().unwrap();
    assert_eq!((got.ci_state, got.ci_failed), (None, Vec::<String>::new()));
}

#[test]
fn ci_works_on_databases_made_before_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let old = rusqlite::Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('backlog', 'todo', 'doing', 'review', 'pending', 'done')),
         issue_url TEXT, cwd TEXT, memo TEXT, updated_at INTEGER NOT NULL, repos TEXT, prompt TEXT, issue_state TEXT,
         pr_url TEXT, pr_state TEXT, queue_runner TEXT, queue_pos INTEGER, queue_error TEXT, kind TEXT,
         parent_id INTEGER REFERENCES todos(id) ON DELETE SET NULL);
         INSERT INTO todos (title, status, updated_at) VALUES ('old', 'doing', 5);",
    )
    .unwrap();
    drop(old);
    let db = Db::open(&path).unwrap();
    let ci = cts_core::github::Ci { state: "success".into(), failed: vec![] };
    db.set_ci(1, Some(&ci)).unwrap();
    assert_eq!(db.get_todo(1).unwrap().unwrap().ci_state.as_deref(), Some("success"));
}
