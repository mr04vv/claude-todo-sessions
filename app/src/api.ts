import { invoke } from "@tauri-apps/api/core";
import type { TerminalRun } from "./Terminal";

export type Status = "backlog" | "todo" | "doing" | "review" | "pending" | "done";
export type SessionState = "running" | "needs_input" | "idle" | "ended";

export interface Session {
  session_id: string;
  title: string | null;
  todo_id: number | null;
  cwd: string;
  state: SessionState;
  state_at: number;
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
  queue_runner: Runner | null;
  queue_error: string | null;
  queue_pos: number | null;
  kind: Kind;
  prompt_preview: string;
  parent_id: number | null;
  /** Its PR's CI (null: no checks). */
  ci_state: CiState | null;
  /** The checks that failed. */
  ci_failed: string[];
  is_orchestrator: boolean;
  links: Link[];
}

/** A URL attached to a todo; title and image arrive once the page has been read. */
export interface Link {
  id: number;
  todo_id: number;
  url: string;
  title: string | null;
  image: string | null;
  created_at: number;
}

/** Material to read in the Input mode, apart from the todos. */
export interface Input {
  id: number;
  title: string;
  memo: string | null;
  /** Read already. */
  done: boolean;
  updated_at: number;
  /** Its pages and its note, in the order added. */
  links: InputLink[];
}

/** A page of an input; like a todo's Link, its title and image come later. */
export interface InputLink {
  id: number;
  input_id: number;
  url: string;
  title: string | null;
  image: string | null;
  created_at: number;
}

/** What the Input mode is open for: a todo's pages, or an input. */
export type Subject = { kind: "todo"; id: number } | { kind: "input"; id: number };

/** The Input mode's 「説明する」 (feynman.rs): a key point of the subject's pages. */
export interface FeynmanPoint {
  id: number;
  text: string;
}
export type FeynmanVerdict = "said" | "vague" | "missing";
export interface FeynmanGrade {
  verdicts: { point: number; verdict: FeynmanVerdict; note: string }[];
  mistakes: string[];
  jargon: string[];
  questions: string[];
}
/** One explanation and its grading. */
export interface FeynmanAttempt {
  id: number;
  explanation: string;
  grade: FeynmanGrade;
  /** Percent. */
  score: number;
  created_at: number;
}
/** A subject's latest attempt, and when to explain again (seconds). */
export interface FeynmanSummary {
  subject: Subject;
  score: number;
  attempted_at: number;
  due_at: number;
}
export interface FeynmanState {
  points: FeynmanPoint[];
  /** Newest first. */
  attempts: FeynmanAttempt[];
}
/** A page's text, as read from its tab (or fetched). */
export interface PageText {
  url: string;
  title: string | null;
  text: string;
}

export type CiState = "pending" | "success" | "failure";

export type PrState = "draft" | "open" | "review_requested" | "changes_requested" | "approved" | "merged" | "closed";

export type Runner = "auto" | "cloud" | "local";
export type Kind = "implementation" | "research";

/** A notification the app posted, kept for the in-app list. */
export interface Notice {
  id: number;
  session_id: string;
  todo_id: number | null;
  kind: "finished" | "needs_input" | "review_requested" | "study";
  title: string;
  created_at: number;
  read: boolean;
  /// The PR of a review request; its session_id is empty.
  url: string | null;
  /// The input a study notice (time to explain again) is for; a todo's is in todo_id.
  input_id: number | null;
}

export interface Board {
  todos: Todo[];
  inputs: Input[];
  inbox: Session[];
  /** Newest first. */
  notifications: Notice[];
  /** Each subject's latest 「説明する」 attempt. */
  feynman: FeynmanSummary[];
  sync_status: string;
  loop_enabled: boolean;
}

export interface TodoInput {
  title: string;
  issue_url?: string;
  cwd?: string;
  memo?: string;
  repos?: string[];
  kind?: Kind;
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
  kind?: Kind;
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
}

export interface Skill {
  name: string;
  description: string;
}

