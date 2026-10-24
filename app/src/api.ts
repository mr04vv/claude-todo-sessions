import { invoke } from "@tauri-apps/api/core";

export type Status = "backlog" | "todo" | "doing" | "review" | "pending" | "done";
export type SessionState = "running" | "needs_input" | "idle" | "ended";

/** Where a session is, from its messages: its last reply (one line), model, and context in tokens. */
export interface Peek {
  last: string | null;
  model: string | null;
  context_tokens: number | null;
}

export interface Session {
  session_id: string;
  title: string | null;
  todo_id: number | null;
  cwd: string;
  state: SessionState;
  state_at: number;
  /** When it was first recorded (its state_at then). */
  started_at: number;
  /** `owner/repo` list; the first is where the session pushes. Present on inbox sessions. */
  repos?: string[];
  /** Its turn ended after it was last looked at (in the app, or its herdr pane). */
  unread: boolean;
  /** What runs it. */
  agent: Agent;
  /** The PR it reviews, when the app started it as a review. */
  review_url: string | null;
  /** Taken off the session lists. */
  hidden: boolean;
  /** What it asked when it last started waiting for a reply. */
  question: string | null;
  /** A review that submits on its own, without asking first. */
  review_auto: boolean;
  /** Made in Claude Desktop (its Code tab). */
  desktop: boolean;
  /** A run of a Claude Desktop routine (scheduled task). */
  routine: boolean;
}

/** The program a session runs: Claude Code, or Codex (local, in herdr). */
export type Agent = "claude" | "codex";

export interface Todo {
  id: number;
  title: string;
  status: Status;
  issue_url: string | null;
  cwd: string | null;
  memo: string | null;
  updated_at: number;
  sessions: Session[];
  /** `owner/repo` list: the todo's own, else derived from the issue URL or the working folder. */
  repos: string[];
  /** True when `repos` was derived rather than set on the todo. */
  repos_derived: boolean;
  /** First prompt for sessions started from this todo; null means the title. */
  prompt: string | null;
  issue_state: "open" | "closed" | null;
  pr_url: string | null;
  pr_state: PrState | null;
  prompt_preview: string;
  parent_id: number | null;
  /** Its PR's CI (null: no checks). */
  ci_state: CiState | null;
  /** The checks that failed. */
  ci_failed: string[];
  /** A parent's plan, which its subtasks start knowing. */
  plan: string | null;
  /** Times its session was sent to fix its PR. */
  fix_count: number;
  /** Why its orchestrator handed it to the user. */
  escalation: string | null;
  is_orchestrator: boolean;
}

/** What a reading is: a web page, a post on X, or a book (O'Reilly's) with chapters. */
export type ReadingKind = "article" | "post" | "book";

/** Something kept to read (読みもの), sorted into tags. */
export interface Reading {
  id: number;
  kind: ReadingKind;
  /** A book's is the book's own page. */
  url: string;
  title: string;
  /** A post's text, or what its page says it is about. */
  text: string | null;
  image: string | null;
  /** Null until sorted; empty when no tag fits. */
  tags: string[] | null;
  /** A book's table of contents, in order. */
  chapters: Chapter[];
  created_at: number;
  /** Read and kept (a good one), as against still to read. */
  kept: boolean;
  /** A post's links, as X gives them (t.co). */
  links: string[];
}

/** A day's readings summed up (its 日報) in an HTML artifact a session publishes, or why it was not. */
export interface Digest {
  /** The local date, YYYY-MM-DD. */
  day: string;
  url: string | null;
  error: string | null;
  made_at: number;
  /** The session making it (in 作業); the artifact it publishes is the digest. */
  session_id: string | null;
}

/** The days summed up (the newest first), and the day being summed up. */
export interface DigestView {
  digests: Digest[];
  running: string | null;
}

export interface Chapter {
  /** From 1. */
  position: number;
  title: string;
  url: string;
  read: boolean;
}

