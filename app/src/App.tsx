import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  ago,
  api,
  BROWSER_ADDRESS_EVENT,
  BROWSER_FOCUS_URL_EVENT,
  BROWSER_OPEN_NEW_TAB_EVENT,
  BROWSER_SWITCH_TAB_EVENT,
  BROWSER_CLOSE_TAB_EVENT,
  BROWSER_ARCHIVE_EVENT,
  OPEN_PALETTE_EVENT,
  OPEN_SESSIONS_EVENT,
  READING_ADDED_EVENT,
  SPACE_EVENT,
  REVIEW_SUBMITTED_EVENT,
  OPEN_TODO_EVENT,
  OPEN_SLACK_EVENT,
  BROWSER_TRANSLATED_EVENT,
  type ReviewRunner,
  LOGIN_CAPTURED_EVENT,
  FOCUS_APP_EVENT,
  PAGE_FOCUSED_EVENT,
  FOCUS_PANE_EVENT,
  WINDOW_FOCUS_EVENT,
  BROWSER_NEW_TAB_EVENT,
  OPEN_URL_EVENT,
  OPENED_EVENT,
  OPEN_NEW_TODO_EVENT,
  BROWSER_DOWNLOADED_EVENT,
  PAGE_DIALOG_EVENT,
  SITE_PERMISSION_EVENT,
  OPEN_CLOUD_EVENT,
  BROWSER_TITLE_EVENT,
  BROWSER_ZOOM_EVENT,
  BROWSER_URL_EVENT,
  cloudWebUrl,
  EFFORTS,
  isCloud,
  issueRef,
  MODELS,
  type Board,
  type Database,
  type DigestView,
  type Reading,
  type ReadingKind,
  type ReadingSort,
  type Issue,
  type HerdrSessions,
  type JevCredit,
  type JevSpend,
  type Limit,
  type LocalRepo,
  type Check,
  type Pr,
  type PrLists,
  type Review,
  type PrState,
  type CiState,
  type TodoEvent,
  type Artifact,
  type MutedChannel,
  type SlackAccount,
  type SlackMentionable,
  type SlackChannel,
  type SlackAttachment,
  type SlackThreadMessage,
  type SlackView,
  SLACK_POSTED_EVENT,
  type Session,
  type SessionState,
  type StartOptions,
  type Status,
  type Todo,
  type Agent,
} from "./api";
import { TYPING, useTodoKeys } from "./todoKeys";
import { emojiChoices, emojiInline, parseSlack, slackPlain, type Inline } from "./slackText";
import { nameToEmoji } from "gemoji";
import { bookmarkItems, slackItems, type SlackItem } from "./slackItems";
// The app's icon (src-tauri/icons/icon.svg), as the sidebar's logo too.
import logoUrl from "../src-tauri/icons/icon.svg?url";
import { ACTIONS, allKeys, keyLabel, keyOf, matches, type Action } from "./keymap";
import { addressToUrl, fileUrl, findTabFor, insertAfter, isSplitRight, nextAfterClose, pathOfFileUrl, SEARCH_URL } from "./tabs";
import { opensOutside } from "./outside";
import { shortMoney } from "./usage";
import { arrange, latestFirst, moveTo } from "./order";
import { ciFailureLine, isFailedReview, isReviewAsk, nextStep, prRef, waitingOnYou, type WaitItem } from "./waiting";
import { effectiveLaunch, launchPrefsFrom, planByDefault, type Launch, type LaunchPrefs } from "./launch";
import { focusRequestCount, focusSoon, noteFocusRequest, takeFocusWish, userActed } from "./focus";
import { closeTerminal, focusTerminal, SessionTitleContext, setTerminalLinkOpener, terminalLinks, terminalSelection, OPEN_LOCAL_EVENT, TERMINAL_TARGET_KEY, terminalApi, TerminalView, type TerminalRun, type TerminalTarget } from "./Terminal";

const REFRESH_MS = 3000;
/// The usage API answers 429 when asked often (status lines poll it too), so
/// it is asked rarely once there are numbers, which then stay on errors.
const USAGE_REFRESH_MS = 5 * 60_000;
/// Until the first numbers arrive, asked again this soon.
const USAGE_RETRY_MS = 60_000;
const PR_REFRESH_MS = 5 * 60_000;
/// How long the focus events are let settle before marking the typing's side.
const FOCUS_SETTLE_MS = 120;
/// The shown tab's address is checked this often, for pages that move
/// without loading or changing their title.
const ADDRESS_POLL_MS = 500;
/// A tab (or 作業's row) starts moving once the pointer has gone this far with the button down.
const DRAG_START_PX = 4;

/// The window is on screen. Closing it only hides it (the app goes on
/// behind, back from the Dock), and there is no point polling for a page nobody sees.
const pageVisible = () => document.visibilityState === "visible";

/// Runs `f` whenever the window comes back on screen.
function useOnVisible(f: () => void) {
  const ref = useRef(f);
  ref.current = f;
  useEffect(() => {
    const onChange = () => pageVisible() && ref.current();
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
}
/// The local checkouts are looked for again at most this often on the window's focus.
const LOCAL_REPOS_REFRESH_MS = 10_000;
/// Pointer must move this far before a click turns into a drag.
const DRAG_DISTANCE_PX = 6;
/// Done cards kept per lane while "Done は直近のみ" is on.
const VIEW_KEY = "view";
const LAYOUT_KEY = "layout";
const COLLAPSED_KEY = "collapsedLanes";
const GROUP_KEY = "groupBy";
/// The launch sheet's choice from before LAUNCH_KEY, carried over once.
const START_KEY = "startChoice";
/// How todos last started, apart for planning and implementing (launch.ts).
const LAUNCH_KEY = "launchPrefs";
const REVIEW_RUNNER_KEY = "reviewRunner";
const HERDR_SESSION_KEY = "herdrSession";

/// The spaces (場), each the home of one kind of object: 管理 the todos,
/// PRs, artifacts and Slack; 作業 the sessions; 学習 the readings; ブラウザ
/// the pages. ⌘1–⌘4 go to them, and each shows what it showed last.
type Space = "manage" | "work" | "study" | "browser";
const SPACE_KEY = "space";

/// 管理's pages. `doing`: the Todo page's list of what is Doing (today's work), on its own;
/// `db:<id>`: the Todo page's todos in a database the user made (Frontend Backlog).
type View = "todos" | "doing" | "prs" | "artifacts" | "slack" | `db:${number}`;
const PAGES = ["todos", "doing", "prs", "artifacts", "slack"] as const;
const dbView = (id: number): View => `db:${id}`;
/// The database view `v` shows, if it shows one.
const dbOfView = (v: View) => (v.startsWith("db:") ? Number(v.slice("db:".length)) : null);
/// 管理's page as last left (a database's too).
const loadView = (): View => {
  const v = loadText(VIEW_KEY);
  return (PAGES as readonly string[]).includes(v) || /^db:\d+$/.test(v) ? (v as View) : "todos";
};
/// The sidebar's groups, in its order.
type NavGroup = "仕事" | "DB" | "連絡";
const NAV_GROUPS: NavGroup[] = ["仕事", "DB", "連絡"];
type Layout = "board" | "list";
type GroupBy = "repo" | "parent";

const GROUPINGS: { key: GroupBy; label: string }[] = [
  { key: "repo", label: "リポジトリ" },
  { key: "parent", label: "親 Todo" },
];

/// Opens a page in the browser space (a new tab, or the one opened for it),
/// which comes up with it.
type OpenInBrowser = (url: string) => void;
const BrowserContext = createContext<OpenInBrowser | null>(null);

/// Opens the work space at a todo (its sessions: a parent's planning one and
/// its subtasks') or at a session.
type OpenWork = (at: { todo: number } | { session: string }) => void;
const WorkContext = createContext<OpenWork | null>(null);

/// Where "開く" takes a cloud session: its page in the work space, or Claude Desktop.
type CloudTarget = "web" | "desktop";
const CLOUD_TARGET_KEY = "cloudTarget";
const OpenCloudContext = createContext<((sessionId: string) => void) | null>(null);

/// 「再開して直させる」: sends the todo's session what to fix in its PR.
type FixInSession = (session: Session, todo: Todo) => void;
const FixContext = createContext<FixInSession | null>(null);

/// With the in-app terminal chosen: shows a run in the work space, and brings
/// up the session a terminal there runs already (false when there is none).
interface InAppTerminal {
  /// Shows `run` in the work space; `focus` (opening, not starting) brings it up with the keyboard.
  open: (run: TerminalRun, focus?: boolean) => void;
  focus: (sessionId: string) => boolean;
}
const TerminalContext = createContext<InAppTerminal | null>(null);
/// Opens a local session in herdr, or in the work space when the in-app
/// terminal is chosen; one still running comes to the front where it runs.
/// `main` is "開く": with herdr it falls back to Desktop, and with the
/// in-app terminal a session Desktop knows opens there.
function openLocal(terminal: InAppTerminal | null, sessionId: string, report: (e: unknown) => void, main = false) {
  api.markSessionSeen(sessionId).catch(report);
  if (!terminal) return void api.openSession(sessionId, main ? undefined : "herdr").catch(report);
  if (terminal.focus(sessionId)) return;
  terminalApi.resume(sessionId, main).then((r) => r && terminal.open(r, true), report);
}

const COLUMNS: { status: Status; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "Todo" },
  { status: "doing", label: "Doing" },
  { status: "review", label: "Review" },
  { status: "pending", label: "Pending" },
  { status: "done", label: "Done" },
];

const STATE_LABEL: Record<SessionState, string> = {
  running: "作業中",
  needs_input: "返事待ち",
  idle: "ひと区切り",
  ended: "終了",
};
/// Where a todo's PR stands, apart from its sessions: its badge's class and name.
const PR_STAGE: Record<PrState, [string, string]> = {
  draft: ["draft", "Draft"],
  open: ["pr_open", "レビュー未依頼"],
  review_requested: ["review", "レビュー待ち"],
  changes_requested: ["changes", "修正依頼"],
  approved: ["approved", "承認済み"],
  merged: ["merged", "マージ済み"],
  closed: ["ended", "closed"],
};
const prStageLabel = (todo: Todo | undefined) => (todo?.pr_state ? PR_STAGE[todo.pr_state][1] : null);

/// The state that needs the user comes first.
const STATE_ORDER: SessionState[] = ["needs_input", "running", "idle", "ended"];

/// Status order for the list: what is in progress first, done last.
const STATUS_RANK: Record<Status, number> = { review: 0, doing: 1, todo: 2, pending: 3, backlog: 4, done: 5 };

const PR_LABEL: Record<PrState, string> = {
  draft: "Draft",
  open: "PR open",
  review_requested: "レビュー待ち",
  changes_requested: "修正依頼",
  approved: "Approve 済み",
  merged: "マージ済み",
  closed: "PR closed",
};

/// Todos without a repository share this lane; picking one moves them out.
const NO_REPO_LANE = "リポジトリなし";
/// Grouped by parent, top-level todos without subtasks share this lane.
const ORPHAN_LANE = "親なし";
/// The title of a session reviewing a PR.
const REVIEW_TITLE_PREFIX = "レビュー: ";
/// A PR review's session (started from the PR page; linked to no todo), by
/// its title: the app's, Claude's /review prompt, or Codex's review prompt.
const isReviewSession = (s: Session) =>
  s.todo_id === null &&
  (!!s.review_url || (!!s.title && (s.title.startsWith(REVIEW_TITLE_PREFIX) || s.title.startsWith("/review ") || /^PR https:\/\/github\.com\/\S+\/pull\/\d+ をレビュー/.test(s.title))));
/// The session lists leave out reviews and routines (one asking is in
/// あなた待ち; the routines have a filter of their own), and sessions put
/// away (⌘⇧A, or a review once it is in) unless they ask.
const listedSession = (s: Session) => (!isReviewSession(s) || s.state === "needs_input") && (!s.routine || s.state === "needs_input") && (!s.hidden || s.state === "needs_input");

/// Lanes that start folded, and the ones already folded once on this machine
/// (so a lane added to the list later folds too, and stays open once opened).
const FOLDED_BY_DEFAULT = [NO_REPO_LANE];
const FOLDED_ONCE_KEY = "lanesFoldedOnce";

function loadCollapsed(): Set<string> {
  const collapsed = new Set(loadJson<string[]>(COLLAPSED_KEY, []));
  // Saved lanes from before this list existed already had the no-repository lane's default.
  const saved = loadJson<string[] | null>(COLLAPSED_KEY, null) !== null;
  const once = new Set(loadJson<string[]>(FOLDED_ONCE_KEY, saved ? [NO_REPO_LANE] : []));
  for (const lane of FOLDED_BY_DEFAULT.filter((l) => !once.has(l))) {
    collapsed.add(lane);
    once.add(lane);
  }
  remember(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  remember(FOLDED_ONCE_KEY, JSON.stringify([...once]));
  return collapsed;
}

const GITHUB = "https://github.com/";

/// Only todos move by drag, and only onto columns. The point is the centre
/// of the dragged item rather than the pointer, whose coordinates did not
/// match the droppables inside the Tauri webview.
const collision: CollisionDetection = ({ collisionRect, droppableRects, droppableContainers }) => {
  const x = collisionRect.left + collisionRect.width / 2;
  const y = collisionRect.top + collisionRect.height / 2;
  return droppableContainers
    .filter((c) => {
      const r = droppableRects.get(c.id);
      return r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    })
    .map((c) => ({ id: c.id }));
};

/// The lane a todo or session belongs to: its first repository, where its
/// sessions push, or the no-repository lane.
const laneKey = (repos: string[] | undefined) => repos?.[0] ?? NO_REPO_LANE;

/// "Atrae/wevox-rest-bff" → "wevox-rest-bff" for compact tags.
const repoName = (repo: string) => repo.split("/").pop() ?? repo;

const isGithubRepo = (key: string) => key.includes("/");

/// A stable hue per repository for its dot.
function repoHue(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function basename(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/// `~/…` for a path under the home folder, for display.
function tildify(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function sessionLabel(s: Session) {
  return s.title ?? s.session_id.slice(0, 12);
}

const liveSessions = (t: Todo) => t.sessions.filter((s) => s.state !== "ended");

/// Where a todo's GitHub button goes: its PR, else its issue, else its repository.
function githubTarget(todo: Todo): string | null {
  const repo = todo.repos.find(isGithubRepo);
  return todo.pr_url ?? todo.issue_url ?? (repo ? GITHUB + repo : null);
}

/// "wevox-mono-web#11766" for an issue or PR URL, else "#<todo id>".
function todoRef(todo: Todo): string {
  const ref = issueRef(todo.issue_url) ?? issueRef(todo.pr_url);
  return ref ? repoName(ref) : `#${todo.id}`;
}

const isoAgo = (iso: string) => ago(Math.floor(Date.parse(iso) / 1000));

function load<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/// A text kept as it was written ("" when none is kept).
function loadText(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

/// Per-viewer conveniences; losing them is fine.
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

const PANEL_W_KEY = "panelWidth";
const PANEL_DEFAULT_W = 440;
const DOCK_MIN_W = 360;
/// The split views' (作業・学習) right side: its width, and the share of the window it starts at.
const FOCUS_RIGHT_W_KEY = "focusRightWidth";
const FOCUS_RIGHT_SHARE = 0.45;
/// The browser space's tab list: its width.
const TAB_LIST_W_KEY = "tabListWidth";
const TAB_LIST_DEFAULT_W = 248;
const TAB_LIST_MIN_W = 180;
const TAB_LIST_MAX_W = 420;
/// The work space's list of what runs: its width.
const WORK_RAIL_W_KEY = "workRailWidth";
const WORK_RAIL_DEFAULT_W = 300;
const RAIL_MIN_W = 200;
const RAIL_MAX_W = 480;
/// How often a parent's 経過 is read again while its sheet is open.
const EVENTS_REFRESH_MS = 5000;
/// How long a short note at the bottom ("読みものに入れました") stays.
const TOAST_MS = 4000;
/// How long the toast about a finished download stays.
const DOWNLOADED_MS = 8000;
/// A page's alert, confirm or prompt (PAGE_DIALOG_EVENT).
interface PageDialogAsk {
  id: number;
  tab: string;
  kind: "alert" | "confirm" | "prompt";
  message: string;
  default: string;
}
/// A site's first ask for the microphone or camera (SITE_PERMISSION_EVENT).
interface SiteAsk {
  id: number;
  site: string;
  camera: boolean;
}
/// The browser space's tabs as kept across restarts (PANE_TABS_KEY): their pages, and the one shown.
interface SavedTabs {
  /// `pinned` is the pinned page's id.
  tabs: { url: string; openedFor?: string; title: string | null; pinned?: string }[];
  active: number;
}
const PANE_TABS_KEY = "paneTabs";
/// The split views' left side keeps at least this.
const FOCUS_LEFT_MIN_W = 360;
/// Arrow keys on a resizer move it this far.
const RESIZE_STEP = 24;

/// Sent on the window when a drag on a Resizer ends.
const PANE_RESIZED_EVENT = "pane-resized";
/// On the body while a Resizer is dragged.
const RESIZING_CLASS = "resizing";

/// A strip on a pane's left edge (a list's right edge, with `edge`);
/// dragging it (or the arrow keys) sets the pane's width, the CSS variable
/// `cssVar` on the app. While dragging only that variable moves, once a
/// frame; `onResize` (a re-render) runs on release.
function Resizer({ label, cssVar, width, min, max, onResize, edge = "left" }: {
  label: string;
  cssVar: string;
  width: number;
  min: number;
  max: () => number;
  onResize: (w: number) => void;
  edge?: "left" | "right";
}) {
  const clamp = (w: number) => Math.round(Math.min(max(), Math.max(min, w)));
  // Toward the pane's own side it grows.
  const grow = edge === "left" ? -1 : 1;
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const app = (e.currentTarget as HTMLElement).closest<HTMLElement>(".app");
    const startX = e.clientX;
    let next = width;
    let frame = 0;
    const move = (ev: PointerEvent) => {
      next = clamp(width + grow * (ev.clientX - startX));
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        app?.style.setProperty(cssVar, `${next}px`);
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      cancelAnimationFrame(frame);
      document.body.classList.remove(RESIZING_CLASS);
      onResize(next);
      // The browser pane kept its page's size while dragging; now it may change.
      requestAnimationFrame(() => window.dispatchEvent(new Event(PANE_RESIZED_EVENT)));
    };
    document.body.classList.add(RESIZING_CLASS);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className={`resizer${edge === "right" ? " right-edge" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onResize(clamp(width - grow * RESIZE_STEP));
        if (e.key === "ArrowRight") onResize(clamp(width + grow * RESIZE_STEP));
      }}
    />
  );
}

/// keyCode of a key the IME handles.
const IME_KEY_CODE = 229;

/// Enter that submits, not the one that confirms a Japanese IME conversion.
/// WebKit ends the composition before that keydown, so isComposing is already
/// false there; only keyCode 229 gives it away.
const isEnter = (e: React.KeyboardEvent) => e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== IME_KEY_CODE;

interface Lane {
  key: string;
  todos: Todo[];
  /// Set when the lane holds one parent's subtasks; the parent is its header.
  parent?: Todo;
  /// Set for a repository or group lane.
  repo?: string;
}

/// Grouped by repository: one lane per first repository, groups ("調査")
/// first, the no-repository lane last. Grouped by parent: one lane per
/// parent with its subtasks, then the other top-level todos without
/// subtasks, then the review todos;
/// `allTodos` finds parents the filters hid.
function buildLanes(todos: Todo[], groupBy: GroupBy, allTodos: Todo[]): Lane[] {
  const lanes = new Map<string, Lane>();
  const add = (key: string, t: Todo, extra: Partial<Lane>) => {
    let l = lanes.get(key);
    if (!l) lanes.set(key, (l = { key, todos: [], ...extra }));
    l.todos.push(t);
  };
  if (groupBy === "parent") {
    const hasChildren = new Set(allTodos.map((t) => t.parent_id));
    for (const t of todos) {
      const parent = allTodos.find((p) => p.id === t.parent_id);
      if (parent) add(`parent:${parent.id}`, t, { parent });
      else if (!hasChildren.has(t.id)) add(ORPHAN_LANE, t, {});
    }
    // Parents in id order, then the rest.
    const rank = (l: Lane) => l.parent?.id ?? Number.MAX_SAFE_INTEGER;
    return [...lanes.values()].sort((a, b) => rank(a) - rank(b));
  }
  for (const t of todos) {
    const key = laneKey(t.repos);
    add(key, t, { repo: key });
  }
  const rank = (key: string) => (key === NO_REPO_LANE ? 2 : isGithubRepo(key) ? 1 : 0);
  return [...lanes.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key, "en", { sensitivity: "base" }));
}

type IconName =
  | "board" | "list" | "spark" | "pr" | "search" | "sync" | "check" | "plus" | "import" | "close" | "open"
  | "up" | "down" | "chevron" | "chevronRight" | "more" | "back" | "forward" | "reload" | "chat"
  | "globe" | "terminal" | "book" | "bookmark" | "key" | "settings";

const ICON_PATHS: Record<IconName, string> = {
  board: "M4 4h6v16H4zM14 4h6v9h-6z",
  list: "M4 6h16M4 12h16M4 18h10",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  pr: "M6 4v16M18 11v9M18 11c0-3-2-5-5-5H9M12 3L9 6l3 3",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM20 20l-4-4",
  check: "M5 12l4 4 10-10",
  sync: "M20 11a8 8 0 0 0-14-5l-2 2M4 13a8 8 0 0 0 14 5l2-2M4 4v4h4M20 20v-4h-4",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  chevron: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  import: "M12 4v11M7 10l5 5 5-5M4 19h16",
  close: "M6 6l12 12M18 6L6 18",
  open: "M7 17L17 7M9 7h8v8",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  back: "M15 6l-6 6 6 6",
  forward: "M9 6l6 6-6 6",
  reload: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
  globe: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  terminal: "M4 5h16v14H4zM8 10l3 2.5L8 15M13 15h3",
  book: "M4 5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4zM20 5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z",
  bookmark: "M7 4h10v16l-5-4-5 4z",
  key: "M14 4a6 6 0 1 0 0.01 0M11 12l-7 7M6 17l2 2",
  settings: "M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4",
};

function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "more" ? 3 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/// Linear-style status mark: dashed, empty, half, three quarters, checked.
function StatusIcon({ status }: { status: Status }) {
  if (status === "done") {
    return (
      <svg className="status-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="var(--st-done)" />
        <path d="M8 12.5l2.8 2.8L16.5 9.5" fill="none" stroke="var(--bg)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  const color = `var(--st-${status})`;
  if (status === "backlog") {
    return (
      <svg className="status-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" fill="none" stroke={color} strokeWidth="2.2" strokeDasharray="3.2 2.6" />
      </svg>
    );
  }
  if (status === "pending") {
    return (
      <svg className="status-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" fill="none" stroke={color} strokeWidth="2.2" strokeDasharray="3.2 2.6" />
        <path d="M10 9v6M14 9v6" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  const fill = { todo: null, doing: "M12 7a5 5 0 0 1 0 10z", review: "M12 7a5 5 0 1 1-5 5h5z" }[status];
  return (
    <svg className="status-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" fill="none" stroke={color} strokeWidth="2.2" />
      {fill && <path d={fill} fill={color} />}
    </svg>
  );
}

/// A session's state in a shape and a word; a turn ended and not looked at
/// yet (as herdr marks it) is 新着.
function StateBadge({ state, unread }: { state: SessionState; unread?: boolean }) {
  const fresh = unread && state === "idle";
  return (
    <span className={`state state-${state}${fresh ? " state-unread" : ""}`} title={fresh ? "ひと区切りしてから、まだ見ていません" : undefined}>
      <i />
      {fresh ? "新着" : STATE_LABEL[state]}
    </span>
  );
}

function RepoDot({ repo }: { repo: string }) {
  const bg = repo === NO_REPO_LANE ? "var(--text-3)" : `hsl(${repoHue(repo)} 70% 64%)`;
  return <span className="repo-dot" style={{ background: bg }} />;
}

/// Clicks inside cards and rows must not also select them or start a drag.
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/// Opens a link in the browser pane (the default browser outside the app's tree of providers).
function useOpenLink(report: (e: unknown) => void) {
  const openInBrowser = useContext(BrowserContext);
  return (url: string) => (openInBrowser ? openInBrowser(url) : api.openLink(url).catch(report));
}

/// Issue or PR chip; the PR wins when there is one. Opens it in the browser pane.
function GhChip({ todo, report }: { todo: Todo; report: (e: unknown) => void }) {
  const openLink = useOpenLink(report);
  const [url, label, cls] = todo.pr_url
    ? [todo.pr_url, todo.pr_state ? PR_LABEL[todo.pr_state] : "PR", `gh-pr-${todo.pr_state ?? "open"}`]
    : todo.issue_url
      ? [todo.issue_url, `issue ${todo.issue_state ?? ""}`.trim(), `gh-issue-${todo.issue_state ?? "open"}`]
      : [null, "", ""];
  if (!url) return null;
  return (
    <button
      className={`gh ${cls}`}
      title={url}
      onPointerDown={stop}
      onClick={(e) => {
        e.stopPropagation();
        openLink(url);
      }}
    >
      {label}
    </button>
  );
}

/// What a PR's CI says, in words (the colour backs it).
const CI_LABEL: Record<CiState, string> = { pending: "CI 実行中", success: "CI 成功", failure: "CI 失敗" };

/// The CI of a todo's open PR, in words; nothing without checks or once the PR is done.
function CiChip({ todo }: { todo: Todo }) {
  if (!todo.ci_state || !todo.pr_url || todo.pr_state === "merged" || todo.pr_state === "closed") return null;
  return (
    <span className={`gh ci-${todo.ci_state}`} title={todo.ci_state === "failure" ? ciFailureLine(todo) : undefined}>
      {CI_LABEL[todo.ci_state]}
      {todo.ci_state === "failure" && todo.ci_failed.length > 0 && ` ${todo.ci_failed.length}`}
    </span>
  );
}

/// "親 #3", "サブ 1/4 完了" or "+1 リポジトリ": how the todo relates to others.
function relationLabel(todo: Todo, allTodos: Todo[]): string | null {
  if (todo.parent_id) return `親 #${todo.parent_id}`;
  const children = allTodos.filter((c) => c.parent_id === todo.id);
  if (children.length > 0) return `サブタスク ${children.filter((c) => c.status === "done").length}/${children.length}`;
  if (todo.repos.length > 1) return `+${todo.repos.length - 1} リポジトリ`;
  return null;
}

/// Closes a menu when the pointer goes down outside `root`.
function useOutsideClose(root: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && close();
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

/// ↓ (or the down key, j, or the menu's ⌃j) is 1, ↑ (or k, ⌃k) -1, else 0.
const stepOf = (e: KeyboardEvent) => {
  const arrow = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  return (arrow && e.key === "ArrowDown") || matches(e, "down") || matches(e, "paletteDown") ? 1 : (arrow && e.key === "ArrowUp") || matches(e, "up") || matches(e, "paletteUp") ? -1 : 0;
};

/// A menu that takes the keyboard when it opens: ↑↓ or j k move, Enter
/// picks, Esc closes. Spread `menuKeys` on the element with role="menu".
/// The menu itself holds the focus and marks its item with `data-active`
/// (WebKit does not focus buttons, so the items cannot take it).
function useMenuKeys(open: boolean, close: () => void, first = 0) {
  const ref = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(first);
  const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
  useEffect(() => {
    if (!open) return;
    setActive(first);
    ref.current?.focus();
  }, [open]);
  useEffect(() => {
    items().forEach((el, i) => el.toggleAttribute("data-active", i === active));
  });
  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = items().length;
    const step = stepOf(e.nativeEvent);
    if (step && n > 0) {
      e.preventDefault();
      setActive((a) => (a + step + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      items()[active]?.click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  };
  // The pointer marks the item it is over, so it and the keys agree.
  const onMouseMove = (e: React.MouseEvent) => {
    const i = items().indexOf((e.target as HTMLElement).closest<HTMLButtonElement>("[role=menuitem]")!);
    if (i >= 0 && i !== active) setActive(i);
  };
  return { ref, onKeyDown, onMouseMove, tabIndex: -1 };
}

/// A keyboard cursor over a page's rows (elements with `data-row` inside
/// `list`): ↑↓ or j k move it, Enter calls `onEnter` (⌥Enter with `alt`).
/// Other keys go to `onKey` (with no row when the list is empty, so a filter
/// that emptied it can still be switched back), which says whether it took the key.
/// Keys typed into fields, dialogs, menus and terminals are left alone.
function useRowCursor(
  ids: string[],
  onEnter: (id: string, alt: boolean, row: HTMLElement) => void,
  onKey?: (e: KeyboardEvent, id: string | null) => boolean,
) {
  const [cursor, setCursor] = useState<string | null>(null);
  const cursorId = cursor !== null && ids.includes(cursor) ? cursor : (ids[0] ?? null);
  const list = useRef<HTMLDivElement>(null);
  const state = useRef({ ids, cursorId, onEnter, onKey });
  state.current = { ids, cursorId, onEnter, onKey };
  useEffect(() => {
    const rowOf = (id: string) => list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // A todo's sheet over the list takes the keys.
      if (t.closest("input, textarea, select, [role=menu], [role=dialog], .xterm") || document.querySelector(".app[data-zone], .sheet-backdrop")) return;
      const { ids, cursorId, onEnter, onKey } = state.current;
      const step = stepOf(e);
      if (step && ids.length > 0) {
        e.preventDefault();
        const next = ids[Math.min(Math.max(ids.indexOf(cursorId ?? "") + step, 0), ids.length - 1)];
        state.current.cursorId = next;
        setCursor(next);
        rowOf(next)?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && cursorId) {
        const row = rowOf(cursorId);
        if (!row) return;
        e.preventDefault();
        onEnter(cursorId, e.altKey, row);
      } else if (onKey?.(e, cursorId)) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return { cursorId, setCursor, list };
}

/// The Todo pages' `s`: the statuses, next to the todo's card, the current
/// one picked first.
function StatusMenu({ todo, onPick, onClose }: { todo: Todo; onPick: (s: Status) => void; onClose: () => void }) {
  const menuKeys = useMenuKeys(true, onClose, COLUMNS.findIndex((c) => c.status === todo.status));
  const root = useRef<HTMLSpanElement>(null);
  useOutsideClose(root, true, onClose);
  const at = document.querySelector(`[data-row="todo:${todo.id}"]`)?.getBoundingClientRect();
  return (
    <span ref={root} className="status-menu" style={{ top: (at?.bottom ?? 120) + 4, left: at?.left ?? 240 }}>
      <span className="menu" role="menu" aria-label={`${todo.title} のステータス`} {...menuKeys}>
        {COLUMNS.map((c) => (
          <button key={c.status} role="menuitem" onClick={() => (onPick(c.status), onClose())}>
            <StatusIcon status={c.status} />
            {c.label}
            {c.status === todo.status && <span className="muted">（今）</span>}
          </button>
        ))}
      </span>
    </span>
  );
}

interface Choice {
  key: string;
  kind: "group" | "repo" | "new";
  label: string;
}

/// Searchable picker for a repository or a free group name ("調査"): type to
/// filter, Enter picks the highlighted entry, and an unknown name becomes a
/// new group. Groups are listed before repositories.
function RepoChoice({ local, groups, exclude = [], value = "", placeholder, onPick }: {
  local: LocalRepo[];
  groups: string[];
  exclude?: string[];
  value?: string;
  placeholder: string;
  onPick: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // The panel is portaled to the body so scrolling parents (panel, dialog) cannot clip it.
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const r = root.current.getBoundingClientRect();
    setRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 260) });
  }, [open]);
  const q = query.trim().toLowerCase();
  const matches = (key: string) => !exclude.includes(key) && key.toLowerCase().includes(q);
  const choices: Choice[] = [
    ...groups.filter(matches).map((g) => ({ key: g, kind: "group" as const, label: g })),
    ...local.filter((r) => matches(r.key)).map((r) => ({ key: r.key, kind: "repo" as const, label: r.key })),
  ];
  const typed = query.trim().replace(/\//g, "-");
  if (typed && !groups.includes(typed) && !local.some((r) => r.key === typed)) {
    choices.push({ key: typed, kind: "new", label: `「${typed}」を新しいグループとして作る` });
  }
  useEffect(() => setActive(0), [query, open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const pick = (c: Choice) => {
    onPick(c.key);
    setQuery("");
    setOpen(false);
  };
  return (
    <div ref={root} className="combo" onClick={stop}>
      <button type="button" className={`combo-button${value ? "" : " placeholder"}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        {value ? (
          <>
            <RepoDot repo={value} />
            <span className="ellipsis">{value}</span>
          </>
        ) : (
          <span className="ellipsis">{placeholder}</span>
        )}
      </button>
      {open &&
        rect &&
        createPortal(
          <div ref={panel} className="combo-panel popover" style={{ top: rect.top, left: rect.left, width: rect.width }} onClick={stop}>
            <input
              autoFocus
              value={query}
              placeholder="検索、または新しいグループ名"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, choices.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (isEnter(e)) {
                  e.preventDefault();
                  if (choices[active]) pick(choices[active]);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
            />
            <ul role="listbox" className="combo-list">
              {choices.length === 0 && <li className="muted combo-empty">候補がありません</li>}
              {choices.map((c, i) => (
                <li
                  key={`${c.kind}:${c.key}`}
                  role="option"
                  aria-selected={i === active}
                  className={`combo-item${i === active ? " active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(c);
                  }}
                >
                  {c.kind === "new" ? <Icon name="plus" size={12} /> : <RepoDot repo={c.key} />}
                  <span className="ellipsis">{c.label}</span>
                  {c.kind !== "new" && <span className="muted combo-kind">{c.kind === "group" ? "グループ" : "リポジトリ"}</span>}
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}

function TodoCard({ todo, selected, onSelect, report, allTodos }: {
  todo: Todo;
  selected: boolean;
  onSelect: () => void;
  report: (e: unknown) => void;
  allTodos: Todo[];
}) {
  const drag = useDraggable({ id: `todo:${todo.id}` });
  // Only what asks the user shows here; the sessions are 作業's.
  const asking = liveSessions(todo).some((s) => s.state === "needs_input");
  const rel = relationLabel(todo, allTodos);
  return (
    <article
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      className={`card${selected ? " selected" : ""}${drag.isDragging ? " dragging" : ""}${asking ? " waiting" : ""}${todo.status === "done" ? " done" : ""}`}
      data-row={`todo:${todo.id}`}
      onClick={onSelect}
    >
      <div className="card-head">
        <span className="mono">{todoRef(todo)}</span>
        {asking && <StateBadge state="needs_input" />}
      </div>
      <div className="card-title">{todo.title}</div>
      {(todo.pr_url || todo.issue_url || rel) && (
        <div className="card-foot">
          <GhChip todo={todo} report={report} />
          <CiChip todo={todo} />
          {rel && <span className="tag">{rel}</span>}
        </div>
      )}
    </article>
  );
}

function LaneColumn({ status, lane, children, onAdd, folded }: { status: Status; lane: Lane; children: React.ReactNode; onAdd?: (title: string) => void; folded?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}:${lane.key}` });
  return (
    <div ref={setNodeRef} className={`cell${isOver ? " drop-target" : ""}${folded ? " folded" : ""}`} data-col={status}>
      {children}
      {onAdd && <AddInline label="新規" onAdd={onAdd} />}
    </div>
  );
}

function LaneHeader({ lane, collapsed, onToggle, onOpenTodo, report }: {
  lane: Lane;
  collapsed?: boolean;
  onToggle?: () => void;
  onOpenTodo: (id: number) => void;
  report: (e: unknown) => void;
}) {
  const openLink = useOpenLink(report);
  const waiting = lane.todos.flatMap(liveSessions).filter((s) => s.state === "needs_input").length;
  const open = lane.todos.filter((t) => t.status !== "done").length;
  const [owner, name] = lane.repo && isGithubRepo(lane.repo) ? lane.repo.split(/\/(.*)/s) : [null, lane.parent?.title ?? lane.key];
  // Only the chevron folds the lane; a parent's title opens the parent.
  const Title = lane.parent ? "button" : "span";
  return (
    <div className="lane-head">
      {onToggle && (
        <button className="lane-toggle" onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? "展開する" : "折りたたむ"}>
          <Icon name={collapsed ? "chevronRight" : "chevron"} size={12} />
        </button>
      )}
      <Title className="lane-toggle" {...(lane.parent ? { onClick: () => onOpenTodo(lane.parent!.id), title: "親を開く" } : {})}>
        {lane.parent ? <span className="mono muted">#{lane.parent.id}</span> : lane.repo ? <RepoDot repo={lane.repo} /> : null}
        {owner && <span className="muted lane-owner">{owner}/</span>}
        <span className="lane-name">{name}</span>
        {lane.parent ? (
          <span className="muted">
            {lane.todos.filter((t) => t.status === "done").length}/{lane.todos.length} 完了
          </span>
        ) : (
          <span className="muted">{open}</span>
        )}
        {waiting > 0 && (
          <span className="pill waiting">
            <i />
            返事待ち {waiting}
          </span>
        )}
        {collapsed && lane.key === NO_REPO_LANE && <span className="muted">場所を選ぶとそのレーンへ移ります</span>}
      </Title>
      <span className="grow" />
      {lane.repo && isGithubRepo(lane.repo) && (
        <button className="link-button" onClick={() => openLink(GITHUB + lane.repo)}>
          GitHub <Icon name="open" size={11} />
        </button>
      )}
    </div>
  );
}

/// What the Todo kanban and list show: words in the title or memo, some
/// statuses (the others fold), some places (lanes by repository). Empty parts
/// do not narrow anything.
interface TodoFilter {
  text: string;
  statuses: Status[];
  places: string[];
}
const NO_FILTER: TodoFilter = { text: "", statuses: [], places: [] };
/// Statuses folded by hand (FOLDED_COLUMNS_KEY): the kanban's column is a
/// narrow strip still taking cards, the list's rows a line with their count.
const FOLDED_COLUMNS_KEY = "foldedColumns";
const FOLDED_BY_DEFAULT_COLUMNS: Status[] = ["done"];
/// The kanban's columns' widths: a folded one is a narrow strip.
const FOLDED_COLUMN_W = "44px";
const columnsTemplate = (folded: Set<Status>) => COLUMNS.map((c) => (folded.has(c.status) ? FOLDED_COLUMN_W : "minmax(0, 1fr)")).join(" ");
/// The statuses folded: by hand, or left out by the filter.
const foldedStatuses = (byHand: Set<Status>, f: TodoFilter) => new Set(COLUMNS.map((c) => c.status).filter((st) => byHand.has(st) || (f.statuses.length > 0 && !f.statuses.includes(st))));
/// The kanban's and the list's filters, each its own.
const TODO_FILTERS_KEY = "todoFilters";
/// Filters kept under a name, listed in the sidebar and ⌘K; each opens the
/// page (kanban or list) it was saved on.
interface SavedFilter {
  id: string;
  name: string;
  filter: TodoFilter;
  layout: Layout;
}
const SAVED_FILTERS_KEY = "savedFilters";
const filterCount = (f: TodoFilter) => (f.text.trim() ? 1 : 0) + f.statuses.length + f.places.length;
const sameFilter = (a: TodoFilter, b: TodoFilter) => JSON.stringify(a) === JSON.stringify(b);
/// The statuses are not matched here: theirs fold instead (foldedStatuses).
function matchesFilter(t: Todo, f: TodoFilter) {
  const words = f.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${t.title} ${t.memo ?? ""} #${t.id}`.toLowerCase();
  return words.every((w) => hay.includes(w)) && (f.places.length === 0 || f.places.includes(laneKey(t.repos)));
}

/// The toolbar's filter: a search box, and a menu of statuses and places
/// with saving the filter under a name.
function TodoFilterBar({ filter, version, places, onChange, onSave }: {
  filter: TodoFilter;
  /// Changes when the filter is set from outside (another page's, a saved one, cleared), so the search box shows it.
  version: string;
  places: string[];
  onChange: (f: TodoFilter) => void;
  onSave: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useOutsideClose(root, open, () => setOpen(false));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const count = filterCount(filter);
  return (
    <>
      {/* Uncontrolled, so typing through the IME is not disturbed by re-renders. */}
      <input
        key={version}
        className="filter-search"
        type="search"
        placeholder="絞り込み（タイトル・メモ）"
        aria-label="タイトルとメモで絞り込む"
        defaultValue={filter.text}
        onInput={(e) => onChange({ ...filter, text: e.currentTarget.value })}
      />
      <span ref={root} className="filter-menu">
        <button className={`filter${count > 0 ? " on" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          フィルター{count > 0 ? ` ${count}` : ""}
        </button>
        {open && (
          <div className="menu filter-panel" role="dialog" aria-label="フィルター">
            <div className="filter-group">
              <span className="muted">ステータス</span>
              {COLUMNS.map((c) => (
                <label key={c.status} className="toggle">
                  <input type="checkbox" checked={filter.statuses.includes(c.status)} onChange={() => onChange({ ...filter, statuses: toggle(filter.statuses, c.status) })} />
                  {c.label}
                </label>
              ))}
            </div>
            <div className="filter-group">
              <span className="muted">リポジトリ</span>
              {places.map((p) => (
                <label key={p} className="toggle">
                  <input type="checkbox" checked={filter.places.includes(p)} onChange={() => onChange({ ...filter, places: toggle(filter.places, p) })} />
                  <RepoDot repo={p} />
                  <span className="ellipsis">{isGithubRepo(p) ? repoName(p) : p}</span>
                </label>
              ))}
            </div>
            <div className="filter-actions">
              {naming ? (
                <SubmitInput
                  autoFocus
                  placeholder="名前を入力して Enter"
                  onSubmit={(name) => {
                    onSave(name);
                    setNaming(false);
                    setOpen(false);
                  }}
                  onClose={() => setNaming(false)}
                />
              ) : (
                <>
                  <button className="ghost small" disabled={count === 0} onClick={() => onChange(NO_FILTER)}>
                    クリア
                  </button>
                  <span className="grow" />
                  <button className="small" disabled={count === 0} onClick={() => setNaming(true)}>
                    保存…
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </span>
    </>
  );
}

function BoardLane({ lane, collapsed, onToggle, selectedId, onSelectTodo, report, allTodos, folded, onAdd }: {
  lane: Lane;
  collapsed: boolean;
  onToggle: () => void;
  selectedId: number | null;
  onSelectTodo: (id: number) => void;
  report: (e: unknown) => void;
  allTodos: Todo[];
  /// Folded columns: their cards are counted, and cards still drop there.
  folded: Set<Status>;
  onAdd: (status: Status, title: string) => void;
}) {
  return (
    <section className={`lane${collapsed ? " collapsed" : ""}`} data-lane={lane.key}>
      <LaneHeader lane={lane} collapsed={collapsed} onToggle={onToggle} onOpenTodo={onSelectTodo} report={report} />
      {!collapsed && (
        <div className="lane-grid" style={{ gridTemplateColumns: columnsTemplate(folded) }}>
          {COLUMNS.map((c) => {
            const todos = lane.todos.filter((t) => t.status === c.status).sort((a, b) => (c.status === "done" ? b.updated_at - a.updated_at : a.id - b.id));
            if (folded.has(c.status)) {
              return (
                <LaneColumn key={c.status} status={c.status} lane={lane} folded>
                  {todos.length > 0 && (
                    <span className="folded-count" title={`${c.label} ${todos.length} 件（畳んでいます）`}>
                      {todos.length}
                    </span>
                  )}
                </LaneColumn>
              );
            }
            return (
              <LaneColumn key={c.status} status={c.status} lane={lane} onAdd={c.status === "done" ? undefined : (title) => onAdd(c.status, title)}>
                {todos.map((t) => (
                  <TodoCard key={t.id} todo={t} selected={t.id === selectedId} onSelect={() => onSelectTodo(t.id)} report={report} allTodos={allTodos} />
                ))}
              </LaneColumn>
            );
          })}
        </div>
      )}
    </section>
  );
}

/// 作業's list's one line for the review requests, as its row.
const ASKS_ROW = "w:reviews";
/// 作業's ちょっと Claude, the list's first row (j k reach it, Enter opens it).
const QUICK_ROW = "quick";
/// 作業's rows in the order the user put them in (their keys).
const WORK_ORDER_KEY = "workOrder";
/// How 作業's list is ordered: by hand, by the work that moved last, or by the work begun last.
type WorkSort = "manual" | "updated" | "started";
const WORK_SORTS: WorkSort[] = ["manual", "updated", "started"];
const WORK_SORT_LABEL: Record<WorkSort, string> = { manual: "手で並べた順", updated: "動きがあった順", started: "始めた順" };
const WORK_SORT_KEY = "workSort";

/// Picks a todo's parent, or none. Subtasks go one level deep, so only
/// top-level todos are offered and a todo with subtasks cannot move.
function ParentPicker({ todo, allTodos, run, compact }: { todo: Todo; allTodos: Todo[]; run: (f: () => Promise<unknown>) => void; compact?: boolean }) {
  const hasChildren = allTodos.some((c) => c.parent_id === todo.id);
  const candidates = allTodos.filter((t) => t.id !== todo.id && t.parent_id === null && (t.status !== "done" || t.id === todo.parent_id)).sort((a, b) => b.id - a.id);
  return (
    <select
      className={`select${compact ? " compact" : ""}`}
      value={todo.parent_id ?? ""}
      disabled={hasChildren}
      title={hasChildren ? "サブタスクがある todo は、ほかの todo の下に入れられません" : "親タスク"}
      onClick={stop}
      onChange={(e) => run(() => api.setParent(todo.id, e.target.value === "" ? null : Number(e.target.value)))}
    >
      <option value="">{compact ? "親を設定…" : "なし"}</option>
      {candidates.map((t) => (
        <option key={t.id} value={t.id}>
          #{t.id} {t.title}
        </option>
      ))}
    </select>
  );
}

function StatusSelect({ todo, setStatus }: { todo: Todo; setStatus: (todo: Todo, status: Status) => void }) {
  return (
    <select className="select status-select" value={todo.status} onClick={stop} onChange={(e) => setStatus(todo, e.target.value as Status)} aria-label="ステータス">
      {COLUMNS.map((c) => (
        <option key={c.status} value={c.status}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

function ListLane({ lane, selectedId, onSelectTodo, report, run, setStatus, allTodos, folded, onUnfold, collapsed, onToggle, onAdd }: {
  lane: Lane;
  selectedId: number | null;
  onSelectTodo: (id: number) => void;
  report: (e: unknown) => void;
  run: (f: () => Promise<unknown>) => void;
  setStatus: (todo: Todo, status: Status) => void;
  allTodos: Todo[];
  /// Statuses folded to a line with their count, which opens them.
  folded: Set<Status>;
  onUnfold: (status: Status) => void;
  collapsed: boolean;
  onToggle: () => void;
  onAdd: (title: string) => void;
}) {
  const open = lane.todos.filter((t) => !folded.has(t.status)).sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (a.status === "done" ? b.updated_at - a.updated_at : a.id - b.id));
  const foldedCounts = COLUMNS.map((c) => ({ ...c, n: lane.todos.filter((t) => t.status === c.status).length })).filter((c) => folded.has(c.status) && c.n > 0);
  const row = (t: Todo) => {
    const asking = liveSessions(t).some((s) => s.state === "needs_input");
    return (
      <li key={t.id} data-row={`todo:${t.id}`} className={`row${t.id === selectedId ? " selected" : ""}${t.status === "done" ? " done" : ""}`} onClick={() => onSelectTodo(t.id)}>
        <StatusIcon status={t.status} />
        <span className="mono muted ref">{todoRef(t)}</span>
        <span className="row-title">{t.title}</span>
        {asking && <StateBadge state="needs_input" />}
        <GhChip todo={t} report={report} />
        <CiChip todo={t} />
        {lane.key === ORPHAN_LANE && <ParentPicker todo={t} allTodos={allTodos} run={run} compact />}
        {t.repos[0] && !lane.repo && (
          <span className="tag repo-tag">
            <RepoDot repo={t.repos[0]} />
            {repoName(t.repos[0])}
          </span>
        )}
        <StatusSelect todo={t} setStatus={setStatus} />
        <span className="muted when">{ago(t.updated_at)}</span>
      </li>
    );
  };
  return (
    <section className="list-lane" data-lane={lane.key}>
      <div data-row={`lane:${lane.key}`}>
        <LaneHeader lane={lane} collapsed={collapsed} onToggle={onToggle} onOpenTodo={onSelectTodo} report={report} />
      </div>
      {!collapsed && (
        <ul className="rows">
          {open.map(row)}
          {foldedCounts.map((c) => (
            <li key={c.status} className="row backlog-toggle" onClick={() => onUnfold(c.status)}>
              <StatusIcon status={c.status} />
              <span className="muted">
                {c.label} {c.n} 件（畳んでいます。クリックで表示）
              </span>
            </li>
          ))}
        </ul>
      )}
      {!collapsed && (
        <div className="row-add">
          <AddInline label="新しい Todo" onAdd={onAdd} />
        </div>
      )}
    </section>
  );
}

// The in-place fields below are uncontrolled: the board refreshes every few
// seconds, and nothing should touch an input's text while an IME composes in
// it. A new stored value remounts the field through its key.

/// A field that saves when left or on Enter. `required` puts the stored
/// value back instead of saving an empty one.
function InlineInput({ value, placeholder, className, required, label, onSave }: {
  value: string;
  placeholder?: string;
  className?: string;
  required?: boolean;
  label?: string;
  onSave: (v: string) => void;
}) {
  return (
    <input
      key={value}
      className={className}
      defaultValue={value}
      placeholder={placeholder}
      aria-label={label ?? placeholder}
      onBlur={(e) => {
        const v = e.currentTarget.value;
        if (required && !v.trim()) e.currentTarget.value = value;
        else if (v !== value) onSave(v);
      }}
      onKeyDown={(e) => isEnter(e) && e.currentTarget.blur()}
    />
  );
}

/// An input that submits on Enter and clears, for adding one thing after another.
function SubmitInput({ placeholder, autoFocus, onSubmit, onClose }: { placeholder: string; autoFocus?: boolean; onSubmit: (v: string) => void; onClose?: () => void }) {
  const submit = (el: HTMLInputElement) => {
    const v = el.value.trim();
    if (v) onSubmit(v);
    el.value = "";
  };
  return (
    <input
      autoFocus={autoFocus}
      placeholder={placeholder}
      aria-label={placeholder}
      onClick={stop}
      onBlur={(e) => {
        submit(e.currentTarget);
        onClose?.();
      }}
      onKeyDown={(e) => {
        if (isEnter(e)) submit(e.currentTarget);
        if (e.key === "Escape") {
          e.currentTarget.value = "";
          onClose?.();
        }
      }}
    />
  );
}

/// Notion-style "+ 新規" at the foot of a column or list: becomes an input
/// that adds on Enter and stays open for the next one.
function AddInline({ label, onAdd }: { label: string; onAdd: (title: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="ghost add-inline" onClick={() => setOpen(true)}>
        <Icon name="plus" size={12} /> {label}
      </button>
    );
  }
  return <SubmitInput autoFocus placeholder="タイトルを入力して Enter" onSubmit={onAdd} onClose={() => setOpen(false)} />;
}

const URL_RE = /https?:\/\/[^\s<>"'）)]+/g;

/// Text with its URLs as links that open in the browser.
function Linkify({ text, report }: { text: string; report: (e: unknown) => void }) {
  const openLink = useOpenLink(report);
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    parts.push(text.slice(last, m.index));
    parts.push(
      <a
        key={m.index}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openLink(url);
        }}
      >
        {url}
      </a>,
    );
    last = m.index + url.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/// Memo text with clickable links; click to edit in place, leave to save.
function MemoEditor({ value, report, onSave, label = "メモ", plan }: { value: string; report: (e: unknown) => void; onSave: (v: string) => void; label?: string; plan?: boolean }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <textarea
        autoFocus
        rows={6}
        defaultValue={value}
        aria-label={label}
        // Esc keeps what was written and leaves the field, as clicking out does.
        onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
        onBlur={(e) => {
          if (e.currentTarget.value !== value) onSave(e.currentTarget.value);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <div className={`memo${plan ? " plan" : " editable"}${value ? "" : " muted"}`} onClick={() => setEditing(true)} title="クリックで編集">
      {value ? <Linkify text={value} report={report} /> : `${label}を書く…`}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/// Adds `key` to the todo's own repo list; the first pick also fills an empty working folder.
function addRepo(todo: Todo, local: LocalRepo[], key: string): Parameters<typeof api.updateTodo>[1] | null {
  const own = todo.repos_derived ? [] : todo.repos;
  if (!key || own.includes(key)) return null;
  const repos = [...own, key];
  const path = local.find((r) => r.key === key)?.path;
  return todo.cwd || !path ? { repos } : { repos, cwd: path };
}

function RepoChips({ todo, local, groups, update }: {
  todo: Todo;
  local: LocalRepo[];
  groups: string[];
  update: (u: Parameters<typeof api.updateTodo>[1]) => void;
}) {
  const own = todo.repos_derived ? [] : todo.repos;
  return (
    <div className="chips">
      {todo.repos.map((r) => (
        <span key={r} className={`chip${todo.repos_derived ? " derived" : ""}`} title={todo.repos_derived ? `${r}（issue URL か作業フォルダから判定）` : r}>
          <RepoDot repo={r} />
          {r}
          {!todo.repos_derived && (
            <button className="ghost icon chip-remove" onClick={() => update({ repos: own.filter((x) => x !== r) })} aria-label={`${r} を外す`}>
              <Icon name="close" size={11} />
            </button>
          )}
        </span>
      ))}
      <RepoChoice
        local={local}
        groups={groups}
        exclude={own}
        placeholder={todo.repos.length === 0 ? "リポジトリかグループを選ぶ" : "＋"}
        onPick={(key) => {
          const u = addRepo(todo, local, key);
          if (u) update(u);
        }}
      />
    </div>
  );
}

/// Starts a todo's session as `launch` and `plan` say, behind: nothing comes
/// forward, and the keyboard stays (a Cloud session's tab is made behind).
type StartTodo = (todoId: number, plan: boolean, launch: Launch) => Promise<void>;
const StartTodoContext = createContext<StartTodo | null>(null);

/// The kept settings (LAUNCH_KEY) for planning or implementing, and their setter.
function useLaunchPrefs() {
  const [prefs, setPrefsState] = useState<LaunchPrefs>(() => launchPrefsFrom(loadJson<Partial<LaunchPrefs> | null>(LAUNCH_KEY, null), loadJson(START_KEY, null)));
  const setLaunch = (plan: boolean, patch: Partial<Launch>) => {
    const next = { ...prefs, [plan ? "plan" : "direct"]: { ...prefs[plan ? "plan" : "direct"], ...patch } };
    remember(LAUNCH_KEY, JSON.stringify(next));
    setPrefsState(next);
  };
  return { prefs, setLaunch };
}

/// 計画させる, where it runs, what runs it and with which model: how a todo
/// starts (the launch sheet's and the new todo dialog's).
function LaunchControls({ plan, launch, onPlan, onLaunch }: { plan: boolean; launch: Launch; onPlan: (on: boolean) => void; onLaunch: (patch: Partial<Launch>) => void }) {
  const e = effectiveLaunch(launch, plan);
  const why = plan ? "計画させるときは herdr の Claude で動きます（Mac の Claude がサブタスクを作ります）" : "Codex は herdr でだけ動きます";
  return (
    <div className="launch-controls">
      <label className="toggle" title="Claude に詳細を詰めさせて、サブタスクに分けさせます（実装はしません）">
        <input type="checkbox" checked={plan} onChange={(ev) => onPlan(ev.target.checked)} />
        計画させる
      </label>
      <div className="segmented" role="group" aria-label="動かす場所">
        {(["cloud", "herdr"] as const).map((r) => (
          <button key={r} className={e.runner === r ? "on" : ""} aria-pressed={e.runner === r} disabled={r === "cloud" && e.runner === "herdr" && launch.runner === "cloud"} title={r === "cloud" && e.runner === "herdr" && launch.runner === "cloud" ? why : undefined} onClick={() => onLaunch({ runner: r })}>
            {r === "cloud" ? "Cloud" : "herdr"}
          </button>
        ))}
      </div>
      <div className="segmented" role="group" aria-label="動かすもの">
        {(["claude", "codex"] as const).map((a) => (
          <button key={a} className={e.agent === a ? "on" : ""} aria-pressed={e.agent === a} disabled={plan && a === "codex"} title={plan && a === "codex" ? why : undefined} onClick={() => onLaunch({ agent: a })}>
            {a === "claude" ? "Claude" : "Codex"}
          </button>
        ))}
      </div>
      {e.agent === "claude" && (
        <>
          <select className="select compact" value={launch.model} title="モデル" aria-label="モデル" onChange={(ev) => onLaunch({ model: ev.target.value })}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <select className="select compact" value={launch.effort} title="effort" aria-label="effort" onChange={(ev) => onLaunch({ effort: ev.target.value })}>
            {EFFORTS.map((x) => (
              <option key={x} value={x}>
                {x ? `effort: ${x}` : "既定の effort"}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

/// The first prompt and how it starts: everything a new session needs (the
/// launch sheet's). ⌘Enter starts it, from anywhere in it.
function Composer({ todo, run, onStarted }: { todo: Todo; run: (f: () => Promise<unknown>) => void; onStarted: () => void }) {
  const startTodo = useContext(StartTodoContext);
  const { prefs, setLaunch } = useLaunchPrefs();
  const [plan, setPlan] = useState(() => planByDefault(todo));
  const [prompt, setPrompt] = useState(todo.prompt ?? "");
  // The stored prompt comes back on another todo, not on every refresh.
  useEffect(() => {
    setPrompt(todo.prompt ?? "");
    setPlan(planByDefault(todo));
  }, [todo.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const launch = prefs[plan ? "plan" : "direct"];
  const [starting, setStarting] = useState(false);
  const start = () => {
    if (starting || !startTodo) return;
    setStarting(true);
    run(async () => {
      try {
        // The prompt lives on the todo, so the next start reuses it.
        if (prompt !== (todo.prompt ?? "")) await api.updateTodo(todo.id, { prompt });
        await startTodo(todo.id, plan, launch);
        onStarted();
      } finally {
        setStarting(false);
      }
    });
  };
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !matches(e, "start")) return;
      e.preventDefault();
      startRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="composer">
      <textarea autoFocus rows={3} value={prompt} aria-label="最初のプロンプト" placeholder={todo.prompt_preview} onChange={(e) => setPrompt(e.target.value)} />
      <div className="composer-foot">
        <LaunchControls plan={plan} launch={launch} onPlan={setPlan} onLaunch={(patch) => setLaunch(plan, patch)} />
        <span className="grow" />
        <button className="primary" onClick={start} disabled={starting} aria-busy={starting}>
          {starting && <span className="spinner" />}
          {starting ? "開始しています…" : "任せる"} {!starting && <span className="kbd">⌘↵</span>}
        </button>
      </div>
      <p className="muted hint">
        前回の設定で始まります（計画させるかどうかで別々に覚えます）· [todo:{todo.id}] は自動で付きます · 空ならタイトルとメモから作ります
        {todo.cwd ? ` · ${tildify(todo.cwd)}` : ""}
      </p>
    </div>
  );
}

/// The `cse_…` id of the cloud session a claude.ai page shows, if it shows one.
const cloudIdOfPage = (url: string) => url.match(/^https:\/\/claude\.ai\/code\/session_([A-Za-z0-9]+)/)?.[1]?.replace(/^/, "cse_") ?? null;

/// A page the app shows (a tab of the browser space, a reading's page in
/// 学習, a Cloud session's in 作業), or a local session's terminal (作業).
interface BrowserTab {
  id: string;
  url: string;
  /// The page of the app's own it was opened for (a session, a PR), which
  /// opening again comes back to though the page moved on (see `findTabFor`).
  openedFor?: string;
  title: string | null;
  /// From opening or a navigation until the page finishes loading.
  loading: boolean;
  /// Bumped when the app sends the tab to `url` (not when the page moves).
  nav: number;
  /// Set on a terminal (a local session's), which shows no web page.
  term?: TerminalRun;
  /// The page's zoom from the keys, when not 1.
  zoom?: number;
  /// One of PINNED_PAGES.
  pinned?: boolean;
  /// Not a tab of the browser space: a reading's page (学習) or a session's (作業).
  area?: "study" | "work";
  /// 学習: the reading it shows.
  reading?: number;
  /// 作業: the session it shows.
  session?: string;
  /// Its page is translated where it is (原文 / 日本語).
  translated?: boolean;
}

/// The browser space's tabs kept from the last run (PANE_TABS_KEY), with new
/// ids; the pages load when shown.
function restoreTabs(): { tabs: BrowserTab[]; active: string | null } {
  const saved = loadJson<SavedTabs>(PANE_TABS_KEY, { tabs: [], active: -1 });
  let n = 1;
  const tabs = saved.tabs
    .filter((t) => !t.pinned || PINNED_PAGES.some((p) => p.id === t.pinned))
    .map((t): BrowserTab => {
      const pinned = PINNED_PAGES.find((p) => p.id === t.pinned);
      return { id: pinned?.id ?? `t${n++}`, url: t.url, openedFor: t.openedFor, title: t.title, loading: false, nav: 0, pinned: pinned ? true : undefined };
    });
  return { tabs, active: tabs[saved.active]?.id ?? null };
}

/// Pages the new tab page offers, which the user sets there (none at first).
interface StartPage {
  label: string;
  url: string;
}
const START_PAGES_KEY = "startPages";
/// The OneLogin portal the pinned page opens, as set in the settings.
const ONELOGIN_URL_KEY = "oneLoginUrl";
const ONELOGIN_DEFAULT_URL = "https://app.onelogin.com/login";
/// Pages kept at the top of the browser space's tab list, opened from there
/// (or ⌘K) and never closed, so they keep their state. NotebookLM, ChatGPT
/// and Claude are also 学習's right side: the same pages, the same chats.
/// Ids are letters and digits only, as the backend takes tab ids.
const PINNED_PAGES: { id: string; label: string; short: string; url: string }[] = [
  { id: "pinonelogin", label: "OneLogin", short: "OL", url: ONELOGIN_DEFAULT_URL },
  { id: "pinnotebooklm", label: "NotebookLM", short: "NL", url: "https://notebooklm.google.com/" },
  { id: "pinchatgpt", label: "ChatGPT", short: "GP", url: "https://chatgpt.com/" },
  { id: "pinclaude", label: "Claude", short: "Cl", url: "https://claude.ai/new" },
];
/// Where a pinned page opens (OneLogin's portal is the user's own).
const pinnedUrl = (id: string) => (id === "pinonelogin" ? loadText(ONELOGIN_URL_KEY) || ONELOGIN_DEFAULT_URL : (PINNED_PAGES.find((p) => p.id === id)?.url ?? ""));
/// The pinned pages 学習 keeps on its right, to ask while reading.
const STUDY_RIGHT = ["pinnotebooklm", "pinchatgpt", "pinclaude"];
/// Pinned pages whose text box takes the typing when the keyboard comes over
/// (⌃l), with what was selected on the other side typed in.
const CHAT_PAGES = ["pinchatgpt", "pinclaude", "pinnotebooklm"];

/// Items (elements with `attr`, their id) moved by dragging with the pointer:
/// the item under it takes the dragged one's place, as `onMove(id, to)`.
/// (Pointer events rather than HTML drag and drop, which the webview's file
/// drop handling can swallow.)
function useDragMove(attr: string, onMove: (id: string, to: string) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const start = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const startY = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < DRAG_START_PX) return;
      moved = true;
      setDragging(id);
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(`[${attr}]`)?.getAttribute(attr);
      if (over && over !== id) onMove(id, over);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return { dragging, start };
}

/// The browser space's row for the new tab page (tab ids are letters and digits only).
const NEW_TAB_ROW = "new-tab";

/// The browser space: the tab list on the left (the pinned pages at its top,
/// then the tabs, which move by dragging), and the page shown, or a new tab
/// page when no tab is picked. While the list has the keyboard, j k move over
/// its rows and Enter shows the page under the cursor.
function BrowserSpace({ tabs, active, covered, listKeys, width, report, onResize, onSelect, onPinned, onClose, onNewTab, onOpen, onAddress, onMove, onArchive, onBookmark, onStrip }: {
  /// The tabs, apart from the pinned pages.
  tabs: BrowserTab[];
  active: BrowserTab | null;
  covered: boolean;
  /// Whether the tab list has the keyboard (its cursor shows).
  listKeys: boolean;
  /// The tab list's.
  width: number;
  report: (e: unknown) => void;
  onResize: (w: number) => void;
  onSelect: (id: string) => void;
  /// Shows a pinned page, opening it the first time.
  onPinned: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  /// Opens what was typed on the new tab page, in a new tab with the keyboard.
  onOpen: (url: string) => void;
  onAddress: (tab: string, url: string) => void;
  /// Moves a dragged tab to where another one is.
  onMove: (tab: string, to: string) => void;
  /// Archives the cloud session the shown tab is on and closes it (⌘⇧A).
  onArchive: () => void;
  /// Keeps the shown page to read (⌘⇧D).
  onBookmark: () => void;
  /// A press on the tab list (not on a tab): the page shown takes the keyboard.
  onStrip: () => void;
}) {
  // Tabs move by dragging with the pointer.
  const { dragging, start: dragTab } = useDragMove("data-tab", onMove);
  const { cursorId, setCursor, list } = useRowCursor([...PINNED_PAGES.map((p) => p.id), NEW_TAB_ROW, ...tabs.map((t) => t.id)], (id) =>
    id === NEW_TAB_ROW ? onNewTab() : PINNED_PAGES.some((p) => p.id === id) ? onPinned(id) : onSelect(id),
  );
  // The cursor starts on the page shown, each time the list takes the keyboard.
  const activeRow = active?.id ?? NEW_TAB_ROW;
  useEffect(() => setCursor(activeRow), [activeRow, listKeys]); // eslint-disable-line react-hooks/exhaustive-deps
  const cursor = (id: string) => (listKeys && id === cursorId ? " cursor" : "");
  return (
    <div className="browser-space">
      <nav className="tab-list" aria-label="タブ" ref={list} onMouseDown={(e) => !(e.target as HTMLElement).closest("button, input") && onStrip()}>
        <div className="pins" role="group" aria-label="固定のページ">
          {PINNED_PAGES.map((p) => (
            <button key={p.id} data-row={p.id} className={`pin${p.id === active?.id ? " on" : ""}${cursor(p.id)}`} aria-pressed={p.id === active?.id} title={p.label} onClick={() => onPinned(p.id)}>
              <span className="pin-mark" data-pin={p.id} aria-hidden="true">
                {p.short}
              </span>
              <span className="pin-label ellipsis">{p.label}</span>
            </button>
          ))}
        </div>
        <button data-row={NEW_TAB_ROW} className={`tab-row new-tab-row${!active ? " on" : ""}${cursor(NEW_TAB_ROW)}`} onClick={onNewTab}>
          <Icon name="plus" size={13} />
          <span className="grow">新しいタブ</span>
          <span className="kbd">{keyLabel(keyOf("newTab"))}</span>
        </button>
        <ul className="tab-rows" role="tablist" aria-orientation="vertical" aria-label="開いているタブ">
          {tabs.map((t) => (
            <li key={t.id} data-tab={t.id} data-row={t.id} className={`tab-row${t.id === active?.id ? " on" : ""}${t.id === dragging ? " dragging" : ""}${cursor(t.id)}`} onPointerDown={(e) => dragTab(e, t.id)}>
              <button role="tab" aria-selected={t.id === active?.id} aria-busy={t.loading} className="tab-row-main" title={t.url} onClick={() => onSelect(t.id)}>
                {t.loading ? <span className="spinner" aria-label="読み込み中" /> : <span className="favicon" aria-hidden="true">{hostOf(t.url).slice(0, 1).toUpperCase()}</span>}
                <span className="ellipsis">{t.title || hostOf(t.url)}</span>
              </button>
              <button className="ghost icon tab-row-close" aria-label={`${t.title || hostOf(t.url)} を閉じる`} onClick={() => onClose(t.id)}>
                <Icon name="close" size={11} />
              </button>
            </li>
          ))}
        </ul>
        <span className="muted small-text tab-list-hint">
          {keyLabel(keyOf("sideApp"))} でここへ、{keyLabel(keyOf("down"))} {keyLabel(keyOf("up"))} で選んで Enter で開く · {keyLabel(keyOf("prevTab"))} {keyLabel(keyOf("nextTab"))} で移る · {keyLabel(keyOf("closeTab"))} で閉じる（固定のページは閉じない）
        </span>
        <Resizer label="タブの一覧の幅" cssVar="--tab-list-w" edge="right" width={width} min={TAB_LIST_MIN_W} max={() => TAB_LIST_MAX_W} onResize={onResize} />
      </nav>
      <section className="browser browser-main" aria-label="ページ">
        {active ? (
          <TabView tab={active} covered={covered} report={report} onAddress={(url) => onAddress(active.id, url)} onArchive={cloudIdOfPage(active.url) ? onArchive : undefined} onBookmark={active.pinned ? undefined : onBookmark} />
        ) : (
          <NewTabPage onOpen={onOpen} />
        )}
      </section>
    </div>
  );
}

/// A new tab: type an address or a search, or pick a start page.
/// The pages visited in the app's browser, for the address field's
/// suggestions: kept in this browser's storage, the most used and recent first.
interface Visit {
  url: string;
  title: string | null;
  visits: number;
  last: number;
}
const HISTORY_KEY = "browserHistory";
/// Each tab's page as last loaded, which its title then belongs to.
const tabUrls = new Map<string, string>();
const HISTORY_MAX = 1000;
const SUGGESTIONS_MAX = 8;
const DAY_MS = 86_400_000;
let history: Visit[] = loadJson<Visit[]>(HISTORY_KEY, []);
const historyKey = (url: string) => url.replace(/#.*$/, "");
const visitScore = (v: Visit, now: number) => v.visits / (1 + (now - v.last) / DAY_MS);
/// A page loaded (`title` unknown yet) or titled (`visit` false) in a tab.
function recordVisit(url: string, title: string | null, visit: boolean) {
  if (!/^https?:\/\//.test(url)) return;
  const key = historyKey(url);
  const now = Date.now();
  const old = history.find((v) => historyKey(v.url) === key);
  const entry = { url: key, title: title ?? old?.title ?? null, visits: (old?.visits ?? 0) + (visit ? 1 : 0), last: visit ? now : (old?.last ?? now) };
  history = [entry, ...history.filter((v) => v !== old)];
  if (history.length > HISTORY_MAX) history = [...history].sort((a, b) => visitScore(b, now) - visitScore(a, now)).slice(0, HISTORY_MAX);
  remember(HISTORY_KEY, JSON.stringify(history));
}
/// The visited pages with every word of `query` in their address or title.
function historyMatches(query: string): Visit[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const now = Date.now();
  return history
    .filter((v) => words.every((w) => v.url.toLowerCase().includes(w) || v.title?.toLowerCase().includes(w)))
    .sort((a, b) => visitScore(b, now) - visitScore(a, now))
    .slice(0, SUGGESTIONS_MAX);
}

/// The address field (a tab's, the new tab page's), suggesting visited pages
/// as it is typed in: ↑↓ (or the menu's ⌃j ⌃k) pick one, Enter opens it (or
/// what was typed), Esc drops the suggestions, then `onEscape`.
function AddressInput({ inputRef, defaultValue, placeholder, autoFocus, label, title, onGo, onEscape, onSuggesting }: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  defaultValue?: string;
  placeholder?: string;
  autoFocus?: boolean;
  label: string;
  title?: string;
  onGo: (url: string) => void;
  onEscape?: (input: HTMLInputElement) => void;
  /// While suggestions show (a page's webview would cover them).
  onSuggesting?: (on: boolean) => void;
}) {
  const [items, setItemsState] = useState<Visit[]>([]);
  const [active, setActive] = useState(-1);
  const setItems = (list: Visit[]) => {
    setItemsState(list);
    setActive(-1);
    onSuggesting?.(list.length > 0);
  };
  useEffect(() => () => onSuggesting?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const step = (e: React.KeyboardEvent) =>
    e.key === "ArrowDown" || matches(e.nativeEvent, "paletteDown") ? 1 : e.key === "ArrowUp" || matches(e.nativeEvent, "paletteUp") ? -1 : 0;
  const go = (url: string) => {
    setItems([]);
    onGo(url);
  };
  return (
    <div className="address">
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        className="url mono"
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label={label}
        title={title}
        aria-autocomplete="list"
        onInput={(e) => setItems(historyMatches(e.currentTarget.value))}
        onBlur={() => setItems([])}
        onKeyDown={(e) => {
          const d = items.length > 0 ? step(e) : 0;
          if (d) {
            e.preventDefault();
            // -1 is what was typed, above the first suggestion.
            return setActive((i) => ((i + 1 + d + items.length + 1) % (items.length + 1)) - 1);
          }
          if (e.key === "Escape") {
            if (items.length > 0) return setItems([]);
            return onEscape?.(e.currentTarget);
          }
          if (!isEnter(e)) return;
          const url = items[active]?.url ?? addressToUrl(e.currentTarget.value);
          if (url) go(url);
        }}
      />
      {items.length > 0 && (
        <ul className="suggestions" role="listbox">
          {items.map((v, i) => (
            <li key={v.url} role="option" aria-selected={i === active} data-active={i === active || undefined} onMouseDown={(e) => (e.preventDefault(), go(v.url))}>
              <span className="ellipsis">{v.title || hostOf(v.url)}</span>
              <span className="muted mono ellipsis">{v.url.replace(/^https?:\/\//, "")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewTabPage({ onOpen }: { onOpen: (url: string) => void }) {
  const [pages, setPagesState] = useState<StartPage[]>(() => loadJson<StartPage[]>(START_PAGES_KEY, []));
  const setPages = (list: StartPage[]) => {
    remember(START_PAGES_KEY, JSON.stringify(list));
    setPagesState(list);
  };
  const [adding, setAdding] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const add = (address: string) => {
    const url = addressToUrl(address);
    // A page, not a search for the words.
    if (!url || url.startsWith(SEARCH_URL)) return;
    const label = nameRef.current?.value.trim() || hostOf(url);
    setPages([...pages.filter((p) => p.url !== url), { label, url }]);
    setAdding(false);
  };
  return (
    <>
      <div className="browser-bar">
        <AddressInput autoFocus placeholder="URL か検索したい言葉を入力して Enter（開いたページから候補が出ます）" label="URL か検索したい言葉" onGo={onOpen} />
      </div>
      <div className="new-tab">
        {pages.map((p) => (
          <div key={p.url} className="start-page">
            <button onClick={() => onOpen(p.url)}>
              {p.label}
              <span className="muted mono">{hostOf(p.url)}</span>
            </button>
            <button className="ghost icon" aria-label={`${p.label} を候補から外す`} title="候補から外す" onClick={() => setPages(pages.filter((x) => x.url !== p.url))}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        {adding ? (
          <div className="start-page-add">
            <input ref={nameRef} autoFocus placeholder="名前（なくてもよい）" aria-label="名前" onKeyDown={(e) => e.key === "Escape" && setAdding(false)} />
            <input
              className="mono"
              placeholder="URL を入力して Enter"
              aria-label="URL"
              onKeyDown={(e) => {
                if (e.key === "Escape") setAdding(false);
                else if (isEnter(e)) add(e.currentTarget.value);
              }}
            />
          </div>
        ) : (
          <button className="ghost add-inline" onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} /> よく開くページを追加
          </button>
        )}
      </div>
    </>
  );
}

/// The places for the keyboard left of a space's list (App's `zone`): the
/// sidebar (管理's, 学習's filters) and the spaces' rail, by their entries.
type Zone = "side" | "rail";
const ZONES: Zone[] = ["side", "rail"];
const ZONE_ITEMS: Record<Zone, string> = { side: ".sidebar nav button, .readings-filters button", rail: ".space-rail button" };
const zoneItems = (z: Zone) => [...document.querySelectorAll<HTMLElement>(ZONE_ITEMS[z])];

/// The side of a split view (作業, 学習 while reading) `el` is on; null off both (its list).
const splitSideOf = (el: Element) => {
  const side = el.closest(".focus-left, .focus-right");
  return side ? (side.classList.contains("focus-right") ? "right" : "left") : null;
};

/// One tab's page: its webview laid over a placeholder that follows the
/// layout. `covered` hides it while a dialog is up, since a native webview
/// draws above everything in the page.
/// Gives tab `tab`'s page the keyboard now (with `input`, its text box), as the user asked.
function giveKeys(tab: string, report: (e: unknown) => void, input?: boolean, text?: string) {
  noteFocusRequest();
  api.browserFocus(tab, input, text).catch(report);
}
/// Gives the tab coming up the keyboard, as a browser does: a page once it is
/// shown (now, if it is `shown` already), a terminal, or with none (a new tab
/// page, whose field takes it) this page. Only for the user's own action.
/// With `text`, a page's text box takes it, typed in.
function keysToTab(next: BrowserTab | null, shown: string | undefined, report: (e: unknown) => void, text?: string) {
  if (!next) {
    noteFocusRequest();
    api.focusAppPage().catch(report);
  } else if (next.term) {
    focusSoon(next.id);
    requestAnimationFrame(() => focusTerminal(next.id));
  } else if (next.id === shown) giveKeys(next.id, report, !!text, text);
  else focusSoon(next.id, !!text, text);
}
/// Each tab's `nav` when it was last sent to its address: showing it again
/// with the same one leaves its page where the user moved it.
const sentNav = new Map<string, number>();

function TabView({ tab: active, covered: dialogUp, report, onAddress, onArchive, onBookmark, keep, keysOn = true }: {
  /// Whether the browser's keys (⌘[ ⌘] ⌘L, zoom) are this tab's: in a split
  /// view, only the side that has the keyboard's.
  keysOn?: boolean;
  /// Keeps the page to read (⌘⇧D).
  onBookmark?: () => void;
  tab: BrowserTab;
  covered: boolean;
  report: (e: unknown) => void;
  onAddress: (url: string) => void;
  /// Set on a cloud session's page.
  onArchive?: () => void;
  /// The tab shown beside this one (a split view's other side), left shown.
  keep?: string;
}) {
  const slot = useRef<HTMLDivElement>(null);
  // The address field's suggestions show where the page is, so it steps aside.
  const [suggesting, setSuggesting] = useState(false);
  const covered = dialogUp || suggesting;
  const rect = () => {
    const r = slot.current!.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, viewport: window.innerHeight };
  };
  const navigate = (to: string, go: boolean) =>
    api
      .browserOpen(active.id, to, rect(), go, keep)
      .then((made) => {
        // Only when the user asked for it and has not done anything since: a
        // page that took long to come up does not take the keyboard back.
        // A tab made now takes it as its page comes (BROWSER_URL_EVENT): until
        // then nothing there takes the app's keys, and the app keeps them.
        if (made) return;
        const wish = takeFocusWish(active.id);
        if (wish) return api.browserFocus(active.id, wish.input || undefined, wish.text);
      })
      .catch(report);
  // Switching tabs or coming back from under a dialog shows the page the tab
  // is on, which may have moved on from the address kept here (a page moving
  // without loading is seen a while later); only a new `nav` sends it.
  useEffect(() => {
    if (covered) return void api.browserHide(active.id).catch(report);
    const go = sentNav.get(active.id) !== active.nav;
    sentNav.set(active.id, active.nav);
    navigate(active.url, go);
  }, [active.id, active.nav, covered, keep]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (covered || !slot.current) return;
    // One resize in flight at a time, then the latest size: the page lays
    // itself out again on every resize, and a queue of them lags behind.
    // While a pane edge is dragged the page only moves and keeps its size;
    // it takes the new size once, on release.
    let inFlight = false;
    let again = false;
    let size: { width: number; height: number } | null = null;
    const follow = () => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      const r = rect();
      if (document.body.classList.contains(RESIZING_CLASS) && size) Object.assign(r, size);
      else size = { width: r.width, height: r.height };
      api
        .browserBounds(tabId.current, r)
        .catch(() => {})
        .finally(() => {
          inFlight = false;
          if (again) {
            again = false;
            follow();
          }
        });
    };
    const ro = new ResizeObserver(follow);
    ro.observe(slot.current);
    window.addEventListener("resize", follow);
    window.addEventListener(PANE_RESIZED_EVENT, follow);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", follow);
      window.removeEventListener(PANE_RESIZED_EVENT, follow);
    };
  }, [covered]);
  useEffect(() => () => void api.browserHide(tabId.current).catch(() => {}), []);
  // Some pages move (history.pushState) without loading or retitling; catch
  // up with them, but leave the address alone while it is being edited.
  const shownUrl = useRef(active.url);
  shownUrl.current = active.url;
  const onAddressRef = useRef(onAddress);
  onAddressRef.current = onAddress;
  useEffect(() => {
    if (covered) return;
    const t = setInterval(() => {
      if (!pageVisible() || document.activeElement === address.current) return;
      api
        .browserUrl(active.id)
        .then((url) => url && url !== shownUrl.current && onAddressRef.current(url))
        .catch(() => {});
    }, ADDRESS_POLL_MS);
    return () => clearInterval(t);
  }, [active.id, covered]);
  // ⌘L edits the address, ⌘R reloads, ⌘[ ⌘] go back and forward and ⌘= ⌘- ⌘0
  // zoom (from the address), as in a browser; a script in the page does the same when the page has focus.
  const address = useRef<HTMLInputElement>(null);
  const tabId = useRef(active.id);
  tabId.current = active.id;
  const keysOnRef = useRef(keysOn);
  keysOnRef.current = keysOn;
  useEffect(() => {
    const focusAddress = () => {
      // A pinned page has no address: ⌘L from its page leaves the keyboard there.
      if (!address.current) return void giveKeys(tabId.current, report);
      address.current.focus();
      address.current.select();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!keysOnRef.current) return;
      if (matches(e, "back") || matches(e, "forward")) {
        e.preventDefault();
        api.browserGo(tabId.current, matches(e, "back") ? "back" : "forward").catch(report);
      } else if (matches(e, "focusUrl")) {
        e.preventDefault();
        focusAddress();
      } else if (document.activeElement === address.current) {
        // Only from its own address: a split view shows two of these.
        const zoom = matches(e, "zoomIn") ? "in" : matches(e, "zoomOut") ? "out" : matches(e, "zoomReset") ? "reset" : null;
        if (!zoom) return;
        e.preventDefault();
        api.browserZoom(tabId.current, zoom).catch(report);
      }
    };
    window.addEventListener("keydown", onKey);
    const off = listen<{ tab: string }>(BROWSER_FOCUS_URL_EVENT, ({ payload }) => payload.tab === tabId.current && keysOnRef.current && focusAddress());
    return () => {
      window.removeEventListener("keydown", onKey);
      off.then((f) => f());
    };
  }, [report]);
  return (
    <>
      {/* A pinned page has no address bar: it stays on its page. */}
      {!active.pinned && (
        <div className="browser-bar">
          <button className="ghost icon" aria-label="戻る" onClick={() => api.browserGo(active.id, "back").catch(report)}>
            <Icon name="back" size={14} />
          </button>
          <button className="ghost icon" aria-label="進む" onClick={() => api.browserGo(active.id, "forward").catch(report)}>
            <Icon name="forward" size={14} />
          </button>
          <button className="ghost icon" aria-label="再読み込み" onClick={() => api.browserGo(active.id, "reload").catch(report)}>
            <Icon name="reload" size={14} />
          </button>
          <AddressInput
            key={`${active.id}:${active.url}`}
            inputRef={address}
            defaultValue={active.url}
            label="URL（⌘L で編集）"
            title="⌘L で編集、Enter で移動、Esc でやめる（開いたページから候補が出ます）"
            // What was typed is to be read (j k scroll it, pick a search result): the page takes the keyboard.
            onGo={(url) => {
              focusSoon(active.id);
              navigate(url, true);
            }}
            onSuggesting={setSuggesting}
            // Esc puts the address back and returns to the page, as in a browser.
            onEscape={(input) => {
              input.value = active.url;
              input.blur();
              giveKeys(active.id, report);
            }}
          />
          {/^https?:/.test(active.url) && (
            <div className="segmented translate-toggle" role="group" aria-label="ページの言葉" title="ページをその場で日本語に訳します（Claude。見えているところから）。訳したページは、次に開いたときも訳します">
              <button className={active.translated ? "" : "on"} aria-pressed={!active.translated} onClick={() => active.translated && api.browserTranslate(active.id, false).catch(report)}>
                原文
              </button>
              <button className={active.translated ? "on" : ""} aria-pressed={!!active.translated} onClick={() => !active.translated && api.browserTranslate(active.id, true).catch(report)}>
                日本語
              </button>
            </div>
          )}
          {active.zoom && active.zoom !== 1 && (
            <button className="ghost small" title={`クリックで 100% に戻す（${keyLabel(keyOf("zoomReset"))}）`} onClick={() => api.browserZoom(active.id, "reset").catch(report)}>
              {Math.round(active.zoom * 100)}%
            </button>
          )}
          {onBookmark && (
            <button className="ghost small" title={`このページを読みものに入れる（${keyLabel(keyOf("bookmark"))}。O'Reilly の本のページなら本として目次ごと）`} onClick={onBookmark}>
              <Icon name="bookmark" size={12} /> ブックマーク
            </button>
          )}
          {onArchive && (
            <button className="ghost small" title="この Cloud セッションをアーカイブしてタブを閉じる（⌘⇧A）" onClick={onArchive}>
              アーカイブ
            </button>
          )}
        </div>
      )}
      <div className={`load-bar${active.loading ? " on" : ""}`} aria-hidden="true" />
      <div ref={slot} className="browser-slot">
        {dialogUp && <span className="muted">ダイアログを閉じると表示に戻ります</span>}
      </div>
    </>
  );
}

/// A subtask of `todo`, in its repository (and folder) when it has just one.
const createSubtask = (todo: Todo, title: string) =>
  api.createTodo({ title, parent_id: todo.id, repos: todo.repos.length === 1 && !todo.repos_derived ? todo.repos : [], cwd: todo.repos.length === 1 ? (todo.cwd ?? undefined) : undefined });

/// The launch sheet (⌘Enter, or o without a session): the first prompt, where
/// it runs and the subtasks, all from the keyboard; ⌘⇧N goes to adding a subtask.
function StartDialog({ todo, allTodos, run, onClose }: { todo: Todo; allTodos: Todo[]; run: (f: () => Promise<unknown>) => void; onClose: () => void }) {
  const children = allTodos.filter((c) => c.parent_id === todo.id);
  const subtask = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey || e.key.toLowerCase() !== "n") return;
      e.preventDefault();
      subtask.current?.querySelector("input")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <Modal title={`#${todo.id} ${todo.title}`} wide onClose={onClose}>
      <Composer todo={todo} run={run} onStarted={onClose} />
      {!todo.parent_id && (
        <section className="start-subtasks" ref={subtask}>
          <h3>
            サブタスク {children.length > 0 && <span className="muted">{children.length}</span>} <span className="kbd">⌘⇧N</span>
          </h3>
          {children.length > 0 && (
            <ul className="rows compact">
              {children.map((c) => (
                <li key={c.id} className="row">
                  <StatusIcon status={c.status} />
                  <span className="row-title">{c.title}</span>
                </li>
              ))}
            </ul>
          )}
          <SubmitInput placeholder="サブタスクのタイトルを入力して Enter" onSubmit={(title) => run(() => createSubtask(todo, title))} />
        </section>
      )}
    </Modal>
  );
}

/// A database to put a todo in, or none.
function DatabaseSelect({ databases, value, onPick }: { databases: Database[]; value: number | null; onPick: (id: number | null) => void }) {
  return (
    <select className="select" value={value ?? ""} aria-label="DB" onClick={stop} onChange={(e) => onPick(e.target.value ? Number(e.target.value) : null)}>
      <option value="">なし</option>
      {databases.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </select>
  );
}

/// A database's name: a new one's (shown once made), or `database`'s put right.
function DatabaseDialog({ database, databases, run, onMade, onClose }: {
  database: Database | null;
  databases: Database[];
  run: (f: () => Promise<unknown>) => void;
  onMade: (d: Database) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(database?.name ?? "");
  const trimmed = name.trim();
  const taken = databases.some((d) => d.name === trimmed && d.id !== database?.id);
  const save = () => {
    if (!trimmed || taken) return;
    onClose();
    run(async () => (database ? api.renameDatabase(database.id, trimmed) : onMade(await api.createDatabase(trimmed))));
  };
  return (
    <Modal
      title={database ? "DB の名前を変える" : "新しい DB"}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button className="ghost" onClick={onClose}>
            やめる
          </button>
          <button className="primary" disabled={!trimmed || taken} onClick={save}>
            {database ? "変える" : "作る"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>名前</span>
        <input autoFocus value={name} placeholder="Frontend Backlog" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => isEnter(e) && save()} />
      </label>
      {taken && <p className="muted small-text">同じ名前の DB があります。</p>}
      {!database && <p className="muted small-text">管理のサイドバーの「DB」に並びます。todo はシートの「DB」か、{keyLabel(keyOf("palette"))} の「DB に入れる」で入れます。</p>}
    </Modal>
  );
}

function TodoPanel({ todo, allTodos, waiting, artifacts, local, groups, databases, unlinked, run, report, setStatus, onOpenTodo, onStart, onWork, onClose }: {
  todo: Todo;
  /// The sessions of no todo, to link one to this.
  unlinked: Session[];
  /// The databases the user made, to put the todo in one.
  databases: Database[];
  /// Every artifact: the todo's (and its subtasks') are listed.
  artifacts: Artifact[];
  /// あなた待ち, for what of it is under this todo.
  waiting: WaitItem[];
  allTodos: Todo[];
  local: LocalRepo[];
  groups: string[];
  run: (f: () => Promise<unknown>) => void;
  report: (e: unknown) => void;
  setStatus: (todo: Todo, status: Status) => void;
  onOpenTodo: (id: number) => void;
  /// The launch sheet.
  onStart: () => void;
  /// Its sessions (and its subtasks') in 作業.
  onWork: () => void;
  onClose: () => void;
}) {
  const browse = useOpenLink(report);
  const fix = useContext(FixContext);
  // The session to send what to fix when the PR's CI failed or changes were asked
  // for: the latest one, unless it is at it already.
  const latest = [...todo.sessions].sort((a, b) => b.state_at - a.state_at)[0];
  const fixable = (todo.ci_state === "failure" || todo.pr_state === "changes_requested") && latest?.state !== "running" ? latest : undefined;
  // e m a: its title, memo and a new subtask (the other keys are todoKeys.ts's).
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest(TYPING) || document.querySelector("[role=dialog], .app[data-zone]")) return;
      const el = root.current;
      const title = matches(e, "editTitle") && el?.querySelector<HTMLInputElement>(".panel-title");
      const target = title || (matches(e, "editMemo") && el?.querySelector<HTMLElement>(".memo.editable")) || (matches(e, "addSubtask") && el?.querySelector<HTMLElement>(".add-inline"));
      if (!target) return;
      e.preventDefault();
      if (title) title.focus();
      else target.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Every field saves as soon as it is left.
  const update = (u: Parameters<typeof api.updateTodo>[1]) => run(() => api.updateTodo(todo.id, u));
  const children = allTodos.filter((c) => c.parent_id === todo.id);
  const parent = todo.parent_id ? allTodos.find((t) => t.id === todo.parent_id) : undefined;
  const [menu, setMenu] = useState(false);
  // window.confirm never returns true inside the Tauri webview, so confirm in place.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    setConfirmingDelete(false);
    setMenu(false);
  }, [todo.id]);
  const gh = githubTarget(todo);
  const addChild = (title: string) => run(() => createSubtask(todo, title));
  // A parent: its plan, what waits under it, and what happened (経過).
  const isParent = children.length > 0 || !!todo.plan;
  const under = waiting.filter((w) => w.todo && (w.todo.id === todo.id || w.todo.parent_id === todo.id));
  // Its sessions (and its subtasks'), only as how many stand how: their talk is 作業's.
  const sessions = [...todo.sessions, ...children.flatMap((c) => c.sessions)];
  const live = sessions.filter((s) => s.state !== "ended");
  const byState = STATE_ORDER.filter((st) => st !== "ended")
    .map((st) => [st, live.filter((s) => s.state === st).length] as const)
    .filter(([, n]) => n > 0);
  const [events, setEvents] = useState<TodoEvent[]>([]);
  useEffect(() => {
    if (!isParent) return setEvents([]);
    const load = () => void api.todoEvents(todo.id).then(setEvents, report);
    load();
    const timer = setInterval(load, EVENTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [todo.id, isParent]); // eslint-disable-line react-hooks/exhaustive-deps
  const latestOf = (t: Todo) => [...t.sessions].sort((a, b) => b.state_at - a.state_at)[0];
  const mine = artifacts.filter((a) => a.todo_id === todo.id || children.some((c) => c.id === a.todo_id));
  return (
    <aside ref={root} className="panel" aria-label={`#${todo.id} ${todo.title}`} onClick={stop}>
      <header className="panel-head">
        {parent && (
          <>
            <button className="link-button" onClick={() => onOpenTodo(parent.id)}>
              #{parent.id} {parent.title}
            </button>
            <Icon name="chevronRight" size={12} />
          </>
        )}
        <span className="mono">#{todo.id}</span>
        <span className="grow" />
        {gh && (
          <button className="ghost icon" aria-label="GitHub で開く" title={gh} onClick={() => browse(gh)}>
            <Icon name="open" size={14} />
          </button>
        )}
        <span className="menu-anchor">
          <button className="ghost icon" aria-label="その他" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <Icon name="more" size={14} />
          </button>
          {menu && (
            <span className="menu" role="menu">
              {!todo.issue_url && todo.repos.some(isGithubRepo) && (
                <button role="menuitem" onClick={() => (setMenu(false), run(() => api.createIssue(todo.id)))}>
                  タイトルとメモから issue を作る
                </button>
              )}
              <button role="menuitem" className="danger" onClick={() => (setMenu(false), setConfirmingDelete(true))}>
                todo を削除…
              </button>
            </span>
          )}
        </span>
        <button className="ghost icon" onClick={onClose} aria-label="閉じる">
          <Icon name="close" size={14} />
        </button>
      </header>
      {confirmingDelete && (
        <div className="notice danger-notice">
          <span>#{todo.id} を削除しますか？ 紐づいたセッションは未紐づけに戻ります。</span>
          <button
            className="danger"
            onClick={() =>
              run(async () => {
                await api.deleteTodo(todo.id);
                onClose();
              })
            }
          >
            削除する
          </button>
          <button className="ghost" onClick={() => setConfirmingDelete(false)}>
            やめる
          </button>
        </div>
      )}
      <InlineInput className="panel-title" value={todo.title} label="タイトル" placeholder="タイトル" required onSave={(title) => update({ title: title.trim() })} />
      <div className="panel-body">
        <dl className="props">
          <dt>ステータス</dt>
          <dd>
            <StatusSelect todo={todo} setStatus={setStatus} />
          </dd>
          <dt>リポジトリ</dt>
          <dd>
            <RepoChips todo={todo} local={local} groups={groups} update={update} />
          </dd>
          <dt>DB</dt>
          <dd>
            {databases.length > 0 ? (
              <DatabaseSelect databases={databases} value={databases.find((d) => d.todos.includes(todo.id))?.id ?? null} onPick={(id) => run(() => api.setTodoDatabase(todo.id, id))} />
            ) : (
              <span className="muted">まだありません（{keyLabel(keyOf("palette"))} の「新しい DB を作る」から）</span>
            )}
          </dd>
          <dt>親</dt>
          <dd>
            <ParentPicker todo={todo} allTodos={allTodos} run={run} />
          </dd>
          <dt>Issue</dt>
          <dd className="gh-row">
            {todo.issue_url ? (
              <>
                <button className="link-button mono" onClick={() => browse(todo.issue_url!)} title={todo.issue_url}>
                  {issueRef(todo.issue_url) ?? todo.issue_url}
                </button>
                {todo.issue_state && <span className={`gh gh-issue-${todo.issue_state}`}>{todo.issue_state}</span>}
                {todo.issue_state === "open" && (
                  <button className="ghost small" onClick={() => run(() => api.closeIssue(todo.id))}>
                    close
                  </button>
                )}
                <button className="ghost icon" onClick={() => update({ issue_url: "" })} aria-label="issue を外す" title="外す">
                  <Icon name="close" size={12} />
                </button>
              </>
            ) : (
              <InlineInput value="" placeholder="URL を貼る" onSave={(issue_url) => update({ issue_url })} />
            )}
          </dd>
          <dt>PR</dt>
          <dd className="gh-row">
            {todo.pr_url ? (
              <>
                <button className="link-button mono" onClick={() => browse(todo.pr_url!)} title={todo.pr_url}>
                  {issueRef(todo.pr_url) ?? todo.pr_url}
                </button>
                {todo.pr_state && <span className={`gh gh-pr-${todo.pr_state}`}>{PR_LABEL[todo.pr_state]}</span>}
                <CiChip todo={todo} />
                {fix && fixable && (
                  <button className="small" title="元のセッションに、直すところを送ります（画面もフォーカスも動きません）" onClick={() => fix(fixable, todo)}>
                    再開して直させる
                  </button>
                )}
                <button className="ghost icon" onClick={() => update({ pr_url: "" })} aria-label="PR を外す" title="外す">
                  <Icon name="close" size={12} />
                </button>
              </>
            ) : (
              <InlineInput value="" placeholder={`claude/todo-${todo.id}- のブランチなら自動で紐づけ`} onSave={(pr_url) => update({ pr_url })} />
            )}
          </dd>
          <dt>フォルダ</dt>
          <dd>
            <InlineInput className="mono" value={todo.cwd ?? ""} label="作業フォルダ" placeholder="未設定" onSave={(cwd) => update({ cwd })} />
          </dd>
        </dl>

        <section className="sessions-summary">
          <h3>セッション</h3>
          {sessions.length === 0 ? (
            <p className="muted hint">まだありません。{keyLabel(keyOf("start"))} で始めます。</p>
          ) : (
            <div className="summary-line">
              <span>
                {live.length > 0 ? `${live.length} 件` : `${sessions.length} 件（終了）`}
                {byState.length > 0 && `（${byState.map(([st, n]) => `${STATE_LABEL[st]} ${n}`).join("・")}）`}
              </span>
              {under.length > 0 && <span className="pill waiting">あなた待ち {under.length}</span>}
              <span className="grow" />
              <button className="primary small" onClick={onWork} title="会話は作業で見ます">
                作業で開く <span className="kbd">{keyLabel(keyOf("session"))}</span>
              </button>
            </div>
          )}
          {unlinked.length > 0 && (
            <div className="summary-line">
              <select
                className="select"
                value=""
                aria-label="todo のないセッションを紐づける"
                title={`todo のないセッションをこの todo に紐づけます（${keyLabel(keyOf("palette"))} の「#${todo.id} にセッションを紐づける」でも）`}
                onChange={(e) => e.target.value && run(() => api.linkSession(e.target.value, todo.id))}
              >
                <option value="">todo のないセッションを紐づける…</option>
                {unlinked.map((s) => (
                  <option key={s.session_id} value={s.session_id}>
                    {sessionLabel(s)}（{STATE_LABEL[s.state]} · {ago(s.state_at)}）
                  </option>
                ))}
              </select>
            </div>
          )}
        </section>

        {!parent && (
          <section>
            <h3>
              サブタスク {children.length > 0 && <span className="muted">{children.filter((c) => c.status === "done").length}/{children.length}</span>}
            </h3>
            {children.length === 0 && todo.is_orchestrator && (
              <p className="muted hint">セッションを Local で始めると、Claude がリポジトリごとのサブタスクを登録します。</p>
            )}
            <ul className="rows compact">
              {children.map((c) => {
                const s = latestOf(c);
                return (
                  <li key={c.id} className="row" onClick={() => onOpenTodo(c.id)}>
                    <StatusIcon status={c.status} />
                    <span className="row-title">{c.title}</span>
                    {s && c.status !== "done" && <StateBadge state={s.state} unread={s.unread} />}
                    {c.repos[0] && <span className="tag">{repoName(c.repos[0])}</span>}
                    <GhChip todo={c} report={report} />
                    <CiChip todo={c} />
                  </li>
                );
              })}
            </ul>
            <AddInline label="サブタスクを追加" onAdd={addChild} />
          </section>
        )}

        <div className="sheet-start">
          <button className="primary" onClick={onStart}>
            セッションを始める <span className="kbd">{keyLabel(keyOf("start"))}</span>
          </button>
          <span className="muted hint">
            {keyLabel(keyOf("editTitle"))} タイトル · {keyLabel(keyOf("editMemo"))} メモ · {keyLabel(keyOf("addSubtask"))} サブタスク · {keyLabel(keyOf("status"))} ステータス ·{" "}
            {keyLabel(keyOf("session"))} 作業で開く · {keyLabel(keyOf("down"))} {keyLabel(keyOf("up"))} 前後の todo · Esc 閉じる
          </span>
        </div>

        <section>
          <h3>メモ</h3>
          <MemoEditor value={todo.memo ?? ""} report={report} onSave={(memo) => update({ memo })} />
        </section>

        {mine.length > 0 && (
          <section>
            <h3>
              成果物 <span className="muted">{mine.length}</span>
            </h3>
            <ArtifactRows artifacts={mine} todos={allTodos} report={report} onOpenTodo={onOpenTodo} />
          </section>
        )}

        {isParent && (
          <section>
            <h3>計画 <span className="muted">サブタスクのセッションが最初から知っています</span></h3>
            <MemoEditor value={todo.plan ?? ""} label="計画" plan report={report} onSave={(plan) => run(() => api.setPlan(todo.id, plan))} />
          </section>
        )}

        {isParent && events.length > 0 && (
          <section>
            <h3>経過</h3>
            <ul className="events">
              {events.map((e) => (
                <li key={e.id}>
                  <span className="muted when">{ago(e.at)}</span>
                  <span>{e.text.replace(/^\[todo-sessions\] /, "")}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

      </div>
    </aside>
  );
}

/// A session, with the todo it belongs to.
interface SessionItem {
  session: Session;
  todo?: Todo;
}

/// Why something waits on the user, as its row's word.
const WAIT_WORD: Record<WaitItem["reasons"][number], string> = {
  escalated: "回されました",
  needs_input: "返事待ち",
  changes: "修正依頼",
  ci: "CI 失敗",
  review: "レビュー依頼",
  review_failed: "レビュー失敗",
};

const ARTIFACT_KIND: Record<Artifact["kind"], string> = { artifact: "アーティファクト", doc: "ドキュメント", file: "ファイル" };

/// An artifact's name: its title, else where it is.
const artifactName = (a: Artifact) => a.title ?? (a.kind === "file" ? (a.url.split("/").pop() ?? a.url) : `名前のない${ARTIFACT_KIND[a.kind]}（${a.url.split("/").pop()?.slice(0, ARTIFACT_ID_SHOWN)}）`);
/// Characters of an untitled artifact's id its name shows.
const ARTIFACT_ID_SHOWN = 8;

/// Opens an artifact in the pane: a claude.ai page, or a file on the Mac
/// (with ctrl, in the default browser or the file's app).
function useOpenArtifact() {
  const openInBrowser = useContext(BrowserContext);
  return (a: Artifact) => openInBrowser?.(a.kind === "file" && !/^https?:/.test(a.url) ? fileUrl(a.url) : a.url);
}

/// Artifacts as rows: their kind, name, todo and when; with `onForget`, a
/// way to take each off the list (the cursor's row shown as such).
function ArtifactRows({ artifacts, todos, report, onOpenTodo, cursorId, onForget }: {
  artifacts: Artifact[];
  todos: Todo[];
  report: (e: unknown) => void;
  onOpenTodo: (id: number) => void;
  cursorId?: string | null;
  onForget?: (a: Artifact) => void;
}) {
  const open = useOpenArtifact();
  return (
    <ul className="rows compact">
      {artifacts.map((a) => {
        const todo = todos.find((t) => t.id === a.todo_id);
        return (
          <li key={a.id} data-row={artifactRow(a)} className={`row artifact-row${artifactRow(a) === cursorId ? " cursor" : ""}`} title={a.url} onClick={() => open(a)}>
            <span className="tag">{ARTIFACT_KIND[a.kind]}</span>
            <span className="row-title ellipsis">{artifactName(a)}</span>
            {todo && (
              <button className="tag todo-chip" onClick={(e) => (e.stopPropagation(), onOpenTodo(todo.id))} title={todo.title}>
                #{todo.id} {todo.title}
              </button>
            )}
            <span className="muted when">{ago(a.created_at)}</span>
            {onForget && (
              <button className="ghost icon" aria-label={`${artifactName(a)} を一覧から消す`} title={`一覧から消す（${keyLabel(keyOf("artifactForget"))}）`} onClick={(e) => (e.stopPropagation(), onForget(a))}>
                <Icon name="close" size={12} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const artifactRow = (a: Artifact) => `a:${a.id}`;

/// What sessions made besides PRs, newest first, narrowed to a todo (a parent
/// with its subtasks).
function ArtifactsPage({ artifacts, todos, report, run, onOpenTodo }: {
  artifacts: Artifact[];
  todos: Todo[];
  report: (e: unknown) => void;
  run: (f: () => Promise<unknown>) => void;
  onOpenTodo: (id: number) => void;
}) {
  const [todoFilter, setTodoFilter] = useState<number | null>(null);
  const parentOf = (id: number | null) => todos.find((t) => t.id === id)?.parent_id ?? null;
  const shown = todoFilter === null ? artifacts : artifacts.filter((a) => a.todo_id === todoFilter || parentOf(a.todo_id) === todoFilter);
  const open = useOpenArtifact();
  const forget = (a: Artifact) => run(() => api.forgetArtifact(a.id));
  const byRow = (id: string) => shown.find((a) => artifactRow(a) === id);
  const { cursorId, list } = useRowCursor(
    shown.map(artifactRow),
    (id) => {
      const a = byRow(id);
      if (a) open(a);
    },
    (e, id) => {
      const a = id && byRow(id);
      if (!a || !matches(e, "artifactForget")) return false;
      forget(a);
      return true;
    },
  );
  // The todos with artifacts, and their parents.
  const withArtifacts = new Set(artifacts.flatMap((a) => (a.todo_id === null ? [] : [a.todo_id, parentOf(a.todo_id)].filter((x): x is number => x !== null))));
  return (
    <>
      <header className="toolbar">
        <h1>成果物</h1>
        <span className="muted">{shown.length}</span>
        {withArtifacts.size > 0 && (
          <select className="select compact" value={todoFilter ?? ""} aria-label="todo で絞り込む" onChange={(e) => setTodoFilter(e.target.value ? Number(e.target.value) : null)}>
            <option value="">すべての todo</option>
            {todos
              .filter((t) => withArtifacts.has(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  #{t.id} {t.title}
                  {todos.some((c) => c.parent_id === t.id) ? "（サブタスクも）" : ""}
                </option>
              ))}
          </select>
        )}
      </header>
      <div className="content" ref={list}>
        {shown.length === 0 && (
          <p className="muted empty">まだありません。セッションが claude.ai にアーティファクトやドキュメントを作ると、ひと区切りしたときにここへ並びます。html スキルで書いた文書も並びます。ほかの Mac のファイルは、セッションが todo-sessions の add_artifact で登録します。</p>
        )}
        <ArtifactRows artifacts={shown} todos={todos} report={report} onOpenTodo={onOpenTodo} cursorId={cursorId} onForget={forget} />
      </div>
    </>
  );
}

type SlackFilter = "unread" | "mention" | "thread" | "read" | "bookmark";
const SLACK_FILTERS: SlackFilter[] = ["unread", "mention", "thread", "read", "bookmark"];
const SLACK_FILTER_LABEL: Record<SlackFilter, string> = { unread: "未読", mention: "メンション", thread: "スレッド", read: "既読", bookmark: "ブックマーク" };
const SLACK_EMPTY: Record<SlackFilter, string> = {
  unread: "未読はありません。",
  mention: "未読はありません。",
  thread: "未読はありません。",
  read: "既読はまだありません。",
  bookmark: "ブックマークはまだありません。スレッドで選んでいるメッセージ（⇧J ⇧K で選ぶ）を B でブックマークします。",
};
/// The Slack page's list width (px), dragged by its edge and kept.
const SLACK_LIST_KEY = "slackListWidth";
const SLACK_LIST_WIDTH = { min: 260, max: 720, initial: 380, step: 40 };

const mentionKey = (m: { channel: string; ts: string }) => `m:${m.channel}:${m.ts}`;

/// 「Todo にする」's memo: who said it where, what, and its link.
const slackMemo = (i: SlackItem) => `Slack #${i.channelName} の ${i.userName}さんから:\n${i.text}\n\n${i.permalink}`;

/// Slack (#27, #28): the unread mentions of the user and of their user
/// groups, and the threads they are in with new replies, newest first. One
/// is read once opened (it leaves the unread when another is) or Done (e);
/// 既読 shows the read rows.
function SlackPage({ slack, pick, run, report, onSettings, onTodo }: {
  slack: SlackView;
  /// A mention to show (a notification's click), by mentionKey.
  pick: string | null;
  run: (f: () => Promise<unknown>) => void;
  report: (e: unknown) => void;
  onSettings: () => void;
  /// 「Todo にする」: the new todo dialog with this memo.
  onTodo: (memo: string) => void;
}) {
  const [filter, setFilter] = useState<SlackFilter>("unread");
  const items = slackItems(slack.messages, slack.threads);
  const marked = bookmarkItems(slack.bookmarks);
  // A notification names a mention: its thread's row is picked.
  const rowOf = (mention: string | null) => items.find((i) => i.mentions.some((m) => mentionKey(m) === mention))?.key ?? null;
  const [selected, setSelected] = useState<string | null>(() => rowOf(pick));
  useEffect(() => {
    if (pick) open(rowOf(pick));
  }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps
  const [width, setWidth] = useState(() => loadJson<number>(SLACK_LIST_KEY, SLACK_LIST_WIDTH.initial));
  // The right side: a new message being written, or the one just posted.
  const [composing, setComposing] = useState(false);
  const [posted, setPosted] = useState<SlackItem | null>(null);
  const openInBrowser = useContext(BrowserContext);
  const openLink = (url: string) => (openInBrowser ? openInBrowser(url) : void api.openLink(url).catch(report));
  const unread = items.filter((i) => !i.read);
  const counts: Record<SlackFilter, number> = {
    unread: unread.length,
    mention: unread.filter((i) => i.mention && i.via === null).length,
    thread: unread.filter((i) => i.newReplies > 0).length,
    read: items.length - unread.length,
    bookmark: marked.length,
  };
  const inFilter = (i: SlackItem) =>
    filter === "bookmark"
      ? i.kind === "bookmark"
      : i.kind !== "bookmark" && (filter === "read" ? i.read : !i.read && (filter === "unread" || (filter === "thread" ? i.newReplies > 0 : i.mention && i.via === null)));
  // The one picked stays while it is read, so it does not jump away.
  const shown = [...items, ...marked].filter((i) => i.key === selected || inFilter(i));
  const current = items.find((i) => i.key === selected) ?? marked.find((i) => i.key === selected) ?? (posted?.key === selected ? posted : null);
  // ↑↓ or j k pick a row, Enter shows its thread.
  const { cursorId, setCursor, list } = useRowCursor(
    shown.map((i) => i.key),
    (id) => (setComposing(false), open(id)),
  );
  const onPosted = (channel: { id: string; name: string }, ts: string) => {
    const item: SlackItem = { key: `p:${channel.id}:${ts}`, kind: "posted", channel: channel.id, threadTs: ts, ts, channelName: channel.name, userName: "", userImage: null, text: "", permalink: "", mention: false, via: null, newReplies: 0, read: true, mentions: [] };
    setPosted(item);
    setComposing(false);
    setSelected(item.key);
  };
  /// The row after `item` (else before it) still in the view, to go on to
  /// (`gone`: the rows that leave with it).
  const nextAfter = (item: SlackItem, gone = (i: SlackItem) => i.key === item.key) => {
    const at = shown.findIndex((i) => i.key === item.key);
    const rest = shown.filter((i) => !gone(i) && inFilter(i));
    return rest.find((i) => shown.indexOf(i) > at) ?? rest.reverse().find((i) => shown.indexOf(i) < at);
  };
  const goOn = (next: SlackItem | undefined) => {
    setSelected(next?.key ?? null);
    if (next) setCursor(next.key);
  };
  /// The row's mentions read and its replies seen.
  const markRead = (item: SlackItem) => run(() => Promise.all([...item.mentions.map((m) => api.slackRead(m.channel, m.ts)), api.slackThreadSeen(item.channel, item.threadTs)]));
  /// Opening a row reads it; it stays in the list until another is opened.
  /// The row Done or 消す goes on to is shown, not read.
  const open = (key: string | null) => {
    setSelected(key);
    const item = items.find((i) => i.key === key);
    if (item && !item.read) markRead(item);
  };
  /// Done: the row read, off the unread; on to the next row.
  const done = (item: SlackItem) => {
    const next = nextAfter(item);
    markRead(item);
    goOn(next);
  };
  /// The row whose 消す waits for a second press (or its button).
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  /// 消す: the row's mentions wiped from this Mac (and kept away), its thread no longer followed.
  const forget = (item: SlackItem) => {
    setConfirmForget(null);
    const next = nextAfter(item);
    run(() => Promise.all([...item.mentions.map((m) => api.slackForget(m.channel, m.ts)), api.slackForgetThread(item.channel, item.threadTs)]));
    goOn(next);
  };
  /// Bookmarks a message of the row's thread (its head: the thread), or takes it off.
  const isBookmarked = (channel: string, ts: string) => slack.bookmarks.some((b) => b.channel === channel && b.ts === ts);
  const toggleBookmark = (item: SlackItem, m: SlackThreadMessage) =>
    run(() =>
      isBookmarked(item.channel, m.ts)
        ? api.slackUnbookmark(item.channel, m.ts)
        : api.slackBookmark({ channel: item.channel, ts: m.ts, thread_ts: m.ts === item.threadTs ? null : item.threadTs, channel_name: item.channelName, user_name: m.user_name, user_image: m.user_image, text: slackPlain(m.text), permalink: m.permalink }),
    );
  /// Mutes the row's channel in Shosai: its rows leave; on to a row of another channel.
  const muteChannel = (item: SlackItem) => {
    const next = nextAfter(item, (i) => i.channel === item.channel);
    run(() => api.slackMuteChannel(item.channel, true));
    goOn(next);
  };
  /// 既読をすべて消す asks twice: 0 not asked, 1 asked, 2 asked again.
  const [confirmForgetRead, setConfirmForgetRead] = useState<0 | 1 | 2>(0);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  // The open thread's own keys: its message cursor, its todo memo, its mute.
  const threadKeys = useRef<SlackThreadKeys | null>(null);
  // The workspace's emoji not had (emoji:read missing, say): shown as names, and said here.
  useEffect(() => {
    if (slack.connected) customEmoji().catch(report);
  }, [slack.connected]); // eslint-disable-line react-hooks/exhaustive-deps
  const keepWidth = (w: number) => {
    const next = Math.min(Math.max(w, SLACK_LIST_WIDTH.min), SLACK_LIST_WIDTH.max);
    setWidth(next);
    remember(SLACK_LIST_KEY, JSON.stringify(next));
  };
  // The page's keys (keymap.ts, "Slack の画面"); j k and Enter are the list's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest(TYPING) || document.querySelector(".app[data-zone], .sheet-backdrop, [role=dialog]")) return;
      if (matches(e, "slackFilter")) setFilter((f) => SLACK_FILTERS[(SLACK_FILTERS.indexOf(f) + 1) % SLACK_FILTERS.length]);
      else if (matches(e, "slackCompose")) setComposing(true);
      else if (composing && e.key === "Escape") setComposing(false);
      else if (matches(e, "slackNarrower")) keepWidth(width - SLACK_LIST_WIDTH.step);
      else if (matches(e, "slackWider")) keepWidth(width + SLACK_LIST_WIDTH.step);
      else if (!current) return;
      else if (e.key === "Escape") confirmForget ? setConfirmForget(null) : setSelected(null);
      else if (matches(e, "slackDone")) done(current);
      else if (matches(e, "slackForget") && current.kind === "thread") confirmForget === current.key ? forget(current) : setConfirmForget(current.key);
      else if (matches(e, "slackReply")) replyRef.current?.focus();
      else if (matches(e, "slackTodo")) onTodo(threadKeys.current?.memo() ?? slackMemo(current));
      else if (matches(e, "slackOpen")) openLink(current.permalink);
      else if (matches(e, "slackMute")) threadKeys.current?.mute();
      else if (matches(e, "slackMuteChannel")) muteChannel(current);
      else if (matches(e, "slackBookmark")) threadKeys.current?.bookmark();
      else if (matches(e, "slackReact")) threadKeys.current?.react();
      else if (matches(e, "slackScrollDown")) threadKeys.current?.move(1);
      else if (matches(e, "slackScrollUp")) threadKeys.current?.move(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const resize = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const from = width;
    const move = (ev: PointerEvent) => setWidth(Math.min(Math.max(from + ev.clientX - startX, SLACK_LIST_WIDTH.min), SLACK_LIST_WIDTH.max));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      keepWidth(from + ev.clientX - startX);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <>
      <header className="toolbar">
        <h1>Slack</h1>
        {slack.connected && (
          <div className="segmented" role="group" aria-label="絞り込み" title={`${keyLabel(keyOf("slackFilter"))} で切り替え`}>
            {SLACK_FILTERS.map((f) => (
              <button key={f} className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {SLACK_FILTER_LABEL[f]} {counts[f]}
              </button>
            ))}
          </div>
        )}
        <span className="muted">自分とユーザーグループへのメンションと、参加しているスレッドの返信だけ</span>
        <span className="grow" />
        {slack.connected && filter === "read" && counts.read > 0 &&
          (confirmForgetRead === 0 ? (
            <button className="ghost small" title="既読のメンションをこの Mac から消します（30日たつと自動でも消えます）" onClick={() => setConfirmForgetRead(1)}>
              既読をすべて消す
            </button>
          ) : (
            <span className="inline-confirm">
              {confirmForgetRead === 1 ? `既読 ${counts.read} 件を、この Mac から消しますか？` : `元に戻せません。本当に既読 ${counts.read} 件を消しますか？`}
              <button className="danger small" onClick={() => (confirmForgetRead === 1 ? setConfirmForgetRead(2) : (setConfirmForgetRead(0), run(() => api.slackForgetRead())))}>
                {confirmForgetRead === 1 ? "消す" : "本当に消す"}
              </button>
              <button className="ghost small" onClick={() => setConfirmForgetRead(0)}>
                やめる
              </button>
            </span>
          ))}
        {slack.connected && (
          <button className="small" onClick={() => setComposing(true)}>
            新しいメッセージ <span className="kbd">{keyLabel(keyOf("slackCompose"))}</span>
          </button>
        )}
        {slack.connected && (
          <span className="muted slack-live" title={
              !slack.live
                ? "設定でアプリのトークン（xapp-…）を入れると、その場で届きます"
                : slack.last_event_at
                  ? "Socket Mode でつながっています。投稿されたその場で届きます"
                  : `Socket Mode でつながっていますが、まだ何も届いていません。Slack アプリの Event Subscriptions に、${SLACK_USER_EVENTS}を足してください`
            }>
            <span className={`dot ${slack.live ? "live" : ""}`} /> {slack.live ? `リアルタイム（${slack.last_event_at ? `最後の受信 ${ago(slack.last_event_at)}` : "まだ受信なし"}）` : "1分おきに確認"}
          </span>
        )}
      </header>
      {!slack.connected ? (
        <div className="content">
          <p className="muted empty">Slack とつながっていません。設定で、自分用の Slack アプリのユーザートークン（xoxp-…）を入れてください。</p>
          <div>
            <button className="primary" onClick={onSettings}>
              設定を開く
            </button>
          </div>
        </div>
      ) : (
        <div className="content flush slack-page" style={{ gridTemplateColumns: current || composing ? `${width}px 6px minmax(0, 1fr)` : "minmax(0, 1fr)" }}>
          <div className="slack-list" ref={list}>
            {slack.error && <p className="error-text pad">Slack から読めませんでした：{slack.error}</p>}
            {slack.events_quiet && (
              <p className="error-text pad">
                リアルタイムでつながっていますが、しばらく何も届いていません。投稿の少ない時間でなければ、Slack アプリの Event Subscriptions の Enable Events が止められていないか確かめてください（Mac が1時間ほど離れていると Slack が止め、メールで知らせてきます。設定で設定用トークンを入れておくと、スリープ中はイベントを外し、止められていてもつなぎ直すときに ON に戻します）。止まっているあいだも、メンションは1分おきの確認で届きます。
              </p>
            )}
            {shown.length === 0 && <p className="muted pad">{SLACK_EMPTY[filter]}</p>}
            <ul className="rows">
              {shown.map((i) => (
                <li key={i.key} data-row={i.key} className={`row slack-row${i.read ? "" : " slack-unread"}${i.key === selected ? " selected" : ""}${i.key === cursorId ? " cursor" : ""}`} onClick={() => (setCursor(i.key), setComposing(false), open(i.key))}>
                  <SlackAvatar name={i.userName} image={i.userImage} size={32} />
                  <span className="slack-row-main">
                    <span className="slack-meta">
                      <b className="ellipsis">{i.userName}</b>
                      <span className="ellipsis">#{i.channelName}</span>
                      {i.via && <span className="tag">@{i.via}</span>}
                      {i.newReplies > 0 && <span className="tag">新しい返信 {i.newReplies}</span>}
                      <span className="grow" />
                      <span className="slack-time">{ago(Number(i.ts))}</span>
                    </span>
                    <span className="slack-body">
                      <SlackLine text={i.text} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {composing && (
            <>
              <div className="slack-split" role="separator" aria-orientation="vertical" aria-label="一覧の幅" onPointerDown={resize} />
              <SlackCompose report={report} onPosted={onPosted} onClose={() => setComposing(false)} />
            </>
          )}
          {current && !composing && (
            <>
              <div className="slack-split" role="separator" aria-orientation="vertical" aria-label="一覧の幅" onPointerDown={resize} />
              <SlackThread
                key={current.key}
                item={current}
                me={slack.user_id}
                replyRef={replyRef}
                keysRef={threadKeys}
                report={report}
                onLink={openLink}
                onDone={() => done(current)}
                confirmingForget={confirmForget === current.key}
                onForget={() => (confirmForget === current.key ? forget(current) : setConfirmForget(current.key))}
                onCancelForget={() => setConfirmForget(null)}
                bookmarked={(ts) => isBookmarked(current.channel, ts)}
                onBookmark={(m) => toggleBookmark(current, m)}
                onMuteChannel={() => muteChannel(current)}
                onTodo={onTodo}
                onClose={() => setSelected(null)}
              />
            </>
          )}
        </div>
      )}
    </>
  );
}

/// A Slack user's picture, or their initial without one.
function SlackAvatar({ name, image, size }: { name: string; image: string | null | undefined; size: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (image && !broken) return <img className="slack-avatar" style={style} src={image} alt="" onError={() => setBroken(true)} />;
  return (
    <span className="slack-avatar initial" style={style} aria-hidden>
      {[...name][0] ?? "?"}
    </span>
  );
}

/// "10:42", or "10/8 10:42" on another day: a Slack message's time.
function slackTime(ts: string) {
  const d = new Date(Number(ts) * 1000);
  const time = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/// Slack's markup, formatted (slackText.ts); links open with `onLink`.
/// The workspace's own emoji (name → picture), asked once a run (again after a failure).
let slackCustomEmoji: Promise<Record<string, string>> | null = null;
const customEmoji = () =>
  (slackCustomEmoji ??= api.slackEmoji().catch((e) => {
    slackCustomEmoji = null;
    throw e;
  }));

/// The workspace's own emoji, once Slack has said them (none until then;
/// why they could not be had, the Slack page says).
function useSlackEmoji(): Record<string, string> {
  const [emoji, setEmoji] = useState<Record<string, string>>({});
  useEffect(() => void customEmoji().then(setEmoji, () => {}), []);
  return emoji;
}

/// A list's line of plain text, its emoji names as emoji.
function SlackLine({ text }: { text: string }) {
  const custom = useSlackEmoji();
  return <>{emojiInline(text).map((p, i) => (p.t === "emoji" ? <SlackEmoji key={i} name={p.name} glyph={p.v} custom={custom} /> : p.t === "text" ? p.v : null))}</>;
}

/// An emoji by its Slack name: the standard one, the workspace's own picture, or its name.
function SlackEmoji({ name, glyph, custom }: { name: string; glyph?: string; custom: Record<string, string> }) {
  if (custom[name]) return <img className="slack-emoji-img" src={custom[name]} alt={`:${name}:`} title={`:${name}:`} />;
  const shown = glyph ?? nameToEmoji[name];
  return shown && !shown.startsWith(":") ? <span title={`:${name}:`}>{shown}</span> : <span className="slack-emoji-name">:{name}:</span>;
}

function SlackText({ text, me, onLink }: { text: string; me?: string; onLink: (url: string) => void }) {
  const custom = useSlackEmoji();
  const inline = (pieces: Inline[]): React.ReactNode[] =>
    pieces.map((p, i) => {
      switch (p.t) {
        case "text":
          return p.v;
        case "mention":
          return (
            <span key={i} className={`slack-mention-chip${p.me ? " me" : ""}`}>
              @{p.v}
            </span>
          );
        case "channel":
          return (
            <span key={i} className="slack-mention-chip">
              #{p.v}
            </span>
          );
        case "link":
          return (
            <a key={i} href={p.url} onClick={(e) => (e.preventDefault(), onLink(p.url))}>
              {p.label}
            </a>
          );
        case "code":
          return <code key={i}>{p.v}</code>;
        case "b":
          return <b key={i}>{inline(p.c)}</b>;
        case "i":
          return <i key={i}>{inline(p.c)}</i>;
        case "s":
          return <s key={i}>{inline(p.c)}</s>;
        case "emoji":
          return <SlackEmoji key={i} name={p.name} glyph={p.v} custom={custom} />;
      }
    });
  return (
    <div className="slack-text">
      {parseSlack(text, me).map((b, i) =>
        b.t === "pre" ? (
          <pre key={i}>{b.v}</pre>
        ) : b.t === "quote" ? (
          <blockquote key={i}>{inline(b.c)}</blockquote>
        ) : (
          <p key={i}>{inline(b.c)}</p>
        ),
      )}
    </div>
  );
}

/// A message's reactions: each emoji with how many, the user's own marked,
/// who gave it on hover; a click gives the user's too, or takes it off, as in Slack.
function SlackReactions({ reactions, onToggle }: { reactions: SlackThreadMessage["reactions"]; onToggle: (name: string, on: boolean) => void }) {
  const custom = useSlackEmoji();
  return (
    <div className="slack-reactions">
      {reactions.map((r) => (
        <button
          key={r.name}
          className={`slack-reaction${r.mine ? " mine" : ""}`}
          title={`:${r.name}: ${r.who.join("、")}${r.count > r.who.length ? ` ほか ${r.count - r.who.length} 人` : ""}（${r.mine ? "クリックで外す" : "クリックで付ける"}）`}
          onClick={(e) => (e.stopPropagation(), onToggle(r.name, !r.mine))}
        >
          <SlackEmoji name={r.name} custom={custom} />
          <span>{r.count}</span>
        </button>
      ))}
    </div>
  );
}

/// What Slack shows under a message: the links it unfurled (a page's
/// preview, a Slack message's) and bots' attachments.
function SlackAttachments({ items, me, onLink }: { items: SlackAttachment[]; me?: string; onLink: (url: string) => void }) {
  const open = (url: string) => (e: React.MouseEvent) => (e.preventDefault(), onLink(url));
  return (
    <>
      {items.map((a, i) => (
        <div key={i} className="slack-unfurl">
          <div className="slack-unfurl-main">
            {a.source && (
              <div className="slack-unfurl-source">
                {a.icon && <img src={a.icon} alt="" />}
                {!a.title && a.link ? (
                  <a href={a.link} onClick={open(a.link)}>
                    {a.source}
                  </a>
                ) : (
                  a.source
                )}
              </div>
            )}
            {a.title &&
              (a.link ? (
                <a className="slack-unfurl-title" href={a.link} onClick={open(a.link)}>
                  {a.title}
                </a>
              ) : (
                <b className="slack-unfurl-title">{a.title}</b>
              ))}
            {a.text && <SlackText text={a.text} me={me} onLink={onLink} />}
            {a.image && <img className="slack-unfurl-image" src={a.image} alt="" />}
            {a.footer && <div className="slack-unfurl-footer">{a.footer}</div>}
          </div>
          {a.thumb && !a.image && <img className="slack-unfurl-thumb" src={a.thumb} alt="" />}
        </div>
      ))}
    </>
  );
}

/// Picks an emoji by its name to react with (↑↓ or ⌃N ⌃P, Enter or Tab); Esc or leaving it gives up.
function SlackEmojiPicker({ onPick, onClose }: { onPick: (name: string) => void; onClose: () => void }) {
  const custom = useSlackEmoji();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ block: "nearest" }), [query]);
  const names = query ? emojiChoices(query, Object.keys(custom), SLACK_SUGGESTIONS) : [];
  return (
    <div className="slack-react-pick" ref={ref} onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={query}
        placeholder="リアクション（絵文字の名前、Enter で付ける、Esc でやめる）"
        aria-label="リアクションの絵文字"
        onChange={(e) => (setQuery(e.target.value.replace(/[:：]/g, "")), setActive(0))}
        onBlur={onClose}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          const step = e.key === "ArrowDown" || (e.ctrlKey && e.key === "n") ? 1 : e.key === "ArrowUp" || (e.ctrlKey && e.key === "p") ? -1 : 0;
          if (step && names.length) setActive((a) => (a + step + names.length) % names.length);
          else if ((e.key === "Enter" || e.key === "Tab") && names[active]) onPick(names[active]);
          else if (e.key === "Escape") onClose();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {names.length > 0 && (
        <ul className="slack-suggest" role="listbox" aria-label="絵文字の候補">
          {names.map((name, i) => (
            <li key={name} role="option" aria-selected={i === active} className={i === active ? "on" : ""} onMouseDown={(e) => (e.preventDefault(), onPick(name))}>
              <span className="slack-suggest-emoji">
                <SlackEmoji name={name} custom={custom} />
              </span>
              <b>:{name}:</b>
              {custom[name] && <span className="muted ellipsis">このワークスペースの絵文字</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/// A Slack channel's or message's address, opened in the Slack app rather than the pane.
const SLACK_PERMALINK = /^https:\/\/[^/]+\.slack\.com\/archives\//;
/// Messages from one person within this many seconds read as one.
const SLACK_GROUP_SECS = 300;
/// Mention suggestions shown at once.
const SLACK_SUGGESTIONS = 8;
/// The people and groups to mention, asked once a run.
let slackDirectory: Promise<SlackMentionable[]> | null = null;
/// The `@…` being written just before the caret.
const MENTION_TYPED = /(?:^|[\s　])[@＠]([^\s@＠　]*)$/;

/// A Slack row's thread (a message not in one, alone), the message itself
/// marked: read again as the thread moves (Socket Mode), and answered from
/// here (#30) with mentions suggested after "@".
/// What the Slack page's keys do in the open thread.
interface SlackThreadKeys {
  /// Moves the message cursor (⇧J ⇧K).
  move: (step: number) => void;
  /// 「Todo にする」's memo for the message the cursor is on.
  memo: () => string | null;
  mute: () => void;
  /// Bookmarks the message picked, or takes it off.
  bookmark: () => void;
  /// Picks an emoji to react to the message picked with.
  react: () => void;
}

function SlackThread({ item, me, replyRef, keysRef, report, onLink, onDone, confirmingForget, onForget, onCancelForget, bookmarked, onBookmark, onMuteChannel, onTodo, onClose }: {
  item: SlackItem;
  me: string | null;
  /// The reply box, for the page's r.
  replyRef: React.RefObject<HTMLTextAreaElement | null>;
  /// Set to this thread's keys, for the page.
  keysRef: React.RefObject<SlackThreadKeys | null>;
  report: (e: unknown) => void;
  onLink: (url: string) => void;
  onDone: () => void;
  /// 消す waits for a second press.
  confirmingForget: boolean;
  /// 消す (a mention from this Mac, a thread from those followed): asks first.
  onForget: () => void;
  onCancelForget: () => void;
  bookmarked: (ts: string) => boolean;
  /// Bookmarks a message, or takes it off.
  onBookmark: (m: SlackThreadMessage) => void;
  /// Mutes its channel in Shosai.
  onMuteChannel: () => void;
  /// 「Todo にする」 with the memo of the message picked in the thread.
  onTodo: (memo: string) => void;
  /// Closes the thread (Esc too); the list takes the width.
  onClose: () => void;
}) {
  const [thread, setThread] = useState<SlackThreadMessage[] | null>(null);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The message picked (⇧J ⇧K or a click): what 「Todo にする」 takes. The row's message at first.
  const [picked, setPicked] = useState<string>(item.ts);
  // The message an emoji is being picked for (the page's key), to react with.
  const [reacting, setReacting] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const { channel, threadTs } = item;
  const read = useCallback(() => {
    api.slackThread(channel, threadTs).then(
      (t) => {
        setThread(t.messages);
        setMuted(t.muted);
        setError(null);
      },
      (e) => setError(String(e)),
    );
  }, [channel, threadTs]);
  useEffect(read, [read]);
  useEffect(() => {
    const off = listen<{ channel: string; thread_ts: string }>(SLACK_POSTED_EVENT, ({ payload }) => {
      if (payload.channel === channel && payload.thread_ts === threadTs) read();
    });
    return () => void off.then((f) => f());
  }, [channel, threadTs, read]);
  const showPicked = (ts: string) => body.current?.querySelector(`[data-ts="${CSS.escape(ts)}"]`)?.scrollIntoView({ block: "nearest" });
  // Read (or read again), the thread shows the message picked (the last when it is not there).
  useEffect(() => {
    if (!thread?.length) return;
    const ts = thread.some((t) => t.ts === picked) ? picked : thread[thread.length - 1].ts;
    setPicked(ts);
    requestAnimationFrame(() => showPicked(ts));
  }, [thread]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleMute = () => api.slackMuteThread(channel, threadTs, !muted).then(() => setMuted(!muted), report);
  const pickedMessage = thread?.find((t) => t.ts === picked) ?? null;
  const memo = () => (pickedMessage ? `Slack #${item.channelName} の ${pickedMessage.user_name}さんから:\n${slackPlain(pickedMessage.text)}\n\n${pickedMessage.permalink}` : null);
  keysRef.current = {
    move: (step) => {
      if (!thread?.length) return;
      const at = Math.max(thread.findIndex((t) => t.ts === picked), 0);
      const ts = thread[Math.min(Math.max(at + step, 0), thread.length - 1)].ts;
      setPicked(ts);
      showPicked(ts);
    },
    memo,
    mute: toggleMute,
    bookmark: () => pickedMessage && onBookmark(pickedMessage),
    react: () => pickedMessage && setReacting(pickedMessage.ts),
  };
  const react = (ts: string, name: string, on: boolean) => api.slackReact(channel, ts, name, on).then(read, report);
  const replies = item.newReplies > 0 ? `新しい返信 ${item.newReplies} 件` : "";
  const title =
    item.kind === "posted" ? "送ったメッセージ" : [item.mention ? (item.via ? `@${item.via} へのメンション` : "あなたへのメンション") : "", replies].filter(Boolean).join("・") || "スレッド";
  return (
    <section className="slack-thread" aria-label="スレッド">
      <div className="slack-thread-head">
        <span className="grow ellipsis">
          <b>#{item.channelName}</b> <span className="muted">· {title}</span>
        </span>
        {confirmingForget ? (
          // While 消す asks, it stands alone: the header has no room beside the rest.
          <span className="inline-confirm">
            このスレッドのメンションを、この Mac から消しますか？
            <button className="danger small" onClick={onForget}>
              消す <span className="kbd">{keyLabel(keyOf("slackForget"))}</span>
            </button>
            <button className="ghost small" onClick={onCancelForget}>
              やめる <span className="kbd">Esc</span>
            </button>
          </span>
        ) : (
          <>
          {!item.read && (
            <button className="small" title="このスレッドのメンションと返信を既読にして、一覧から消して次へ" onClick={onDone}>
              Done <span className="kbd">{keyLabel(keyOf("slackDone"))}</span>
            </button>
          )}
          <button className="ghost small" title="選んでいるメッセージ（⇧J ⇧K で選ぶ）から Todo を作ります" onClick={() => onTodo(memo() ?? slackMemo(item))}>
            Todo にする <span className="kbd">{keyLabel(keyOf("slackTodo"))}</span>
          </button>
          {item.kind === "thread" && (
            <button className="ghost small" title="このスレッドのメンションをこの Mac から消し（また見つかっても出しません）、スレッドを追うのもやめます。押すと確認します" onClick={onForget}>
              消す <span className="kbd">{keyLabel(keyOf("slackForget"))}</span>
            </button>
          )}
          {pickedMessage && (
            <button className="ghost small" title="選んでいるメッセージ（⇧J ⇧K で選ぶ）をブックマークします。スレッドの先頭ならスレッドを" onClick={() => onBookmark(pickedMessage)}>
              {bookmarked(pickedMessage.ts) ? "ブックマークを外す" : "ブックマーク"} <span className="kbd">{keyLabel(keyOf("slackBookmark"))}</span>
            </button>
          )}
          <button className="ghost small" title="このスレッドの新しい返信を、未読に数えない（メンションは届きます）" onClick={toggleMute}>
            {muted ? "返信をまた数える" : "返信を数えない"} <span className="kbd">{keyLabel(keyOf("slackMute"))}</span>
          </button>
          <button className="ghost small" title="このチャンネルを Shosai でミュートします（メンションも返信も届かなくなります。解除は設定の Slack から）" onClick={onMuteChannel}>
            チャンネルをミュート <span className="kbd">{keyLabel(keyOf("slackMuteChannel"))}</span>
          </button>
          {item.permalink && (
            <button className="ghost small" onClick={() => onLink(item.permalink)}>
              Slack で開く <span className="kbd">{keyLabel(keyOf("slackOpen"))}</span>
            </button>
          )}
          </>
        )}
        <button className="ghost icon" aria-label="スレッドを閉じる（Esc）" title="スレッドを閉じる（Esc）" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="slack-thread-body" ref={body}>
        {error && <p className="error-text pad">スレッドを読めませんでした：{error}</p>}
        {!thread && !error && <p className="muted pad">読んでいます…</p>}
        {thread?.map((t, i) => {
          const prev = thread[i - 1];
          const joined = i > 1 && prev && prev.user_name === t.user_name && Number(t.ts) - Number(prev.ts) < SLACK_GROUP_SECS;
          return (
            <div key={t.ts}>
              {i === 1 && <div className="slack-replies">{thread.length - 1} 件の返信</div>}
              <div data-ts={t.ts} className={`slack-msg${joined ? " joined" : ""}${t.ts === item.ts ? " this" : ""}${t.ts === picked ? " picked" : ""}`} onClick={() => setPicked(t.ts)}>
                {joined ? <span className="slack-avatar-space slack-time">{slackTime(t.ts).slice(-5)}</span> : <SlackAvatar name={t.user_name} image={t.user_image} size={36} />}
                <div className="slack-msg-main">
                  {!joined && (
                    <div className="slack-msg-head">
                      <b className={t.mine ? "slack-me" : ""}>{t.user_name}</b>
                      <span className="slack-time">{slackTime(t.ts)}</span>
                    </div>
                  )}
                  <SlackText text={t.text} me={me ?? undefined} onLink={onLink} />
                  {t.attachments.length > 0 && <SlackAttachments items={t.attachments} me={me ?? undefined} onLink={onLink} />}
                  {t.reactions.length > 0 && <SlackReactions reactions={t.reactions} onToggle={(name, on) => react(t.ts, name, on)} />}
                  {reacting === t.ts && (
                    <SlackEmojiPicker
                      onPick={(name) => {
                        setReacting(null);
                        react(t.ts, name, true);
                      }}
                      onClose={() => setReacting(null)}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <SlackComposer
        boxRef={replyRef}
        label="スレッドに返信"
        placeholder={`スレッドに返信（${keyLabel(keyOf("slackReply"))} でここへ、@ でメンション、⌘Enter で送る、Esc で一覧へ）`}
        sendLabel="返信する"
        near={thread?.map((t) => t.user_name) ?? []}
        report={report}
        onSend={(text) => api.slackReply(channel, threadTs, text).then(read)}
      />
    </section>
  );
}

/// A suggestion of a Slack message box: someone to mention, or an emoji.
interface Suggestion {
  key: string;
  name: string;
  /// What goes in the box.
  insert: string;
  /// How Slack writes a mention, sent in its place.
  token?: string;
  image?: string | null;
  /// The emoji's name, for an emoji.
  emoji?: string;
  note: string;
}
/// The `:emoji` being written just before the caret (two letters or more, so a time is not one).
const EMOJI_TYPED = /(?:^|[\s　(（])[:：]([a-z0-9_+'-]{2,})$/;

/// A Slack message box: "@" (or "＠") suggests people and user groups, ":"
/// emoji (↑↓ or ⌃N ⌃P, Enter or Tab to pick); mentions are written as
/// Slack writes them when sent with ⌘Enter; Esc leaves it.
function SlackComposer({ boxRef, label, placeholder, sendLabel, near, disabled, report, onSend }: {
  boxRef: React.RefObject<HTMLTextAreaElement | null>;
  label: string;
  placeholder: string;
  sendLabel: string;
  /// Names suggested first (the thread's people).
  near: string[];
  disabled?: boolean;
  report: (e: unknown) => void;
  /// Sends the text, its mentions written as Slack writes them.
  onSend: (text: string) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [people, setPeople] = useState<SlackMentionable[]>([]);
  const custom = useSlackEmoji();
  // What is being written after "@" (a mention) or ":" (an emoji), and where it starts.
  const [typed, setTyped] = useState<{ kind: "mention" | "emoji"; query: string; from: number } | null>(null);
  const [active, setActive] = useState(0);
  // The mentions picked: their name → how Slack writes them.
  const picked = useRef(new Map<string, string>());
  const nearby = new Set(near);
  const q = typed?.query.toLowerCase() ?? "";
  const candidates: Suggestion[] = !typed
    ? []
    : typed.kind === "emoji"
      ? emojiChoices(q, Object.keys(custom), SLACK_SUGGESTIONS).map((name) => ({ key: `e:${name}`, name, insert: `:${name}:`, emoji: name, note: custom[name] ? "このワークスペースの絵文字" : "" }))
      : people
          .map((p) => {
            const names = [p.name, ...p.also].map((n) => n.toLowerCase());
            const rank = !q ? 1 : names.some((n) => n.startsWith(q)) ? 0 : names.some((n) => n.includes(q)) ? 1 : 2;
            return { p, rank: rank - (nearby.has(p.name) ? 0.5 : 0) };
          })
          .filter((c) => c.rank < 2)
          .sort((a, b) => a.rank - b.rank)
          .slice(0, SLACK_SUGGESTIONS)
          .map(({ p }) => ({ key: p.token, name: p.name, insert: `@${p.name}`, token: p.token, image: p.image, note: p.token.startsWith("<!subteam") ? "ユーザーグループ" : p.also.join(" · ") }));
  const watchTyping = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const mention = MENTION_TYPED.exec(before);
    const emoji = EMOJI_TYPED.exec(before);
    const m = mention ?? emoji;
    setTyped(m ? { kind: mention ? "mention" : "emoji", query: m[1], from: caret - m[1].length - 1 } : null);
    setActive(0);
    if (mention && !slackDirectory) slackDirectory = api.slackDirectory();
    if (mention) slackDirectory?.then(setPeople, (e) => ((slackDirectory = null), report(e)));
  };
  const pick = (c: Suggestion) => {
    const box = boxRef.current;
    if (!typed || !box) return;
    const caret = box.selectionStart;
    if (c.token) picked.current.set(c.name, c.token);
    setText(`${text.slice(0, typed.from)}${c.insert} ${text.slice(caret)}`);
    setTyped(null);
    const at = typed.from + c.insert.length + 1;
    requestAnimationFrame(() => box.setSelectionRange(at, at));
  };
  const withMentions = (value: string) =>
    [...picked.current.entries()].sort((a, b) => b[0].length - a[0].length).reduce((t, [name, token]) => t.split(`@${name}`).join(token), value);
  const send = () => {
    if (!text.trim() || sending || disabled) return;
    setSending(true);
    onSend(withMentions(text))
      .then(() => {
        setText("");
        picked.current.clear();
      }, report)
      .finally(() => setSending(false));
  };
  return (
    <div className="slack-reply">
      {candidates.length > 0 && (
        <ul className="slack-suggest" role="listbox" aria-label={typed?.kind === "emoji" ? "絵文字の候補" : "メンションの候補"}>
          {candidates.map((c, i) => (
            <li key={c.key} role="option" aria-selected={i === active} className={i === active ? "on" : ""} onMouseDown={(e) => (e.preventDefault(), pick(c))}>
              {c.emoji ? (
                <span className="slack-suggest-emoji">
                  <SlackEmoji name={c.emoji} custom={custom} />
                </span>
              ) : (
                <SlackAvatar name={c.name} image={c.image ?? null} size={20} />
              )}
              <b>{c.emoji ? `:${c.name}:` : c.name}</b>
              <span className="muted ellipsis">{c.note}</span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={boxRef}
        rows={2}
        value={text}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => {
          setText(e.target.value);
          watchTyping(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          const composing = e.nativeEvent.isComposing || e.keyCode === 229;
          if (candidates.length > 0 && !composing) {
            const step = e.key === "ArrowDown" || (e.ctrlKey && e.key === "n") ? 1 : e.key === "ArrowUp" || (e.ctrlKey && e.key === "p") ? -1 : 0;
            if (step) {
              e.preventDefault();
              setActive((a) => (a + step + candidates.length) % candidates.length);
              return;
            }
            if ((e.key === "Enter" && !e.metaKey) || e.key === "Tab") {
              e.preventDefault();
              pick(candidates[active]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setTyped(null);
              return;
            }
          }
          if (e.key === "Enter" && e.metaKey && !composing) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape" && !composing) {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
      />
      <button className="primary small" disabled={!text.trim() || sending || disabled} onClick={send}>
        {sending ? "送っています…" : sendLabel} <span className="kbd">⌘↵</span>
      </button>
    </div>
  );
}

/// A new message in a channel the user is in: pick the channel (type to
/// narrow, ↑↓ and Enter), write, ⌘Enter. The message's thread opens once sent.
function SlackCompose({ report, onPosted, onClose }: {
  report: (e: unknown) => void;
  onPosted: (channel: { id: string; name: string }, ts: string) => void;
  onClose: () => void;
}) {
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [to, setTo] = useState<SlackChannel | null>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    api.slackChannels().then((c) => setChannels(c.sort((a, b) => a.name.localeCompare(b.name))), report);
    queryRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const q = query.trim().replace(/^#/, "").toLowerCase();
  const matching = (channels ?? []).filter((c) => !q || c.name.toLowerCase().includes(q)).sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q))).slice(0, SLACK_CHANNELS_SHOWN);
  const choose = (c: SlackChannel) => {
    setTo(c);
    setQuery("");
    requestAnimationFrame(() => boxRef.current?.focus());
  };
  return (
    <section className="slack-thread" aria-label="新しいメッセージ">
      <div className="slack-thread-head">
        <b className="grow">新しいメッセージ</b>
        <button className="ghost icon" aria-label="閉じる（Esc）" title="閉じる（Esc）" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="slack-thread-body slack-compose">
        {to ? (
          <div className="slack-compose-to">
            <span className="muted">送り先</span>
            <span className="tag">
              {to.private ? "🔒" : "#"}
              {to.name}
            </span>
            <button className="ghost small" onClick={() => (setTo(null), requestAnimationFrame(() => queryRef.current?.focus()))}>
              変える
            </button>
          </div>
        ) : (
          <>
            <input
              ref={queryRef}
              value={query}
              placeholder="チャンネルを探す（入っているチャンネルだけ）"
              aria-label="送り先のチャンネル"
              onChange={(e) => (setQuery(e.target.value), setActive(0))}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                const step = e.key === "ArrowDown" || (e.ctrlKey && e.key === "n") ? 1 : e.key === "ArrowUp" || (e.ctrlKey && e.key === "p") ? -1 : 0;
                if (step && matching.length > 0) {
                  e.preventDefault();
                  setActive((a) => (a + step + matching.length) % matching.length);
                } else if (e.key === "Enter" && matching[active]) {
                  e.preventDefault();
                  choose(matching[active]);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onClose();
                }
              }}
            />
            {!channels && <p className="muted pad">チャンネルを読んでいます…</p>}
            <ul className="slack-channel-list" role="listbox" aria-label="チャンネル">
              {matching.map((c, i) => (
                <li key={c.id} role="option" aria-selected={i === active} className={i === active ? "on" : ""} onMouseDown={(e) => (e.preventDefault(), choose(c))}>
                  <span className="muted">{c.private ? "🔒" : "#"}</span>
                  {c.name}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <SlackComposer
        boxRef={boxRef}
        label="メッセージ"
        placeholder={to ? `#${to.name} に送る（@ でメンション、⌘Enter で送る）` : "先に送り先のチャンネルを選んでください"}
        sendLabel="送る"
        near={[]}
        disabled={!to}
        report={report}
        onSend={(text) => (to ? api.slackPost(to.id, text).then((ts) => onPosted(to, ts)) : Promise.resolve())}
      />
    </section>
  );
}
/// Channels the new message's picker shows at once.
const SLACK_CHANNELS_SHOWN = 12;

/// The settings' Slack: the user's token, given to the app (kept in the
/// Keychain) or let go.
function SlackSettings({ report }: { report: (e: unknown) => void }) {
  // undefined while asked; null without a token.
  const [account, setAccount] = useState<SlackAccount | null | undefined>(undefined);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [letGo, setLetGo] = useState(false);
  useEffect(() => {
    api.slackAccount().then(setAccount, (e) => {
      setAccount(null);
      report(e);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const connect = () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    api
      .slackConnect(token)
      .then((a) => {
        setAccount(a);
        setToken("");
      }, report)
      .finally(() => setBusy(false));
  };
  return (
    <section>
      <h3>Slack</h3>
      {account === undefined && <p className="muted">確かめています…</p>}
      {account && (
        <div className="setting-row">
          <span className="grow">
            <span className="mono">{account.team_url}</span> に、自分のアカウント（<span className="mono">{account.user_id}</span>）でつながっています
          </span>
          {letGo ? (
            <span className="inline-confirm">
              トークンを Keychain から消し、読んだ印も忘れますか？
              <button className="danger small" onClick={() => api.slackDisconnect().then(() => (setAccount(null), setLetGo(false)), report)}>
                外す
              </button>
              <button className="ghost small" onClick={() => setLetGo(false)}>
                やめる
              </button>
            </span>
          ) : (
            <button className="ghost small" onClick={() => setLetGo(true)}>
              外す
            </button>
          )}
        </div>
      )}
      {account && <p className="muted">既読のメンションは、投稿から30日たつとこの Mac から消えます（Slack の画面の「消す」や「既読をすべて消す」で先に消すこともできます）。</p>}
      {account && <SlackRealtime realtime={account.realtime} report={report} onChange={(realtime) => setAccount({ ...account, realtime })} />}
      {account?.realtime && <SlackKeepEvents config={account.config} report={report} onChange={(config) => setAccount({ ...account, config })} />}
      {account && <SlackMutedChannels report={report} />}
      {account === null && (
        <>
          <p className="muted">自分用の Slack アプリのユーザートークン（xoxp-…）を入れると、自分とユーザーグループへのメンションが Slack の画面に並びます。トークンは Keychain に置きます。</p>
          <div className="setting-row">
            <input
              type="password"
              className="grow"
              value={token}
              placeholder="xoxp-…"
              aria-label="Slack のユーザートークン"
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => isEnter(e) && connect()}
            />
            <button className="primary small" disabled={!token.trim() || busy} onClick={connect}>
              {busy ? "確かめています…" : "つなぐ"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/// The settings' channels muted in Shosai (⇧M on the Slack page), to unmute.
function SlackMutedChannels({ report }: { report: (e: unknown) => void }) {
  const [muted, setMuted] = useState<MutedChannel[]>([]);
  const load = () => void api.slackMutedChannels().then(setMuted, report);
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (muted.length === 0) return null;
  return (
    <>
      <p className="muted">Shosai でミュートしたチャンネル（Slack の画面の {keyLabel(keyOf("slackMuteChannel"))}）。メンションも返信も届きません。Slack 本体のミュートは、ユーザートークンでは読めないので効きません。</p>
      {muted.map((c) => (
        <div className="setting-row" key={c.channel}>
          <span className="grow">#{c.name}</span>
          <button className="ghost small" onClick={() => api.slackMuteChannel(c.channel, false).then(load, report)}>
            解除
          </button>
        </div>
      ))}
    </>
  );
}

/// What Socket Mode needs subscribed for messages to come (a bot event comes
/// only from channels the bot is in).
const SLACK_USER_EVENTS = "「Subscribe to events on behalf of users」の message.channels と message.groups（ユーザートークンに channels:history と groups:history）";

/// The settings' Slack in real time: the app's token (`xapp-…`) for Socket Mode.
function SlackRealtime({ realtime, report, onChange }: { realtime: boolean; report: (e: unknown) => void; onChange: (realtime: boolean) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const save = () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    api
      .slackSetAppToken(token)
      .then(() => {
        onChange(true);
        setToken("");
      }, report)
      .finally(() => setBusy(false));
  };
  if (realtime) {
    return (
      <div className="setting-row">
        <span className="grow">リアルタイム（Socket Mode）：アプリのトークンを Keychain に置いています</span>
        <button className="ghost small" onClick={() => api.slackForgetAppToken().then(() => onChange(false), report)}>
          やめる
        </button>
      </div>
    );
  }
  return (
    <>
      <p className="muted">アプリのトークン（xapp-…、connections:write）を入れると、Socket Mode で投稿されたその場でメンションが届きます（Slack アプリの Event Subscriptions に、{SLACK_USER_EVENTS}が要ります）。入れても入れなくても、1分おきにも確かめます。</p>
      <div className="setting-row">
        <input
          type="password"
          className="grow"
          value={token}
          placeholder="xapp-…"
          aria-label="Slack アプリのトークン"
          autoComplete="off"
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => isEnter(e) && save()}
        />
        <button className="primary small" disabled={!token.trim() || busy} onClick={save}>
          {busy ? "確かめています…" : "リアルタイムにする"}
        </button>
      </div>
    </>
  );
}

/// The settings' configuration token (its refresh token, `xoxe-…`): the app's
/// events are taken out while the Mac sleeps, and put back as it wakes.
function SlackKeepEvents({ config, report, onChange }: { config: boolean; report: (e: unknown) => void; onChange: (config: boolean) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const save = () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    api
      .slackSetConfigToken(token)
      .then(() => {
        onChange(true);
        setToken("");
      }, report)
      .finally(() => setBusy(false));
  };
  if (config) {
    return (
      <div className="setting-row">
        <span className="grow">スリープ中は Slack のイベントを外し、戻ったら付け直します（設定用トークンを Keychain に置いています）</span>
        <button className="ghost small" onClick={() => api.slackForgetConfigToken().then(() => onChange(false), report)}>
          やめる
        </button>
      </div>
    );
  }
  return (
    <>
      <p className="muted">
        Mac が1時間ほどスリープしていると、Slack はアプリのイベントを止めます（Enable Events が OFF になり、メールが届きます）。設定用トークンを入れると、スリープの前にイベントを外し、戻ったら付け直します。止められていたときも、つなぎ直すときに ON に戻します。api.slack.com/apps の一番下の「Your App Configuration Tokens」で Generate Token を押し、出てきた Refresh Token（xoxe-1-…）を入れてください。Keychain に置き、12時間ごとに取り直します。
      </p>
      <div className="setting-row">
        <input
          type="password"
          className="grow"
          value={token}
          placeholder="xoxe-1-…"
          aria-label="Slack の設定用トークン（Refresh Token）"
          autoComplete="off"
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => isEnter(e) && save()}
        />
        <button className="primary small" disabled={!token.trim() || busy} onClick={save}>
          {busy ? "確かめています…" : "止められないようにする"}
        </button>
      </div>
    </>
  );
}

/// A page's filter by place (a repository, a group, or none).
function PlaceFilter({ places, value, onChange }: { places: string[]; value: string | null; onChange: (place: string | null) => void }) {
  if (places.length < 2 && value === null) return null;
  return (
    <select className="select compact" value={value ?? ""} aria-label="リポジトリで絞り込む" title="リポジトリで絞り込む" onChange={(e) => onChange(e.target.value || null)}>
      <option value="">すべてのリポジトリ</option>
      {places.map((p) => (
        <option key={p} value={p}>
          {isGithubRepo(p) ? repoName(p) : p}
        </option>
      ))}
    </select>
  );
}

/// Every session the board knows, with the todo it belongs to.
function sessionItemsOf(board: Board): SessionItem[] {
  return [...board.todos.flatMap((todo) => todo.sessions.map((session) => ({ session, todo }))), ...board.inbox.map((session) => ({ session }))];
}

/// Where a session runs and what runs it: "Cloud · Claude", "Desktop · Claude", "herdr · Codex".
const placeOf = (s: Session) => `${isCloud(s) ? "Cloud" : s.desktop ? "Desktop" : "herdr"} · ${s.agent === "codex" ? "Codex" : "Claude"}`;

/// How reviews start, kept as last picked: who reviews, whether it submits
/// on its own, where it runs. Codex runs in herdr only.
interface ReviewPrefs {
  agent: Agent;
  auto: boolean;
  runner: ReviewRunner;
}
const REVIEW_PREFS_KEY = "reviewPrefs";
function loadReviewPrefs(): ReviewPrefs {
  const saved = loadJson<Partial<ReviewPrefs> | null>(REVIEW_PREFS_KEY, null);
  if (saved) return { agent: saved.agent ?? "claude", auto: saved.auto ?? false, runner: saved.agent === "codex" ? "herdr" : (saved.runner ?? "cloud") };
  // From before the choices were apart: one list of where (and with what) reviews started.
  const old = load(REVIEW_RUNNER_KEY, ["web", "cloud", "desktop", "terminal", "codex"] as const, "web");
  return { agent: old === "codex" ? "codex" : "claude", auto: false, runner: old === "codex" || old === "terminal" ? "herdr" : "cloud" };
}
/// The model and effort reviews start with, Claude's and Codex's apart.
const REVIEW_OPTIONS_KEY = "reviewOptions";
type ReviewOptions = Record<Agent, { model: string; effort: string }>;
const NO_REVIEW_OPTIONS: ReviewOptions = { claude: { model: "", effort: "" }, codex: { model: "", effort: "" } };
const loadReviewOptions = (): ReviewOptions => ({ ...NO_REVIEW_OPTIONS, ...loadJson<Partial<ReviewOptions>>(REVIEW_OPTIONS_KEY, {}) });

/// The PR a review is for.
interface ReviewTarget {
  url: string;
  repo: string;
  number: number;
  title: string;
}

/// How a review submitted went in, in GitHub's words.
const REVIEW_VERDICT: Record<string, string> = { APPROVED: "Approve", CHANGES_REQUESTED: "Request changes", COMMENTED: "Comment" };

/// Starts reviews as the PR page's choices say, behind (nothing comes
/// forward), and tells which PRs' reviews are starting.
function useReviewStarter(local: LocalRepo[], run: (f: () => Promise<unknown>) => void) {
  const [starting, setStarting] = useState<Set<string>>(new Set());
  const mark = (url: string, on: boolean) =>
    setStarting((prev) => {
      const next = new Set(prev);
      if (on) next.add(url);
      else next.delete(url);
      return next;
    });
  const startReview = (p: ReviewTarget) => {
    if (starting.has(p.url)) return;
    mark(p.url, true);
    const prefs = loadReviewPrefs();
    const picked = loadReviewOptions()[prefs.agent];
    // Its session shows in 作業's list (its レビュー); nothing comes forward.
    run(async () => {
      try {
        await api.startReview({
          url: p.url,
          repo: p.repo,
          // A review is its own session, not a todo; the PR page is where it is followed.
          title: `${REVIEW_TITLE_PREFIX}${p.title}`,
          agent: prefs.agent,
          auto: prefs.auto,
          runner: prefs.runner,
          cwd: local.find((r) => r.key === p.repo)?.path,
          options: { model: picked.model || undefined, effort: picked.effort || undefined },
        });
      } finally {
        mark(p.url, false);
      }
    });
  };
  return { startReview, starting };
}

const PR_FILTERS = ["all", "review", "mine"] as const;
type PrFilter = (typeof PR_FILTERS)[number];

/// Where a review asked of the user stands, by its session (`session`, to open).
function reviewStanding(p: Pr, sessions: Session[], submitted: Map<string, string>, now: number): { word: string; cls: string; session?: Session; failed?: Session } {
  const s = sessions.filter((x) => x.review_url === p.url && !x.hidden).sort((a, b) => b.state_at - a.state_at)[0];
  if (!s) return submitted.has(p.url) ? { word: `提出済み（${REVIEW_VERDICT[submitted.get(p.url)!] ?? submitted.get(p.url)}）`, cls: "state-merged" } : { word: "未着手", cls: "state-needs_input" };
  if (s.state === "needs_input") return { word: "返事待ち", cls: "state-needs_input", session: s };
  if (isFailedReview(s, now)) return { word: "失敗", cls: "state-ended", session: s, failed: s };
  return { word: s.review_auto ? "レビュー中（自動で提出）" : "レビュー中", cls: "state-running", session: s };
}

/// The steps a PR goes through, for the detail's stepper.
const PR_STEPS = ["下書き", "レビュー待ち", "承認済み", "マージ済み"];
/// Where a PR's stage is along PR_STEPS.
const PR_STEP: Record<PrState, number> = { draft: 0, open: 0, review_requested: 1, changes_requested: 1, approved: 2, merged: 3, closed: 3 };
const CHECK_WORD: Record<Check["state"], string> = { success: "成功", failure: "失敗", pending: "実行中", skipped: "スキップ" };
const CHECK_CLS: Record<Check["state"], string> = { success: "ci-success", failure: "ci-failure", pending: "", skipped: "" };
const REVIEW_WORD: Record<Review["state"], string> = { requested: "依頼中", approved: "承認", changes_requested: "修正を依頼", commented: "コメント", dismissed: "取り下げ", pending: "書いている途中" };
const REVIEW_CLS: Partial<Record<Review["state"], string>> = { requested: "gh-pr-review_requested", approved: "gh-pr-approved", changes_requested: "gh-pr-changes_requested" };

/// The PRs on the left (review requests, then the user's own), the picked
/// one on the right: a request's description and how its review starts, or
/// an own PR's stage, checks, reviews and what to do next.
function PrsPage({ prs, prsLoading, prError, todos, sessions, submitted, local, run, report, onRefresh, onOpenTodo }: {
  prs: PrLists | null;
  /// While the PRs are being taken again, so ↻ turns.
  prsLoading: boolean;
  prError: string | null;
  todos: Todo[];
  /// Sessions not linked to a todo: the reviews among them.
  sessions: Session[];
  /// Reviews that went in since the PRs were taken: their verdicts by URL.
  submitted: Map<string, string>;
  local: LocalRepo[];
  run: (f: () => Promise<unknown>) => void;
  report: (e: unknown) => void;
  onRefresh: () => void;
  onOpenTodo: (id: number) => void;
}) {
  // Review requests first: they are what waits on the user.
  const [filter, setFilter] = useState<PrFilter>("review");
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const openInBrowser = useContext(BrowserContext);
  const openWork = useContext(WorkContext);
  const fix = useContext(FixContext);
  const [prefs, setPrefsState] = useState<ReviewPrefs>(loadReviewPrefs);
  const setPrefs = (patch: Partial<ReviewPrefs>) => {
    const next = { ...prefs, ...patch };
    if (next.agent === "codex") next.runner = "herdr";
    remember(REVIEW_PREFS_KEY, JSON.stringify(next));
    setPrefsState(next);
  };
  // The model and effort reviews start with (Codex's from its own list).
  const [reviewOptions, setReviewOptionsState] = useState<ReviewOptions>(loadReviewOptions);
  const setReviewOption = (patch: Partial<{ model: string; effort: string }>) => {
    const next = { ...reviewOptions, [prefs.agent]: { ...reviewOptions[prefs.agent], ...patch } };
    remember(REVIEW_OPTIONS_KEY, JSON.stringify(next));
    setReviewOptionsState(next);
  };
  const [codexModels, setCodexModels] = useState<{ id: string; label: string; efforts: string[] }[]>([]);
  useEffect(() => void api.codexModels().then(setCodexModels, () => {}), []);
  const picked = reviewOptions[prefs.agent];
  const modelChoices = prefs.agent === "codex" ? [{ id: "", label: "Codex の既定のモデル" }, ...codexModels] : MODELS;
  const effortChoices = prefs.agent === "codex" ? ["", ...(codexModels.find((m) => m.id === picked.model)?.efforts ?? ["low", "medium", "high", "xhigh"])] : EFFORTS;
  const byRepo = (p: { repo: string }) => repoFilter === null || p.repo === repoFilter;
  const review = (prs?.review ?? []).filter(byRepo);
  const mine = (prs?.mine ?? []).filter(byRepo);
  const todoOf = (url: string) => todos.find((t) => t.pr_url === url);
  // PRs whose review session is being started, so their button shows it.
  const { startReview, starting } = useReviewStarter(local, run);
  const now = Date.now() / 1000;
  const rowId = (kind: string, url: string) => `${kind}:${url}`;
  const shownReview = filter !== "mine" ? review : [];
  const shownMine = filter !== "review" ? mine : [];
  const startable = (p: Pr) => !starting.has(p.url) && reviewStanding(p, sessions, submitted, now).word === "未着手";
  // ↑↓ or j k pick a PR (shown on the right), Enter is the detail's primary
  // button (start reviewing a request, have an own PR fixed); the other keys
  // are its other buttons.
  const { cursorId, setCursor, list } = useRowCursor(
    [...shownReview.map((p) => rowId("review", p.url)), ...shownMine.map((p) => rowId("mine", p.url))],
    (id) => {
      const p = review.find((x) => rowId("review", x.url) === id);
      if (!p) actions.fix();
      else if (startable(p)) startReview(p);
    },
    (e) => {
      if (matches(e, "prFilter")) return (setFilter(PR_FILTERS[(PR_FILTERS.indexOf(filter) + 1) % PR_FILTERS.length]), true);
      const act = matches(e, "start") ? actions.github : matches(e, "session") ? actions.work : matches(e, "showTodo") ? actions.todo : undefined;
      if (act) return (act(), true);
      if (!pickedReview) return false;
      if (matches(e, "reviewAgent")) setPrefs({ agent: prefs.agent === "claude" ? "codex" : "claude" });
      else if (matches(e, "reviewSubmit")) setPrefs({ auto: !prefs.auto });
      else if (matches(e, "reviewRunner") && prefs.agent !== "codex") setPrefs({ runner: prefs.runner === "cloud" ? "herdr" : "cloud" });
      else return false;
      return true;
    },
  );
  const pickedReview = shownReview.find((p) => rowId("review", p.url) === cursorId);
  const pickedMine = shownMine.find((p) => rowId("mine", p.url) === cursorId);
  const pickedPr = pickedReview ?? pickedMine;
  const standing = pickedReview && reviewStanding(pickedReview, sessions, submitted, now);
  const todo = pickedMine && todoOf(pickedMine.url);
  const latest = todo && [...todo.sessions].sort((a, b) => b.state_at - a.state_at)[0];
  const next = pickedMine && nextStep(pickedMine, todo?.id);
  const canFix = !!(fix && next?.fix && todo && latest && latest.state !== "running");
  const workSession = standing?.session ?? (todo && todo.sessions.length > 0 ? latest : undefined);
  // What the detail's buttons (and their keys) do; each does nothing when it is not there.
  const actions = {
    github: () => pickedPr && openInBrowser?.(pickedPr.url),
    work: () => workSession && openWork?.(todo ? { todo: todo.id } : { session: workSession.session_id }),
    fix: () => canFix && fix!(latest!, todo!),
    todo: () => todo && onOpenTodo(todo.id),
  };
  const reviewerLabel = (reviews: Review[]) => (reviews.length === 0 ? "レビュー未依頼" : `${reviews.slice(0, 2).map((r) => r.who).join("・")}${reviews.length > 2 ? ` ほか ${reviews.length - 2}` : ""}`);
  const kbd = (action: Action) => <span className="kbd">{keyLabel(keyOf(action))}</span>;
  const githubButton = <button onClick={actions.github}>GitHub で見る {kbd("start")}</button>;
  const workButton = workSession && openWork && <button onClick={actions.work}>作業で開く {kbd("session")}</button>;
  let detail: React.ReactNode = <p className="muted pad">{prs ? "PR を選んでください。" : ""}</p>;
  if (pickedReview && standing) {
    const p = pickedReview;
    const busy = starting.has(p.url);
    detail = (
      <>
        <div className="pr-meta">
          <span className="mono">
            {p.repo}#{p.number}
          </span>
          <span>
            {p.author} から · {isoAgo(p.updated_at)}
          </span>
          {p.is_draft && <span className="gh">{PR_LABEL.draft}</span>}
        </div>
        <h2 className="pr-title">{p.title}</h2>
        <div className="pr-next">
          <span className={`state ${standing.cls}`}>
            <i />
            {busy ? "始めています…" : standing.word}
          </span>
          <div className="pr-actions">
            {standing.word === "未着手" && (
              <button className="primary" disabled={busy} onClick={() => startReview(p)}>
                レビューを始める <span className="kbd">↵</span>
              </button>
            )}
            {standing.failed && (
              <button
                disabled={busy}
                title="止まったレビューを片付けて、もう一度始めます"
                onClick={() => {
                  const failed = standing.failed!;
                  run(() => api.hideSession(failed.session_id));
                  startReview(p);
                }}
              >
                もう一度
              </button>
            )}
            {workButton}
            {githubButton}
          </div>
          <p className="muted">始めても、この画面とキーボードは動きません。セッションは作業の「レビュー」に並びます。</p>
        </div>
        <section className="pr-block">
          <h3>レビューを任せる</h3>
          <div className="review-prefs">
            <span className="muted">エージェント {kbd("reviewAgent")}</span>
            <div className="segmented" role="group" aria-label="レビューするエージェント">
              {(["claude", "codex"] as const).map((a) => (
                <button key={a} className={prefs.agent === a ? "on" : ""} aria-pressed={prefs.agent === a} onClick={() => setPrefs({ agent: a })}>
                  {a === "claude" ? "Claude" : "Codex"}
                </button>
              ))}
            </div>
            <span className="muted">提出 {kbd("reviewSubmit")}</span>
            <div className="segmented" role="group" aria-label="レビューの提出">
              <button className={!prefs.auto ? "on" : ""} aria-pressed={!prefs.auto} title="指摘がまとまると、Request changes・Comment・Approve のどれで出すかを聞いてきます（あなた待ちに入ります）" onClick={() => setPrefs({ auto: false })}>
                提出前に確認する
              </button>
              <button className={prefs.auto ? "on" : ""} aria-pressed={prefs.auto} title="確かめずに提出し、提出したら片付けます" onClick={() => setPrefs({ auto: true })}>
                自動で提出する
              </button>
            </div>
            <span className="muted">動く場所 {kbd("reviewRunner")}</span>
            <div className="segmented" role="group" aria-label="レビューが動く場所">
              <button className={prefs.runner === "cloud" ? "on" : ""} aria-pressed={prefs.runner === "cloud"} disabled={prefs.agent === "codex"} title={prefs.agent === "codex" ? "Codex は herdr でだけ動きます" : undefined} onClick={() => setPrefs({ runner: "cloud" })}>
                Cloud
              </button>
              <button className={prefs.runner === "herdr" ? "on" : ""} aria-pressed={prefs.runner === "herdr"} onClick={() => setPrefs({ runner: "herdr" })}>
                herdr
              </button>
            </div>
            <select className="select compact" value={picked.model} aria-label="レビューのモデル" title="レビューのモデル" onChange={(e) => setReviewOption({ model: e.target.value })}>
              {modelChoices.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <select className="select compact" value={picked.effort} aria-label="レビューの effort" title="レビューの effort" onChange={(e) => setReviewOption({ effort: e.target.value })}>
              {effortChoices.map((x) => (
                <option key={x} value={x}>
                  {x ? `effort: ${x}` : "既定の effort"}
                </option>
              ))}
            </select>
          </div>
        </section>
        <section className="pr-block">
          <h3>説明</h3>
          {p.body.trim() ? <p className="pr-body">{p.body.trim()}</p> : <p className="muted">説明はありません。</p>}
        </section>
      </>
    );
  } else if (pickedMine && next) {
    const p = pickedMine;
    const at = PR_STEP[p.stage];
    const fixNote = !next.fix || !fix ? "" : !todo || !latest ? "この PR の todo にセッションがないので、直させられません。" : latest.state === "running" ? "元のセッションが動いています。止まったら直させられます。" : "元のセッションに渡して直させます。";
    detail = (
      <>
        <div className="pr-meta">
          <span className="mono">
            {p.repo}#{p.number}
          </span>
          <span>{isoAgo(p.updated_at)}</span>
          {todo && (
            <button className="tag todo-chip" onClick={actions.todo} title={`${todo.title}（${keyLabel(keyOf("showTodo"))}）`}>
              #{todo.id} {todo.title}
            </button>
          )}
        </div>
        <h2 className="pr-title">{p.title}</h2>
        <ol className="pr-steps" aria-label={`今：${PR_LABEL[p.stage]}`}>
          {PR_STEPS.map((label, i) => (
            <li key={label} className={i < at ? "done" : i === at ? "at" : ""}>
              {i === at ? PR_LABEL[p.stage] : label}
            </li>
          ))}
        </ol>
        <div className="pr-next">
          <b>{next.title}</b>
          <p>
            {next.note}
            {fixNote}
          </p>
          <div className="pr-actions">
            {next.fix && fix && (
              <button className="primary" disabled={!canFix} title="画面もフォーカスも動きません" onClick={actions.fix}>
                元のセッションに直させる <span className="kbd">↵</span>
              </button>
            )}
            {workButton}
            {githubButton}
          </div>
        </div>
        <section className="pr-block">
          <h3>
            CI {p.ci && <span className={`gh ci-${p.ci.state}`}>{CI_LABEL[p.ci.state]}</span>}
          </h3>
          {p.checks.length === 0 ? (
            <p className="muted">チェックはありません。</p>
          ) : (
            <ul className="pr-list-items">
              {p.checks.map((c, i) => (
                <li key={i}>
                  <span className={`gh ${CHECK_CLS[c.state]}`}>{CHECK_WORD[c.state]}</span>
                  <span className="ellipsis">{c.name}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="pr-block">
          <h3>レビュー</h3>
          {p.reviews.length === 0 ? (
            <p className="muted">まだ誰にも依頼していません。</p>
          ) : (
            <ul className="pr-list-items">
              {p.reviews.map((r) => (
                <li key={r.who}>
                  <span className={`gh ${REVIEW_CLS[r.state] ?? ""}`}>{REVIEW_WORD[r.state] ?? r.state}</span>
                  <span className="ellipsis">{r.who}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </>
    );
  }
  return (
    <>
      <header className="toolbar">
        <h1>PR</h1>
        <div className="segmented" role="group" aria-label="絞り込み">
          <button className={filter === "all" ? "on" : ""} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            すべて
          </button>
          <button className={filter === "review" ? "on" : ""} aria-pressed={filter === "review"} onClick={() => setFilter("review")}>
            レビュー依頼 {review.length}
          </button>
          <button className={filter === "mine" ? "on" : ""} aria-pressed={filter === "mine"} onClick={() => setFilter("mine")}>
            自分の PR {mine.length}
          </button>
        </div>
        <PlaceFilter places={[...new Set([...(prs?.review ?? []), ...(prs?.mine ?? [])].map((p) => p.repo))].sort()} value={repoFilter} onChange={setRepoFilter} />
        <span className="grow" />
        <button className={`ghost icon${prsLoading ? " turning" : ""}`} aria-label="PR を取り直す（⌘R）" title="PR を取り直す（⌘R）" aria-busy={prsLoading} onClick={onRefresh}>
          <Icon name="sync" size={14} />
        </button>
      </header>
      <div className="content flush pr-page">
        <div className="pr-list" ref={list}>
          {prError && <p className="error-text pad">{prError}</p>}
          {!prs && !prError && <p className="muted pad">gh で取得しています…</p>}
          {filter !== "mine" && (
            <section>
              <div className="section-head">
                <b>レビュー依頼</b>
                <span className="muted">{review.length}</span>
              </div>
              {prs && review.length === 0 && <p className="muted pad">ありません。</p>}
              <ul className="rows">
                {review.map((p) => {
                  const st = reviewStanding(p, sessions, submitted, now);
                  const id = rowId("review", p.url);
                  return (
                    <li key={p.url} data-row={id} className={`row pr-row${id === cursorId ? " selected" : ""}`} onClick={() => setCursor(id)}>
                      <span className={`state ${st.cls}`}>
                        <i />
                        {starting.has(p.url) ? "始めています…" : st.word}
                      </span>
                      <span className="pr-main">
                        <span className="ellipsis">{p.title}</span>
                        <span className="pr-meta">
                          <span className="mono">
                            {repoName(p.repo)}#{p.number}
                          </span>
                          <span>
                            {p.author} から · {isoAgo(p.updated_at)}
                          </span>
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {filter !== "review" && (
            <section>
              <div className="section-head">
                <b>自分の PR</b>
                <span className="muted">{mine.length}</span>
              </div>
              {prs && mine.length === 0 && <p className="muted pad">ありません。</p>}
              <ul className="rows">
                {mine.map((p) => {
                  const id = rowId("mine", p.url);
                  return (
                    <li key={p.url} data-row={id} className={`row pr-row${id === cursorId ? " selected" : ""}`} onClick={() => setCursor(id)}>
                      <span className={`gh gh-pr-${p.stage}`}>{PR_LABEL[p.stage]}</span>
                      <span className="pr-main">
                        <span className="ellipsis">{p.title}</span>
                        <span className="pr-meta">
                          <span className="mono">
                            {repoName(p.repo)}#{p.number}
                          </span>
                          {p.ci && <span className={`gh ci-${p.ci.state}`}>{CI_LABEL[p.ci.state]}{p.ci.failed.length > 0 && ` ${p.ci.failed.length}`}</span>}
                          <span>{reviewerLabel(p.reviews)}</span>
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
        <div className="pr-detail">{detail}</div>
      </div>
    </>
  );
}

function Modal({ title, onClose, children, footer, wide }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-label={title} onClick={stop}>
        <header>
          <h2>{title}</h2>
          <button className="ghost icon" onClick={onClose} aria-label="閉じる">
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/// Adds todos one after another: the dialog stays open and lists what it added.
/// ⌘N: a todo in one go. 「作って任せる」 (⌘Enter) makes it and starts its
/// session as last time (behind: nothing comes forward); 「置いておく」 (Enter)
/// only makes it, and the dialog stays for the next.
function AddTodoDialog({ local, groups, databases, initialRepo, initialDatabase, initialMemo, run, onClose, onOpenTodo, onImport }: {
  local: LocalRepo[];
  groups: string[];
  databases: Database[];
  initialRepo: string | null;
  /// The database the new todo goes in (the one shown).
  initialDatabase: number | null;
  /// What the memo starts with (a Slack message's 「Todo にする」).
  initialMemo?: string;
  run: (f: () => Promise<unknown>) => void;
  onClose: () => void;
  onOpenTodo: (id: number) => void;
  /// The issues assigned to the user, to pick from instead.
  onImport: () => void;
}) {
  const startTodo = useContext(StartTodoContext);
  const { prefs, setLaunch } = useLaunchPrefs();
  const [title, setTitle] = useState("");
  const [memo, setMemo] = useState(initialMemo ?? "");
  const [repo, setRepo] = useState(initialRepo && initialRepo !== NO_REPO_LANE ? initialRepo : "");
  const [issueUrl, setIssueUrl] = useState("");
  const [database, setDatabase] = useState(initialDatabase);
  const [plan, setPlan] = useState(false);
  const [added, setAdded] = useState<Todo[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const launch = prefs[plan ? "plan" : "direct"];
  const make = async () => {
    const todo = await api.createTodo({ title: title.trim(), memo: memo.trim() || undefined, repos: repo ? [repo] : [], cwd: local.find((r) => r.key === repo)?.path, issue_url: issueUrl.trim() || undefined });
    if (database !== null) await api.setTodoDatabase(todo.id, database);
    return todo;
  };
  const keep = () => {
    if (!title.trim()) return;
    run(async () => {
      const todo = await make();
      setAdded((prev) => [todo, ...prev]);
      setTitle("");
      setMemo("");
      setIssueUrl("");
      titleRef.current?.focus();
    });
  };
  const delegate = () => {
    if (!title.trim() || !startTodo) return;
    onClose();
    run(async () => startTodo((await make()).id, plan, launch));
  };
  const delegateRef = useRef(delegate);
  delegateRef.current = delegate;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !matches(e, "start")) return;
      e.preventDefault();
      delegateRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <Modal
      title="新しい todo"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onImport} title="自分に割り当てられた issue から選んで todo にします">
            issue から…
          </button>
          <span className="grow" />
          <button disabled={!title.trim()} title="作るだけで、まだ始めません（Enter）" onClick={keep}>
            置いておく
          </button>
          <button className="primary" disabled={!title.trim()} title="作って、前回の設定でセッションを始めます（画面もフォーカスも動きません）" onClick={delegate}>
            作って任せる <span className="kbd">⌘↵</span>
          </button>
        </>
      }
    >
      <label className="field">
        <span>タイトル</span>
        <input ref={titleRef} value={title} placeholder="何をする？" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => isEnter(e) && !e.metaKey && keep()} />
      </label>
      <label className="field">
        <span>メモ（任意。最初のプロンプトに入ります）</span>
        <textarea rows={3} value={memo} placeholder="背景・方針・完了条件など" onChange={(e) => setMemo(e.target.value)} />
      </label>
      <div className="two-col">
        <div className="field">
          <span>リポジトリ / グループ（任意）</span>
          <RepoChoice local={local} groups={repo && !isGithubRepo(repo) && !groups.includes(repo) ? [repo, ...groups] : groups} value={repo} placeholder={NO_REPO_LANE} onPick={setRepo} />
        </div>
        <label className="field">
          <span>Issue URL（任意）</span>
          <input value={issueUrl} placeholder="https://github.com/…" onChange={(e) => setIssueUrl(e.target.value)} onKeyDown={(e) => isEnter(e) && !e.metaKey && keep()} />
        </label>
      </div>
      {databases.length > 0 && (
        <label className="field">
          <span>DB（任意）</span>
          <DatabaseSelect databases={databases} value={database} onPick={setDatabase} />
        </label>
      )}
      <div className="field">
        <span>任せ方（前回の設定）</span>
        <LaunchControls plan={plan} launch={launch} onPlan={setPlan} onLaunch={(patch) => setLaunch(plan, patch)} />
      </div>
      {added.length > 0 && (
        <div className="added">
          <span className="muted">置いておいたもの {added.length} 件</span>
          <ul className="rows compact">
            {added.map((t) => (
              <li key={t.id} className="row" onClick={() => onOpenTodo(t.id)}>
                <span className="mono muted">#{t.id}</span>
                <span className="row-title">{t.title}</span>
                <span className="tag">{t.repos[0] ? repoName(t.repos[0]) : NO_REPO_LANE}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function ImportDialog({ run, onClose }: { run: (f: () => Promise<unknown>) => void; onClose: () => void }) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => {
    api.ghIssues().then(setIssues, (e) => setLoadError(String(e)));
  }, []);
  const toggle = (url: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(url) ? next.delete(url) : next.add(url);
      return next;
    });
  const submit = () => {
    const picked = (issues ?? []).filter((i) => checked.has(i.url));
    run(async () => {
      await api.importIssues(picked.map((i) => ({ title: i.title, url: i.url, cwd: i.cwd ?? undefined })));
      onClose();
    });
  };
  return (
    <Modal
      title="自分に割り当てられた issue"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="grow" />
          <button className="ghost" onClick={onClose}>
            キャンセル
          </button>
          <button className="primary" disabled={checked.size === 0} onClick={submit}>
            {checked.size} 件を取り込む
          </button>
        </>
      }
    >
      {loadError && <p className="error-text">{loadError}</p>}
      {!issues && !loadError && <p className="muted">gh で取得しています…</p>}
      {issues?.length === 0 && <p className="muted">取り込める issue はありません。</p>}
      <ul className="issue-list">
        {issues?.map((i) => (
          <li key={i.url}>
            <label>
              <input type="checkbox" checked={checked.has(i.url)} onChange={() => toggle(i.url)} />
              <span className="issue-main">
                <span>{i.title}</span>
                <span className="muted">
                  <span className="mono">
                    {i.repo}#{i.number}
                  </span>{" "}
                  · {i.cwd ? basename(i.cwd) : "ローカルに未 clone"}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/// A throwaway claude in a new herdr workspace at home, with an optional first prompt.
function QuickClaudeDialog({ run, onClose }: { run: (f: () => Promise<unknown>) => void; onClose: () => void }) {
  const [prompt, setPrompt] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const terminal = useContext(TerminalContext);
  const start = () =>
    run(async () => {
      if (terminal) terminal.open(await terminalApi.quick(prompt));
      else await api.quickClaude(prompt);
      onClose();
    });
  return (
    <Modal
      title="ちょっと Claude"
      onClose={onClose}
      footer={
        <>
          <span className="muted">⌘Enter で起動。todo には紐づけません</span>
          <span className="grow" />
          <button className="ghost" onClick={onClose}>
            キャンセル
          </button>
          <button className="primary" onClick={start}>
            {terminal ? "ターミナルで起動" : "herdr で起動"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>最初のプロンプト（空なら何も送らずに起動）</span>
        <textarea
          ref={ref}
          rows={5}
          value={prompt}
          placeholder="例: このエラーの意味を教えて …"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e) && e.metaKey) {
              e.preventDefault();
              start();
            }
          }}
        />
      </label>
    </Modal>
  );
}

interface Command {
  key: string;
  label: string;
  hint?: string;
  run: () => void;
  /// Shown before the label (a session's state).
  icon?: React.ReactNode;
  /// Words it is also found by.
  keywords?: string;
  /// A list of its own, which picking it opens in the same box (Esc, or ⌫ on an empty query, goes back).
  items?: () => Command[];
}

/// Other words a command is found by, for a word in its label: "プルリク"
/// finds "PR を表示", "session" finds "セッションを表示".
const SEARCH_ALIASES: Record<string, string[]> = {
  pr: ["pull request", "プルリク", "プルリクエスト", "レビュー", "review"],
  セッション: ["session", "claude"],
  todo: ["タスク", "task"],
  読みもの: ["読む", "reading", "学習", "ブックマーク", "bookmark", "本", "book"],
  カンバン: ["kanban", "board", "ボード"],
  管理: ["manage", "todo", "kanban"],
  作業: ["work", "session", "セッション", "ターミナル", "terminal"],
  学習: ["study", "learn", "読む", "notebooklm"],
  リスト: ["list"],
  フィルター: ["filter", "絞り込み", "view", "ビュー"],
  キー: ["shortcut", "ショートカット", "key", "keys", "keymap"],
  ブラウザ: ["browser", "web", "タブ", "tab"],
  タブ: ["tab"],
  同期: ["sync", "更新", "refresh", "reload"],
  issue: ["イシュー", "課題", "import", "取り込み"],
  chatgpt: ["gpt", "openai", "チャット", "chat"],
  claude: ["クロード", "cloud", "web"],
  onelogin: ["login", "ログイン", "sso", "portal"],
  ちょっと: ["quick", "claude"],
  新しい: ["new", "add", "作成", "追加"],
  リンク: ["link"],
  表示: ["show", "open", "開く"],
};
/// Whether every word of the query is in the label or the label's aliases.
function commandMatches(label: string, query: string) {
  const text = label.toLowerCase();
  const hay = [text, ...Object.entries(SEARCH_ALIASES).filter(([word]) => text.includes(word)).flatMap(([, aliases]) => aliases)].join(" ");
  return query.split(/\s+/).every((w) => hay.includes(w));
}

/// ⌘K: the actions, the spaces and their pages, and a jump to any todo or
/// reading (each in its own space).
function CommandPalette({ commands, todos, readings, start, onOpenTodo, onRead, onClose }: {
  commands: Command[];
  /// A list to open on (a terminal's links), which Esc closes from.
  start?: Command;
  todos: Todo[];
  readings: Reading[];
  onOpenTodo: (id: number) => void;
  /// Opens a reading in 学習.
  onRead: (id: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // The lists opened from one another (a command's items), the last shown.
  const [stack, setStack] = useState<Command[]>(start ? [start] : []);
  const page = stack.at(-1);
  const q = query.trim().toLowerCase();
  const items: Command[] = page
    ? (page.items?.() ?? []).filter((c) => commandMatches(`${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`, q))
    : [
    ...commands.filter((c) => commandMatches(c.label, q)),
    ...(q
      ? todos
          .filter((t) => t.title.toLowerCase().includes(q) || `#${t.id}` === q || String(t.id) === q)
          .slice(0, 20)
          .map((t) => ({ key: `todo:${t.id}`, label: `#${t.id} ${t.title}`, hint: t.status, run: () => onOpenTodo(t.id) }))
      : []),
    ...(q
      ? readings
          .filter((r) => r.title.toLowerCase().includes(q) || r.tags?.some((t) => t.toLowerCase().includes(q)))
          .slice(0, 20)
          .map((r) => ({ key: `reading:${r.id}`, label: r.title, hint: `学習 · ${READING_KIND[r.kind]}`, run: () => onRead(r.id) }))
      : []),
  ];
  useEffect(() => setActive(0), [query, stack.length]);
  const back = () => {
    if (start && stack.length === 1) return onClose();
    setStack((s) => s.slice(0, -1));
    setQuery("");
  };
  // Keep the picked row in sight as the keys move it.
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const pick = (c: Command) => {
    if (c.items) {
      setStack((s) => [...s, c]);
      return setQuery("");
    }
    onClose();
    c.run();
  };
  return (
    <div className="modal-backdrop palette-backdrop" onClick={onClose}>
      <div className={`palette${page ? " wide" : ""}`} role="dialog" aria-label="コマンド" onClick={stop}>
        {page && (
          <div className="palette-crumb">
            <button className="ghost small" onClick={back}>
              <Icon name="back" size={12} /> 戻る
            </button>
            <span>{page.label}</span>
            <span className="muted">Esc で戻る</span>
          </div>
        )}
        <input
          key={page?.key ?? "root"}
          autoFocus
          value={query}
          placeholder={page ? `${page.label}を絞り込む` : "操作を選ぶ、または todo や読みものを検索"}
          aria-label={page ? `${page.label}を絞り込む` : "操作を選ぶ、または todo や読みものを検索"}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // ⌃J ⌃K (as set) move too, as in fzf.
            const down = e.key === "ArrowDown" || matches(e.nativeEvent, "paletteDown");
            const up = e.key === "ArrowUp" || matches(e.nativeEvent, "paletteUp");
            if (down) {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (up) {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (isEnter(e)) {
              e.preventDefault();
              if (items[active]) pick(items[active]);
            } else if (e.key === "Escape") {
              if (page) back();
              else onClose();
            } else if (e.key === "Backspace" && page && query === "") {
              e.preventDefault();
              back();
            }
          }}
        />
        <ul role="listbox" className="palette-list" ref={list}>
          {items.length === 0 && <li className="muted palette-empty">見つかりません</li>}
          {items.map((c, i) => (
            <li
              key={c.key}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
            >
              {c.icon}
              <span className="ellipsis">{c.label}</span>
              {c.hint && <span className="muted">{c.hint}</span>}
              {c.items && <Icon name="chevronRight" size={12} />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function resetLabel(iso: string | null) {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "まもなくリセット";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `リセットまで ${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `リセットまで ${hours}時間${minutes % 60}分`;
  return `${new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit" })} にリセット`;
}

const money = (n: number, currency: string) => n.toLocaleString("ja-JP", { style: "currency", currency });

/// Plan usage kept in view (session, weekly, per model, or what has been spent), warning colours from the API.
function UsageBox({ limits, error }: { limits: Limit[] | null; error: string | null }) {
  return (
    <div className="usage" title={error ?? undefined}>
      <div className="section-title">Claude の使用量</div>
      {error && !limits && <span className="muted small-text">取得できませんでした</span>}
      {!limits && !error && <span className="muted small-text">取得しています…</span>}
      {limits?.map((l) => (
        <div key={l.label} className={`meter${limitWarns(l) ? " warn" : ""}`}>
          <div className="meter-row">
            <span>{l.label}</span>
            <b>{l.amount ? `${money(l.amount.used, l.amount.currency)} / ${money(l.amount.limit, l.amount.currency)}` : `${Math.round(l.percent)}%`}</b>
          </div>
          <div className="bar">
            <i style={{ width: `${Math.min(100, l.percent)}%` }} />
          </div>
          {resetLabel(l.resets_at) && <span className="muted small-text">{resetLabel(l.resets_at)}</span>}
        </div>
      ))}
    </div>
  );
}

/// A limit warns when the API says so, or once this much of it is used.
const LIMIT_WARN_PERCENT = 80;
const limitWarns = (l: Limit) => l.severity !== "normal" || l.percent >= LIMIT_WARN_PERCENT;
/// Jev's spend in dollars: to the cent, or to a hundredth of one while under a cent.
const jevUsd = (n: number) => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;

/// The rail's usage at a glance: Claude's most used limit as a ring (with
/// what was spent of it, when it is money), and under it Jev's credit left
/// (or, not knowing the credit, this month's spend); a click shows them in full.
function RailUsage({ limits, jev, jevLeft, onOpen }: { limits: Limit[] | null; jev: JevSpend | undefined; jevLeft: number | null; onOpen: () => void }) {
  const top = limits && limits.length > 0 ? limits.reduce((a, b) => (b.percent > a.percent ? b : a)) : null;
  const percent = Math.min(100, top?.percent ?? 0);
  const claude = top ? `Claude：${top.label} ${top.amount ? `${money(top.amount.used, top.amount.currency)} / ${money(top.amount.limit, top.amount.currency)}` : `${Math.round(top.percent)}%`}` : "Claude：取得していません";
  const jevLine = jevLeft !== null ? `残${jevUsd(jevLeft)}` : jev ? jevUsd(jev.month_usd) : null;
  const title = [claude, jevLine && `Jev：${jevLeft !== null ? `クレジットの残り ${jevUsd(jevLeft)}` : `今月 ${jevLine}`}`].filter(Boolean).join("\n");
  return (
    <button className={`rail-usage${limits?.some(limitWarns) ? " warn" : ""}`} aria-label="使用量" title={`${title}\nクリックで詳しく`} onClick={onOpen}>
      <svg className="ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r="15" pathLength="100" />
        <circle className="ring-used" cx="18" cy="18" r="15" pathLength="100" strokeDasharray={`${percent} 100`} />
        <text x="18" y="18">{top ? Math.round(top.percent) : "–"}</text>
      </svg>
      {top?.amount && (
        <span className="rail-amount">
          <b>{shortMoney(top.amount.used, top.amount.currency)}</b>
          <span>/{shortMoney(top.amount.limit, top.amount.currency)}</span>
        </span>
      )}
      {jevLine && <span className="rail-jev">{jevLine}</span>}
    </button>
  );
}

/// Claude's limits and what Jev cost, in full (from the rail).
function UsageDialog({ limits, error, jev, onClose }: {
  limits: Limit[] | null;
  error: string | null;
  jev: JevSpend | undefined;
  onClose: () => void;
}) {
  const credit = jev?.credit;
  return (
    <Modal title="使用量" onClose={onClose}>
      <div className="usage-dialog">
        <UsageBox limits={limits} error={error} />
        <div className="usage">
          <div className="section-title">Jev（TypeSafe）</div>
          {jev ? (
            (["today", "month"] as const).map((span) => (
              <div key={span} className="meter-row">
                <span>{span === "today" ? "今日" : "今月"}</span>
                <span className="muted">
                  {jev[span].calls} 回 · 入力 {jev[span].input_tokens.toLocaleString()} トークン
                </span>
                <b>{jevUsd(span === "today" ? jev.today_usd : jev.month_usd)}</b>
              </div>
            ))
          ) : (
            <span className="muted small-text">取得しています…</span>
          )}
          {credit ? (
            <>
              <div className="meter-row">
                <span>クレジットの残り</span>
                <b>{jevUsd(credit.left)}</b>
              </div>
              <span className="muted small-text">
                {new Date(credit.at * 1000).toLocaleDateString("ja-JP")} に入れたクレジット ${credit.credit} − その時の Spend ${credit.spent} − その後このアプリで使った {jevUsd(credit.since_usd)}（同じキーを使うほかのもの、X の拡張機能などの分は入りません）
              </span>
            </>
          ) : (
            <span className="muted small-text">設定の「学習」で TypeSafe のクレジットと Spend を入れると、残りを出します。</span>
          )}
          <span className="muted small-text">TypeSafe の料金（入力 10 億トークンで $42、出力は料金なし）での目安です。請求額は console.typesafe.ai で見られます。</span>
        </div>
      </div>
    </Modal>
  );
}

type Selection = { kind: "todo"; id: number } | null;
type DialogKind = "add" | "import" | "quick" | "palette" | "keys" | "start" | "settings" | "usage" | "database" | null;

/// A page's alert, confirm or prompt, as the app's dialog (the page waits for the answer).
function PageDialog({ ask, onAnswer }: { ask: PageDialogAsk; onAnswer: (ok: boolean, text?: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const ok = () => onAnswer(true, ask.kind === "prompt" ? (input.current?.value ?? "") : undefined);
  return (
    <Modal
      title="ページからの確認"
      onClose={() => onAnswer(false)}
      footer={
        <>
          <span className="grow" />
          {ask.kind !== "alert" && (
            <button className="ghost" onClick={() => onAnswer(false)}>
              キャンセル
            </button>
          )}
          <button className="primary" autoFocus={ask.kind !== "prompt"} onClick={ok}>
            OK
          </button>
        </>
      }
    >
      <p className="page-dialog-message">{ask.message}</p>
      {ask.kind === "prompt" && (
        <input ref={input} autoFocus defaultValue={ask.default} aria-label="ページへの入力" onKeyDown={(e) => isEnter(e) && ok()} />
      )}
    </Modal>
  );
}

/// Keys that stay as they are, shown under the ones that can change.
const FIXED_KEYS: [string, string][] = [
  ["↑↓←→", "一覧・カンバンの移動（変えたキーと一緒に使えます）"],
  ["Enter", "開く（todo のシート、セッション、メニューの項目）"],
  ["⌥Enter", "開き方を選ぶ（セッション）/ PR を開く（PR）"],
  ["Esc", "シートやパネル、メニューを閉じる（学習で読んでいるときは一覧へ）"],
];

/// Every shortcut, and changing one: its key's button, then the new key
/// (Esc keeps the old one). ? and ⌘K's "ショートカット" open it.
/// Where things open and run, and what the browser keeps for sites: the
/// logins (their sites and users), the sites not asked about, and the
/// microphone and camera answers.
function SettingsDialog({ cloudTarget, onCloudTarget, terminalTarget, onTerminalTarget, herdr, onLoadHerdr, onPickHerdr, hasTypesafeKey, jevCredit, run, report, onClose }: {
  cloudTarget: CloudTarget;
  onCloudTarget: (t: CloudTarget) => void;
  terminalTarget: TerminalTarget;
  onTerminalTarget: (t: TerminalTarget) => void;
  herdr: HerdrSessions | null;
  onLoadHerdr: () => void;
  onPickHerdr: (name: string) => void;
  /// A TypeSafe API key is kept (for the readings' tags).
  hasTypesafeKey: boolean;
  /// Jev's credit as last read off TypeSafe's console.
  jevCredit: JevCredit | null;
  run: (f: () => Promise<unknown>) => void;
  report: (e: unknown) => void;
  onClose: () => void;
}) {
  const keyRef = useRef<HTMLInputElement>(null);
  const creditRef = useRef<HTMLInputElement>(null);
  const spentRef = useRef<HTMLInputElement>(null);
  const saveCredit = () => {
    const [credit, spent] = [creditRef.current?.value, spentRef.current?.value].map((v) => Number(v?.trim().replace(/^\$/, "")));
    if (!(credit >= 0 && spent >= 0)) return report("クレジットと Spend はドルの額（0 以上の数）で入れてください");
    run(() => api.setJevCredit(credit, spent));
  };
  const [logins, setLogins] = useState<{ site: string; user: string }[] | null>(null);
  const [never, setNever] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const load = () => {
    api.savedLogins().then(setLogins, report);
    api.neverAskedLogins().then(setNever, report);
    api.sitePermissions().then(setPermissions, report);
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  const then = (p: Promise<unknown>) => p.then(load, report);
  return (
    <Modal title="設定" wide onClose={onClose}>
      <div className="settings">
        <section>
          <h3>開く場所</h3>
          <div className="setting-row">
            <span className="grow">Cloud のセッション</span>
            <div className="segmented" role="group" aria-label="Cloud のセッションを開く場所">
              {(["web", "desktop"] as const).map((t) => (
                <button key={t} className={cloudTarget === t ? "on" : ""} aria-pressed={cloudTarget === t} onClick={() => onCloudTarget(t)}>
                  {t === "web" ? "Web（アプリ内）" : "Claude Desktop"}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <span className="grow">ターミナル（herdr のセッションを開く場所）</span>
            <div className="segmented" role="group" aria-label="ターミナル">
              {(["ghostty", "app"] as const).map((t) => (
                <button key={t} className={terminalTarget === t ? "on" : ""} aria-pressed={terminalTarget === t} onClick={() => onTerminalTarget(t)}>
                  {t === "ghostty" ? "Ghostty" : "アプリ内"}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <span className="grow">新しいワークスペースを開く herdr のセッション</span>
            {herdr && herdr.running.length > 0 ? (
              <select className="select compact" value={herdr.picked && herdr.running.includes(herdr.picked) ? herdr.picked : ""} aria-label="herdr のセッション" onMouseDown={onLoadHerdr} onChange={(e) => onPickHerdr(e.target.value)}>
                <option value="">自動（{herdr.target}）</option>
                {herdr.running.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <button className="ghost small" title="herdr のセッションを探し直す（止まっているときは、アプリ内のセッションはタブの中で直接動きます）" onClick={onLoadHerdr}>
                停止中（探し直す）
              </button>
            )}
          </div>
        </section>
        <section>
          <h3>学習</h3>
          <div className="setting-row">
            <span className="grow">
              TypeSafe の API キー（読みものにタグを付ける Jev 用。Keychain に置きます）
              <span className="muted">{hasTypesafeKey ? " · 保存済み" : " · まだありません"}</span>
            </span>
          </div>
          <div className="setting-row">
            <input ref={keyRef} className="grow mono" type="password" placeholder={hasTypesafeKey ? "新しいキーで置き換える" : "API キー"} aria-label="TypeSafe の API キー" onKeyDown={(e) => isEnter(e) && run(() => api.setTypesafeKey(e.currentTarget.value).then(() => keyRef.current && (keyRef.current.value = "")))} />
            <button className="small" onClick={() => run(() => api.setTypesafeKey(keyRef.current?.value ?? "").then(() => keyRef.current && (keyRef.current.value = "")))}>
              保存
            </button>
            {hasTypesafeKey && (
              <button className="ghost small" onClick={() => run(() => api.setTypesafeKey(""))}>
                消す
              </button>
            )}
          </div>
          <div className="setting-row">
            <span className="grow">
              TypeSafe のクレジット（console.typesafe.ai の請求ページの額と、使用量ページの Spend から、残りを出します）
              <span className="muted">{jevCredit ? ` · ${new Date(jevCredit.at * 1000).toLocaleDateString("ja-JP")} に $${jevCredit.credit} − $${jevCredit.spent}` : " · まだありません"}</span>
            </span>
          </div>
          <div className="setting-row">
            <input ref={creditRef} className="grow mono" inputMode="decimal" defaultValue={jevCredit?.credit} placeholder="クレジット（$）" aria-label="TypeSafe のクレジット（ドル）" />
            <input ref={spentRef} className="grow mono" inputMode="decimal" defaultValue={jevCredit?.spent} placeholder="Spend（$）" aria-label="console の Spend（ドル）" onKeyDown={(e) => isEnter(e) && saveCredit()} />
            <button className="small" onClick={saveCredit}>
              保存
            </button>
            {jevCredit && (
              <button className="ghost small" onClick={() => run(() => api.clearJevCredit())}>
                消す
              </button>
            )}
          </div>
        </section>
        <section>
          <h3>ブラウザ</h3>
          <div className="setting-row">
            <span className="grow">固定の OneLogin が開くポータル</span>
            <input
              className="mono"
              defaultValue={loadText(ONELOGIN_URL_KEY)}
              placeholder={ONELOGIN_DEFAULT_URL}
              aria-label="OneLogin のポータルの URL"
              onBlur={(e) => {
                const url = addressToUrl(e.currentTarget.value);
                remember(ONELOGIN_URL_KEY, url && !url.startsWith(SEARCH_URL) ? url : "");
              }}
            />
          </div>
        </section>
        <SlackSettings report={report} />
        <section>
          <h3>保存したログイン</h3>
          {logins === null && <p className="muted">Keychain を見ています…</p>}
          {logins?.length === 0 && <p className="muted">ありません。ログインしたときに「保存する」を選ぶと、ここに並びます。</p>}
          {logins?.map((l) => (
            <div key={l.site} className="setting-row">
              <span className="mono grow">{l.site}</span>
              <span className="muted">{l.user}</span>
              <button className="ghost small" onClick={() => then(api.forgetLogin(l.site))}>
                消す
              </button>
            </div>
          ))}
        </section>
        {never.length > 0 && (
          <section>
            <h3>ログインを聞かないサイト</h3>
            {never.map((site) => (
              <div key={site} className="setting-row">
                <span className="mono grow">{site}</span>
                <button className="ghost small" onClick={() => then(api.askLoginAgain(site))}>
                  また聞く
                </button>
              </div>
            ))}
          </section>
        )}
        <section>
          <h3>サイトの許可（マイク・カメラ）</h3>
          {Object.keys(permissions).length === 0 && <p className="muted">まだありません。サイトが初めて使おうとしたときに聞いて、答えをここに覚えます。</p>}
          {Object.entries(permissions)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([site, allow]) => (
              <div key={site} className="setting-row">
                <span className="mono grow">{site}</span>
                <span className={allow ? "" : "muted"}>{allow ? "許可" : "許可しない"}</span>
                <button className="ghost small" title="次に使おうとしたとき、また聞きます" onClick={() => then(api.forgetSitePermission(site))}>
                  外す
                </button>
              </div>
            ))}
        </section>
      </div>
    </Modal>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="キーの一覧" wide onClose={onClose}>
      <div className="shortcuts">
        {ACTIONS.map((g) => (
          <section key={g.group}>
            <h3>{g.group}</h3>
            {g.items.map(([action, what]) => (
              <div key={action} className="shortcut-row">
                <span className="grow">{what}</span>
                <span className="kbd">{keyLabel(keyOf(action))}</span>
              </div>
            ))}
          </section>
        ))}
        <section>
          <h3>そのほかのキー</h3>
          {FIXED_KEYS.map(([k, what]) => (
            <div key={k} className="shortcut-row">
              <span className="grow">{what}</span>
              <span className="kbd">{k}</span>
            </div>
          ))}
        </section>
      </div>
    </Modal>
  );
}

/// The spaces in the rail at the left, with their keys (⌘1–⌘4).
const SPACES: { key: Space; label: string; icon: IconName; action: Action }[] = [
  { key: "manage", label: "管理", icon: "board", action: "spaceManage" },
  { key: "work", label: "作業", icon: "terminal", action: "spaceWork" },
  { key: "study", label: "学習", icon: "book", action: "spaceStudy" },
  { key: "browser", label: "ブラウザ", icon: "globe", action: "spaceBrowser" },
];
const SPACE_ACTIONS: [Action, Space][] = SPACES.map((s) => [s.action, s.key]);

const WAITING_TITLE = "あなた待ち：あなたが動かないと進まないもの（返事待ち・CI 失敗・修正依頼・未着手のレビュー依頼）";

/// The rail down the window's left: the spaces as icons (あなた待ち's count
/// on 作業's, as what waits is answered there), then the usage, ⌘K and the
/// settings at its foot.
function SpaceRail({ space, waiting, limits, jev, jevLeft, onSpace, onUsage, onSearch, onSettings }: {
  space: Space;
  waiting: number;
  limits: Limit[] | null;
  jev: JevSpend | undefined;
  jevLeft: number | null;
  onSpace: (s: Space) => void;
  onUsage: () => void;
  onSearch: () => void;
  onSettings: () => void;
}) {
  return (
    <nav className="space-rail" aria-label="場">
      <img className="brand-mark" src={logoUrl} alt="Shosai" title="Shosai" />
      {SPACES.map((s) => (
        <button
          key={s.key}
          className={`space-icon${space === s.key ? " on" : ""}`}
          aria-label={s.label}
          aria-current={space === s.key ? "page" : undefined}
          title={`${s.label}（${keyLabel(keyOf(s.action))}）${s.key === "work" && waiting > 0 ? `\n${WAITING_TITLE} ${waiting} 件` : ""}`}
          onClick={() => onSpace(s.key)}
        >
          <Icon name={s.icon} size={18} />
          {s.key === "work" && waiting > 0 && <span className="rail-count">{waiting}</span>}
        </button>
      ))}
      <span className="grow" />
      <RailUsage limits={limits} jev={jev} jevLeft={jevLeft} onOpen={onUsage} />
      <button className="space-icon" aria-label="検索・操作" title={`検索・操作（${keyLabel(keyOf("palette"))}）`} onClick={onSearch}>
        <Icon name="search" size={18} />
      </button>
      <button className="space-icon" aria-label="設定" title="設定" onClick={onSettings}>
        <Icon name="settings" size={18} />
      </button>
    </nav>
  );
}

/// What 学習 keeps across restarts: the readings open (their pages on the
/// left), the left's tab shown, whether the list or the reading is up, and
/// the pinned page on the right.
interface StudyState {
  open: number[];
  active: string | null;
  view: "list" | "read";
  right: string;
}
const STUDY_KEY = "study";
const NO_STUDY: StudyState = { open: [], active: null, view: "list", right: "pinchatgpt" };
/// A reading's tab (ids are letters and digits only).
const readingTabId = (id: number) => `r${id}`;
/// Where a reading opens: a book at its first chapter not read yet.
const readingUrl = (r: Reading) => (r.kind === "book" ? (r.chapters.find((c) => !c.read)?.url ?? r.url) : r.url);
const READING_KIND: Record<ReadingKind, string> = { article: "記事", post: "X の投稿", book: "本" };
type KindFilter = "all" | ReadingKind;
const KIND_FILTERS: KindFilter[] = ["all", "article", "post", "book"];
const KIND_FILTER_LABEL: Record<KindFilter, string> = { all: "すべて", ...READING_KIND };
/// A local date (YYYY-MM-DD) `offset` days from today.
const localDay = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/// A day as the list shows it: 10/18（土）.
const dayLabel = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", weekday: "short" });

/// 学習's shelves: the readings still to read, the ones read and kept (good
/// ones; the rest are deleted once read), or both.
type Shelf = "toRead" | "kept" | "all";
const SHELVES: Shelf[] = ["toRead", "kept", "all"];
const SHELF_LABEL: Record<Shelf, string> = { toRead: "これから読む", kept: "残した", all: "すべて" };
const onShelf = (r: Reading, shelf: Shelf) => shelf === "all" || r.kept === (shelf === "kept");
/// The tag filter's choices besides the tags: every reading, and those not sorted yet.
const ALL_TAGS = "";
const UNSORTED = "\n";

/// A reading's row as the lists show it: what it is, its title, where from, its tags.
function ReadingMeta({ r }: { r: Reading }) {
  const read = r.chapters.filter((c) => c.read).length;
  return (
    <span className="reading-meta">
      <span className="muted">{r.kind === "post" ? "X" : hostOf(r.url)}</span>
      <span className="muted">· {ago(r.created_at)}</span>
      {r.kept && <span className="tag kept">残した</span>}
      {r.tags === null ? <span className="tag pending">分類待ち</span> : r.tags.map((t) => <span key={t} className="tag">{t}</span>)}
      {r.kind === "book" && r.chapters.length > 0 && (
        <span className="book-progress" title={`${r.chapters.length} 章のうち ${read} 章を読んだ`}>
          <span className="meter-mini" aria-hidden="true">
            <i style={{ width: `${(read / r.chapters.length) * 100}%` }} />
          </span>
          章 {read}/{r.chapters.length}
        </span>
      )}
    </span>
  );
}

/// 学習's list: every reading, the newest first, narrowed by kind, tag and
/// words. Picked ones (x) read together, or have their URLs copied for
/// NotebookLM; every action has its key (keymap.ts, "学習の一覧").
function ReadingsPage({ readings, sort, digests, opened, run, report, onRead, onResume, onBrowser, onSettings, onToast }: {
  readings: Reading[];
  sort: ReadingSort | undefined;
  /// The days' X bookmarks summed up, each opened in the browser.
  digests: DigestView | undefined;
  /// How many readings are open to read (to go back to them).
  opened: number;
  run: (f: () => Promise<unknown>) => void;
  report: (e: unknown) => void;
  onRead: (ids: number[]) => void;
  onResume: () => void;
  onBrowser: (url: string) => void;
  onSettings: () => void;
  onToast: (text: string) => void;
}) {
  const [shelf, setShelf] = useState<Shelf>("toRead");
  const [kind, setKind] = useState<KindFilter>("all");
  const [tag, setTag] = useState(ALL_TAGS);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [forgetting, setForgetting] = useState<number | null>(null);
  const [tagsFor, setTagsFor] = useState<number | null>(null);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shelved = readings.filter((r) => onShelf(r, shelf));
  const ofKind = shelved.filter((r) => kind === "all" || r.kind === kind);
  const shown = ofKind.filter(
    (r) =>
      (tag === ALL_TAGS || (tag === UNSORTED ? r.tags === null : !!r.tags?.includes(tag))) &&
      words.every((w) => `${r.title} ${r.text ?? ""} ${r.url} ${r.tags?.join(" ") ?? ""}`.toLowerCase().includes(w)),
  );
  const tags = sort?.tags ?? [];
  const count = (t: string) => ofKind.filter((r) => (t === UNSORTED ? r.tags === null : r.tags?.includes(t))).length;
  const togglePick = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const copyUrls = (ids: number[]) => {
    const urls = ids.map((id) => readings.find((r) => r.id === id)?.url).filter((u): u is string => !!u);
    api.copyText(urls.join("\n")).then(() => onToast(`${urls.length} 件の URL をコピーしました。NotebookLM のソースの追加（ウェブサイト）に貼ってください`), report);
  };
  const byRow = (id: string) => readings.find((r) => `r:${r.id}` === id);
  const { cursorId, list } = useRowCursor(
    shown.map((r) => `r:${r.id}`),
    (id) => {
      const r = byRow(id);
      if (r) onRead([r.id]);
    },
    (e, id) => {
      if (matches(e, "studyKind")) return (setKind((k) => KIND_FILTERS[(KIND_FILTERS.indexOf(k) + 1) % KIND_FILTERS.length]), true);
      if (matches(e, "search")) return (document.querySelector<HTMLInputElement>(".readings-search")?.focus(), true);
      // Esc steps back: out of forgetting, out of picking, then to the readings open.
      if (matches(e, "studyList")) {
        if (forgetting !== null) setForgetting(null);
        else if (picked.length > 0) setPicked([]);
        else if (opened > 0) onResume();
        else return false;
        return true;
      }
      const r = id && byRow(id);
      if (!r) return false;
      const acts: [boolean, () => void][] = [
        [matches(e, "studyPick"), () => togglePick(r.id)],
        [matches(e, "studyRead"), () => onRead(picked.length > 0 ? picked : [r.id])],
        [matches(e, "studyBrowser"), () => onBrowser(r.url)],
        [matches(e, "studyForget"), () => (forgetting === r.id ? (setForgetting(null), run(() => api.deleteReading(r.id))) : setForgetting(r.id))],
        [matches(e, "studyTags"), () => setTagsFor(r.id)],
        [matches(e, "studyCopy"), () => copyUrls(picked.length > 0 ? picked : [r.id])],
        [matches(e, "studyKeep"), () => run(() => api.setReadingKept(r.id, !r.kept))],
      ];
      const hit = acts.find(([yes]) => yes);
      hit?.[1]();
      return !!hit;
    },
  );
  return (
    <div className="readings-page">
      <nav className="readings-filters" aria-label="絞り込み">
        <div className="section-title">読む・残した</div>
        {SHELVES.map((sh) => (
          <button key={sh} className={`filter-row${shelf === sh ? " on" : ""}`} aria-pressed={shelf === sh} onClick={() => setShelf(sh)}>
            <span className="grow">{SHELF_LABEL[sh]}</span>
            <span className="muted">{readings.filter((r) => onShelf(r, sh)).length}</span>
          </button>
        ))}
        <div className="section-title">種類 <span className="kbd">{keyLabel(keyOf("studyKind"))}</span></div>
        {KIND_FILTERS.map((k) => (
          <button key={k} className={`filter-row${kind === k ? " on" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
            <span className="grow">{KIND_FILTER_LABEL[k]}</span>
            <span className="muted">{k === "all" ? shelved.length : shelved.filter((r) => r.kind === k).length}</span>
          </button>
        ))}
        <div className="section-title">タグ</div>
        <button className={`filter-row${tag === ALL_TAGS ? " on" : ""}`} aria-pressed={tag === ALL_TAGS} onClick={() => setTag(ALL_TAGS)}>
          <span className="grow">すべて</span>
          <span className="muted">{ofKind.length}</span>
        </button>
        {count(UNSORTED) > 0 && (
          <button className={`filter-row${tag === UNSORTED ? " on" : ""}`} aria-pressed={tag === UNSORTED} onClick={() => setTag(UNSORTED)}>
            <span className="grow">分類待ち</span>
            <span className="muted">{count(UNSORTED)}</span>
          </button>
        )}
        {tags.map((t) => (
          <button key={t} className={`filter-row${tag === t ? " on" : ""}`} aria-pressed={tag === t} onClick={() => setTag(t)}>
            <span className="grow ellipsis">{t}</span>
            <span className="muted">{count(t)}</span>
          </button>
        ))}
        <div className="section-title">X のまとめ</div>
        {(digests?.digests.length ?? 0) === 0 && <span className="muted small-text digest-hint">毎朝、前の日の X のブックマークを Claude Docs にまとめます（{keyLabel(keyOf("palette"))} から今すぐも）</span>}
        {digests?.digests.map((d) => (
          <button
            key={d.day}
            className="filter-row"
            title={d.url ? `${d.url} をブラウザで開く` : `まとめられませんでした：${d.error}（押すともう一度）`}
            onClick={() => (d.url ? onBrowser(d.url) : run(() => api.makeXDigest(d.day)))}
          >
            <span className="grow">{dayLabel(d.day)}</span>
            <span className="muted">{digests.running === d.day ? "まとめています…" : d.url ? "開く" : "失敗・もう一度"}</span>
          </button>
        ))}
      </nav>
      <main className="main readings-main">
        <header className="toolbar">
          <h1>読みもの</h1>
          <span className="muted">{shown.length} 件</span>
          {opened > 0 && (
            <button className="small" onClick={onResume}>
              読んでいる {opened} 件に戻る <span className="kbd">{keyLabel(keyOf("studyList"))}</span>
            </button>
          )}
          <span className="grow" />
          <input className="filter-search readings-search" value={query} placeholder="タイトル・本文・タグで探す（/）" aria-label="読みものを探す" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()} />
        </header>
        {sort && !sort.has_key && readings.some((r) => r.tags === null) && (
          <div className="notice">
            <span className="grow">TypeSafe の API キーを設定すると、タグを自動で付けます（Jev）。</span>
            <button className="small" onClick={onSettings}>
              設定を開く
            </button>
          </div>
        )}
        {sort?.error && (
          <div className="notice danger-notice">
            <span className="grow">タグを付けられませんでした：{sort.error}（次に入れたときか、キーを設定し直したときにやり直します）</span>
          </div>
        )}
        {digests?.running && (
          <div className="notice" role="status">
            <span className="grow">{dayLabel(digests.running)} の X のブックマークを、リンク先まで読んでまとめています（数分かかります）。</span>
          </div>
        )}
        {picked.length > 0 ? (
          <div className="notice picked-bar">
            <b className="grow">{picked.length} 件を選んでいます</b>
            <button className="primary small" onClick={() => onRead(picked)}>
              まとめて読む <span className="kbd">{keyLabel(keyOf("studyRead"))}</span>
            </button>
            <button className="small" onClick={() => copyUrls(picked)}>
              URL をコピー（NotebookLM 用） <span className="kbd">{keyLabel(keyOf("studyCopy"))}</span>
            </button>
            <button className="ghost small" onClick={() => setPicked([])}>
              選ぶのをやめる <span className="kbd">{keyLabel(keyOf("studyList"))}</span>
            </button>
          </div>
        ) : (
          <p className="muted hint readings-hint">
            入れ方：ページで {keyLabel(keyOf("bookmark"))}、リンクを ⌥ クリック、X ではブックマークのボタン。O'Reilly の本のページなら本として目次ごと入ります。{keyLabel(keyOf("studyPick"))} で選ぶと、まとめて読めます。
          </p>
        )}
        <div className="content" ref={list}>
          {readings.length === 0 && <p className="muted empty">まだありません。ブラウザでページを開いて {keyLabel(keyOf("bookmark"))} を押すと、ここに並びます。</p>}
          {readings.length > 0 && shown.length === 0 && <p className="muted empty">合う読みものはありません。</p>}
          <ul className="rows">
            {shown.map((r) => {
              const row = `r:${r.id}`;
              const isPicked = picked.includes(r.id);
              return (
                <li key={r.id} data-row={row} className={`row reading-row${row === cursorId ? " cursor" : ""}${isPicked ? " picked" : ""}`} onClick={() => onRead([r.id])}>
                  <input type="checkbox" checked={isPicked} aria-label={`${r.title} を選ぶ`} onClick={stop} onChange={() => togglePick(r.id)} />
                  <span className={`reading-kind kind-${r.kind}`} aria-hidden="true">
                    {READING_KIND[r.kind]}
                  </span>
                  <span className="reading-main">
                    <span className="row-title ellipsis">{r.title}</span>
                    <ReadingMeta r={r} />
                  </span>
                  <span className="row-actions" onClick={stop}>
                    <button className="small" title="読む（Enter）" onClick={() => onRead([r.id])}>
                      {r.kind === "book" ? (r.chapters.some((c) => c.read) ? "続きを読む" : "読み始める") : "読む"}
                    </button>
                    <button className="ghost small" title={`読んで良かったものを残す、残したものを「これから読む」に戻す（${keyLabel(keyOf("studyKeep"))}）`} onClick={() => run(() => api.setReadingKept(r.id, !r.kept))}>
                      {r.kept ? "読むに戻す" : "残す"}
                    </button>
                    <button className="ghost small" title={`ブラウザで開く（${keyLabel(keyOf("studyBrowser"))}）`} onClick={() => onBrowser(r.url)}>
                      ブラウザで
                    </button>
                    <span className="menu-anchor">
                      <button className="ghost small" title={`タグを直す（${keyLabel(keyOf("studyTags"))}）`} aria-expanded={tagsFor === r.id} onClick={() => setTagsFor(tagsFor === r.id ? null : r.id)}>
                        タグ
                      </button>
                      {tagsFor === r.id && <TagMenu reading={r} tags={tags} run={run} onClose={() => setTagsFor(null)} />}
                    </span>
                    {forgetting === r.id ? (
                      <span className="inline-confirm">
                        <button className="danger small" onClick={() => (setForgetting(null), run(() => api.deleteReading(r.id)))}>
                          消す
                        </button>
                        <button className="ghost small" onClick={() => setForgetting(null)}>
                          やめる
                        </button>
                      </span>
                    ) : (
                      <button className="ghost icon" aria-label={`${r.title} を消す`} title={`消す（${keyLabel(keyOf("studyForget"))}）`} onClick={() => setForgetting(r.id)}>
                        <Icon name="close" size={12} />
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </main>
    </div>
  );
}

/// A reading's tags put right by hand: each a checkbox in a menu (↑↓ or j k
/// move, Enter puts it on or off, Esc closes).
function TagMenu({ reading, tags, run, onClose }: { reading: Reading; tags: string[]; run: (f: () => Promise<unknown>) => void; onClose: () => void }) {
  const root = useRef<HTMLSpanElement>(null);
  useOutsideClose(root, true, onClose);
  const menuKeys = useMenuKeys(true, onClose);
  const has = reading.tags ?? [];
  const toggle = (t: string) => run(() => api.setReadingTags(reading.id, has.includes(t) ? has.filter((x) => x !== t) : tags.filter((x) => x === t || has.includes(x))));
  return (
    <span ref={root} className="tag-menu-anchor">
      <span className="menu tag-menu" role="menu" aria-label={`${reading.title} のタグ`} {...menuKeys}>
        {tags.map((t) => (
          <button key={t} role="menuitem" aria-checked={has.includes(t)} onClick={() => toggle(t)}>
            <span className="check">{has.includes(t) ? <Icon name="check" size={12} /> : null}</span>
            {t}
          </button>
        ))}
      </span>
    </span>
  );
}

/// 学習's left while reading: a book's contents (its chapters, read or not:
/// m marks the one under the cursor), or the readings to open beside.
function StudyRail({ reading, readings, opened, run, onRead, onChapter, onCopy, onList, onKeep, onForget }: {
  /// The reading shown on the left.
  reading: Reading | undefined;
  readings: Reading[];
  opened: number[];
  run: (f: () => Promise<unknown>) => void;
  onRead: (ids: number[]) => void;
  /// Shows a chapter of the book on the left.
  onChapter: (url: string) => void;
  /// Copies the open readings' URLs.
  onCopy: () => void;
  onList: () => void;
  /// Read: kept (a good one; again, back to read), or let go (its tab closes).
  onKeep: (r: Reading) => void;
  onForget: (r: Reading) => void;
}) {
  const [forgetting, setForgetting] = useState(false);
  useEffect(() => setForgetting(false), [reading?.id]);
  const book = reading?.kind === "book" && reading.chapters.length > 0 ? reading : undefined;
  const rows = book ? book.chapters.map((c) => `c:${c.position}`) : readings.map((r) => `r:${r.id}`);
  const toggle = (position: number, read: boolean) => book && run(() => api.setChapterRead(book.id, position, read));
  const { cursorId, list } = useRowCursor(
    rows,
    (id) => {
      if (id.startsWith("r:")) onRead([Number(id.slice(2))]);
      else {
        const c = book?.chapters.find((x) => `c:${x.position}` === id);
        if (c) onChapter(c.url);
      }
    },
    (e, id) => {
      if (matches(e, "studyList")) return (forgetting ? setForgetting(false) : onList(), true);
      if (matches(e, "studyCopy")) return (onCopy(), true);
      if (reading && matches(e, "studyKeep")) return (onKeep(reading), true);
      // d asks, d again lets it go.
      if (reading && matches(e, "studyForget")) return (forgetting ? (setForgetting(false), onForget(reading)) : setForgetting(true), true);
      if (!matches(e, "studyChapter") || !id?.startsWith("c:")) return false;
      const c = book?.chapters.find((x) => `c:${x.position}` === id);
      if (c) toggle(c.position, !c.read);
      return true;
    },
  );
  const read = book?.chapters.filter((c) => c.read).length ?? 0;
  return (
    <nav className="split-rail study-rail" aria-label={book ? "目次" : "読みもの"} ref={list}>
      <div className="rail-head">
        <button className="ghost small" onClick={onList} title={`一覧へ（${keyLabel(keyOf("studyList"))}）`}>
          <Icon name="back" size={12} /> 一覧
        </button>
        <span className="muted small-text">{book ? "目次" : "読みもの"}</span>
        <span className="grow" />
        {reading &&
          (forgetting ? (
            <span className="inline-confirm">
              <button className="danger small" onClick={() => (setForgetting(false), onForget(reading))}>
                消す
              </button>
              <button className="ghost small" onClick={() => setForgetting(false)}>
                やめる
              </button>
            </span>
          ) : (
            <>
              <button className="ghost small" title={`読んで良かったので残す（もう一度で「これから読む」に戻す。${keyLabel(keyOf("studyKeep"))}）`} onClick={() => onKeep(reading)}>
                {reading.kept ? "残した" : "残す"} <span className="kbd">{keyLabel(keyOf("studyKeep"))}</span>
              </button>
              <button className="ghost small" title={`読み終わって要らないので消す（${keyLabel(keyOf("studyForget"))} を2回）`} onClick={() => setForgetting(true)}>
                消す
              </button>
            </>
          ))}
      </div>
      {book ? (
        <>
          <div className="book-head">
            <b>{book.title}</b>
            <span className="book-progress">
              <span className="meter-mini" aria-hidden="true">
                <i style={{ width: `${(read / book.chapters.length) * 100}%` }} />
              </span>
              章 {read}/{book.chapters.length} 読んだ
            </span>
          </div>
          <ul className="rows compact">
            {book.chapters.map((c) => (
              <li key={c.position} data-row={`c:${c.position}`} className={`row chapter-row${`c:${c.position}` === cursorId ? " cursor" : ""}${c.read ? " read" : ""}`} onClick={() => onChapter(c.url)}>
                <input type="checkbox" checked={c.read} aria-label={`第${c.position}章を読んだ`} onClick={stop} onChange={() => toggle(c.position, !c.read)} />
                <span className="mono muted">{c.position}</span>
                <span className="row-title ellipsis" title={c.title}>
                  {c.title}
                </span>
              </li>
            ))}
          </ul>
          <span className="muted small-text rail-hint">Enter でその章へ。章を最後までスクロールすると印が付きます。{keyLabel(keyOf("studyChapter"))} でも付け外しできます</span>
        </>
      ) : (
        <ul className="rows compact">
          {readings.map((r) => (
            <li key={r.id} data-row={`r:${r.id}`} className={`row${`r:${r.id}` === cursorId ? " cursor" : ""}${r.id === reading?.id ? " selected" : ""}`} onClick={() => onRead([r.id])}>
              <span className="reading-main">
                <span className="row-title ellipsis">{r.title}</span>
                <span className="muted small-text">
                  {READING_KIND[r.kind]} · {r.kind === "post" ? "X" : hostOf(r.url)}
                  {opened.includes(r.id) ? " · 開いている" : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/// What 作業 keeps across restarts: what is picked in its list (`t<todo id>`
/// or `s<session id>`) and the subtask shown on the right.
interface WorkState {
  pick: string | null;
  child: number | null;
}
const WORK_KEY = "work";
/// A session's page or terminal in 作業 (ids are letters and digits only).
const workTabId = (sessionId: string) => `w${sessionId.replace(/[^A-Za-z0-9]/g, "")}`;
/// The session a todo is worked in: the latest live one, else the latest.
function mainSession(todo: Todo): Session | undefined {
  const byLatest = [...todo.sessions].sort((a, b) => b.state_at - a.state_at);
  return byLatest.find((s) => s.state !== "ended") ?? byLatest[0];
}
/// What 作業 shows for its pick: a parent todo's planning session (left) and
/// a subtask's (right, with the subtasks as tabs), or one session alone.
interface WorkView {
  title: string | null;
  todo?: Todo;
  children: Todo[];
  child?: Todo;
  left?: Session;
  right?: Session;
}
function workViewOf(board: Board | null, work: WorkState): WorkView {
  const none: WorkView = { title: null, children: [] };
  if (!board || !work.pick) return none;
  if (work.pick.startsWith("s")) {
    const id = work.pick.slice(1);
    const session = [...board.inbox, ...board.todos.flatMap((t) => t.sessions)].find((s) => s.session_id === id);
    return session ? { title: sessionLabel(session), children: [], left: session } : none;
  }
  const todo = board.todos.find((t) => `t${t.id}` === work.pick);
  if (!todo) return none;
  const children = board.todos.filter((t) => t.parent_id === todo.id);
  if (children.length === 0 && !todo.plan) return { title: todo.title, todo, children, left: mainSession(todo) };
  // The subtask asked for, else one that asks, else one at work, else the first.
  const asks = (t: Todo) => t.sessions.some((s) => s.state === "needs_input");
  const runs = (t: Todo) => t.sessions.some((s) => s.state === "running");
  const child = children.find((c) => c.id === work.child) ?? children.find(asks) ?? children.find(runs) ?? children[0];
  return { title: todo.title, todo, children, child, left: mainSession(todo), right: child && mainSession(child) };
}

/// A row of 作業's list: a todo at work (a parent with its subtasks' state)
/// or a session of no todo.
interface WorkRow {
  key: string;
  todo?: Todo;
  session?: Session;
}

/// 作業's list on the left: あなた待ち first (what is asked, in one line),
/// then the work in one list (the todos at work, the reviews and the sessions
/// of no todo), in the order chosen. j k move, Enter shows one (its session takes the keyboard), ⌘⇧A puts a session away.
function WorkRail({ board, waiting, pick, width, onResize, onPick, onTodo, onShowPrs, onQuick, onLink, run }: {
  board: Board;
  waiting: WaitItem[];
  pick: string | null;
  width: number;
  onResize: (w: number) => void;
  /// Shows a row's work: a todo (a subtask's at its parent) or a session.
  onPick: (at: { todo: number } | { session: string }) => void;
  /// Shows a todo in 管理.
  onTodo: (id: number) => void;
  onShowPrs: () => void;
  onQuick: () => void;
  /// Links a session to a todo (picked in ⌘K), or unlinks it from `todo`.
  onLink: (s: Session, todo: Todo | undefined) => void;
  run: (f: () => Promise<unknown>) => void;
}) {
  const fix = useContext(FixContext);
  const [showEnded, setShowEnded] = useState(false);
  const live = (s: Session) => s.state !== "ended";
  const todos = board.todos.filter((t) => t.status !== "done");
  // A todo is at work while it or (for a parent) one of its subtasks has a live session.
  const atWork = todos.filter((t) => t.parent_id === null && (t.sessions.some(live) || todos.some((c) => c.parent_id === t.id && c.sessions.some(live))));
  const waitingSessions = new Set(waiting.flatMap((w) => (w.session ? [w.session.session_id] : [])));
  const shownWaits = waiting.filter((w) => !isReviewAsk(w));
  const asks = waiting.length - shownWaits.length;
  // Sessions put away (⌘⇧A) and routines' runs are out, but for one asking.
  const listed = (s: Session) => (!s.hidden && !s.routine) || s.state === "needs_input";
  const loose = board.inbox.filter((s) => (showEnded || live(s)) && listed(s) && !waitingSessions.has(s.session_id));
  // The work (the todos at work, the reviews and the sessions of no todo, in
  // one list) is in the order chosen (s): the one the user put it in (⇧j ⇧k,
  // or dragging; what was never moved on top), or the latest work first, by
  // when it last moved or began.
  const [sort, setSortState] = useState<WorkSort>(() => load(WORK_SORT_KEY, WORK_SORTS, "manual"));
  const setSort = (s: WorkSort) => {
    remember(WORK_SORT_KEY, s);
    setSortState(s);
  };
  const [order, setOrderState] = useState(() => loadJson<string[]>(WORK_ORDER_KEY, []));
  const setOrder = (f: (prev: string[]) => string[]) =>
    setOrderState((prev) => {
      const next = f(prev);
      remember(WORK_ORDER_KEY, JSON.stringify(next));
      return next;
    });
  /// A row's sessions: its own, or its todo's and its subtasks'.
  const sessionsOf = (r: WorkRow) => (r.session ? [r.session] : todos.filter((t) => t.id === r.todo?.id || t.parent_id === r.todo?.id).flatMap((t) => t.sessions));
  const ordered = (rows: WorkRow[]) =>
    sort === "manual"
      ? arrange(rows, (r) => r.key, order)
      : latestFirst(rows, (r) => Math.max(0, ...sessionsOf(r).map((s) => (sort === "updated" ? s.state_at : s.started_at))));
  const workRows = ordered([...atWork.map((t): WorkRow => ({ key: `t${t.id}`, todo: t })), ...loose.map((s): WorkRow => ({ key: `s${s.session_id}`, session: s }))]);
  /// Moves row `key` to where `to` is, both in the work (not あなた待ち):
  /// the list is ordered by hand from then on, as it was shown.
  const moveRow = (key: string, to: string) => {
    if (![key, to].every((k) => workRows.some((r) => r.key === k))) return;
    const manual = sort === "manual";
    setOrder((prev) => moveTo(prev, (manual ? arrange(workRows, (r) => r.key, prev) : workRows).map((r) => r.key), key, to));
    if (!manual) setSort("manual");
  };
  const { dragging, start: dragRow } = useDragMove("data-row", moveRow);
  const ended = board.inbox.filter((s) => !live(s) && listed(s)).length;
  const rows: WorkRow[] = [...shownWaits.map((w) => ({ key: `w:${w.key}`, todo: w.todo, session: w.session })), ...workRows];
  const open = (r: WorkRow) => (r.todo ? onPick({ todo: r.todo.id }) : r.session ? onPick({ session: r.session.session_id }) : undefined);
  const { cursorId, setCursor, list } = useRowCursor(
    [QUICK_ROW, ...rows.map((r) => r.key), ...(asks > 0 ? [ASKS_ROW] : [])],
    (id) => {
      if (id === QUICK_ROW) return onQuick();
      if (id === ASKS_ROW) return onShowPrs();
      const r = rows.find((x) => x.key === id);
      if (r) open(r);
    },
    (e, id) => {
      if (matches(e, "workEnded")) return (setShowEnded((v) => !v), true);
      if (matches(e, "workSort")) return (setSort(WORK_SORTS[(WORK_SORTS.indexOf(sort) + 1) % WORK_SORTS.length]), true);
      // ⇧j ⇧k: the row under the cursor a place down or up in the work.
      const shift = matches(e, "workMoveDown") ? 1 : matches(e, "workMoveUp") ? -1 : 0;
      const at = workRows.findIndex((r) => r.key === id);
      if (shift && at >= 0) {
        const to = workRows[at + shift];
        if (to) moveRow(id!, to.key);
        return true;
      }
      // The button of the side without its terminal: start, resume or open where it runs.
      if (matches(e, "start")) {
        const side = document.querySelector(".app.typing-right") ? "right" : "left";
        document.querySelector<HTMLButtonElement>(`.focus-${side} .pane-empty button`)?.click();
        return true;
      }
      const r = rows.find((x) => x.key === id);
      const w = waiting.find((x) => `w:${x.key}` === id);
      const s = r?.session;
      // A todo's row stands for the session it shows.
      const shown = s ?? (r?.todo && mainSession(r.todo));
      const acts: [boolean, () => void][] = [
        [matches(e, "workLink") && !!shown, () => onLink(shown!, r?.todo)],
        [matches(e, "archive") && !!s, () => run(() => (isCloud(s!) ? api.archiveSessions([s!.session_id]) : api.hideSession(s!.session_id)))],
        [matches(e, "showTodo") && !!r?.todo, () => onTodo(r!.todo!.id)],
        [matches(e, "workFix") && !!(fix && s && w?.todo && (w.reasons.includes("ci") || w.reasons.includes("changes"))), () => fix!(s!, w!.todo!)],
        [matches(e, "workHandled") && !!(w?.todo && w.reasons.includes("escalated")), () => run(() => api.clearEscalation(w!.todo!.id))],
      ];
      const hit = acts.find(([yes]) => yes);
      hit?.[1]();
      return !!hit;
    },
  );
  // The cursor starts on the first of the work, not on ちょっと Claude above it.
  useEffect(() => void (rows[0] && setCursor(rows[0].key)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = (r: WorkRow) => (r.todo ? pick === `t${r.todo.parent_id ?? r.todo.id}` : pick === `s${r.session?.session_id}`);
  const sessionRow = (r: WorkRow, s: Session) => (
    <li key={r.key} data-row={r.key} className={`row work-row${r.key === cursorId ? " cursor" : ""}${picked(r) ? " selected" : ""}${r.key === dragging ? " dragging" : ""}`} onPointerDown={(e) => dragRow(e, r.key)} onClick={() => open(r)}>
      <span className="work-line">
        <StateBadge state={s.state} unread={s.unread} />
        <span className="row-title ellipsis">{sessionLabel(s)}</span>
      </span>
      <span className="muted small-text ellipsis">
        {s.review_url ? `${prRef(s.review_url)} · ` : ""}
        {placeOf(s)} · {ago(s.state_at)}
      </span>
    </li>
  );
  return (
    <nav className="split-rail work-rail" aria-label="作業の一覧" ref={list}>
      <div className="rail-head">
        <h1>作業</h1>
        <select className="select compact" value={sort} aria-label="並べ方" title={`並べ方（${keyLabel(keyOf("workSort"))} で切り替え）`} onChange={(e) => setSort(e.target.value as WorkSort)}>
          {WORK_SORTS.map((s) => (
            <option key={s} value={s}>
              {WORK_SORT_LABEL[s]}
            </option>
          ))}
        </select>
        <span className="grow" />
        <button data-row={QUICK_ROW} className={`ghost small${cursorId === QUICK_ROW ? " cursor" : ""}`} onClick={onQuick} title="todo に紐づけずに claude を開く">
          <Icon name="spark" size={12} /> ちょっと Claude
        </button>
      </div>
      <div className="rail-body">
        {(shownWaits.length > 0 || asks > 0) && (
          <section>
            <div className="section-title waiting-title">あなた待ち {waiting.length}</div>
            <ul className="rows compact">
              {shownWaits.map((w) => {
                const key = `w:${w.key}`;
                const r: WorkRow = { key, todo: w.todo, session: w.session };
                return (
                  <li key={key} data-row={key} className={`row work-row wait-row${key === cursorId ? " cursor" : ""}`} onClick={() => open(r)}>
                    <span className="work-line">
                      <span className="state state-needs_input">
                        <i />
                        {w.reasons.map((x) => WAIT_WORD[x]).join("・")}
                      </span>
                      {w.todo && <span className="mono muted">#{w.todo.id}</span>}
                      <span className="row-title ellipsis">{w.session ? sessionLabel(w.session) : (w.todo?.title ?? w.review?.title)}</span>
                    </span>
                    <span className="ask-line" title={w.line}>
                      {w.line}
                    </span>
                    <span className="work-line muted small-text">
                      <span className="ellipsis">{[w.todo?.parent_id ? `親 #${w.todo.parent_id}` : null, w.session ? placeOf(w.session) : null, w.session ? ago(w.session.state_at) : null].filter(Boolean).join(" · ")}</span>
                      <span className="grow" />
                      {w.todo && w.reasons.includes("escalated") && (
                        <button className="small" title="指揮役から回されたことに対応しました（あなた待ちから外します）" onClick={(e) => (e.stopPropagation(), run(() => api.clearEscalation(w.todo!.id)))}>
                          対応した <span className="kbd">{keyLabel(keyOf("workHandled"))}</span>
                        </button>
                      )}
                      {w.session && w.todo && fix && (w.reasons.includes("ci") || w.reasons.includes("changes")) && (
                        <button className="small" title="元のセッションに、直すところを送ります（画面もフォーカスも動きません）" onClick={(e) => (e.stopPropagation(), fix(w.session!, w.todo!))}>
                          直させる <span className="kbd">{keyLabel(keyOf("workFix"))}</span>
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
              {asks > 0 && (
                <li data-row={ASKS_ROW} className={`row work-row wait-row${ASKS_ROW === cursorId ? " cursor" : ""}`} onClick={onShowPrs}>
                  <span className="work-line">
                    <span className="state state-needs_input">
                      <i />
                      {WAIT_WORD.review}
                    </span>
                    <span className="row-title">まだ始めていないレビュー依頼 {asks} 件</span>
                  </span>
                  <span className="muted small-text">管理の PR で始めます</span>
                </li>
              )}
            </ul>
          </section>
        )}
        <section>
          <div className="section-title">作業中</div>
          {workRows.length === 0 && <p className="muted hint">動いているセッションはありません。管理で todo を任せるか、ちょっと Claude で始めると、ここに並びます。</p>}
          <ul className="rows compact">
            {workRows.map((r) => {
              const t = r.todo;
              if (!t) return r.session && sessionRow(r, r.session);
              const children = todos.filter((c) => c.parent_id === t.id);
              const key = `t${t.id}`;
              const s = mainSession(t);
              const under = waiting.filter((w) => w.todo && (w.todo.id === t.id || w.todo.parent_id === t.id)).length;
              return (
                <li key={key} data-row={key} className={`row work-row${key === cursorId ? " cursor" : ""}${pick === key ? " selected" : ""}${key === dragging ? " dragging" : ""}`} onPointerDown={(e) => dragRow(e, key)} onClick={() => onPick({ todo: t.id })}>
                  <span className="work-line">
                    {s ? <StateBadge state={s.state} unread={s.unread} /> : <StatusIcon status={t.status} />}
                    <span className="mono muted">#{t.id}</span>
                    <span className="row-title ellipsis">{t.title}</span>
                  </span>
                  <span className="work-line muted small-text">
                    {children.length > 0 && (
                      <span>
                        サブタスク {board.todos.filter((c) => c.parent_id === t.id && c.status === "done").length}/{board.todos.filter((c) => c.parent_id === t.id).length}
                      </span>
                    )}
                    {under > 0 && <span className="pill waiting">あなた待ち {under}</span>}
                    {s && <span className="ellipsis">{placeOf(s)} · {ago(s.state_at)}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
        {ended > 0 && (
          <button className="ghost small show-ended" onClick={() => setShowEnded((v) => !v)}>
            {showEnded ? "終了したセッションを隠す" : `終了したセッション ${ended} 件`} <span className="kbd">{keyLabel(keyOf("workEnded"))}</span>
          </button>
        )}
        <span className="muted small-text rail-hint">
          {keyLabel(keyOf("down"))} {keyLabel(keyOf("up"))} で選ぶ · Enter で開く · {keyLabel(keyOf("workMoveDown"))} {keyLabel(keyOf("workMoveUp"))}（ドラッグでも）で並べ替え · {keyLabel(keyOf("workSort"))} で並べ方 · {keyLabel(keyOf("workLink"))} で todo に紐づける · {keyLabel(keyOf("sidePane"))} でセッションへ · {keyLabel(keyOf("archive"))} で片付ける · {keyLabel(keyOf("help"))} でキーの一覧
        </span>
      </div>
      <Resizer label="作業の一覧の幅" cssVar="--rail-w" edge="right" width={width} min={RAIL_MIN_W} max={() => RAIL_MAX_W} onResize={onResize} />
    </nav>
  );
}

export default function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  // The space shown (⌘1–⌘4), kept across restarts.
  const [space, setSpaceState] = useState<Space>(() => load(SPACE_KEY, ["manage", "work", "study", "browser"] as const, "manage"));
  const spaceRef = useRef(space);
  spaceRef.current = space;
  const setSpace = (s: Space) => {
    remember(SPACE_KEY, s);
    spaceRef.current = s;
    setSpaceState(s);
  };
  useEffect(() => void api.setSpace(space).catch((e) => setError(String(e))), [space]);
  // Every page the app shows: the browser space's tabs (and pinned pages),
  // the readings' pages (学習) and the sessions' pages and terminals (作業).
  // The browser space's are kept across restarts (see `restoreTabs`).
  const restored = useRef<ReturnType<typeof restoreTabs> | null>(null);
  restored.current ??= restoreTabs();
  const [tabs, setTabs] = useState<BrowserTab[]>(() => restored.current!.tabs);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(() => restored.current!.active);
  const [newTab, setNewTab] = useState(false);
  const setActiveTabId = (id: string | null) => {
    setActiveTabIdState(id);
    setNewTab(false);
  };
  const nextTab = useRef(tabs.filter((t) => !t.pinned).length + 1);
  // The browser space's tabs: the pinned pages, then the others.
  const paneTabs = tabs.filter((t) => !t.area);
  const normalTabs = paneTabs.filter((t) => !t.pinned);
  const activeTab = newTab ? null : (paneTabs.find((t) => t.id === activeTabId) ?? normalTabs[normalTabs.length - 1] ?? null);
  const browserShown = space === "browser";
  /// The previous (-1) or next (1) tab, wrapping around (⌘⇧[ ⌘⇧]), in the order
  /// of the tab list: the pinned pages (a page not opened yet opens), then the others.
  const switchTab = (delta: number) => {
    const shown = [...PINNED_PAGES.map((p) => p.id), ...normalTabs.map((t) => t.id)];
    if (!browserShown) return;
    const i = activeTab ? shown.indexOf(activeTab.id) : delta > 0 ? -1 : shown.length;
    const nextId = shown[(i + delta + shown.length) % shown.length];
    if (PINNED_PAGES.some((p) => p.id === nextId)) return showPinned(nextId);
    const next = tabs.find((t) => t.id === nextId) ?? null;
    keysToTab(next, activeTab?.id, report);
    setActiveTabId(nextId);
  };
  const switchRef = useRef(switchTab);
  switchRef.current = switchTab;
  /// The browser space on a new tab page (⌘T).
  const openNewTab = () => {
    setSpace("browser");
    setNewTab(true);
  };
  const [cloudTarget, setCloudTargetState] = useState<CloudTarget>(() => load(CLOUD_TARGET_KEY, ["web", "desktop"] as const, "web"));
  const setCloudTarget = (t: CloudTarget) => {
    remember(CLOUD_TARGET_KEY, t);
    setCloudTargetState(t);
  };
  /// Opens a page (a PR, an issue, an artifact) in the browser space, which
  /// comes up with it: the tab opened for it, else a new tab next to the one
  /// shown. Opening is the user's action, so the page takes the keyboard
  /// (`keys` false leaves it), its text box with `text` typed in; `behind`
  /// makes the tab without moving to it.
  /// With ctrl held (see outside.ts): a page in the default browser, a file
  /// with its app. A Slack permalink always (open_link opens it in Slack).
  const openOutside = (url: string) => {
    const path = pathOfFileUrl(url);
    (path ? api.openPath(path) : api.openLink(url)).catch(report);
  };
  const openInBrowser = (url: string, keys = true, behind = false, text?: string) => {
    if (opensOutside() || SLACK_PERMALINK.test(url)) return openOutside(url);
    const open = findTabFor(normalTabs.filter((t) => !t.term), url);
    if (open) {
      if (behind) return;
      setSpace("browser");
      if (keys) keysToTab(open, browserShown ? activeTab?.id : undefined, report, text);
      return setActiveTabId(open.id);
    }
    const id = `t${nextTab.current++}`;
    if (keys && !behind) focusSoon(id, !!text, text);
    setTabs((prev) => insertAfter(prev, { id, url, openedFor: url, title: null, loading: true, nav: 0 }, activeTab?.id ?? null));
    if (!behind) {
      setSpace("browser");
      setActiveTabId(id);
    }
  };
  /// A link a page opens in a new window: a new tab right after that page's
  /// tab, in front with the keyboard (the user clicked it), or `behind` (⌘-click).
  const openFromPage = (url: string, from: string, behind: boolean) => {
    const id = `t${nextTab.current++}`;
    if (!behind) focusSoon(id);
    setTabs((prev) => insertAfter(prev, { id, url, title: null, loading: true, nav: 0 }, prev.some((t) => t.id === from && !t.pinned && !t.area) ? from : (activeTab?.id ?? null)));
    if (!behind) {
      setSpace("browser");
      setActiveTabId(id);
    }
  };
  const [terminalTarget, setTerminalTargetState] = useState<TerminalTarget>(() => load(TERMINAL_TARGET_KEY, ["ghostty", "app"] as const, "ghostty"));
  const setTerminalTarget = (t: TerminalTarget) => {
    remember(TERMINAL_TARGET_KEY, t);
    setTerminalTargetState(t);
  };
  // The pages take the keys as they are set (their script reads them).
  useEffect(() => void api.setPageKeys(JSON.stringify(allKeys())).catch((e) => setError(String(e))), []);
  // A short note at the bottom of what was done in the background (a reading
  // kept, a session sent what to fix).
  const [toast, setToastState] = useState<string | null>(null);
  const showToast = (text: string) => {
    setToastState(text);
    setTimeout(() => setToastState((now) => (now === text ? null : now)), TOAST_MS);
  };

  // 学習: the readings in one list, and the ones open to read, their pages on
  // the left as tabs, the pinned NotebookLM, ChatGPT or Claude on the right.
  const readings = board?.readings ?? [];
  const [study, setStudyState] = useState<StudyState>(() => ({ ...NO_STUDY, ...loadJson<Partial<StudyState>>(STUDY_KEY, {}) }));
  const setStudy = (f: (s: StudyState) => StudyState) =>
    setStudyState((prev) => {
      const next = f(prev);
      remember(STUDY_KEY, JSON.stringify(next));
      return next;
    });
  const studyReading = space === "study" && study.view === "read";
  // The left's tabs: the open readings' pages, and pages they opened.
  const studyLefts = tabs.filter((t) => t.area === "study");
  const studyLeft = studyLefts.find((t) => t.id === study.active) ?? studyLefts[0] ?? null;
  const studyRightTab = tabs.find((t) => t.id === study.right);
  /// A pinned page, made (not shown) when it is not yet.
  const ensurePinned = (id: string) =>
    setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [{ id, url: pinnedUrl(id), title: PINNED_PAGES.find((p) => p.id === id)?.label ?? null, loading: true, nav: 0, pinned: true }, ...prev]));
  /// Readings' tabs, made where missing (a book's at its first chapter not read).
  const readingTabs = (list: Reading[]) =>
    setTabs((prev) => [
      ...prev,
      ...list.filter((r) => !prev.some((t) => t.id === readingTabId(r.id))).map((r): BrowserTab => ({ id: readingTabId(r.id), url: readingUrl(r), openedFor: r.url, title: r.title, loading: true, nav: 0, area: "study", reading: r.id })),
    ]);
  /// Opens readings to read, the first shown with the keyboard (as tabs on the left).
  const readReadings = (ids: number[]) => {
    const list = ids.map((id) => readings.find((r) => r.id === id)).filter((r): r is Reading => !!r);
    if (list.length === 0) return;
    readingTabs(list);
    ensurePinned(study.right);
    const first = readingTabId(list[0].id);
    focusSoon(first);
    setFocusTyping("left");
    setStudy((s) => ({ ...s, open: [...new Set([...s.open, ...list.map((r) => r.id)])], active: first, view: "read" }));
    setSpace("study");
  };
  // The readings open before a restart come back once the board has them.
  const boardLoaded = board !== null;
  useEffect(() => {
    if (!boardLoaded) return;
    const kept = study.open.filter((id) => readings.some((r) => r.id === id));
    readingTabs(kept.map((id) => readings.find((r) => r.id === id)!));
    if (kept.length !== study.open.length) setStudy((s) => ({ ...s, open: kept, view: kept.length > 0 ? s.view : "list" }));
  }, [boardLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
  /// A tab of 学習's left closed (⌘W, ×): the next one shows; with none, the list.
  const closeStudyTab = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    const next = nextAfterClose(studyLefts, id);
    api.browserClose(id).catch(report);
    setTabs((prev) => prev.filter((t) => t.id !== id));
    setStudy((s) => ({ ...s, open: s.open.filter((r) => r !== tab?.reading), active: s.active === id ? (next?.id ?? null) : s.active, view: next ? s.view : "list" }));
    if (id === studyLeft?.id && next) keysToTab(next, undefined, report);
  };
  const studyReadingShown = studyLeft?.reading !== undefined ? readings.find((r) => r.id === studyLeft.reading) : undefined;
  /// 学習's reading read: kept (a good one; again, back to read), or let go (its tab closes).
  const keepReading = (r: Reading) => run(() => api.setReadingKept(r.id, !r.kept));
  const forgetReading = (r: Reading) => {
    const tab = tabs.find((t) => t.reading === r.id);
    if (tab) closeStudyTab(tab.id);
    run(() => api.deleteReading(r.id));
  };
  /// Picks the page on 学習's right; it takes the typing (its text box, with `text` typed in).
  const setStudyRight = (id: string, text?: string) => {
    ensurePinned(id);
    setStudy((s) => ({ ...s, right: id }));
    focusSoon(id, true, text);
    setFocusTyping("right");
  };
  /// A page a reading's page opened (a link to a new window): a tab among 学習's left.
  const addStudyPage = (url: string, behind: boolean) => {
    const id = `f${nextTab.current++}`;
    setTabs((prev) => [...prev, { id, url, title: null, loading: true, nav: 0, area: "study" }]);
    if (behind) return;
    focusSoon(id);
    setStudy((s) => ({ ...s, active: id }));
  };
  // Notifications wait while in 学習 (the backend posts none); on leaving it,
  // the page tells how much more waits on the user.
  const waitingAtStudy = useRef<Set<string>>(new Set());
  const waitingKeys = useRef<string[]>([]);
  const [heldWaiting, setHeldWaiting] = useState(0);
  const lastSpace = useRef(space);
  useEffect(() => {
    if (space === "study" && lastSpace.current !== "study") waitingAtStudy.current = new Set(waitingKeys.current);
    if (space !== "study" && lastSpace.current === "study") setHeldWaiting(waitingKeys.current.filter((k) => !waitingAtStudy.current.has(k)).length);
    lastSpace.current = space;
  }, [space]);

  // 作業: what runs (a todo with its sessions, or a session of no todo),
  // picked in the list on the left; a parent's planning session on the left
  // and its subtasks' on the right, or one session alone.
  const [work, setWorkState] = useState<WorkState>(() => loadJson<WorkState>(WORK_KEY, { pick: null, child: null }));
  const setWork = (w: WorkState) => {
    remember(WORK_KEY, JSON.stringify(w));
    setWorkState(w);
  };
  const workView = workViewOf(board, work);
  // Which terminal shows each local session in 作業: the herdr session it
  // runs in, attached once and shared by its sessions (showing one focuses
  // its pane), else its own `claude --resume`. Local sessions found running
  // outside herdr are not started twice: they are only marked.
  const [workTerms, setWorkTerms] = useState<Record<string, string>>({});
  const [outsideHerdr, setOutsideHerdr] = useState<Set<string>>(new Set());
  const workTab = (session: Session | undefined) => (session ? tabs.find((t) => t.id === (isCloud(session) ? workTabId(session.session_id) : workTerms[session.session_id])) : undefined);
  const resuming = useRef(new Set<string>());
  /// Shows a session in 作業: a Cloud session's claude.ai page (made once), a
  /// local one's herdr pane (focused, its herdr session attached). An ended
  /// one waits for `resume` (a press), as resuming starts it again.
  const ensureWorkTab = (session: Session, resume = false) => {
    const sid = session.session_id;
    if (isCloud(session)) {
      const id = workTabId(sid);
      const url = cloudWebUrl(sid);
      return setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, url, openedFor: url, title: sessionLabel(session), loading: true, nav: 0, area: "work", session: sid }]));
    }
    if (resuming.current.has(sid) || (session.state === "ended" && !resume)) return;
    resuming.current.add(sid);
    terminalApi
      .resume(sid, false, !resume)
      .then((run) => {
        setOutsideHerdr((prev) => {
          const next = new Set(prev);
          if (run) next.delete(sid);
          else next.add(sid);
          return next;
        });
        if (!run) return;
        const id = run.herdr ? `wh${run.herdr.replace(/[^A-Za-z0-9]/g, "")}` : workTabId(sid);
        setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, url: "", title: run.title, loading: false, nav: 0, term: run, area: "work", session: run.herdr ? undefined : sid }]));
        setWorkTerms((m) => (m[sid] === id ? m : { ...m, [sid]: id }));
      }, report)
      .finally(() => resuming.current.delete(sid));
  };
  // Each session as it comes up (a herdr pane is focused again for it).
  useEffect(() => {
    if (space !== "work") return;
    for (const s of [workView.left, workView.right]) if (s) ensureWorkTab(s);
  }, [space, workView.left?.session_id, workView.right?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps
  /// Opens 作業 at a todo (a subtask: at its parent, on it) or a session
  /// (the todo it is of, when it has one); the left takes the keyboard.
  const openWork: OpenWork = (at) => {
    const todos = board?.todos ?? [];
    const todo = "todo" in at ? todos.find((t) => t.id === at.todo) : todos.find((t) => t.sessions.some((s) => s.session_id === at.session));
    const parent = todo?.parent_id != null ? todos.find((t) => t.id === todo.parent_id) : undefined;
    const next: WorkState = parent ? { pick: `t${parent.id}`, child: todo!.id } : todo ? { pick: `t${todo.id}`, child: work.child } : "session" in at ? { pick: `s${at.session}`, child: null } : work;
    setWork(next);
    setSpace("work");
    const view = workViewOf(board, next);
    const side = parent ? view.right : view.left;
    const tab = workTab(side);
    if (tab) keysToTab(tab, undefined, report);
    else if (side) focusSoon(workTabId(side.session_id));
    setFocusTyping(parent ? "right" : "left");
  };
  const openWorkRef = useRef(openWork);
  openWorkRef.current = openWork;
  /// Picks a subtask on 作業's right; its session takes the keyboard.
  const pickChild = (id: number) => {
    setWork({ ...work, child: id });
    const child = (board?.todos ?? []).find((t) => t.id === id);
    const session = child && mainSession(child);
    const tab = workTab(session);
    if (tab) keysToTab(tab, workView.right && workTabId(workView.right.session_id), report);
    else if (session) focusSoon(workTabId(session.session_id));
    setFocusTyping("right");
  };

  // A split view (作業, or 学習 while reading): its left and right, and which
  // of them has the keyboard (null: the list on its left, or another app).
  const split = space === "work" || studyReading;
  const splitRef = useRef(split);
  splitRef.current = split;
  const splitLeft = space === "work" ? workTab(workView.left) : studyReading ? studyLeft : undefined;
  const splitRight = space === "work" ? workTab(workView.right) : studyReading ? studyRightTab : undefined;
  const [focusTyping, setFocusTyping] = useState<"left" | "right" | null>(null);
  /// ⌘⇧[ ⌘⇧] in a split view: the previous or next tab of the side that has
  /// the keyboard: 学習's readings or LLMs, 作業's subtasks.
  const switchSplitTab = (right: boolean, delta: number) => {
    setFocusTyping(right ? "right" : "left");
    const step = <T,>(list: T[], at: number) => list[(at + delta + list.length) % list.length];
    if (space === "study") {
      if (right) return setStudyRight(step(STUDY_RIGHT, STUDY_RIGHT.indexOf(study.right)));
      if (studyLefts.length === 0) return;
      const next = step(studyLefts, studyLeft ? studyLefts.indexOf(studyLeft) : -1);
      setStudy((s) => ({ ...s, active: next.id }));
      return keysToTab(next, studyLeft?.id, report);
    }
    if (right && workView.children.length > 0) pickChild(step(workView.children, workView.child ? workView.children.indexOf(workView.child) : -1).id);
  };
  const switchSplitTabRef = useRef(switchSplitTab);
  switchSplitTabRef.current = switchSplitTab;
  /// Whether tab `id` is a split view's right side.
  const onSplitRight = (id: string) => isSplitRight(tabs, id, STUDY_RIGHT, workView.right?.session_id);
  const onSplitRightRef = useRef(onSplitRight);
  onSplitRightRef.current = onSplitRight;

  /// ⌘⇧D: the page shown keeps itself to read (a book's with its contents).
  const bookmarkShown = () => {
    const tab = browserShown ? activeTab : studyReading ? studyLeft : undefined;
    if (!tab || tab.term || tab.pinned || !/^https?:\/\//.test(tab.url)) return false;
    api.browserBookmark(tab.id).catch(report);
    return true;
  };
  const bookmarkShownRef = useRef(bookmarkShown);
  bookmarkShownRef.current = bookmarkShown;
  // A login a page sent, asked about before the app keeps it.
  const [loginAsk, setLoginAsk] = useState<{ host: string; user: string } | null>(null);
  useEffect(() => {
    const off = listen<{ host: string; user: string }>(LOGIN_CAPTURED_EVENT, ({ payload }) => setLoginAsk(payload));
    return () => void off.then((f) => f());
  }, []);
  const answerLogin = (answer: "keep" | "skip" | "never") => {
    setLoginAsk(null);
    api.answerLogin(answer).catch(report);
  };
  /// ⌘K: the login kept for the site the browser space shows, taken out.
  const forgetShownLogin = () => {
    const site = activeTab && !activeTab.term ? hostOf(activeTab.url) : null;
    if (site) api.forgetLogin(site).catch(report);
  };
  // A terminal's links open in a new tab of the browser space, in front
  // (with the keyboard) or behind.
  const openTerminalLink = (url: string, front: boolean) => (opensOutside() ? openOutside(url) : openInBrowser(url, front, !front));
  const openTerminalLinkRef = useRef(openTerminalLink);
  openTerminalLinkRef.current = openTerminalLink;
  useEffect(() => {
    setTerminalLinkOpener((url, front) => openTerminalLinkRef.current(url, front));
    return () => setTerminalLinkOpener(null);
  }, []);
  /// ⌘⇧L in terminal `id`: the addresses it shows, to pick one from in ⌘K's box.
  /// ⌘K opened on a list of its own: a terminal's links (back to `terminal` on Esc), or the sessions.
  const [paletteStart, setPaletteStart] = useState<{ command: Command; terminal?: string } | null>(null);
  const pickTerminalLink = (id: string) => {
    const links = terminalLinks(id);
    setPaletteStart({
      terminal: id,
      command: { key: "terminalLinks", label: "ターミナルのリンク", run: () => {}, items: () => links.map(({ url, text }) => ({ key: url, label: text ?? url, hint: text && url, run: () => openTerminalLink(url, true) })) },
    });
    setDialog("palette");
  };
  const pickTerminalLinkRef = useRef(pickTerminalLink);
  pickTerminalLinkRef.current = pickTerminalLink;
  const togglePalette = () => setDialog((d) => (d === "palette" ? null : "palette"));
  const paletteRef = useRef(togglePalette);
  paletteRef.current = togglePalette;
  /// Brings up a pinned page in the browser space, opening its tab the first
  /// time, with its text box ready for typing.
  const showPinned = (id: string) => {
    if (!PINNED_PAGES.some((p) => p.id === id)) return;
    focusSoon(id, true);
    ensurePinned(id);
    setSpace("browser");
    setActiveTabId(id);
  };
  // With the in-app terminal chosen, local sessions open in 作業; a run that
  // is no herdr session's runs in its own terminal there (made now, started
  // when first shown).
  const inAppTerminal: InAppTerminal | null =
    terminalTarget === "app"
      ? {
          open: (run, focus = false) => {
            const session = run.session;
            if (!session) return;
            if (!run.herdr) {
              const id = workTabId(session);
              setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, url: "", title: run.title, loading: false, nav: 0, term: run, area: "work", session }]));
              setWorkTerms((m) => ({ ...m, [session]: id }));
            }
            if (focus) openWorkRef.current({ session });
          },
          focus: (sessionId) => {
            openWorkRef.current({ session: sessionId });
            return true;
          },
        }
      : null;
  useEffect(() => void terminalApi.setInApp(terminalTarget === "app").catch((e) => setError(String(e))), [terminalTarget]);
  const openLocalRef = useRef((sessionId: string) => openLocal(inAppTerminal, sessionId, report, true));
  openLocalRef.current = (sessionId) => openLocal(inAppTerminal, sessionId, report, true);
  useEffect(() => {
    const off = listen<{ session_id: string }>(OPEN_LOCAL_EVENT, ({ payload }) => openLocalRef.current(payload.session_id));
    return () => void off.then((f) => f());
  }, []);
  /// Closes a tab of the browser space.
  const closeTab = (id: string) => {
    api.browserClose(id).catch(report);
    // The tab shown next is the one under it in the list (else the one
    // above); with none left, a new tab page. It takes the keyboard only if
    // the page had it.
    const next = nextAfterClose(normalTabs, id);
    setTabs((prev) => prev.filter((t) => t.id !== id));
    if (id !== activeTab?.id) return;
    const typing = typingSideRef.current === "pane";
    if (!next) {
      setNewTab(true);
      if (typing) keysToTab(null, undefined, report);
    } else {
      if (typing) keysToTab(next, undefined, report);
      setActiveTabId(next.id);
    }
  };
  /// ⌘W: closes the tab shown (a pinned page stays), or leaves the new tab
  /// page for the last tab; in 学習, the reading shown. False when ⌘W is not ours.
  const closeShown = () => {
    if (studyReading) {
      if (focusTyping !== "right" && studyLeft) closeStudyTab(studyLeft.id);
      return true;
    }
    if (!browserShown) return false;
    if (activeTab && !activeTab.pinned) closeTab(activeTab.id);
    else if (!activeTab && normalTabs.length > 0) setNewTab(false);
    return true;
  };
  // Places for the keyboard left of the list (⌃h from it): the sidebar
  // (管理's, or 学習's filters), and left of everything the spaces' rail.
  // j k move over their entries, Enter picks one (and goes to it), ⌃l steps
  // back right, Esc goes back to the list.
  const [zone, setZoneState] = useState<Zone | null>(null);
  const zoneRef = useRef(zone);
  zoneRef.current = zone;
  const [zoneCursor, setZoneCursor] = useState(0);
  const zoneCursorRef = useRef(zoneCursor);
  zoneCursorRef.current = zoneCursor;
  const setZone = (z: Zone | null) => {
    zoneRef.current = z;
    setZoneState(z);
    // It starts on what is shown.
    if (z) setZoneCursor(Math.max(0, zoneItems(z).findIndex((el) => el.classList.contains("on"))));
  };
  useEffect(() => {
    for (const z of ZONES) zoneItems(z).forEach((el, i) => el.toggleAttribute("data-cursor", zone === z && i === zoneCursor));
  });
  /// ⌃l gives the typing one side to the right, ⌃h one to the left (from a
  /// page, ⌃h comes back through FOCUS_APP_EVENT), the spaces' rail being
  /// the leftmost. In a split view: the rail, its list, its left page, its
  /// right one, going on `from` the side the key was pressed on (null: the
  /// list); `text` (selected on the left) is typed into the right's box.
  /// Elsewhere: the rail, the sidebar (if the space has one), the list (the
  /// browser's tab list), the page.
  const focusSide = (pane: boolean, from: "left" | "right" | null, text?: string) => {
    const give = (tab: BrowserTab | undefined | null, chat: boolean) => {
      if (!tab) return;
      if (tab.term) focusTerminal(tab.id);
      else giveKeys(tab.id, report, chat, chat ? text : undefined);
    };
    const hasSide = zoneItems("side").length > 0;
    if (zoneRef.current) {
      if (pane) setZone(zoneRef.current === "rail" && hasSide ? "side" : null);
      else setZone("rail");
      return;
    }
    if (splitRef.current) {
      if (!pane && from === null) return setZone("rail");
      if (pane) {
        const to = from === null ? (splitLeft ? "left" : "right") : "right";
        const tab = to === "left" ? splitLeft : splitRight;
        if (!tab) return;
        setFocusTyping(to);
        setTypingSide("pane");
        return give(tab, to === "right" && CHAT_PAGES.includes(tab.id));
      }
      if (from === "right" && splitLeft) {
        setFocusTyping("left");
        return give(splitLeft, false);
      }
      // To the list on the left: nothing focused in it (its rows take j k as
      // they are; a button there, focused, would take Enter).
      setFocusTyping(null);
      setTypingSide("app");
      noteFocusRequest();
      api.focusAppPage().catch(report);
      return void (document.activeElement as HTMLElement | null)?.blur();
    }
    // Left from the list is the sidebar (管理's, 学習's filters), or with none the rail.
    if (!pane) {
      if (typingSideRef.current === "app") setZone(hasSide ? "side" : "rail");
      setTypingSide("app");
      return void (document.activeElement as HTMLElement | null)?.blur();
    }
    if (!browserShown) return;
    // The new tab page: its address field.
    if (!activeTab) return void document.querySelector<HTMLInputElement>(".browser-main input")?.focus();
    setTypingSide("pane");
    give(activeTab, CHAT_PAGES.includes(activeTab.id));
  };
  const focusLeftRef = useRef(splitLeft);
  focusLeftRef.current = splitLeft;
  const focusSideRef = useRef(focusSide);
  focusSideRef.current = focusSide;
  // Which side has the typing, marked on the page: this one, a page (or a
  // terminal), or neither while another app is in front; in a split view,
  // its left or right. The keys moving the typing (⌃h ⌃l, ⌘⇧[ ⌘⇧]) mark it
  // as they move it; a click, or a page taking it, as that happens.
  const [typingSide, setTypingSide] = useState<"app" | "pane" | null>("app");
  /// What had the keyboard in this window when the user last pressed a key or
  /// clicked (before a dialog's own field takes it): a dialog gives it back.
  const lastActive = useRef<Element | null>(null);
  /// Set when a page's key opened the dialog (⌘K in a page): it goes back to the page.
  const dialogFromPage = useRef(false);
  const typingSideRef = useRef(typingSide);
  typingSideRef.current = typingSide;
  useEffect(() => {
    let timer = 0;
    // This page has it: its fields and terminals by where they are (a page's
    // address bar is the page's side). Nothing focused in it leaves the split
    // view's side to the key that is moving the typing.
    // A press on a page's own parts (its tab strip) gives this page the
    // keyboard for a moment, which goes on to the page or terminal shown: the
    // page keeps the mark meanwhile.
    let pressedInPane = false;
    const press = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      pressedInPane = !!t.closest(".browser-tabs, .tab-list") && !t.closest("input");
      // A press anywhere leaves the zone the keys were in (its entry, pressed, still acts).
      if (zoneRef.current) setZone(null);
    };
    const here = () => {
      const el = document.activeElement;
      if (pressedInPane && (!el || el === document.body)) return;
      setTypingSide(el?.closest(".xterm, .browser-main, .focus-left, .focus-right") ? "pane" : "app");
      if (!el || el === document.body) return;
      setFocusTyping(splitSideOf(el));
    };
    // A page took it. What was focused here would come back as this page
    // takes the keyboard on the way to a side (a page's ⌃h ⌃l), marking the
    // side it is on, so it lets go; a click puts the focus back.
    const toPage = () => {
      setTypingSide("pane");
      setZone(null);
      if (!document.hasFocus()) (document.activeElement as HTMLElement | null)?.blur();
    };
    // This page lost it, to a page (which says so in a split view) or to
    // another app (asked once the focus events stop).
    const lost = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (document.hasFocus()) return here();
        api.windowFocused().then((front) => {
          if (document.hasFocus()) return;
          if (front) return toPage();
          setTypingSide(null);
          setFocusTyping(null);
        }, () => {});
      }, FOCUS_SETTLE_MS);
    };
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("focus", here);
    document.addEventListener("focusin", here);
    window.addEventListener("blur", lost);
    document.addEventListener("focusout", lost);
    const offs = [
      listen(WINDOW_FOCUS_EVENT, lost),
      listen<{ tab: string }>(PAGE_FOCUSED_EVENT, ({ payload }) => {
        toPage();
        setFocusTyping(onSplitRightRef.current(payload.tab) ? "right" : "left");
      }),
    ];
    return () => {
      clearTimeout(timer);
      offs.forEach((off) => void off.then((f) => f()));
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("focus", here);
      document.removeEventListener("focusin", here);
      window.removeEventListener("blur", lost);
      document.removeEventListener("focusout", lost);
    };
  }, []);
  // The user's own keys and presses (and the window losing the keyboard to a
  // page or another app) make older wishes for the keyboard stale (focus.ts).
  useEffect(() => {
    const acted = () => {
      userActed();
      lastActive.current = document.activeElement;
    };
    window.addEventListener("keydown", acted, true);
    window.addEventListener("pointerdown", acted, true);
    window.addEventListener("blur", acted);
    return () => {
      window.removeEventListener("keydown", acted, true);
      window.removeEventListener("pointerdown", acted, true);
      window.removeEventListener("blur", acted);
    };
  }, []);
  // The browser space's tabs are kept across restarts: their pages (not the
  // pages' state), the pinned pages' too.
  const savedTabsJson = JSON.stringify({
    tabs: paneTabs.map((t): SavedTabs["tabs"][number] => ({ url: t.url, openedFor: t.openedFor, title: t.title, pinned: t.pinned ? t.id : undefined })),
    active: paneTabs.findIndex((t) => t.id === activeTab?.id),
  });
  useEffect(() => remember(PANE_TABS_KEY, savedTabsJson), [savedTabsJson]);
  const closeShownRef = useRef(closeShown);
  closeShownRef.current = closeShown;
  /// ⌘⇧A: archives the cloud session the browser's tab is on and closes the
  /// tab. False when the tab shows no cloud session.
  const archiveShown = () => {
    const id = browserShown && activeTab ? cloudIdOfPage(activeTab.url) : null;
    if (!id || !activeTab) return false;
    if (!activeTab.pinned) closeTab(activeTab.id);
    api.archiveSessions([id]).then(refresh, report);
    return true;
  };
  const archiveShownRef = useRef(archiveShown);
  archiveShownRef.current = archiveShown;
  /// ⌘R while a page has the typing (its address bar, the tab list): the page shown is reloaded.
  const reloadShown = () => {
    const tab = browserShown ? activeTab : focusTyping === "right" ? splitRight : splitLeft;
    if (tab && !tab.term) api.browserGo(tab.id, "reload").catch(report);
  };
  const reloadShownRef = useRef(reloadShown);
  reloadShownRef.current = reloadShown;
  // Pages report where they went and what they are called; links they open in
  // a new window arrive as new tabs.
  /// A tab moved on its own; the address bar follows without navigating it again.
  const setTabUrl = (id: string, url: string) => setTabs((prev) => prev.map((t) => (t.id === id && t.url !== url ? { ...t, url } : t)));
  const openRef = useRef(openInBrowser);
  openRef.current = openInBrowser;
  const studyReadingRef = useRef(studyReading);
  studyReadingRef.current = studyReading;
  /// Web pages macOS asked the app to open (a Raycast quicklink set to open
  /// with Shosai): a tab in ブラウザ (the one with the page, if any), or while
  /// reading in 学習 a new tab on the left, as a page's new window is.
  const takeOpened = () =>
    api.takeOpened().then((urls) => {
      for (const url of urls) {
        if (studyReadingRef.current) addStudyPageRef.current(url, false);
        else openRef.current(url, true);
      }
    }, report);
  const openFromPageRef = useRef(openFromPage);
  openFromPageRef.current = openFromPage;
  const addStudyPageRef = useRef(addStudyPage);
  addStudyPageRef.current = addStudyPage;
  // A page's download, dialog (alert, confirm, prompt) and ask for the microphone or camera.
  const [downloaded, setDownloadedState] = useState<{ path: string; name: string } | null>(null);
  const setDownloaded = (d: { path: string; name: string }) => {
    setDownloadedState(d);
    setTimeout(() => setDownloadedState((now) => (now === d ? null : now)), DOWNLOADED_MS);
  };
  const [pageDialog, setPageDialog] = useState<PageDialogAsk | null>(null);
  const answerPageDialog = (ok: boolean, text?: string) => {
    if (!pageDialog) return;
    api.answerPageDialog(pageDialog.id, ok, text).catch(report);
    setPageDialog(null);
  };
  const [siteAsk, setSiteAsk] = useState<SiteAsk | null>(null);
  const answerSite = (allow: boolean) => {
    if (!siteAsk) return;
    api.answerSitePermission(siteAsk.id, siteAsk.site, allow).catch(report);
    setSiteAsk(null);
  };
  /// "開く" on a Cloud session: its page in 作業, or Claude Desktop (as set).
  const openCloud = (sessionId: string) => {
    api.markSessionSeen(sessionId).catch(report);
    return cloudTarget === "desktop" ? api.openSession(sessionId, "desktop").catch(report) : openWork({ session: sessionId });
  };
  /// Starts a todo's session behind (StartTodo): nothing moves; it shows in 作業.
  const startTodo: StartTodo = async (todoId, plan, launch) => {
    const e = effectiveLaunch(launch, plan);
    const options: StartOptions = { plan, agent: e.agent, ...(e.agent === "claude" ? { model: e.model || undefined, effort: e.effort || undefined } : {}) };
    if (e.runner === "cloud") await api.startCloud(todoId, options);
    else if (inAppTerminal) inAppTerminal.open(await terminalApi.start(todoId, options));
    else await api.startTerminal(todoId, options);
  };
  /// 「再開して直させる」: the todo's session is sent what to fix in its PR,
  /// without the keyboard or the screen moving. A Cloud session cannot be
  /// sent anything from here yet: its page opens in 作業 with the request typed in.
  const fixInSession: FixInSession = (s, todo) =>
    run(async () => {
      const r = await api.fixInSession(s.session_id, todo.id);
      if (r.sent) return showToast(`#${todo.id} のセッションに、直すように送りました`);
      api.markSessionSeen(s.session_id).catch(report);
      ensureWorkTab(s);
      openWork({ session: s.session_id });
      focusSoon(workTabId(s.session_id), true, r.prompt);
    });
  // Reviews that went in (REVIEW_SUBMITTED_EVENT), for the PR page until the
  // PRs are taken again; each is told in a toast.
  const [submittedReviews, setSubmittedReviews] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const off = listen<{ url: string; title: string; verdict: string }>(REVIEW_SUBMITTED_EVENT, ({ payload }) => {
      setSubmittedReviews((prev) => new Map(prev).set(payload.url, payload.verdict));
      showToastRef.current(`${prRef(payload.url).split("/").pop()} にレビューを提出しました（${REVIEW_VERDICT[payload.verdict] ?? payload.verdict}）`);
    });
    return () => void off.then((f) => f());
  }, []);
  const submittedRef = useRef(submittedReviews);
  submittedRef.current = submittedReviews;
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const openCloudRef = useRef(openCloud);
  openCloudRef.current = openCloud;
  useEffect(() => {
    const offs = [
      listen<{ tab: string; url: string; loading: boolean }>(BROWSER_URL_EVENT, ({ payload }) => {
        // A tab made with a wish for the keyboard takes it as its page comes, with the app's keys (TabView).
        const wish = payload.loading ? takeFocusWish(payload.tab) : null;
        if (wish) api.browserFocus(payload.tab, wish.input || undefined, wish.text).catch(report);
        // A new page starts in its own words (one translated before says so as it loads).
        if (payload.loading) setTabs((prev) => prev.map((t) => (t.id === payload.tab && t.translated ? { ...t, translated: false } : t)));
        // A page loaded is a visit, for the address field's suggestions.
        if (!payload.loading) {
          tabUrls.set(payload.tab, payload.url);
          recordVisit(payload.url, null, true);
        }
        setTabs((prev) => prev.map((t) => (t.id === payload.tab ? { ...t, url: payload.url, loading: payload.loading } : t)));
      }),
      listen<{ tab: string; url: string }>(BROWSER_ADDRESS_EVENT, ({ payload }) => setTabUrl(payload.tab, payload.url)),
      listen<{ tab: string; on: boolean }>(BROWSER_TRANSLATED_EVENT, ({ payload }) =>
        setTabs((prev) => prev.map((t) => (t.id === payload.tab ? { ...t, translated: payload.on } : t))),
      ),
      listen<{ tab: string; zoom: number }>(BROWSER_ZOOM_EVENT, ({ payload }) =>
        setTabs((prev) => prev.map((t) => (t.id === payload.tab ? { ...t, zoom: payload.zoom } : t))),
      ),
      listen<{ tab: string; title: string }>(BROWSER_TITLE_EVENT, ({ payload }) => {
        const url = tabUrls.get(payload.tab);
        if (url) recordVisit(url, payload.title, false);
        setTabs((prev) => prev.map((t) => (t.id === payload.tab ? { ...t, title: payload.title } : t)));
      }),
      // A reading's page's new window is a tab among 学習's left; any other page's, the browser space's.
      listen<{ url: string; tab: string; behind: boolean }>(BROWSER_NEW_TAB_EVENT, ({ payload }) =>
        spaceRef.current === "study" && payload.tab.match(/^[rf]\d/) ? addStudyPageRef.current(payload.url, payload.behind) : openFromPageRef.current(payload.url, payload.tab, payload.behind),
      ),
      // A notification's PR: opened by the user, so it takes the keyboard.
      listen<{ url: string }>(OPEN_URL_EVENT, ({ payload }) => openRef.current(payload.url, true)),
      listen(OPENED_EVENT, () => takeOpened()),
      listen(OPEN_NEW_TODO_EVENT, () => {
        dialogFromPage.current = true;
        setDialog("add");
      }),
      listen<{ path: string; name: string }>(BROWSER_DOWNLOADED_EVENT, ({ payload }) => setDownloaded(payload)),
      listen<PageDialogAsk>(PAGE_DIALOG_EVENT, ({ payload }) => setPageDialog(payload)),
      listen<SiteAsk>(SITE_PERMISSION_EVENT, ({ payload }) => setSiteAsk(payload)),
      // A page kept itself to read: said at the bottom.
      listen<{ title: string; kind: ReadingKind; chapters: number }>(READING_ADDED_EVENT, ({ payload }) =>
        showToastRef.current(payload.kind === "book" ? `本として読みものに入れました（目次 ${payload.chapters} 章）：${payload.title}` : `読みものに入れました：${payload.title}`),
      ),
      listen<{ space: Space }>(SPACE_EVENT, ({ payload }) => goSpaceRef.current(payload.space)),
      listen(BROWSER_OPEN_NEW_TAB_EVENT, () => openNewTab()),
      listen<{ tab: string; delta: number }>(BROWSER_SWITCH_TAB_EVENT, ({ payload }) =>
        splitRef.current ? switchSplitTabRef.current(onSplitRightRef.current(payload.tab), payload.delta) : switchRef.current(payload.delta),
      ),
      listen<{ tab: string }>(BROWSER_CLOSE_TAB_EVENT, ({ payload }) => !(splitRef.current && onSplitRightRef.current(payload.tab)) && closeShownRef.current()),
      listen<{ tab: string }>(BROWSER_ARCHIVE_EVENT, () => archiveShownRef.current()),
      listen(OPEN_PALETTE_EVENT, () => {
        dialogFromPage.current = true;
        paletteRef.current();
      }),
      listen(OPEN_SESSIONS_EVENT, () => {
        dialogFromPage.current = true;
        openSessionsRef.current();
      }),
      listen<{ id: number }>(OPEN_TODO_EVENT, ({ payload }) => goTodoRef.current(payload.id)),
      listen<{ channel: string; ts: string }>(OPEN_SLACK_EVENT, ({ payload }) => {
        setSlackPick(mentionKey(payload));
        setViewRef.current("slack");
      }),
      listen<{ tab: string; text: string | null }>(FOCUS_PANE_EVENT, ({ payload }) => focusSideRef.current(true, onSplitRightRef.current(payload.tab) ? "right" : "left", payload.text ?? undefined)),
      // Back from a page: nothing on this side keeps the typing, so j k work.
      listen<{ tab: string }>(FOCUS_APP_EVENT, ({ payload }) => (splitRef.current ? focusSideRef.current(false, onSplitRightRef.current(payload.tab) ? "right" : "left") : (document.activeElement as HTMLElement | null)?.blur())),
      // Notifications open cloud sessions as set here.
      listen<{ session_id: string }>(OPEN_CLOUD_EVENT, ({ payload }) => openCloudRef.current(payload.session_id)),
    ];
    // What macOS asked to open before the page was up (the app launched for it).
    void Promise.all(offs).then(takeOpened);
    return () => offs.forEach((off) => off.then((f) => f()));
  }, []);
  const [dragging, setDragging] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  // The new todo dialog's memo from a Slack message, until the dialog closes.
  const [addMemo, setAddMemo] = useState<string | undefined>();
  useEffect(() => {
    if (dialog !== "add") setAddMemo(undefined);
  }, [dialog]);
  // The Slack message a notification's click shows.
  const [slackPick, setSlackPick] = useState<string | null>(null);
  // ⌘K opens on its own list again.
  useEffect(() => {
    if (dialog !== "palette") setPaletteStart(null);
  }, [dialog]);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  // Closing a dialog (⌘K among them) gives the keyboard back to where it was
  // before, unless what was done in it sent the keyboard somewhere.
  const beforeDialog = useRef<{ side: "app" | "pane" | null; el: HTMLElement | null; tab: BrowserTab | null; requests: number } | null>(null);
  const dialogUp = dialog !== null || pageDialog !== null;
  useEffect(() => {
    if (dialogUp) {
      if (!beforeDialog.current) {
        const fromPage = dialogFromPage.current || pageDialog !== null;
        const el = lastActive.current;
        beforeDialog.current = {
          side: fromPage ? "pane" : typingSideRef.current,
          // Only a field that had the keyboard (on the page's body, the keys work as they are).
          el: !fromPage && el instanceof HTMLElement && el !== document.body && !el.closest(".modal-backdrop") ? el : null,
          tab: activeTab,
          requests: focusRequestCount(),
        };
      }
      dialogFromPage.current = false;
      return;
    }
    const before = beforeDialog.current;
    beforeDialog.current = null;
    dialogFromPage.current = false;
    if (!before || before.requests !== focusRequestCount()) return;
    if (before.side === "pane" && before.tab && browserShown) {
      if (before.tab.term) focusTerminal(before.tab.id);
      else giveKeys(before.tab.id, report);
    } else if (before.side === "app") {
      if (before.el?.isConnected) before.el.focus();
      else (document.activeElement as HTMLElement | null)?.blur();
    }
  }, [dialogUp]); // eslint-disable-line react-hooks/exhaustive-deps
  const [view, setViewState] = useState<View>(loadView);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [layout, setLayoutState] = useState<Layout>(() => load(LAYOUT_KEY, ["board", "list"] as const, "board"));
  const [groupBy, setGroupByState] = useState<GroupBy>(() => load(GROUP_KEY, ["repo", "parent"] as const, "repo"));
  const [foldedByHand, setFoldedByHand] = useState<Set<Status>>(() => new Set(loadJson<Status[]>(FOLDED_COLUMNS_KEY, FOLDED_BY_DEFAULT_COLUMNS)));
  // The kanban's and the list's filters, kept across launches, and the saved ones.
  const [todoFilters, setTodoFiltersState] = useState<Record<Layout, TodoFilter>>(() => {
    const saved = loadJson<Partial<Record<Layout, Partial<TodoFilter>>>>(TODO_FILTERS_KEY, {});
    return { board: { ...NO_FILTER, ...saved.board }, list: { ...NO_FILTER, ...saved.list } };
  });
  const todoFilter = todoFilters[layout];
  const [filterVersion, setFilterVersion] = useState(0);
  const setTodoFilter = (f: TodoFilter, fromOutside = false, on: Layout = layout) => {
    const next = { ...todoFilters, [on]: f };
    remember(TODO_FILTERS_KEY, JSON.stringify(next));
    setTodoFiltersState(next);
    if (fromOutside) setFilterVersion((v) => v + 1);
  };
  const [savedFilters, setSavedFiltersState] = useState<SavedFilter[]>(() =>
    // Ones saved before filters had a page open on the kanban.
    loadJson<SavedFilter[]>(SAVED_FILTERS_KEY, []).map((f) => ({ ...f, layout: f.layout ?? "board" })),
  );
  const setSavedFilters = (list: SavedFilter[]) => {
    remember(SAVED_FILTERS_KEY, JSON.stringify(list));
    setSavedFiltersState(list);
  };
  const saveFilter = (name: string) => setSavedFilters([...savedFilters.filter((f) => f.name !== name), { id: `f${Date.now()}`, name, filter: todoFilter, layout }]);
  const applyFilter = (f: SavedFilter) => {
    setTodoFilter(f.filter, true, f.layout);
    showTodos(f.layout);
  };
  const [local, setLocal] = useState<LocalRepo[]>([]);
  // The checkouts are looked for at launch, and again (a clone made since)
  // when the window comes back or the new todo dialog opens.
  const localAt = useRef(0);
  const loadLocal = useCallback((now = false) => {
    if (!now && Date.now() - localAt.current < LOCAL_REPOS_REFRESH_MS) return;
    localAt.current = Date.now();
    api.localRepos().then(setLocal, () => setLocal([]));
  }, []);
  useEffect(() => {
    const off = listen(WINDOW_FOCUS_EVENT, () => loadLocal());
    return () => void off.then((f) => f());
  }, [loadLocal]);
  useEffect(() => {
    if (dialog === "add") loadLocal(true);
  }, [dialog, loadLocal]);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [limits, setLimits] = useState<Limit[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  // What is left of Jev's credit as read off TypeSafe's console (設定).
  const jevLeft = board?.jev_spend.credit?.left ?? null;
  const [prs, setPrs] = useState<PrLists | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } }));

  /// 管理's page `v` (管理 comes up with it).
  const setView = (v: View) => {
    remember(VIEW_KEY, v);
    setViewState(v);
    setSpace("manage");
  };
  const setLayout = (v: Layout) => {
    remember(LAYOUT_KEY, v);
    setLayoutState(v);
  };
  /// The Todo page as a kanban or a list, the two entries in the sidebar.
  const showTodos = (v: Layout) => {
    setView("todos");
    setLayout(v);
  };
  const setGroupBy = (v: GroupBy) => {
    remember(GROUP_KEY, v);
    setGroupByState(v);
  };
  /// A column's head (or a list's folded line): a status left out by the
  /// filter comes back into it, else it folds or opens by hand.
  const toggleColumn = (st: Status) => {
    if (todoFilter.statuses.length > 0 && !todoFilter.statuses.includes(st)) return setTodoFilter({ ...todoFilter, statuses: [...todoFilter.statuses, st] });
    const next = new Set(foldedByHand);
    if (next.has(st)) next.delete(st);
    else next.add(st);
    remember(FOLDED_COLUMNS_KEY, JSON.stringify([...next]));
    setFoldedByHand(next);
  };
  const toggleLane = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      remember(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });

  const report = useCallback((e: unknown) => setError(String(e)), []);
  // herdr session for new workspaces; the backend keeps it while the app runs.
  const [herdr, setHerdr] = useState<HerdrSessions | null>(null);
  const loadHerdr = useCallback(() => {
    api.herdrSessions().then(setHerdr, report);
  }, [report]);
  const pickHerdr = (name: string) => {
    remember(HERDR_SESSION_KEY, name);
    api.setHerdrSession(name || null).then(loadHerdr, report);
  };
  useEffect(() => {
    let saved = "";
    try {
      saved = localStorage.getItem(HERDR_SESSION_KEY) ?? "";
    } catch {
      // ignore
    }
    api.setHerdrSession(saved || null).then(loadHerdr, report);
  }, [loadHerdr, report]);
  // The board comes back every few seconds, mostly unchanged; re-render only on a change.
  const lastBoard = useRef("");
  const refresh = useCallback(() => {
    api.board().then((b) => {
      const json = JSON.stringify(b);
      if (json === lastBoard.current) return;
      lastBoard.current = json;
      setBoard(b);
    }, report);
  }, [report]);
  // The todo's sheet keeps the width it was given before the side panels went.
  const [panelW] = useState(() => loadJson<number>(PANEL_W_KEY, PANEL_DEFAULT_W));
  const [focusRightW, setFocusRightWState] = useState(() => loadJson<number>(FOCUS_RIGHT_W_KEY, Math.max(DOCK_MIN_W, Math.round(window.innerWidth * FOCUS_RIGHT_SHARE))));
  const setFocusRightW = (w: number) => {
    remember(FOCUS_RIGHT_W_KEY, String(w));
    setFocusRightWState(w);
  };
  const [tabListW, setTabListWState] = useState(() => loadJson<number>(TAB_LIST_W_KEY, TAB_LIST_DEFAULT_W));
  const setTabListW = (w: number) => {
    remember(TAB_LIST_W_KEY, String(w));
    setTabListWState(w);
  };
  const [railW, setRailWState] = useState(() => loadJson<number>(WORK_RAIL_W_KEY, WORK_RAIL_DEFAULT_W));
  const setRailW = (w: number) => {
    remember(WORK_RAIL_W_KEY, String(w));
    setRailWState(w);
  };
  const [prsLoading, setPrsLoading] = useState(false);
  const loadPrs = useCallback(() => {
    prsLoadedAt.current = Date.now();
    setPrsLoading(true);
    // The PRs taken show the reviews that went in before this began (a PR
    // asked again is to be reviewed again); one that goes in meanwhile stays.
    const known = submittedRef.current;
    api
      .ghPrs()
      .then(
        (p) => (setPrs(p), setPrError(null), setSubmittedReviews((cur) => new Map([...cur].filter(([url]) => !known.has(url))))),
        (e) => setPrError(String(e)),
      )
      .finally(() => setPrsLoading(false));
  }, []);

  // At launch the app's page takes the keyboard, so its keys work before any click
  // (the window alone being in front leaves the keys with no one).
  useEffect(() => {
    api.focusAppPage().catch(report);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    refresh();
    loadLocal(true);
    const t = setInterval(() => pageVisible() && refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);
  useOnVisible(refresh);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let got = false;
    const load = () =>
      api
        .usage()
        .then(
          (l) => ((got = true), setLimits(l), setUsageError(null)),
          (e) => setUsageError(String(e)),
        )
        .finally(() => (timer = setTimeout(tick, got ? USAGE_REFRESH_MS : USAGE_RETRY_MS)));
    // While hidden it only waits; the next tick on screen asks again.
    const tick = () => (pageVisible() ? load() : (timer = setTimeout(tick, USAGE_RETRY_MS)));
    load();
    return () => clearTimeout(timer);
  }, []);

  const prsLoadedAt = useRef(0);
  const loadPrsIfStale = () => Date.now() - prsLoadedAt.current >= PR_REFRESH_MS && loadPrs();
  useEffect(() => {
    loadPrs();
    const t = setInterval(() => pageVisible() && loadPrsIfStale(), PR_REFRESH_MS);
    return () => clearInterval(t);
  }, [loadPrs]); // eslint-disable-line react-hooks/exhaustive-deps
  useOnVisible(loadPrsIfStale);

  // Coming back to the window is when fresh GitHub and cloud state matters.
  useEffect(() => {
    const onFocus = () => api.syncNow().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // The app's shortcuts from anywhere (keymap.ts: ⌘N a todo, ⌘K the commands,
  // ⌘T ⌘W a browser tab, ⌘⇧[ ⌘⇧] switch tabs, ⌃h ⌃l the typing's side, …).
  // A page's come through its script's events; the terminal leaves the
  // sides' keys to this.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘⇧L in a terminal: the links it shows, to pick one.
      const terminal = matches(e, "terminalLinks") ? (e.target as HTMLElement).closest<HTMLElement>("[data-terminal]")?.dataset.terminal : undefined;
      if (terminal) {
        e.preventDefault();
        pickTerminalLinkRef.current(terminal);
        return;
      }
      if (matches(e, "sessions")) {
        e.preventDefault();
        openSessionsRef.current();
        return;
      }
      if (matches(e, "sideApp") || matches(e, "sidePane")) {
        e.preventDefault();
        // A selection in a split view's terminal goes along to the right.
        const inTerminal = (e.target as HTMLElement).closest(".xterm");
        focusSideRef.current(matches(e, "sidePane"), splitSideOf(e.target as HTMLElement), inTerminal && focusLeftRef.current ? terminalSelection(focusLeftRef.current.id) : undefined);
        return;
      }
      const z = zoneRef.current;
      if (z && !e.metaKey && (!e.ctrlKey || stepOf(e))) {
        // A zone's keys are its own (picking an entry re-renders at once,
        // and the pages' keys must not take the same Enter after it).
        e.stopImmediatePropagation();
        const step = stepOf(e);
        if (step) {
          e.preventDefault();
          setZoneCursor((i) => Math.min(Math.max(i + step, 0), zoneItems(z).length - 1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          // Picks the entry and goes over to what it shows.
          zoneItems(z)[zoneCursorRef.current]?.click();
          setZone(null);
        } else if (e.key === "Escape") setZone(null);
        return;
      }
      // ⌘1–⌘4: the spaces.
      const toSpace = SPACE_ACTIONS.find(([action]) => matches(e, action));
      if (toSpace) {
        e.preventDefault();
        return goSpaceRef.current(toSpace[1]);
      }
      const t = e.target as HTMLElement;
      // A split view: ⌘⇧[ ⌘⇧] go through the tabs of the side that has the
      // typing; ⌘T opens a tab of the browser space.
      if (splitRef.current && (matches(e, "prevTab") || matches(e, "nextTab"))) {
        e.preventDefault();
        return switchSplitTabRef.current(!!t.closest(".focus-right"), matches(e, "prevTab") ? -1 : 1);
      }
      // The browser space's tabs move only while a page has the typing (as
      // marked); on 管理's Todo page these keys go through the lanes (todoKeys.ts).
      if ((matches(e, "prevTab") || matches(e, "nextTab")) && typingSideRef.current !== "pane" && !t.closest(".tab-list, .browser-main")) return;
      const run: [Action, () => unknown][] = [
        // The browser's page, while it has the typing (in 作業's list ⌘⇧A puts its row away).
        ["archive", () => typingSideRef.current === "pane" && archiveShownRef.current()],
        ["bookmark", () => bookmarkShownRef.current()],
        ["prevTab", () => switchRef.current(-1)],
        ["nextTab", () => switchRef.current(1)],
        ["newTodo", () => setDialog("add")],
        // Again closes the commands.
        ["palette", () => setDialog((d) => (d === "palette" ? null : "palette"))],
        ["newTab", () => openNewTab()],
        ["closeTab", () => closeShownRef.current()],
        // The side with the typing: this one takes its data again, a page
        // reloads (a page with the keyboard reloads itself).
        ["reload", () => (typingSideRef.current === "pane" || t.closest(".tab-list, .browser-main") ? reloadShownRef.current() : reloadRef.current())],
      ];
      const hit = run.find(([action]) => matches(e, action));
      if (hit) {
        e.preventDefault();
        hit[1]();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = (f: () => Promise<unknown>) => {
    setError(null);
    f().then(refresh, report);
  };

  // Moving a todo with an open issue to Done offers to close the issue too.
  const [closePrompt, setClosePrompt] = useState<Todo | null>(null);
  const setStatus = (todo: Todo, status: Status) => {
    run(() => api.updateTodo(todo.id, { status }));
    if (status === "done" && todo.issue_url?.includes("/issues/") && todo.issue_state !== "closed") setClosePrompt(todo);
  };

  const allTodos = board?.todos ?? [];
  const selectedTodo = selection?.kind === "todo" ? allTodos.find((t) => t.id === selection.id) ?? null : null;

  // "+ 新規" in a lane: a todo there with that status, a subtask when the lane is a parent's.
  const addTodoIn = (lane: Lane, status: Status, title: string) =>
    run(async () => {
      const repos = lane.parent ? (lane.parent.repos.length === 1 && !lane.parent.repos_derived ? lane.parent.repos : []) : lane.repo && lane.repo !== NO_REPO_LANE ? [lane.repo] : [];
      const cwd = repos.length === 1 ? local.find((r) => r.key === repos[0])?.path : undefined;
      const todo = await api.createTodo({ title, repos, cwd, parent_id: lane.parent?.id });
      if (status !== "todo") await api.updateTodo(todo.id, { status });
      if (openDb) await api.setTodoDatabase(todo.id, openDb.id);
    });

  const onDragStart = ({ active }: DragStartEvent) => setDragging(Number(String(active.id).split(":")[1]));
  const onDragEnd = ({ over }: DragEndEvent) => {
    const id = dragging;
    setDragging(null);
    if (!over || id === null) return;
    const status = String(over.id).split(":")[1] as Status;
    const todo = allTodos.find((t) => t.id === id);
    if (todo && todo.status !== status) setStatus(todo, status);
  };

  // Subtasks of a Done parent are finished business; the parent stands for them.
  const doneParents = new Set(allTodos.filter((t) => t.status === "done").map((t) => t.id));
  const shownTodos = allTodos.filter((t) => t.parent_id === null || !doneParents.has(t.parent_id));
  const visibleTodos = shownTodos.filter((t) => matchesFilter(t, todoFilter));
  const foldedCols = foldedStatuses(foldedByHand, todoFilter);
  // The Doing page is the Todo page's list of the Doing todos alone, its
  // filter and folds left to the Todo page.
  const doingView = view === "doing";
  // A database's page is the Todo page's, of the todos in it alone.
  const databases = board?.databases ?? [];
  const openDbId = dbOfView(view);
  const openDb = databases.find((d) => d.id === openDbId) ?? null;
  const todoView = view === "todos" || doingView || openDbId !== null;
  const databaseOf = (todoId: number) => databases.find((d) => d.todos.includes(todoId));
  /// The database dialog's: one to rename, or null for a new one.
  const [renamingDb, setRenamingDb] = useState<Database | null>(null);
  const askDatabase = (d: Database | null) => {
    setRenamingDb(d);
    setDialog("database");
  };
  const [deletingDb, setDeletingDb] = useState(false);
  useEffect(() => setDeletingDb(false), [openDbId]);
  /// Its todos stay, in no database; its page, shown, gives way to the Todo page.
  const deleteDatabase = (d: Database) => {
    if (openDbId === d.id) {
      remember(VIEW_KEY, "todos");
      setViewState("todos");
    }
    run(() => api.deleteDatabase(d.id));
  };
  const doingTodos = shownTodos.filter((t) => t.status === "doing");
  // (A database just made has none until the board has it.)
  const pageTodos = doingView ? doingTodos : openDbId !== null ? visibleTodos.filter((t) => openDb?.todos.includes(t.id)) : visibleTodos;
  const pageLayout: Layout = doingView ? "list" : layout;
  const pageFolded = doingView ? new Set<Status>() : foldedCols;
  // A Done parent without shown subtasks is a card like any other.
  const lanes = buildLanes(pageTodos, groupBy, shownTodos);
  const repoLanes = buildLanes(shownTodos, "repo", shownTodos);
  // Free group names in use, offered beside repositories when picking.
  const groups = [...new Set(allTodos.flatMap((t) => t.repos).filter((r) => !isGithubRepo(r)))].sort();
  const allSessions = [...allTodos.flatMap(liveSessions), ...(board?.inbox ?? []).filter((s) => s.state !== "ended")];
  /// A terminal's title: the session it shows, as the session list names it.
  const sessionTitle = (id: string) => (board ? (sessionItemsOf(board).find((i) => i.session.session_id === id)?.session.title ?? null) : null);
  // A session shown in 作業 (the app in front) is looked at.
  const watchedSession = space === "work" && typingSide !== null ? ((focusTyping === "right" ? workView.right : workView.left)?.session_id ?? null) : null;
  const watchedUnread = !!watchedSession && allSessions.some((s) => s.session_id === watchedSession && s.unread);
  useEffect(() => {
    if (watchedSession && watchedUnread && pageVisible()) api.markSessionSeen(watchedSession).then(refresh, report);
  }, [watchedSession, watchedUnread]); // eslint-disable-line react-hooks/exhaustive-deps
  // A session gone from the board (archived, put away) takes its page or terminal in 作業 with it.
  useEffect(() => {
    if (!board) return;
    const known = new Set(sessionItemsOf(board).map((i) => i.session.session_id));
    const gone = tabs.filter((t) => t.area === "work" && t.session && !known.has(t.session));
    if (gone.length === 0) return;
    for (const t of gone) (t.term ? closeTerminal(t.id) : api.browserClose(t.id).catch(report));
    setTabs((prev) => prev.filter((t) => !gone.includes(t)));
  }, [board]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = waitingOnYou({ todos: allTodos, inbox: board?.inbox ?? [], reviews: prs?.review ?? [], now: Date.now() / 1000 });
  waitingKeys.current = waiting.map((w) => w.key);
  /// あなた待ち: 作業, whose list has it at the top.
  const showWaiting = () => goSpace("work");
  const openTodoCount = allTodos.filter((t) => t.status !== "done").length;
  const colCounts = Object.fromEntries(COLUMNS.map((c) => [c.status, pageTodos.filter((t) => t.status === c.status).length])) as Record<Status, number>;

  const openTodo = (id: number) => {
    setSelection({ kind: "todo", id });
    // The panel shows issue and PR state; fetch this todo's now.
    api.syncNow(id).catch(() => {});
  };
  const goTodo = (id: number) => {
    setView(view === "doing" ? "doing" : "todos");
    openTodo(id);
  };
  const goTodoRef = useRef(goTodo);
  goTodoRef.current = goTodo;
  const setViewRef = useRef(setView);
  setViewRef.current = setView;
  const [syncing, setSyncing] = useState(false);
  const syncAll = () => {
    setSyncing(true);
    run(() => api.syncNow());
    loadPrs();
    // The syncs run in the background; the board refresh shows their results.
    setTimeout(() => setSyncing(false), REFRESH_MS);
  };
  /// ⌘R: the PR page takes the PRs again (its ↻), other pages sync everything.
  const reload = () => (space === "manage" && view === "prs" ? loadPrs() : syncAll());
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  /// ⌘1–⌘4 and the bar: a space, the keyboard on what it shows (its page,
  /// its session, its list).
  const goSpace = (s: Space) => {
    setSpace(s);
    setZone(null);
    const tab = s === "browser" ? (activeTab ?? null) : s === "work" ? workTab(workView.left) : s === "study" && study.view === "read" ? studyLeft : undefined;
    if (tab !== undefined) {
      setFocusTyping(tab ? "left" : null);
      return keysToTab(tab, undefined, report);
    }
    setFocusTyping(null);
    noteFocusRequest();
    api.focusAppPage().catch(report);
    (document.activeElement as HTMLElement | null)?.blur();
  };
  const goSpaceRef = useRef(goSpace);
  goSpaceRef.current = goSpace;

  const covered = dialog !== null || pageDialog !== null;
  // j k / h l and the other keys of the Todo pages (todoKeys.ts).
  const todoPage = useRef<HTMLDivElement>(null);
  const [statusMenuFor, setStatusMenuFor] = useState<number | null>(null);
  const statusMenuTodo = statusMenuFor !== null ? allTodos.find((t) => t.id === statusMenuFor) : undefined;
  const { setCursor: setTodoCursor } = useTodoKeys(todoPage, pageLayout, space === "manage" && todoView && !covered && zone === null, selectedTodo !== null, {
    open: (id) => openTodo(id),
    select: openTodo,
    status: setStatusMenuFor,
    link: (id) => {
      const todo = allTodos.find((t) => t.id === id);
      const url = todo?.pr_url ?? todo?.issue_url;
      if (url) openInBrowser(url);
    },
    help: () => setDialog("keys"),
    parent: (id) => {
      const parent = allTodos.find((t) => t.id === id)?.parent_id;
      if (parent != null) openTodo(parent);
    },
    shift: (id, delta) => {
      const todo = allTodos.find((t) => t.id === id);
      const next = todo && COLUMNS[COLUMNS.findIndex((c) => c.status === todo.status) + delta];
      if (todo && next) setStatus(todo, next.status);
    },
    // A todo with sessions: 作業 at it; without, the launch sheet.
    work: (id) => {
      const todo = allTodos.find((t) => t.id === id);
      if (todo && (todo.sessions.length > 0 || allTodos.some((c) => c.parent_id === id && c.sessions.length > 0))) return openWork({ todo: id });
      openTodo(id);
      setDialog("start");
    },
    // Over the todo's sheet.
    start: (id) => {
      openTodo(id);
      setDialog("start");
    },
    close: () => setSelection(null),
    toggleLane,
    isCollapsed: (lane) => collapsed.has(lane),
  });
  // The keys act on the todo the sheet shows, however it was opened.
  useEffect(() => {
    if (selection?.kind === "todo") setTodoCursor(`todo:${selection.id}`);
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps
  const draggedTodo = dragging !== null ? allTodos.find((t) => t.id === dragging) : undefined;
  // Review requests no review session has taken yet.
  const reviewCount = waiting.filter((w) => w.reasons.includes("review")).length;
  // One per thread, as the Slack page's rows.
  const slackUnread = board?.slack.connected ? slackItems(board.slack.messages, board.slack.threads).filter((i) => !i.read).length : 0;

  // 管理's sidebar lists the objects only, each with what of it waits on the
  // user (or how many there are); how a list shows is chosen on its page.
  const nav: { key: string; group: NavGroup; label: string; icon: IconName; badge?: React.ReactNode; count?: number; on: boolean; go: () => void }[] = [
    { key: "todos", group: "仕事", label: "Todo", icon: "board", count: openTodoCount, on: view === "todos" || doingView, go: () => setView(doingView ? view : "todos") },
    { key: "prs", group: "仕事", label: "PR", icon: "pr", on: view === "prs", go: () => setView("prs"), badge: reviewCount > 0 && <span className="pill accent" title="まだレビューを始めていないレビュー依頼">レビュー {reviewCount}</span> },
    { key: "artifacts", group: "仕事", label: "成果物", icon: "open", count: board?.artifacts.length, on: view === "artifacts", go: () => setView("artifacts") },
    ...databases.map((d) => ({
      key: `db:${d.id}`,
      group: "DB" as const,
      label: d.name,
      icon: "list" as const,
      count: d.todos.filter((id) => allTodos.find((t) => t.id === id)?.status !== "done").length,
      on: openDbId === d.id,
      go: () => setView(dbView(d.id)),
    })),
    { key: "db:new", group: "DB", label: "新しい DB", icon: "plus", on: false, go: () => askDatabase(null) },
    {
      key: "slack",
      group: "連絡",
      label: "Slack",
      icon: "chat",
      on: view === "slack",
      go: () => setView("slack"),
      badge: slackUnread > 0 && <span className="pill accent" title="未読のスレッド（メンションか新しい返信があるもの）">{slackUnread}</span>,
    },
  ];

  /// Puts tab `id` where tab `to` is (dragged in the tab list, or ⌘K's "動かす").
  const moveTab = (id: string, to: string) =>
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === id);
      const target = prev.findIndex((t) => t.id === to);
      if (from < 0 || target < 0) return prev;
      const next = [...prev];
      next.splice(target, 0, ...next.splice(from, 1));
      return next;
    });
  // The shown tab's neighbours in the tab list, for moving it from ⌘K.
  const shownAt = activeTab && !activeTab.pinned ? normalTabs.indexOf(activeTab) : -1;
  const neighbours = shownAt < 0 ? [] : ([["上", normalTabs[shownAt - 1]], ["下", normalTabs[shownAt + 1]]] as const).filter(([, t]) => t);
  // ⌘K lists the spaces and 管理's pages first, then the actions.
  // The live sessions, the one that changed last first, each opened in 作業.
  const sessionCommands = (): Command[] =>
    (board ? sessionItemsOf(board) : [])
      .filter(({ session: s }) => s.state !== "ended" && listedSession(s))
      .sort((a, b) => b.session.state_at - a.session.state_at)
      .map(({ session: s, todo }) => ({
        key: `session:${s.session_id}`,
        icon: <StateBadge state={s.state} unread={s.unread} />,
        label: todo ? `${sessionLabel(s)} · #${todo.id} ${todo.title}` : sessionLabel(s),
        hint: [prStageLabel(todo), s.agent === "codex" ? "Codex" : isCloud(s) ? "Cloud" : "Local", ago(s.state_at)].filter(Boolean).join(" · "),
        keywords: [STATE_LABEL[s.state], s.unread ? "新着" : ""].join(" "),
        run: () => openWork({ session: s.session_id }),
      }));
  const sessionsCommand: Command = { key: "sessions", label: "セッション一覧", hint: `${allSessions.length}件`, run: () => {}, items: sessionCommands };
  /// The sessions of no todo, to link one: listed ones, the one that changed last first.
  const unlinkedSessions = (board?.inbox ?? []).filter(listedSession).sort((a, b) => b.state_at - a.state_at);
  /// ⌘K's list linking session `s` to a todo not done (the one changed last
  /// first), or, with `todo`, unlinking it from that.
  const linkCommand = (s: Session, todo: Todo | undefined): Command =>
    todo
      ? {
          key: "unlinkSession",
          label: `${sessionLabel(s)} を #${todo.id} から外す`,
          run: () => {},
          items: () => [
            { key: "yes", label: "外す（todo のないセッションに戻ります）", run: () => run(() => api.unlinkSession(s.session_id)) },
            { key: "no", label: "やめる", run: () => {} },
          ],
        }
      : {
          key: "linkSession",
          label: `${sessionLabel(s)} を todo に紐づける`,
          run: () => {},
          items: () =>
            allTodos
              .filter((t) => t.status !== "done")
              .sort((a, b) => b.updated_at - a.updated_at)
              .map((t) => ({ key: `todo:${t.id}`, label: `#${t.id} ${t.title}`, hint: COLUMNS.find((c) => c.status === t.status)?.label, run: () => run(() => api.linkSession(s.session_id, t.id)) })),
        };
  /// 作業's l: that list straight away.
  const openLink = (s: Session, todo: Todo | undefined) => {
    setPaletteStart({ command: linkCommand(s, todo) });
    setDialog("palette");
  };
  /// ⌘K's list linking a session of no todo to `todo`.
  const linkToTodoCommand = (todo: Todo): Command => ({
    key: "linkToTodo",
    label: `#${todo.id} にセッションを紐づける`,
    run: () => {},
    items: () =>
      unlinkedSessions.map((s) => ({
        key: `session:${s.session_id}`,
        icon: <StateBadge state={s.state} unread={s.unread} />,
        label: sessionLabel(s),
        hint: `${placeOf(s)} · ${ago(s.state_at)}`,
        run: () => run(() => api.linkSession(s.session_id, todo.id)),
      })),
  });
  /// ⌘⇧K: ⌘K's list of sessions straight away.
  const openSessions = () => {
    setPaletteStart({ command: sessionsCommand });
    setDialog("palette");
  };
  const openSessionsRef = useRef(openSessions);
  openSessionsRef.current = openSessions;
  const commands: Command[] = [
    sessionsCommand,
    ...SPACES.map((sp) => ({ key: `space:${sp.key}`, label: sp.label, hint: keyLabel(keyOf(sp.action)), run: () => goSpace(sp.key) })),
    ...nav.map((n) => ({ key: `nav:${n.key}`, label: `管理：${n.label}`, run: n.go })),
    { key: "nav:doing", label: "管理：Doing", run: () => setView("doing") },
    ...PINNED_PAGES.map((p) => ({ key: p.id, label: p.label, hint: "ブラウザ", run: () => showPinned(p.id) })),
    ...savedFilters.map((f) => ({ key: `filter:${f.id}`, label: `フィルター: ${f.name}`, run: () => applyFilter(f) })),
    { key: "shortcuts", label: "キーの一覧", hint: keyLabel(keyOf("help")), run: () => setDialog("keys") },
    { key: "settings", label: "設定（開く場所・ターミナル・herdr・TypeSafe・ログイン・サイトの許可）", run: () => setDialog("settings") },
    { key: "usage", label: "使用量（Claude・Jev）", run: () => setDialog("usage") },
    { key: "forgetLogin", label: "表示中のサイトの保存したログインを消す", run: forgetShownLogin },
    { key: "add", label: "新しい Todo", hint: keyLabel(keyOf("newTodo")), run: () => setDialog("add") },
    { key: "digestYesterday", label: `昨日（${dayLabel(localDay(-1))}）の X のブックマークをまとめる`, run: () => run(() => api.makeXDigest(localDay(-1))) },
    { key: "digestToday", label: "今日の X のブックマークを今まとめる", run: () => run(() => api.makeXDigest(localDay(0))) },
    ...(board?.x_digests.digests ?? []).flatMap((d) => (d.url ? [{ key: `digest:${d.day}`, label: `X のまとめ：${dayLabel(d.day)}`, run: () => openInBrowser(d.url!) }] : [])),
    ...(studyReading && studyReadingShown
      ? [
          {
            key: "keepReading",
            label: studyReadingShown.kept ? `「${studyReadingShown.title}」を「これから読む」に戻す` : `「${studyReadingShown.title}」を残す（読んで良かった）`,
            run: () => keepReading(studyReadingShown),
          },
          {
            key: "forgetReading",
            label: `「${studyReadingShown.title}」を消す（読み終わって要らない）`,
            run: () => {},
            items: () => [
              { key: "yes", label: "消す", run: () => forgetReading(studyReadingShown) },
              { key: "no", label: "やめる", run: () => {} },
            ],
          },
        ]
      : []),
    ...(openDb
      ? [
          { key: "renameDatabase", label: `DB「${openDb.name}」の名前を変える`, run: () => askDatabase(openDb) },
          {
            key: "deleteDatabase",
            label: `DB「${openDb.name}」を消す（中の todo は残ります）`,
            run: () => {},
            items: () => [
              { key: "yes", label: "消す", run: () => deleteDatabase(openDb) },
              { key: "no", label: "やめる", run: () => {} },
            ],
          },
        ]
      : []),
    ...(selectedTodo && unlinkedSessions.length > 0 ? [linkToTodoCommand(selectedTodo)] : []),
    // 作業's session shown: linked to a todo, or unlinked from its.
    ...(space === "work" && workView.left && !workView.right ? [linkCommand(workView.left, workView.todo)] : []),
    ...(selectedTodo && databases.length > 0
      ? [
          {
            key: "todoDatabase",
            label: `#${selectedTodo.id} を DB に入れる`,
            run: () => {},
            items: () => [
              ...databases.map((d) => ({ key: `db:${d.id}`, label: d.name, hint: databaseOf(selectedTodo.id)?.id === d.id ? "入っている" : undefined, run: () => run(() => api.setTodoDatabase(selectedTodo.id, d.id)) })),
              ...(databaseOf(selectedTodo.id) ? [{ key: "none", label: "DB から外す", run: () => run(() => api.setTodoDatabase(selectedTodo.id, null)) }] : []),
            ],
          },
        ]
      : []),
    ...(browserShown && activeTab && !activeTab.term && !activeTab.pinned ? [{ key: "bookmark", label: "表示中のページを読みものに入れる", hint: keyLabel(keyOf("bookmark")), run: bookmarkShown }] : []),
    { key: "import", label: "自分に割り当てられた issue を取り込む", run: () => setDialog("import") },
    { key: "quick", label: "ちょっと Claude（todo に紐づけずに起動）", run: () => setDialog("quick") },
    { key: "sync", label: "GitHub とクラウドを今すぐ同期", run: syncAll },
    ...(filterCount(todoFilter) > 0 ? [{ key: "clearFilter", label: "フィルターを外す", run: () => setTodoFilter(NO_FILTER, true) }] : []),
    { key: "newTab", label: "ブラウザで新しいタブを開く", hint: keyLabel(keyOf("newTab")), run: openNewTab },
    ...(browserShown ? neighbours.map(([dir, t]) => ({ key: `moveTab:${dir}`, label: `表示中のタブを${dir}へ動かす`, run: () => moveTab(activeTab!.id, t!.id) })) : []),
  ];

  /// A side of a split view: its page or terminal, or what stands for one
  /// not made yet (a session ended or in Desktop, one not started).
  const pane = (tab: BrowserTab | undefined, session: Session | undefined, side: "left" | "right", other: BrowserTab | undefined, todo?: Todo) => {
    if (tab?.term) return <TerminalView key={tab.id} id={tab.id} run={tab.term} report={report} />;
    if (tab) return <TabView key={tab.id} tab={tab} covered={covered} report={report} onAddress={(url) => setTabUrl(tab.id, url)} keep={other?.term ? undefined : other?.id} keysOn={focusTyping === side} onArchive={cloudIdOfPage(tab.url) ? () => run(() => api.archiveSessions([cloudIdOfPage(tab.url)!])) : undefined} />;
    if (session && session.state !== "ended" && outsideHerdr.has(session.session_id))
      return (
        <div className="pane-empty">
          <b>{session.desktop ? "Claude Desktop のセッションです" : "herdr の外で動いているセッションです"}</b>
          <p className="muted">動いているところで開きます（ここで再開すると、同じセッションが二つ動きます）。</p>
          <button onClick={() => api.openSession(session.session_id, session.desktop ? "desktop" : undefined).catch(report)}>{session.desktop ? "Desktop で開く" : "開く"}</button>
        </div>
      );
    if (session?.state === "ended")
      return (
        <div className="pane-empty">
          <b>終了したセッションです</b>
          <p className="muted">{sessionLabel(session)}</p>
          <button onClick={() => ensureWorkTab(session, true)}>再開する（claude --resume）</button>
        </div>
      );
    if (session)
      return (
        <div className="pane-empty">
          <span className="spinner" /> 開いています…
        </div>
      );
    return (
      <div className="pane-empty">
        <b>まだ始めていません</b>
        {todo && (
          <button
            className="primary"
            onClick={() => {
              openTodo(todo.id);
              setDialog("start");
            }}
          >
            セッションを始める
          </button>
        )}
      </div>
    );
  };
  const workLeftTab = workTab(workView.left);
  const workRightTab = workTab(workView.right);
  /// 学習's open readings' URLs, one a line, for NotebookLM's sources.
  const copyOpenUrls = () => {
    const urls = study.open.map((id) => readings.find((r) => r.id === id)?.url).filter((u): u is string => !!u);
    api.copyText(urls.join("\n")).then(() => showToast(`${urls.length} 件の URL をコピーしました。NotebookLM のソースの追加に貼ってください`), report);
  };
  /// A book's chapter from 学習's contents, in the tab reading it.
  const goChapter = (url: string) => studyLeft && setTabs((prev) => prev.map((t) => (t.id === studyLeft.id ? { ...t, url, loading: true, nav: t.nav + 1 } : t)));

  // A todo picked on the Todo pages opens in the same sheet.
  const panel = todoView && selectedTodo ? "todo" : null;

  return (
    <BrowserContext.Provider value={openInBrowser}>
    <WorkContext.Provider value={openWork}>
    <OpenCloudContext.Provider value={openCloud}>
    <FixContext.Provider value={fixInSession}>
    <StartTodoContext.Provider value={startTodo}>
    <TerminalContext.Provider value={inAppTerminal}>
    <SessionTitleContext.Provider value={sessionTitle}>
      <div
        className={`app space-${space}${split ? " split-shown" : ""}${typingSide ? ` typing-${typingSide}` : ""}${split && focusTyping ? ` typing-${focusTyping}` : ""}`}
        data-zone={zone ?? undefined}
        style={{ "--panel-w": `${panelW}px`, "--focus-right-w": `${focusRightW}px`, "--tab-list-w": `${tabListW}px`, "--rail-w": `${railW}px` } as React.CSSProperties}
      >
        <SpaceRail
          space={space}
          waiting={waiting.length}
          limits={limits}
          jev={board?.jev_spend}
          jevLeft={jevLeft}
          onSpace={goSpace}
          onUsage={() => setDialog("usage")}
          onSearch={() => setDialog("palette")}
          onSettings={() => setDialog("settings")}
        />
        {(closePrompt || error || heldWaiting > 0) && (
          <div className="banners">
            {heldWaiting > 0 && (
              <div className="notice" role="status">
                <span className="grow">学習のあいだに、あなた待ちが {heldWaiting} 件増えました。</span>
                <button className="primary small" onClick={() => (setHeldWaiting(0), showWaiting())}>
                  作業で見る
                </button>
                <button className="ghost icon" onClick={() => setHeldWaiting(0)} aria-label="閉じる">
                  <Icon name="close" size={12} />
                </button>
              </div>
            )}
            {closePrompt && (
              <div className="notice" role="status">
                <span>
                  #{closePrompt.id} を Done にしました。{issueRef(closePrompt.issue_url) ?? "issue"} も close しますか？
                </span>
                <button
                  className="primary small"
                  onClick={() => {
                    const id = closePrompt.id;
                    setClosePrompt(null);
                    run(() => api.closeIssue(id));
                  }}
                >
                  close する
                </button>
                <button className="ghost small" onClick={() => setClosePrompt(null)}>
                  そのまま
                </button>
              </div>
            )}
            {error && (
              <div className="error" role="alert">
                <span className="grow">{error}</span>
                <button className="ghost icon" onClick={() => setError(null)} aria-label="閉じる">
                  <Icon name="close" size={12} />
                </button>
              </div>
            )}
          </div>
        )}
        <div className="space-body">
          {space === "manage" && (
            <>
              <aside className="sidebar">
                {NAV_GROUPS.map((group) => (
                  <nav key={group} className="nav" aria-label={group}>
                    <div className="section-title">{group}</div>
                    {nav
                      .filter((n) => n.group === group)
                      .map((n) => (
                        <button key={n.key} className={n.on ? "on" : ""} aria-current={n.on ? "page" : undefined} onClick={n.go}>
                          <Icon name={n.icon} />
                          <span className="grow">{n.label}</span>
                          {n.badge}
                          {n.count !== undefined && <span className="muted">{n.count}</span>}
                        </button>
                      ))}
                  </nav>
                ))}
                <div className="sidebar-foot">
                  <div className="sync-line">
                    <span className="dot state-running" />
                    <span className="grow ellipsis muted" title={board?.sync_status}>
                      {board?.sync_status}
                    </span>
                    <button className="ghost icon" onClick={syncAll} disabled={syncing} aria-label="GitHub とクラウドを今すぐ同期" title="今すぐ同期">
                      <Icon name="sync" size={12} />
                    </button>
                  </div>
                </div>
              </aside>

              <main className="main">
                {todoView && (
                  <>
                    <header className="toolbar">
                      <h1>{openDbId !== null ? (openDb?.name ?? "DB") : "Todo"}</h1>
                      <div className="segmented" role="group" aria-label="見え方">
                        {(["board", "list"] as const).map((l) => (
                          <button key={l} className={!doingView && layout === l ? "on" : ""} aria-pressed={!doingView && layout === l} onClick={() => (openDb ? setLayout(l) : showTodos(l))}>
                            {l === "board" ? "カンバン" : "リスト"}
                          </button>
                        ))}
                        {!openDb && (
                          <button className={doingView ? "on" : ""} aria-pressed={doingView} title="今日やるもの（Doing の todo）だけ" onClick={() => setView("doing")}>
                            Doing {doingTodos.length}
                          </button>
                        )}
                      </div>
                      <div className="segmented" role="group" aria-label="まとめ方">
                        {GROUPINGS.map((g) => (
                          <button key={g.key} className={groupBy === g.key ? "on" : ""} aria-pressed={groupBy === g.key} onClick={() => setGroupBy(g.key)}>
                            {g.label}
                          </button>
                        ))}
                      </div>
                      {!doingView && (
                        <TodoFilterBar filter={todoFilter} version={`${layout}:${filterVersion}`} places={repoLanes.map((l) => l.key)} onChange={(f) => setTodoFilter(f, f === NO_FILTER)} onSave={saveFilter} />
                      )}
                      {!doingView && !openDb && savedFilters.length > 0 && (
                        <select
                          className="select compact"
                          value={savedFilters.find((f) => f.layout === layout && sameFilter(todoFilter, f.filter))?.id ?? ""}
                          aria-label="保存したビュー"
                          title="保存したビュー（絞り込みとフィルター）"
                          onChange={(e) => {
                            const f = savedFilters.find((x) => x.id === e.target.value);
                            if (f) applyFilter(f);
                          }}
                        >
                          <option value="">ビュー</option>
                          {savedFilters.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.name}（{f.layout === "board" ? "カンバン" : "リスト"}）
                            </option>
                          ))}
                        </select>
                      )}
                      {!doingView && !openDb && savedFilters.some((f) => f.layout === layout && sameFilter(todoFilter, f.filter)) && (
                        <button
                          className="ghost icon"
                          aria-label="このビューを消す"
                          title="このビューを消す（絞り込みはそのまま）"
                          onClick={() => setSavedFilters(savedFilters.filter((f) => !(f.layout === layout && sameFilter(todoFilter, f.filter))))}
                        >
                          <Icon name="close" size={11} />
                        </button>
                      )}
                      <span className="grow" />
                      {openDb &&
                        (deletingDb ? (
                          <span className="inline-confirm">
                            <span className="muted small-text">中の todo は残ります</span>
                            <button className="danger small" onClick={() => deleteDatabase(openDb)}>
                              DB を消す
                            </button>
                            <button className="ghost small" onClick={() => setDeletingDb(false)}>
                              やめる
                            </button>
                          </span>
                        ) : (
                          <>
                            <button className="ghost small" onClick={() => askDatabase(openDb)}>
                              名前を変える
                            </button>
                            <button className="ghost small" onClick={() => setDeletingDb(true)}>
                              消す
                            </button>
                          </>
                        ))}
                      <button className="primary" onClick={() => setDialog("add")}>
                        <Icon name="plus" size={13} /> 新しい Todo <span className="kbd">{keyLabel(keyOf("newTodo"))}</span>
                      </button>
                    </header>
                    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
                      <div className="content" ref={todoPage}>
                        {pageLayout === "board" && lanes.length > 0 && (
                          <div className="col-heads" style={{ gridTemplateColumns: columnsTemplate(foldedCols) }}>
                            {COLUMNS.map((c) => (
                              <h2 key={c.status} className={foldedCols.has(c.status) ? "folded" : undefined}>
                                <button className="col-toggle" title={foldedCols.has(c.status) ? `${c.label} を開く` : `${c.label} を畳む（カードはここへ動かせます）`} onClick={() => toggleColumn(c.status)}>
                                  <StatusIcon status={c.status} />
                                  {!foldedCols.has(c.status) && c.label} <span className="muted">{colCounts[c.status]}</span>
                                </button>
                              </h2>
                            ))}
                          </div>
                        )}
                        {lanes.map((lane) =>
                          pageLayout === "board" ? (
                            <BoardLane
                              key={lane.key}
                              lane={lane}
                              collapsed={collapsed.has(lane.key)}
                              onToggle={() => toggleLane(lane.key)}
                              selectedId={selectedTodo?.id ?? null}
                              onSelectTodo={openTodo}
                              report={report}
                              allTodos={allTodos}
                              folded={foldedCols}
                              onAdd={(status, title) => addTodoIn(lane, status, title)}
                            />
                          ) : (
                            <ListLane
                              key={lane.key}
                              lane={lane}
                              collapsed={collapsed.has(lane.key)}
                              onToggle={() => toggleLane(lane.key)}
                              selectedId={selectedTodo?.id ?? null}
                              onSelectTodo={openTodo}
                              report={report}
                              run={run}
                              setStatus={setStatus}
                              allTodos={allTodos}
                              folded={pageFolded}
                              onUnfold={toggleColumn}
                              onAdd={(title) => addTodoIn(lane, doingView ? "doing" : "todo", title)}
                            />
                          ),
                        )}
                        {board && lanes.length === 0 && (
                          <p className="muted empty">
                            {doingView
                              ? "Doing の todo はありません。今日やるものを Doing にすると、ここに並びます。"
                              : openDb && openDb.todos.length === 0
                                ? "この DB にはまだ todo がありません。ここで新しい Todo を作るか、todo のシートの「DB」で入れると並びます。"
                                : filterCount(todoFilter) > 0
                                ? "フィルターに合う todo はありません。"
                                : `表示できる todo がありません。${keyLabel(keyOf("newTodo"))} で追加するか、${keyLabel(keyOf("palette"))} から issue を取り込めます。`}
                          </p>
                        )}
                      </div>
                      {statusMenuTodo && <StatusMenu todo={statusMenuTodo} onPick={(st) => setStatus(statusMenuTodo, st)} onClose={() => setStatusMenuFor(null)} />}
                      <DragOverlay dropAnimation={null}>{draggedTodo && <div className="card overlay">{draggedTodo.title}</div>}</DragOverlay>
                    </DndContext>
                  </>
                )}
                {view === "prs" && (
                  <PrsPage
                    prs={prs}
                    prsLoading={prsLoading}
                    prError={prError}
                    todos={allTodos}
                    sessions={board?.inbox ?? []}
                    submitted={submittedReviews}
                    local={local}
                    run={run}
                    report={report}
                    onRefresh={loadPrs}
                    onOpenTodo={goTodo}
                  />
                )}
                {view === "artifacts" && board && <ArtifactsPage artifacts={board.artifacts} todos={allTodos} report={report} run={run} onOpenTodo={goTodo} />}
                {view === "slack" && board && (
                  <SlackPage
                    slack={board.slack}
                    pick={slackPick}
                    run={run}
                    report={report}
                    onSettings={() => setDialog("settings")}
                    onTodo={(memo) => {
                      setDialog("add");
                      setAddMemo(memo);
                    }}
                  />
                )}
                {panel === "todo" && selectedTodo && (
                  // A sheet over the Todo page, not a dialog: j k go on to the next todo.
                  <div className="sheet-backdrop" onClick={() => setSelection(null)}>
                    <TodoPanel
                      todo={selectedTodo}
                      allTodos={allTodos}
                      waiting={waiting}
                      artifacts={board?.artifacts ?? []}
                      local={local}
                      groups={groups}
                      databases={databases}
                      unlinked={unlinkedSessions}
                      run={run}
                      report={report}
                      setStatus={setStatus}
                      onOpenTodo={openTodo}
                      onStart={() => setDialog("start")}
                      onWork={() => openWork({ todo: selectedTodo.id })}
                      onClose={() => setSelection(null)}
                    />
                  </div>
                )}
              </main>
            </>
          )}

          {space === "work" && board && (
            <div className="split">
              <WorkRail board={board} waiting={waiting} pick={work.pick} width={railW} onResize={setRailW} onPick={openWork} onTodo={goTodo} onShowPrs={() => setView("prs")} onQuick={() => setDialog("quick")} onLink={openLink} run={run} />
              {workView.left || workView.todo ? (
                <>
                  <section className="focus-left browser" aria-label={workView.right || workView.children.length > 0 ? "指揮役のセッション" : "セッション"}>
                    <div className="browser-tabs work-head">
                      {workView.todo && <span className="mono muted">#{workView.todo.id}</span>}
                      <b className="ellipsis">{workView.title}</b>
                      {workView.children.length > 0 && <span className="muted small-text">指揮役</span>}
                      {workView.left && <StateBadge state={workView.left.state} unread={workView.left.unread} />}
                      <span className="grow" />
                      {workView.left && <span className="muted small-text">{placeOf(workView.left)}</span>}
                      {workView.todo && (
                        <button className="ghost small" onClick={() => goTodo(workView.todo!.id)}>
                          管理で見る <span className="kbd">{keyLabel(keyOf("showTodo"))}</span>
                        </button>
                      )}
                    </div>
                    {pane(workLeftTab, workView.left, "left", workRightTab, workView.todo)}
                  </section>
                  {workView.children.length > 0 && (
                    <aside className="browser-dock focus-right">
                      <Resizer label="右側の幅" cssVar="--focus-right-w" width={focusRightW} min={DOCK_MIN_W} max={() => window.innerWidth - FOCUS_LEFT_MIN_W} onResize={setFocusRightW} />
                      <section className="browser" aria-label="サブタスクのセッション">
                        <div className="browser-tabs focus-head" role="tablist" aria-label="サブタスク">
                          {workView.children.map((c) => {
                            const s = mainSession(c);
                            return (
                              <span key={c.id} className={`browser-tab${c.id === workView.child?.id ? " on" : ""}`}>
                                <button role="tab" aria-selected={c.id === workView.child?.id} className="browser-tab-main" title={c.title} onClick={() => pickChild(c.id)}>
                                  {s ? <StateBadge state={s.state} unread={s.unread} /> : <StatusIcon status={c.status} />}
                                  <span className="mono">#{c.id}</span>
                                  <span className="ellipsis">{c.title}</span>
                                </button>
                              </span>
                            );
                          })}
                          <span className="grow" />
                          <span className="kbd">{keyLabel(keyOf("nextTab"))}</span>
                        </div>
                        {pane(workRightTab, workView.right, "right", workLeftTab, workView.child)}
                      </section>
                    </aside>
                  )}
                </>
              ) : (
                <div className="pane-empty">
                  <b>左の一覧から選ぶと、そのセッションが開きます</b>
                  <p className="muted">
                    {keyLabel(keyOf("down"))} {keyLabel(keyOf("up"))} で選んで Enter。親の todo なら、指揮役が左、サブタスクが右に並びます。
                  </p>
                </div>
              )}
            </div>
          )}

          {space === "study" && board && !studyReading && (
            <ReadingsPage
              readings={readings}
              sort={board.reading_sort}
              digests={board.x_digests}
              opened={study.open.length}
              run={run}
              report={report}
              onRead={readReadings}
              onResume={() => setStudy((st) => ({ ...st, view: "read" }))}
              onBrowser={(url) => openInBrowser(url)}
              onSettings={() => setDialog("settings")}
              onToast={showToast}
            />
          )}
          {studyReading && (
            <div className="split">
              <StudyRail reading={studyReadingShown} readings={readings} opened={study.open} run={run} onRead={readReadings} onChapter={goChapter} onCopy={copyOpenUrls} onList={() => setStudy((st) => ({ ...st, view: "list" }))} onKeep={keepReading} onForget={forgetReading} />
              <section className="focus-left browser" aria-label="読んでいるページ">
                <div className="browser-tabs" role="tablist" onMouseDown={(e) => !(e.target as HTMLElement).closest("input, button, .browser-tab") && studyLeft && keysToTab(studyLeft, studyLeft.id, report)}>
                  {studyLefts.map((t) => (
                    <span key={t.id} className={`browser-tab${t.id === studyLeft?.id ? " on" : ""}`}>
                      <button
                        role="tab"
                        aria-selected={t.id === studyLeft?.id}
                        className="browser-tab-main"
                        title={t.url}
                        onClick={() => {
                          keysToTab(t, studyLeft?.id, report);
                          setStudy((st) => ({ ...st, active: t.id }));
                        }}
                      >
                        {t.loading && <span className="spinner" aria-label="読み込み中" />}
                        <span className="ellipsis">{t.title || hostOf(t.url)}</span>
                      </button>
                      <button className="ghost icon browser-tab-close" aria-label={`${t.title || hostOf(t.url)} を閉じる`} onClick={() => closeStudyTab(t.id)}>
                        <Icon name="close" size={11} />
                      </button>
                    </span>
                  ))}
                </div>
                {studyLeft ? (
                  <TabView key={studyLeft.id} tab={studyLeft} covered={covered} report={report} onAddress={(url) => setTabUrl(studyLeft.id, url)} keep={studyRightTab?.id} keysOn={focusTyping === "left"} onBookmark={studyLeft.reading === undefined ? bookmarkShown : undefined} />
                ) : (
                  <div className="pane-empty">読みものを左の一覧から選んでください。</div>
                )}
              </section>
              <aside className="browser-dock focus-right">
                <Resizer label="右側の幅" cssVar="--focus-right-w" width={focusRightW} min={DOCK_MIN_W} max={() => window.innerWidth - FOCUS_LEFT_MIN_W} onResize={setFocusRightW} />
                <section className="browser">
                  <div className="browser-tabs focus-head">
                    <div className="segmented" role="group" aria-label="右側で聞く相手">
                      {STUDY_RIGHT.map((id) => (
                        <button key={id} className={study.right === id ? "on" : ""} aria-pressed={study.right === id} onClick={() => setStudyRight(id)}>
                          {PINNED_PAGES.find((p) => p.id === id)?.label}
                        </button>
                      ))}
                    </div>
                    {study.right === "pinnotebooklm" && study.open.length > 0 && (
                      <button className="ghost small" title="NotebookLM のソースの追加（ウェブサイト）に貼れるよう、開いている読みものの URL を1行ずつコピーします" onClick={copyOpenUrls}>
                        開いている {study.open.length} 件の URL をコピー <span className="kbd">{keyLabel(keyOf("studyCopy"))}</span>
                      </button>
                    )}
                    <span className="grow" />
                    <span className="muted small-text" title="学習のあいだは macOS の通知を出しません。離れたときに、増えたあなた待ちを知らせます">
                      通知は止めています
                    </span>
                  </div>
                  {studyRightTab && <TabView key={studyRightTab.id} tab={studyRightTab} covered={covered} report={report} onAddress={(url) => setTabUrl(studyRightTab.id, url)} keep={studyLeft?.id} keysOn={focusTyping === "right"} />}
                </section>
              </aside>
            </div>
          )}

          {space === "browser" && (
            <BrowserSpace
              tabs={normalTabs}
              active={activeTab}
              covered={covered}
              listKeys={typingSide === "app"}
              width={tabListW}
              report={report}
              onResize={setTabListW}
              onSelect={(id) => {
                keysToTab(tabs.find((t) => t.id === id) ?? null, activeTab?.id, report);
                setActiveTabId(id);
              }}
              onStrip={() => activeTab && keysToTab(activeTab, activeTab.id, report)}
              onPinned={showPinned}
              onArchive={() => archiveShownRef.current()}
              onBookmark={bookmarkShown}
              onClose={closeTab}
              onNewTab={openNewTab}
              // What is typed on a new tab page opens in a new tab, as a page's link does.
              onOpen={(url) => openFromPage(url, activeTab?.id ?? "", false)}
              onAddress={setTabUrl}
              onMove={moveTab}
            />
          )}
        </div>

        {dialog === "add" && (
          <AddTodoDialog
            local={local}
            groups={groups}
            databases={databases}
            initialRepo={todoFilter.places.length === 1 ? todoFilter.places[0] : null}
            initialDatabase={openDb?.id ?? null}
            initialMemo={addMemo}
            run={run}
            onClose={() => {
              setDialog(null);
              setAddMemo(undefined);
            }}
            onOpenTodo={(id) => {
              setDialog(null);
              goTodo(id);
            }}
            onImport={() => setDialog("import")}
          />
        )}
        {dialog === "import" && <ImportDialog run={run} onClose={() => setDialog(null)} />}
        {dialog === "quick" && <QuickClaudeDialog run={run} onClose={() => setDialog(null)} />}
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
        {downloaded && (
          <div className="toast login-ask" role="status">
            <span>
              ダウンロードしました：<b>{downloaded.name}</b>
            </span>
            <button className="small" onClick={() => api.revealInFinder(downloaded.path).catch(report)}>
              Finder で表示
            </button>
          </div>
        )}
        {siteAsk && (
          <div className="toast login-ask" role="alertdialog" aria-label="マイクとカメラの許可">
            <span>
              <b>{siteAsk.site}</b> が{siteAsk.camera ? "カメラとマイク" : "マイク"}を使おうとしています。答えはこのサイトについて覚えます
            </span>
            <button className="primary small" onClick={() => answerSite(true)}>
              許可
            </button>
            <button className="ghost small" onClick={() => answerSite(false)}>
              許可しない
            </button>
          </div>
        )}
        {pageDialog && <PageDialog ask={pageDialog} onAnswer={answerPageDialog} />}
        {loginAsk && (
          <div className="toast login-ask" role="alertdialog" aria-label="ログインの保存">
            <span>
              <b>{loginAsk.host}</b> のログイン（{loginAsk.user}）を Keychain に保存しますか？次から自動で入力して送信します
            </span>
            <button className="primary small" onClick={() => answerLogin("keep")}>
              保存する
            </button>
            <button className="ghost small" onClick={() => answerLogin("skip")}>
              今回はしない
            </button>
            <button className="ghost small" title="このサイトのログインは、設定で戻すまで聞きません" onClick={() => answerLogin("never")}>
              このサイトでは聞かない
            </button>
          </div>
        )}
        {dialog === "keys" && <ShortcutsDialog onClose={() => setDialog(null)} />}
        {dialog === "settings" && (
          <SettingsDialog
            cloudTarget={cloudTarget}
            onCloudTarget={setCloudTarget}
            terminalTarget={terminalTarget}
            onTerminalTarget={setTerminalTarget}
            herdr={herdr}
            onLoadHerdr={loadHerdr}
            onPickHerdr={pickHerdr}
            hasTypesafeKey={!!board?.reading_sort.has_key}
            jevCredit={board?.jev_spend.credit ?? null}
            run={run}
            report={report}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === "database" && <DatabaseDialog database={renamingDb} databases={databases} run={run} onMade={(d) => setView(dbView(d.id))} onClose={() => setDialog(null)} />}
        {dialog === "usage" && <UsageDialog limits={limits} error={usageError} jev={board?.jev_spend} onClose={() => setDialog(null)} />}
        {dialog === "start" && selectedTodo && <StartDialog todo={selectedTodo} allTodos={allTodos} run={run} onClose={() => setDialog(null)} />}
        {dialog === "palette" && (
          <CommandPalette
            commands={commands}
            todos={allTodos}
            readings={readings}
            start={paletteStart?.command}
            onOpenTodo={goTodo}
            onRead={(id) => readReadings([id])}
            onClose={() => {
              setDialog(null);
              // Back to the terminal the links were picked from (a link picked takes the keyboard after).
              const from = paletteStart?.terminal;
              if (from) requestAnimationFrame(() => focusTerminal(from));
            }}
          />
        )}
      </div>
    </SessionTitleContext.Provider>
    </TerminalContext.Provider>
    </StartTodoContext.Provider>
    </FixContext.Provider>
    </OpenCloudContext.Provider>
    </WorkContext.Provider>
    </BrowserContext.Provider>
  );
}