export interface Pr {
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  updated_at: string;
  is_draft: boolean;
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
  /** Whom it asks for a review and who reviewed it (logins, team slugs). */
  reviewers: string[];
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
  /** The session sets its PR to merge once approved (GitHub's auto-merge). */
  auto_merge?: boolean;
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
  enqueue: (todoId: number, runner: Runner) => invoke<void>("enqueue", { todoId, runner }),
  dequeue: (todoId: number) => invoke<void>("dequeue", { todoId }),
  moveInQueue: (todoId: number, delta: number) => invoke<void>("move_in_queue", { todoId, delta }),
  setLoopEnabled: (enabled: boolean) => invoke<void>("set_loop_enabled", { enabled }),
  ghIssues: () => invoke<Issue[]>("gh_issues"),
  importIssues: (issues: IssueImport[]) => invoke<number>("import_issues", { issues }),
  board: () => invoke<Board>("board"),
  createTodo: (input: TodoInput) => invoke<Todo>("create_todo", { input }),
  updateTodo: (id: number, update: TodoUpdate) => invoke<Todo>("update_todo", { id, update }),
  deleteTodo: (id: number) => invoke<void>("delete_todo", { id }),
  linkSession: (sessionId: string, todoId: number) => invoke<void>("link_session", { sessionId, todoId }),
  unlinkSession: (sessionId: string) => invoke<void>("unlink_session", { sessionId }),
  /// A plain claude in herdr, at home unless `cwd` is given.
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
  herdrSessions: () => invoke<HerdrSessions>("herdr_sessions"),
  setHerdrSession: (name: string | null) => invoke<void>("set_herdr_session", { name }),
  addLink: (todoId: number, url: string) => invoke<Link>("add_link", { todoId, url }),
  /// A page's own title (og:title, else <title>), when it has one.
  pageTitle: (url: string) => invoke<string | null>("page_title", { url }),
  removeLink: (id: number) => invoke<void>("remove_link", { id }),
  openSession: (sessionId: string, target?: "desktop" | "herdr") => invoke<void>("open_session", { sessionId, target }),
  startDesktop: (todoId: number) => invoke<void>("start_desktop", { todoId }),
  windowFocused: () => invoke<boolean>("window_focused"),
  /// Gives the app's own page the keyboard, which a browser tab may hold.
  focusAppPage: () => invoke<void>("term_focus"),
  setFocusMode: (on: boolean) => invoke<void>("set_focus_mode", { on }),
  /// The app's keys (keymap.ts), as JSON, for the pages' script.
  setPageKeys: (keys: string) => invoke<void>("set_page_keys", { keys }),
  /// Archives cloud sessions (`cse_…`), as claude.ai does.
  archiveSessions: (ids: string[]) => invoke<void>("archive_sessions", { ids }),
  /// A session making the focus mode's note of `urls` for the todo; locally, the
  /// in-app terminal gets the command to run (`run`), herdr runs it itself.
  startNote: (subject: Subject, urls: string[], format: NoteFormat, cloud: boolean) => invoke<NoteStart>("start_note", { subject, urls, format, cloud }),
  /// The note the session published, once it has (kept as a link of the todo).
  noteUrl: (subject: Subject, sessionId: string) => invoke<string | null>("note_url", { subject, sessionId }),
  /// The text of a tab's page; null when the tab has no page open.
  browserText: (tab: string) => invoke<string | null>("browser_text", { tab }),
  /// A page's text fetched afresh (one behind a login comes back as its sign-in page).
  pageText: (url: string) => invoke<string>("page_text", { url }),
  feynmanState: (subject: Subject) => invoke<FeynmanState>("feynman_state", { subject }),
  feynmanMakePoints: (subject: Subject, title: string, pages: PageText[]) => invoke<FeynmanPoint[]>("feynman_make_points", { subject, title, pages }),
  feynmanGrade: (subject: Subject, title: string, explanation: string) => invoke<FeynmanAttempt>("feynman_grade", { subject, title, explanation }),
  createInput: (title: string) => invoke<Input>("create_input", { title }),
  updateInput: (id: number, update: { title?: string; memo?: string; done?: boolean }) => invoke<Input>("update_input", { id, update }),
  deleteInput: (id: number) => invoke<void>("delete_input", { id }),
  addInputLink: (inputId: number, url: string) => invoke<InputLink>("add_input_link", { inputId, url }),
  removeInputLink: (id: number) => invoke<void>("remove_input_link", { id }),
  startTerminal: (todoId: number, options?: StartOptions) => invoke<void>("start_terminal", { todoId, options: options ?? null }),
  /** Starts a cloud session and returns its id; `desktop` also opens it in Claude Desktop. */
  startCloud: (todoId: number, options: StartOptions | undefined, desktop: boolean) => invoke<string>("start_cloud", { todoId, options: options ?? null, desktop }),
  /** Marks one notification read, or all with no id. */
  /// Merges the PR once approved: now when it is ready ("merged"), else by GitHub's auto-merge ("auto").
  /// Keeps (in the Keychain) the login a page just sent, or lets it go.
  answerLogin: (keep: boolean) => invoke<void>("answer_login", { keep }),
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
  skills: (cwd: string | null) => invoke<Skill[]>("skills", { cwd }),
  ghPrs: () => invoke<PrLists>("gh_prs"),
  /** Shows tab `tab` (created on first use) at `url` and hides the other tabs. */
  /// Shows `tab`, hiding the other tabs but `keep` (the focus mode's other side).
  /// With `go` it is sent to `url`; else a tab already open stays on its page.
  browserOpen: (tab: string, url: string, r: Rect, go: boolean, keep?: string) => invoke<void>("browser_open", { tab, url, ...r, go, keep: keep ?? null }),
  browserBounds: (tab: string, r: Rect) => invoke<void>("browser_bounds", { tab, ...r }),
  /// Hides `tab`, or every tab.
  browserHide: (tab?: string) => invoke<void>("browser_hide", { tab: tab ?? null }),
  browserClose: (tab: string) => invoke<void>("browser_close", { tab }),
  /// With `input`, the page's text box takes the typing too.
  browserFocus: (tab: string, input?: boolean, text?: string) => invoke<void>("browser_focus", { tab, input: input ?? null, text: text ?? null }),
  browserUrl: (tab: string) => invoke<string | null>("browser_url", { tab }),
  browserGo: (tab: string, action: "back" | "forward" | "reload") => invoke<void>("browser_go", { tab, action }),
  browserZoom: (tab: string, action: "in" | "out" | "reset") => invoke<void>("browser_zoom", { tab, action }),
};