/** How sorting the readings into tags stands: an API key kept, why the last run stopped, and the tags. */
export interface ReadingSort {
  has_key: boolean;
  error: string | null;
  tags: string[];
}

/** A list the user made to keep todos in (Frontend Backlog), with the ids of the todos in it (a todo is in one at most). */
export interface Database {
  id: number;
  name: string;
  todos: number[];
}

/** The requests to Jev over a span, and their tokens. */
export interface JevTally {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

/** What the requests to Jev took today, this month (by the local date) and all along, in US dollars too. */
export interface JevSpend {
  today: JevTally;
  month: JevTally;
  all: JevTally;
  today_usd: number;
  month_usd: number;
  all_usd: number;
  /** The credit as last read off TypeSafe's console, and what is left of it. */
  credit: JevCredit | null;
}

/** Jev's credit as read off TypeSafe's console (its billing page has no API) at `at` (unix seconds), what this app spent since, and what is left. */
export interface JevCredit {
  credit: number;
  spent: number;
  base_input_tokens: number;
  at: number;
  since_usd: number;
  left: number;
}

export type CiState = "pending" | "success" | "failure";

/** Something that happened under a (parent) todo: its 経過. */
export interface TodoEvent {
  id: number;
  todo_id: number;
  at: number;
  text: string;
}

export type PrState = "draft" | "open" | "review_requested" | "changes_requested" | "approved" | "merged" | "closed";


/** What a session made besides a PR: a claude.ai artifact or doc, or a file it registered. */
export interface Artifact {
  id: number;
  /** A claude.ai page, or a file's path. */
  url: string;
  title: string | null;
  kind: "artifact" | "doc" | "file";
  session_id: string | null;
  todo_id: number | null;
  created_at: number;
}

/** A Slack message for the user (#27): a mention of them, or of a user group they are in, in a channel. */
export interface SlackMessage {
  channel: string;
  ts: string;
  /** The thread it is in; null for a message in the channel itself. */
  thread_ts: string | null;
  channel_name: string;
  user_name: string;
  text: string;
  permalink: string;
  /** The user group's handle when it mentions a group, not the user. */
  via: string | null;
  /** The sender's picture. */
  user_image: string | null;
  /** Read in the app (Slack's own marks are left as they are). */
  read: boolean;
}

/** A Slack thread the user is in, with replies since they last saw it (#28). */
export interface SlackThread {
  channel: string;
  thread_ts: string;
  channel_name: string;
  permalink: string;
  latest_ts: string | null;
  latest_user_name: string | null;
  latest_text: string | null;
  latest_image: string | null;
  new_replies: number;
}

/** A channel the user is in, to post in. */
export interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
}

/** Someone or a user group to mention in a reply: how it is written (`<@U1>`), its name, what else finds it. */
export interface SlackMentionable {
  token: string;
  name: string;
  also: string[];
  image: string | null;
}

/** A Slack message bookmarked (a thread's head stands for the thread), as it was then. */
export interface SlackBookmark {
  channel: string;
  ts: string;
  thread_ts: string | null;
  channel_name: string;
  user_name: string;
  user_image: string | null;
  /** As plain text. */
  text: string;
  permalink: string;
}

/** A Slack channel muted in Shosai (Slack's own mute cannot be read with a user token). */
export interface MutedChannel {
  channel: string;
  name: string;
}

export interface SlackView {
  connected: boolean;
  /** Socket Mode brings the messages as they are posted (and a search every minute, either way). */
  live: boolean;
  /** When Socket Mode last brought an event (unix seconds), since launch. */
  last_event_at: number | null;
  /** Socket Mode is connected but nothing came for a long while: Slack may have turned the app's events off. */
  events_quiet: boolean;
  /** The user's Slack id, once known (their mentions are marked). */
  user_id: string | null;
  /** Why the last check failed. */
  error: string | null;
  /** Newest first. */
  messages: SlackMessage[];
  /** The threads the user is in with new replies, the latest first. */
  threads: SlackThread[];
  /** The last bookmarked first. */
  bookmarks: SlackBookmark[];
}

