import { invoke } from "@tauri-apps/api/core";
import type { TerminalRun } from "./Terminal";

export type Status = "todo" | "doing" | "review" | "pending" | "done";
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
}

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

/** What a page asked onto the focus mode's left is judged against. */
export interface FocusAsk {
  /** The todo the focus mode was opened for, and its memo. */
  subject: string | null;
  memo: string | null;
  /** The left's pages. */
  pages: { title: string | null; url: string }[];
  url: string;
  /** The text of the link that asked. */
  text: string | null;
}

/** How likely the page is the focus mode's work (Jev's, in percent), and its title. */
export interface Verdict {
  score: number;
  title: string | null;
}

/** judgeFocusLink's error when Jev has no API key (crates/core relevance::NO_KEY). */
export const JEV_NO_KEY = "Jev の API キーが設定されていません";

export type PrState = "draft" | "open" | "review_requested" | "changes_requested" | "approved" | "merged" | "closed";

export type Runner = "auto" | "cloud" | "local";
export type Kind = "implementation" | "research" | "input";

/** A notification the app posted, kept for the in-app list. */
export interface Notice {
  id: number;
  session_id: string;
  todo_id: number | null;
  kind: "finished" | "needs_input" | "review_requested";
  title: string;
  created_at: number;
  read: boolean;
  /// The PR of a review request; its session_id is empty.
  url: string | null;
}

export interface Board {
  todos: Todo[];
  inbox: Session[];
  /** Newest first. */
  notifications: Notice[];
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

export interface ToolCall {
  name: string;
  summary: string;
}

/** What a session is doing, from its transcript or cloud events. */
export interface SessionDetail {
  model: string | null;
  context_tokens: number | null;
  last_text: string | null;
  /** Newest first. */
  tools: ToolCall[];
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

export interface PrLists {
  review: Pr[];
  mine: Pr[];
}

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
  quickClaude: (prompt: string, cwd?: string, title?: string) => invoke<void>("quick_claude", { prompt, cwd: cwd ?? null, title: title ?? null }),
  /// A PR review in a cloud session linked to no todo; returns its id.
  startReviewCloud: (repo: string, title: string, prompt: string, desktop: boolean) => invoke<string>("start_review_cloud", { repo, title, prompt, desktop }),
  startDesktopPrompt: (cwd: string | undefined, prompt: string) => invoke<void>("start_desktop_prompt", { cwd: cwd ?? null, prompt }),
  syncNow: (todoId?: number) => invoke<void>("sync_now", { todoId: todoId ?? null }),
  openLink: (url: string) => invoke<void>("open_link", { url }),
  openInDia: (url: string) => invoke<void>("open_in_dia", { url }),
  herdrSessions: () => invoke<HerdrSessions>("herdr_sessions"),
  setHerdrSession: (name: string | null) => invoke<void>("set_herdr_session", { name }),
  addLink: (todoId: number, url: string) => invoke<Link>("add_link", { todoId, url }),
  removeLink: (id: number) => invoke<void>("remove_link", { id }),
  openSession: (sessionId: string, target?: "desktop" | "herdr") => invoke<void>("open_session", { sessionId, target }),
  startDesktop: (todoId: number) => invoke<void>("start_desktop", { todoId }),
  windowFocused: () => invoke<boolean>("window_focused"),
  setFocusMode: (on: boolean) => invoke<void>("set_focus_mode", { on }),
  /// The app's keys (keymap.ts), as JSON, for the pages' script.
  setPageKeys: (keys: string) => invoke<void>("set_page_keys", { keys }),
  /// Where tab `tab`'s page may go in the focus mode (address prefixes); null lifts it.
  setFocusAllow: (tab: string, allow: string[] | null) => invoke<void>("set_focus_allow", { tab, allow }),
  judgeFocusLink: (ask: FocusAsk) => invoke<Verdict>("judge_focus_link", { ask }),
  /// Jev's API key, kept in the Keychain; an empty one takes it out.
  jevKeyExists: () => invoke<boolean>("jev_key_exists"),
  setJevKey: (key: string) => invoke<void>("set_jev_key", { key }),
  /// Archives cloud sessions (`cse_…`), as claude.ai does.
  archiveSessions: (ids: string[]) => invoke<void>("archive_sessions", { ids }),
  /// A session making the focus mode's note of `urls` for the todo; locally, the
  /// in-app terminal gets the command to run (`run`), herdr runs it itself.
  startNote: (todoId: number, urls: string[], format: NoteFormat, cloud: boolean) => invoke<NoteStart>("start_note", { todoId, urls, format, cloud }),
  /// The note the session published, once it has (kept as a link of the todo).
  noteUrl: (todoId: number, sessionId: string) => invoke<string | null>("note_url", { todoId, sessionId }),
  startTerminal: (todoId: number, options?: StartOptions) => invoke<void>("start_terminal", { todoId, options: options ?? null }),
  /** Starts a cloud session and returns its id; `desktop` also opens it in Claude Desktop. */
  startCloud: (todoId: number, options: StartOptions | undefined, desktop: boolean) => invoke<string>("start_cloud", { todoId, options: options ?? null, desktop }),
  /** Marks one notification read, or all with no id. */
  readNotifications: (id?: number) => invoke<void>("read_notifications", { id: id ?? null }),
  setParent: (todoId: number, parentId: number | null) => invoke<Todo>("set_parent", { todoId, parentId }),
  sessionDetail: (sessionId: string) => invoke<SessionDetail>("session_detail", { sessionId }),
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
};

/// What the note is made as (`NoteFormat` in launch.rs).
export type NoteFormat = "page" | "docs" | "slides" | "design";

export interface NoteStart {
  session: string;
  run: TerminalRun | null;
}

/** `{tab, url}` after a tab navigates. */
export const BROWSER_URL_EVENT = "browser-url";
/** `-1` or `1` when a page asks for the previous or next tab (⌘⇧[ ⌘⇧]). */
export const BROWSER_SWITCH_TAB_EVENT = "browser-switch-tab";
/** When ⌘W in the app menu asks to close the shown tab. */
export const BROWSER_CLOSE_TAB_EVENT = "browser-close-tab";
/** When the window's focus changes (another app, or a browser tab, took the keyboard). */
export const WINDOW_FOCUS_EVENT = "window-focus";
/** `{tab}` when a page's ⌃l asks for the focus mode's right side. */
export const FOCUS_PANE_EVENT = "focus-pane";
/** `{url, title}` when a link is ⌥-clicked in a page, to keep as an input todo. */
export const ADD_INPUT_EVENT = "add-input";
/** `{tab, url, text}` when a page, in the focus mode, is asked to go where it may not (`text` the link's). */
export const FOCUS_LINK_EVENT = "focus-link";
/** When a page's Esc, in the focus mode, asks about leaving it. */
export const FOCUS_EXIT_EVENT = "focus-exit";
/** When a page's ⌃h hands the typing back to the app's side. */
export const FOCUS_APP_EVENT = "focus-app";
/** When a page's ⌘K asks for the app's commands. */
export const OPEN_PALETTE_EVENT = "open-palette";
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
/** `{session_id}` of a cloud session picked in the menu bar or a notification. */
export const OPEN_CLOUD_EVENT = "open-cloud";
/** `{url}` for a link a page opens in a new window; it becomes a new tab. */
export const BROWSER_NEW_TAB_EVENT = "browser-new-tab";

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