/// What the note is made as (`NoteFormat` in launch.rs).
export type NoteFormat = "page" | "docs" | "slides" | "design";

export interface NoteStart {
  session: string;
  run: TerminalRun | null;
}

/** `{tab, url}` after a tab navigates. */
export const BROWSER_URL_EVENT = "browser-url";
/** `{tab, delta}` (-1 or 1) when a page asks for the previous or next tab (⌘⇧[ ⌘⇧]). */
export const BROWSER_SWITCH_TAB_EVENT = "browser-switch-tab";
/** When ⌘W in the app menu asks to close the shown tab. */
export const BROWSER_CLOSE_TAB_EVENT = "browser-close-tab";
/** When the window's focus changes (another app, or a browser tab, took the keyboard). */
export const WINDOW_FOCUS_EVENT = "window-focus";
/** `{tab}` when a page's ⌃l asks for the focus mode's right side. */
export const FOCUS_PANE_EVENT = "focus-pane";
/** `{url, title}` when a link is ⌥-clicked in a page, to keep as an input todo. */
export const ADD_INPUT_EVENT = "add-input";
/** When a page's Esc, in the focus mode, asks about leaving it. */
export const FOCUS_EXIT_EVENT = "focus-exit";
/** When a page's ⌃h hands the typing back to the app's side. */
export const FOCUS_APP_EVENT = "focus-app";
/** `{tab}` when a page takes the keyboard in the Input mode. */
export const PAGE_FOCUSED_EVENT = "page-focused";
/** When a page's ⌘K asks for the app's commands. */
export const OPEN_PALETTE_EVENT = "open-palette";
/** `{host, user}` when a page sent a login not kept yet: asked whether to keep it (answerLogin). */
export const LOGIN_CAPTURED_EVENT = "login-captured";
/** When a page's ⌘⇧K asks for the list of sessions. */
export const OPEN_SESSIONS_EVENT = "open-sessions";
/** `{subject}` when a notification says it is time to explain the subject again. */
export const OPEN_STUDY_EVENT = "open-study";
/// A review went in: `{url, title, verdict}` (APPROVED, CHANGES_REQUESTED or COMMENTED).
export const REVIEW_SUBMITTED_EVENT = "review-submitted";
/** `{tab}` when a cloud session's page asks to archive it (⌘⇧A). */
export const BROWSER_ARCHIVE_EVENT = "browser-archive";
/** `{tab}` when a page asks to go into an input (⌘⇧D). */
export const BROWSER_TO_INPUT_EVENT = "browser-to-input";
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
/** claude.ai's Claude Code page, shown while a new cloud session is created. */
export const CLOUD_HOME = "https://claude.ai/code";

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