/** Who the kept Slack token is. */
export interface SlackAccount {
  team_url: string;
  user_id: string;
  /** The app's token is kept (Socket Mode). */
  realtime: boolean;
  /** A configuration token is kept: the app's events are out while the Mac sleeps. */
  config: boolean;
}

/** A message of a Slack thread, its head first. */
export interface SlackThreadMessage {
  user_name: string;
  user_image: string | null;
  /** Slack's markup (slackText.ts formats it), the user mentions named. */
  text: string;
  ts: string;
  mine: boolean;
  /// Its link, for a todo made from it.
  permalink: string;
  /** Each emoji with how many gave it, whether the user did, and the first who did. */
  reactions: { name: string; count: number; mine: boolean; who: string[] }[];
  /** The links Slack unfurled under it (a page's preview, a Slack message's), or a bot's attachments. */
  attachments: SlackAttachment[];
}

/** What Slack shows under a message; `text` is Slack's markup, `source` who posted or the site. */
export interface SlackAttachment {
  source: string | null;
  icon: string | null;
  title: string | null;
  link: string | null;
  text: string | null;
  image: string | null;
  thumb: string | null;
  footer: string | null;
}

export interface Board {
  todos: Todo[];
  slack: SlackView;
  /** Newest first. */
  readings: Reading[];
  reading_sort: ReadingSort;
  jev_spend: JevSpend;
  /** The lists the user made to keep todos in, in the order made. */
  databases: Database[];
  /** The days' readings summed up (日報), and the day being summed up. */
  digests: DigestView;
  inbox: Session[];
  /** Newest first. */
  artifacts: Artifact[];
  sync_status: string;
}

export interface TodoInput {
  title: string;
  issue_url?: string;
  cwd?: string;
  memo?: string;
  repos?: string[];
  parent_id?: number;
}

export interface TodoUpdate {
  title?: string;
  status?: Status;
  memo?: string;
  cwd?: string;
  issue_url?: string;
  repos?: string[];
  prompt?: string;
  pr_url?: string;
}

export interface Issue {
  number: number;
  title: string;
  url: string;
  repo: string;
  updated_at: string;
  cwd: string | null;
}

export interface IssueImport {
  title: string;
  url: string;
  cwd?: string;
}

export interface LocalRepo {
  key: string;
  path: string;
}

/** A plan usage limit, as `/usage` in Claude Code shows it. */
export interface Limit {
  label: string;
  percent: number;
  resets_at: string | null;
  severity: string;
  /** What has been spent against the limit, when the limit is money. */
  amount: { used: number; limit: number; currency: string } | null;
}

export interface Pr {
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  updated_at: string;
  is_draft: boolean;
  /** Its description, as written. */
  body: string;
}

/** A PR's CI: its state and the checks that failed. */
export interface Ci {
  state: CiState;
  failed: string[];
}

/** An open PR of the user's. */
export interface MyPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  is_draft: boolean;
  updated_at: string;
  stage: PrState;
  ci: Ci | null;
  checks: Check[];
  /** Whom it asks for a review and who reviewed it. */
  reviews: Review[];
}

/** One check of a PR's last commit. */
export interface Check {
  name: string;
  state: "success" | "failure" | "pending" | "skipped";
}

/** A user's login or a team's slug, and "requested" while asked, or how they last reviewed. */
export interface Review {
  who: string;
  state: "requested" | "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
}

export interface PrLists {
  review: Pr[];
  mine: MyPr[];
}

/** Where a review runs. */
export type ReviewRunner = "cloud" | "herdr";

export interface HerdrSessions {
  running: string[];
  picked: string | null;
  /** Where a new workspace would go now. */
  target: string | null;
}

/** Model and effort for a new session; unset keeps the default. */
export interface StartOptions {
  model?: string;
  effort?: string;
  /** The session plans the todo into subtasks (Claude in herdr) instead of implementing it. */
  plan?: boolean;
  /** What runs a terminal session (Cloud and Desktop are Claude's). */
  agent?: Agent;
}

export const MODELS: { id: string; label: string }[] = [
  { id: "", label: "既定のモデル" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

export const EFFORTS: string[] = ["", "low", "medium", "high", "xhigh", "max"];

/** Where the browser pane sits, in CSS pixels of the page. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The page's innerHeight, which tells how much of the window's top the title bar covers. */
  viewport: number;
}

export const api = {
  localRepos: () => invoke<LocalRepo[]>("local_repos"),
  createIssue: (todoId: number) => invoke<Todo>("create_issue", { todoId }),
  closeIssue: (todoId: number) => invoke<void>("close_issue", { todoId }),
  ghIssues: () => invoke<Issue[]>("gh_issues"),
  importIssues: (issues: IssueImport[]) => invoke<number>("import_issues", { issues }),
  board: () => invoke<Board>("board"),
  createTodo: (input: TodoInput) => invoke<Todo>("create_todo", { input }),
  updateTodo: (id: number, update: TodoUpdate) => invoke<Todo>("update_todo", { id, update }),
  deleteTodo: (id: number) => invoke<void>("delete_todo", { id }),
  createDatabase: (name: string) => invoke<Database>("create_database", { name }),
  renameDatabase: (id: number, name: string) => invoke<void>("rename_database", { id, name }),
  /// Its todos stay, in no database.
  deleteDatabase: (id: number) => invoke<void>("delete_database", { id }),
  /// Puts the todo in a database (out of the one it was in), or with null in none.
  setTodoDatabase: (todoId: number, databaseId: number | null) => invoke<void>("set_todo_database", { todoId, databaseId }),
  linkSession: (sessionId: string, todoId: number) => invoke<void>("link_session", { sessionId, todoId }),
  unlinkSession: (sessionId: string) => invoke<void>("unlink_session", { sessionId }),
  /// A plain claude in herdr, at home unless `cwd` is given.
  /// Translates a tab's page where it is, or puts it back.
  browserTranslate: (tab: string, on: boolean) => invoke<void>("browser_translate", { tab, on }),
  /// Opens a file an artifact is, with its app.
  openPath: (path: string) => invoke<void>("open_path", { path }),
  /// The todo's handover is dealt with.
  clearEscalation: (todoId: number) => invoke<void>("clear_escalation", { todoId }),
  /// What happened under a (parent) todo, newest first: its 経過.
  todoEvents: (todoId: number) => invoke<TodoEvent[]>("todo_events", { todoId }),
  /// A parent's plan, which its subtasks start knowing.
  setPlan: (todoId: number, plan: string) => invoke<void>("set_plan", { todoId, plan }),
  /// Sends the session what to fix in the todo's PR; a Cloud one is not sent it (`sent` false).
  fixInSession: (sessionId: string, todoId: number) => invoke<{ sent: boolean; prompt: string }>("fix_in_session", { sessionId, todoId }),
  quickClaude: (prompt: string, cwd?: string, title?: string, agent?: Agent, options?: StartOptions) =>
    invoke<void>("quick_claude", { prompt, cwd: cwd ?? null, title: title ?? null, agent: agent ?? null, options: options ?? null }),
  /// A PR review in a cloud session linked to no todo; returns its id.
  /// `url` is the PR reviewed: the session is put away once the review is in.
  /// Reviews a PR in a session of its own, started behind; its id (none for Codex's, which picks its own).
  startReview: (r: { url: string; repo: string; title: string; agent: Agent; auto: boolean; runner: ReviewRunner; cwd?: string; options?: StartOptions }) =>
    invoke<string | null>("start_review", { ...r, cwd: r.cwd ?? null, options: r.options ?? null }),
  /// Stops a review: archived on Cloud, its herdr workspace closed, off the lists.
  stopReview: (sessionId: string) => invoke<void>("stop_review", { sessionId }),
  /// Takes a session off the lists (a Local one, which cannot be archived from here).
  hideSession: (sessionId: string) => invoke<void>("hide_session", { sessionId }),
  /// The models Codex offers and the efforts each takes (Codex's own cache).
  codexModels: () => invoke<{ id: string; label: string; efforts: string[] }[]>("codex_models"),
  syncNow: (todoId?: number) => invoke<void>("sync_now", { todoId: todoId ?? null }),
  openLink: (url: string) => invoke<void>("open_link", { url }),
  slackConnect: (token: string) => invoke<SlackAccount>("slack_connect", { token }),
  slackAccount: () => invoke<SlackAccount | null>("slack_account"),
  slackDisconnect: () => invoke<void>("slack_disconnect"),
  slackSetAppToken: (token: string) => invoke<void>("slack_set_app_token", { token }),
  slackForgetAppToken: () => invoke<void>("slack_forget_app_token"),
  slackSetConfigToken: (token: string) => invoke<void>("slack_set_config_token", { token }),
  slackForgetConfigToken: () => invoke<void>("slack_forget_config_token"),
  slackRead: (channel: string, ts: string) => invoke<void>("slack_read", { channel, ts }),
  slackThread: (channel: string, threadTs: string) => invoke<{ messages: SlackThreadMessage[]; muted: boolean }>("slack_thread", { channel, threadTs }),
  slackThreadSeen: (channel: string, threadTs: string) => invoke<void>("slack_thread_seen", { channel, threadTs }),
  slackMuteThread: (channel: string, threadTs: string, muted: boolean) => invoke<void>("slack_mute_thread", { channel, threadTs, muted }),
  slackBookmark: (bookmark: SlackBookmark) => invoke<void>("slack_bookmark", { bookmark }),
  slackUnbookmark: (channel: string, ts: string) => invoke<void>("slack_unbookmark", { channel, ts }),
  slackMuteChannel: (channel: string, muted: boolean) => invoke<void>("slack_mute_channel", { channel, muted }),
  slackMutedChannels: () => invoke<MutedChannel[]>("slack_muted_channels"),
  slackDirectory: () => invoke<SlackMentionable[]>("slack_directory"),
  slackEmoji: () => invoke<Record<string, string>>("slack_emoji"),
  slackChannels: () => invoke<SlackChannel[]>("slack_channels"),
  slackPost: (channel: string, text: string) => invoke<string>("slack_post", { channel, text }),
  slackForget: (channel: string, ts: string) => invoke<void>("slack_forget", { channel, ts }),
  slackForgetRead: () => invoke<void>("slack_forget_read"),
  slackForgetThread: (channel: string, threadTs: string) => invoke<void>("slack_forget_thread", { channel, threadTs }),
  slackReply: (channel: string, threadTs: string, text: string) => invoke<void>("slack_reply", { channel, threadTs, text }),
  /// Gives the user's reaction to a message (`on`), or takes it off.
  slackReact: (channel: string, ts: string, name: string, on: boolean) => invoke<void>("slack_react", { channel, ts, name, on }),
  herdrSessions: () => invoke<HerdrSessions>("herdr_sessions"),
  setHerdrSession: (name: string | null) => invoke<void>("set_herdr_session", { name }),
  openSession: (sessionId: string, target?: "desktop" | "herdr") => invoke<void>("open_session", { sessionId, target }),
  windowFocused: () => invoke<boolean>("window_focused"),
  /// Gives the app's own page the keyboard, which a browser tab may hold.
  focusAppPage: () => invoke<void>("term_focus"),
  /// The space shown: the pages learn whether a split view (作業・学習) is up, and 学習 holds the notifications.
  setSpace: (space: string) => invoke<void>("set_space", { space }),
  /// The app's keys (keymap.ts), as JSON, for the pages' script.
  setPageKeys: (keys: string) => invoke<void>("set_page_keys", { keys }),
  /// Archives cloud sessions (`cse_…`), as claude.ai does.
  archiveSessions: (ids: string[]) => invoke<void>("archive_sessions", { ids }),
  copyText: (text: string) => invoke<void>("copy_text", { text }),
  takeOpened: () => invoke<string[]>("take_opened"),
  addReading: (reading: { kind: ReadingKind; url: string; title: string; text?: string; chapters?: [string, string][] }) => invoke<Reading>("add_reading", { reading }),
  deleteReading: (id: number) => invoke<void>("delete_reading", { id }),
  /// The tags put right by hand (from ReadingSort's tags).
  setReadingTags: (id: number, tags: string[]) => invoke<void>("set_reading_tags", { id, tags }),
  setChapterRead: (readingId: number, position: number, read: boolean) => invoke<void>("set_chapter_read", { readingId, position, read }),
  /// Keeps a reading read (a good one), or puts it back to read.
  setReadingKept: (id: number, kept: boolean) => invoke<void>("set_reading_kept", { id, kept }),
  /// Has `day`'s readings (YYYY-MM-DD, the local date) summed up into its 日報 now, behind: a session (in 作業) publishes it, and its link comes on the board.
  makeDigest: (day: string) => invoke<void>("make_digest", { day }),
  /// Keeps the TypeSafe API key (blank takes it out); what waits is sorted then.
  setTypesafeKey: (key: string) => invoke<void>("set_typesafe_key", { key }),
  /// Keeps Jev's credit as just read off TypeSafe's console: the credit, and the Spend.
  setJevCredit: (credit: number, spent: number) => invoke<void>("set_jev_credit", { credit, spent }),
  clearJevCredit: () => invoke<void>("clear_jev_credit"),
  /// The tab's page keeps itself to read, as its own ⌘⇧D does.
  browserBookmark: (tab: string) => invoke<void>("browser_bookmark", { tab }),
  forgetArtifact: (id: number) => invoke<void>("forget_artifact", { id }),
  startTerminal: (todoId: number, options?: StartOptions) => invoke<void>("start_terminal", { todoId, options: options ?? null }),
  /** Starts a cloud session and returns its id; `desktop` also opens it in Claude Desktop. */
  startCloud: (todoId: number, options?: StartOptions) => invoke<string>("start_cloud", { todoId, options: options ?? null }),
  /** Marks one notification read, or all with no id. */
  /// Merges the PR once approved: now when it is ready ("merged"), else by GitHub's auto-merge ("auto").
  /// Keeps (in the Keychain) the login a page just sent, or lets it go.
  answerLogin: (answer: "keep" | "skip" | "never") => invoke<void>("answer_login", { answer }),
  /// The logins kept: each site and its user (never the password).
  savedLogins: () => invoke<{ site: string; user: string }[]>("saved_logins"),
  /// The sites whose logins are never asked about, and asking about one again.
  neverAskedLogins: () => invoke<string[]>("never_asked_logins"),
  askLoginAgain: (site: string) => invoke<void>("ask_login_again", { site }),
  /// Takes out the login kept for a site.
  forgetLogin: (host: string) => invoke<void>("forget_login", { host }),
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
  answerPageDialog: (id: number, ok: boolean, text?: string) => invoke<void>("answer_page_dialog", { id, ok, text: text ?? null }),
  answerSitePermission: (id: number, site: string, allow: boolean) => invoke<void>("answer_site_permission", { id, site, allow }),
  sitePermissions: () => invoke<Record<string, boolean>>("site_permissions"),
  forgetSitePermission: (site: string) => invoke<void>("forget_site_permission", { site }),
  /// The session was looked at now: its ended turn is read.
  markSessionSeen: (sessionId: string) => invoke<void>("mark_session_seen", { sessionId }),
  setParent: (todoId: number, parentId: number | null) => invoke<Todo>("set_parent", { todoId, parentId }),
  usage: () => invoke<Limit[]>("usage"),
  ghPrs: () => invoke<PrLists>("gh_prs"),
  /** Shows tab `tab` (created on first use) at `url` and hides the other tabs. */
  /// Shows `tab`, hiding the other tabs but `keep` (the focus mode's other side).
  /// With `go` it is sent to `url`; else a tab already open stays on its page.
  /// True when the tab was made now (its page is still coming).
  browserOpen: (tab: string, url: string, r: Rect, go: boolean, keep?: string) => invoke<boolean>("browser_open", { tab, url, ...r, go, keep: keep ?? null }),
  browserBounds: (tab: string, r: Rect) => invoke<void>("browser_bounds", { tab, ...r }),
  /// Hides `tab`, or every tab.
  browserHide: (tab?: string) => invoke<void>("browser_hide", { tab: tab ?? null }),
  browserClose: (tab: string) => invoke<void>("browser_close", { tab }),
  /** Opens a page in a window of its own, apart from the app's tabs. */
  /** Brings the browser's own window forward, with `url` (or `pin:<id>`) opened as its tab. */
  browserWindowOpen: (url?: string) => invoke<void>("browser_window_open", { url: url ?? null }),
  /** The pages asked of the browser window before its page was up. */
  browserWindowTake: () => invoke<string[]>("browser_window_take"),
  /** Each session's last reply, model and context (the ones that could be read). */
  sessionPeeks: (ids: string[]) => invoke<Record<string, Peek>>("session_peeks", { ids }),
  /** Where a session stands, in one line Claude writes (none when nothing can be said yet). */
  sessionSummary: (id: string) => invoke<string | null>("session_summary", { id }),
  /// With `input`, the page's text box takes the typing too.
  browserFocus: (tab: string, input?: boolean, text?: string) => invoke<void>("browser_focus", { tab, input: input ?? null, text: text ?? null }),
  browserUrl: (tab: string) => invoke<string | null>("browser_url", { tab }),
  browserGo: (tab: string, action: "back" | "forward" | "reload") => invoke<void>("browser_go", { tab, action }),
  browserZoom: (tab: string, action: "in" | "out" | "reset") => invoke<void>("browser_zoom", { tab, action }),
};

/** `{tab, url}` after a tab navigates. */
/** `url` (or `pin:<id>`) to open as a tab in the browser's own window. */
export const BROWSER_WINDOW_OPEN_EVENT = "browser-window-open";
export const BROWSER_URL_EVENT = "browser-url";
/** `{tab, delta}` (-1 or 1) when a page asks for the previous or next tab (⌘⇧[ ⌘⇧]). */
export const BROWSER_SWITCH_TAB_EVENT = "browser-switch-tab";
/** When ⌘W in the app menu asks to close the shown tab. */
export const BROWSER_CLOSE_TAB_EVENT = "browser-close-tab";
/** When the window's focus changes (another app, or a browser tab, took the keyboard). */
export const WINDOW_FOCUS_EVENT = "window-focus";
/** `{tab}` when a page's ⌃l asks for the split view's right side. */
export const FOCUS_PANE_EVENT = "focus-pane";
/** `{title, kind, chapters}` once a page kept itself to read (⌘⇧D, a link ⌥-clicked, X's bookmark button). */
export const READING_ADDED_EVENT = "reading-added";
/** `{space}` when a page's ⌘1–⌘6 asks for a space. */
export const SPACE_EVENT = "space";
/** When a page's ⌃h hands the typing back to the app's side. */
export const FOCUS_APP_EVENT = "focus-app";
/** `{tab}` when a page takes the keyboard in a split view (作業・学習). */
export const PAGE_FOCUSED_EVENT = "page-focused";
/** When a page's ⌘K asks for the app's commands. */
export const OPEN_PALETTE_EVENT = "open-palette";
/** `{host, user}` when a page sent a login not kept yet: asked whether to keep it (answerLogin). */
export const LOGIN_CAPTURED_EVENT = "login-captured";
/** When a page's ⌘⇧K asks for the list of sessions. */
export const OPEN_SESSIONS_EVENT = "open-sessions";
/// A review went in: `{url, title, verdict}` (APPROVED, CHANGES_REQUESTED or COMMENTED).
export const REVIEW_SUBMITTED_EVENT = "review-submitted";
/// `{id}`: a todo to open (a handover's notification).
export const OPEN_TODO_EVENT = "open-todo";
/// `{channel, ts}`: a Slack message to show (a mention's notification).
export const OPEN_SLACK_EVENT = "open-slack";
/// `{channel, thread_ts}`: a message was posted where the user is (Socket Mode); an open thread reads itself again.
export const SLACK_POSTED_EVENT = "slack-posted";
/// `{tab, on}`: a tab's page was translated where it is, or put back.
export const BROWSER_TRANSLATED_EVENT = "browser-translated";
/** `{tab}` when a cloud session's page asks to archive it (⌘⇧A). */
export const BROWSER_ARCHIVE_EVENT = "browser-archive";
/** When a page asks for a new tab (⌘T). */
export const BROWSER_OPEN_NEW_TAB_EVENT = "browser-open-new-tab";
/** `{tab}` when a page asks for the address bar (⌘L). */
export const BROWSER_FOCUS_URL_EVENT = "browser-focus-url";
/** `{tab, url}` when a tab's address changes without a page load. */
export const BROWSER_ADDRESS_EVENT = "browser-address";
/** `{tab, title}` when a tab's page title changes. */
export const BROWSER_TITLE_EVENT = "browser-title";
/** `{tab, zoom}` when a tab's zoom changes (1 is none). */
export const BROWSER_ZOOM_EVENT = "browser-zoom";
/** `{session_id}` of a cloud session picked in a notification. */
export const OPEN_CLOUD_EVENT = "open-cloud";
/** `{url, tab, behind}` for a link a page opens in a new window; it becomes a new tab next to `tab`. */
export const BROWSER_NEW_TAB_EVENT = "browser-new-tab";
/** `{url}` for a page of the app's own (a PR from a notification), opened in its tab if it has one. */
export const OPEN_URL_EVENT = "open-url";
/** When macOS has asked the app to open web pages (a Raycast quicklink): they are taken with `takeOpened`. */
export const OPENED_EVENT = "opened";
/** When a page's ⌘N asks for a new todo. */
export const OPEN_NEW_TODO_EVENT = "open-new-todo";
/** `{path, name}` when a page's download has finished (in the Downloads folder). */
export const BROWSER_DOWNLOADED_EVENT = "browser-downloaded";
/** `{id, tab, kind, message, default}` when a page shows an alert, confirm or prompt (answerPageDialog). */
export const PAGE_DIALOG_EVENT = "page-dialog";
/** `{id, site, camera}` when a site asks for the microphone or camera the first time (answerSitePermission). */
export const SITE_PERMISSION_EVENT = "site-permission";

export const isCloud = (s: Session) => s.session_id.startsWith("cse_");

const CLOUD_WEB = "https://claude.ai/code/";
/** claude.ai page of a cloud session; the web names `cse_…` as `session_…`. */
export const cloudWebUrl = (sessionId: string) => CLOUD_WEB + sessionId.replace(/^cse_/, "session_");

/** `owner/repo#123` from a GitHub issue or PR URL, or null. */
export function issueRef(url: string | null): string | null {
  const m = url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : null;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Relative time like "3分前" for a unix timestamp in seconds. */
export function ago(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < MINUTE) return "たった今";
  if (s < HOUR) return `${Math.floor(s / MINUTE)}分前`;
  if (s < DAY) return `${Math.floor(s / HOUR)}時間前`;
  return `${Math.floor(s / DAY)}日前`;
}
