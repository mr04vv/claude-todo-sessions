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
  BROWSER_TO_INPUT_EVENT,
  OPEN_PALETTE_EVENT,
  OPEN_SESSIONS_EVENT,
  THEME_DOC_EVENT,
  REVIEW_SUBMITTED_EVENT,
  OPEN_TODO_EVENT,
  OPEN_SLACK_EVENT,
  BROWSER_TRANSLATED_EVENT,
  type ReviewRunner,
  LOGIN_CAPTURED_EVENT,
  FOCUS_APP_EVENT,
  PAGE_FOCUSED_EVENT,
  FOCUS_PANE_EVENT,
  FOCUS_EXIT_EVENT,
  ADD_INPUT_EVENT,
  WINDOW_FOCUS_EVENT,
  BROWSER_NEW_TAB_EVENT,
  OPEN_URL_EVENT,
  OPEN_NEW_TODO_EVENT,
  BROWSER_DOWNLOADED_EVENT,
  PAGE_DIALOG_EVENT,
  SITE_PERMISSION_EVENT,
  OPEN_CLOUD_EVENT,
  BROWSER_TITLE_EVENT,
  BROWSER_ZOOM_EVENT,
  BROWSER_URL_EVENT,
  CLOUD_HOME,
  cloudWebUrl,
  EFFORTS,
  isCloud,
  issueRef,
  MODELS,
  type Board,
  type Input,
  type Theme,
  type Placement,
  type ReviewQuestion,
  type FeynmanAttempt,
  type Subject,
  type Issue,
  type HerdrSessions,
  type Limit,
  type LocalRepo,
  type Pr,
  type PrLists,
  type PrState,
  type CiState,
  type TodoEvent,
  type Artifact,
  type SlackAccount,
  type SlackMentionable,
  type SlackThreadMessage,
  type SlackView,
  SLACK_POSTED_EVENT,
  type Session,
  type SessionState,
  type StartOptions,
  type Status,
  type Todo,
  type Agent,
  type FeynmanSummary,
  type FeynmanVerdict,
  type PageText,
} from "./api";
import { TYPING, useTodoKeys } from "./todoKeys";
import { parseSlack, type Inline } from "./slackText";
// The app's icon (src-tauri/icons/icon.svg), as the sidebar's logo too.
import logoUrl from "../src-tauri/icons/icon.svg?url";
import { groupRowId, sessionTree, type TreeRow } from "./sessionTree";
import { ACTIONS, allKeys, keyLabel, keyOf, matches, type Action } from "./keymap";
import { addressToUrl, findTabFor, foldReviews, insertAfter, nextAfterClose, SEARCH_URL } from "./tabs";
import { ciFailureLine, isFailedReview, isReviewAsk, prRef, waitingOnYou, type WaitItem } from "./waiting";
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
/// A tab starts moving once the pointer has gone this far with the button down.
const TAB_DRAG_PX = 4;

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
const BROWSER_SHOWN_KEY = "browserShown";
const HERDR_SESSION_KEY = "herdrSession";


type View = "todos" | "inputs" | "sessions" | "prs" | "artifacts" | "slack";
/// The sidebar's groups, in its order.
type NavGroup = "仕事" | "連絡" | "学び";
const NAV_GROUPS: NavGroup[] = ["仕事", "連絡", "学び"];
type Layout = "board" | "list";
type GroupBy = "repo" | "parent";

const GROUPINGS: { key: GroupBy; label: string }[] = [
  { key: "repo", label: "リポジトリ" },
  { key: "parent", label: "親 Todo" },
];

/// Opens a page in the browser pane docked on the right. It stays open across
/// screens until closed, so opening a page never leaves the current one.
type OpenInBrowser = (url: string) => void;
const BrowserContext = createContext<OpenInBrowser | null>(null);

/// Creating a cloud session takes seconds, so its tab opens at once on
/// claude.ai (loading alongside) and moves to the session once it exists.
/// Call the returned function with the session id, or null if it failed.
/// With `review`, the tab goes in the strip's review group.
type BeginWeb = (review?: ReviewTab) => (sessionId: string | null) => void;
const BeginWebContext = createContext<BeginWeb | null>(null);

/// Where "開く" takes a cloud session: its web page, or Claude Desktop.
type CloudTarget = "web" | "desktop";
const CLOUD_TARGET_KEY = "cloudTarget";
const OpenCloudContext = createContext<((sessionId: string) => void) | null>(null);

/// 「再開して直させる」: sends the todo's session what to fix in its PR.
type FixInSession = (session: Session, todo: Todo) => void;
const FixContext = createContext<FixInSession | null>(null);

/// With the in-app terminal chosen: opens a run in a terminal tab, and brings
/// up the tab a session already runs in (false when there is none).
interface InAppTerminal {
  /// Shows `run` in a terminal tab; `focus` (opening, not starting) brings it up with the keyboard.
  open: (run: TerminalRun, focus?: boolean) => void;
  focus: (sessionId: string) => boolean;
}
const TerminalContext = createContext<InAppTerminal | null>(null);
/// Opens a local session in herdr, or in a terminal tab when the in-app
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
/// The session lists leave out reviews (one asking is in あなた待ち), and
/// sessions put away (⌘⇧A, or a review once it is in) unless they ask.
const listedSession = (s: Session) => (!isReviewSession(s) || s.state === "needs_input") && (!s.hidden || s.state === "needs_input");

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

/// The session state that most needs the user, among the live ones.
function urgentState(sessions: Session[]): SessionState | null {
  return STATE_ORDER.find((st) => st !== "ended" && sessions.some((s) => s.state === st)) ?? null;
}

/// One obvious session to jump to: the most urgent live one, or the only one.
function directSession(todo: Todo): Session | null {
  const live = liveSessions(todo);
  const urgent = urgentState(live);
  if (urgent) return live.find((s) => s.state === urgent) ?? null;
  return todo.sessions.length === 1 ? todo.sessions[0] : null;
}

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
const DOCK_W_KEY = "dockWidth";
const PANEL_DEFAULT_W = 440;
const PANEL_MIN_W = 320;
const DOCK_MIN_W = 360;
/// The browser pane starts at this share of the window.
const DOCK_DEFAULT_SHARE = 0.44;
/// The study time (the Input mode): the page a new space shows on the right, and that side's width.
const FOCUS_RIGHT_KEY = "focusRight";
/// Each theme's space, saved to be resumed (SavedSpace by subjectKey).
const INPUT_SPACES_KEY = "inputSpaces";
/// The space of pages picked without a theme; it closes with the study time.
const FREE_SPACE = "free";
/// A theme's space is kept under this (letters and digits, as tab ids are).
const subjectKey = (s: Subject | null) => (s === null ? FREE_SPACE : `h${s.id}`);
const FOCUS_RIGHT_W_KEY = "focusRightWidth";
const FOCUS_RIGHT_SHARE = 0.45;
/// The right pages a space may show: the LLM to ask while reading.
const RIGHT_KINDS = ["pinchatgpt", "pinclaude"];
/// After how many days to review again, by the last score (as feynman.rs decides it).
const reviewAfterDays = (score: number) => (score < 60 ? 1 : score < 85 ? 3 : 7);
const VERDICT_MARK: Record<FeynmanVerdict, string> = { said: "✓", vague: "△", missing: "✗" };
const VERDICT_LABEL: Record<FeynmanVerdict, string> = { said: "言えた", vague: "あいまい", missing: "抜けている" };
/// A space's tab for a right page (ids are letters and digits only).
const rightTabId = (space: string, kind: string) => `s${space}${kind}`;
const newSpace = (right: string): InputSpace => ({ lefts: [], active: null, right, pages: [], rightUrls: {} });
/// How often a parent's 経過 is read again while its sheet is open.
const EVENTS_REFRESH_MS = 5000;
/// How long a short note at the bottom ("学びに入れました") stays.
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
/// The pane's tabs as kept across restarts (PANE_TABS_KEY): their pages, and the one shown.
interface SavedTabs {
  /// `pinned` is the pinned page's id.
  tabs: { url: string; openedFor?: string; title: string | null; pinned?: string; term?: TerminalRun }[];
  active: number;
}
const PANE_TABS_KEY = "paneTabs";
/// The focus mode's left side keeps at least this.
const FOCUS_LEFT_MIN_W = 360;
const SIDEBAR_W = 232;
/// Room always left for the screen in the middle.
const MAIN_MIN_W = 320;
/// Arrow keys on a resizer move it this far.
const RESIZE_STEP = 24;

/// Sent on the window when a drag on a Resizer ends.
const PANE_RESIZED_EVENT = "pane-resized";
/// On the body while a Resizer is dragged.
const RESIZING_CLASS = "resizing";

/// Widest a side pane may get, leaving the sidebar, `others` and the middle.
const maxPaneWidth = (others: number) => Math.max(PANEL_MIN_W, window.innerWidth - SIDEBAR_W - MAIN_MIN_W - others);

/// A strip on a pane's left edge; dragging it (or the arrow keys) sets the
/// pane's width, the CSS variable `cssVar` on the app. While dragging only
/// that variable moves, once a frame; `onResize` (a re-render) runs on release.
function Resizer({ label, cssVar, width, min, max, onResize }: {
  label: string;
  cssVar: string;
  width: number;
  min: number;
  max: () => number;
  onResize: (w: number) => void;
}) {
  const clamp = (w: number) => Math.round(Math.min(max(), Math.max(min, w)));
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const app = (e.currentTarget as HTMLElement).closest<HTMLElement>(".app");
    const startX = e.clientX;
    let next = width;
    let frame = 0;
    const move = (ev: PointerEvent) => {
      next = clamp(width + startX - ev.clientX);
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
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onResize(clamp(width + RESIZE_STEP));
        if (e.key === "ArrowRight") onResize(clamp(width - RESIZE_STEP));
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
  | "globe";

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

/// ↓ (or the down key, j) is 1, ↑ (or k) -1, else 0.
const stepOf = (e: KeyboardEvent) => {
  const arrow = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  return (arrow && e.key === "ArrowDown") || matches(e, "down") ? 1 : (arrow && e.key === "ArrowUp") || matches(e, "up") ? -1 : 0;
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
/// Other keys go to `onKey`, which says whether it took the key.
/// Keys typed into fields, dialogs, menus and terminals are left alone.
function useRowCursor(
  ids: string[],
  onEnter: (id: string, alt: boolean, row: HTMLElement) => void,
  onKey?: (e: KeyboardEvent, id: string) => boolean,
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
      if (t.closest("input, textarea, select, [role=menu], [role=dialog], .xterm") || document.querySelector(".app.focus, .app[data-zone=sidebar], .sheet-backdrop")) return;
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
      } else if (cursorId && onKey?.(e, cursorId)) {
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

/// "開く" jumps to the session where it runs (its herdr pane, else Desktop);
/// the caret picks Desktop or herdr explicitly.
function OpenMenu({ session, report, primary, label = "開く" }: { session: Session; report: (e: unknown) => void; primary?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useOutsideClose(root, open, () => setOpen(false));
  const openInBrowser = useContext(BrowserContext);
  const openCloud = useContext(OpenCloudContext);
  const terminal = useContext(TerminalContext);
  const cloud = isCloud(session);
  const go = (target?: "desktop" | "herdr" | "web") => {
    setOpen(false);
    api.markSessionSeen(session.session_id).catch(report);
    if (target === "web" && openInBrowser) openInBrowser(cloudWebUrl(session.session_id));
    else if (target === "herdr") openLocal(terminal, session.session_id, report);
    else api.openSession(session.session_id, target === "web" ? "desktop" : target).catch(report);
  };
  const openMain = () => {
    if (cloud && openCloud) {
      setOpen(false);
      openCloud(session.session_id);
    } else {
      setOpen(false);
      openLocal(terminal, session.session_id, report, true);
    }
  };
  const menuKeys = useMenuKeys(open, () => setOpen(false));
  return (
    <span ref={root} className={`open-menu${primary ? " primary" : ""}`} onPointerDown={stop} onClick={stop}>
      <button className="open-main" title={`${sessionLabel(session)} を開く`} onClick={openMain}>
        {label}
      </button>
      <button className="open-caret" aria-label="開く場所を選ぶ" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevron" size={10} />
      </button>
      {open && (
        <span className="menu" role="menu" {...menuKeys}>
          {cloud && openInBrowser && (
            <button role="menuitem" onClick={() => go("web")}>
              Web で開く（アプリ内）
            </button>
          )}
          <button role="menuitem" onClick={() => go("desktop")}>
            Claude Desktop で開く
          </button>
          {cloud && (
            <button role="menuitem" onClick={() => (setOpen(false), api.archiveSessions([session.session_id]).catch(report))}>
              アーカイブ
            </button>
          )}
          {!cloud && (
            <button role="menuitem" onClick={() => go("herdr")}>
              {terminal ? "ターミナルで開く" : "herdr で開く"}（閉じていれば再開）
            </button>
          )}
        </span>
      )}
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
  const urgent = urgentState(liveSessions(todo));
  const direct = directSession(todo);
  const rel = relationLabel(todo, allTodos);
  return (
    <article
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      className={`card${selected ? " selected" : ""}${drag.isDragging ? " dragging" : ""}${urgent === "needs_input" ? " waiting" : ""}${todo.status === "done" ? " done" : ""}`}
      data-row={`todo:${todo.id}`}
      onClick={onSelect}
    >
      <div className="card-head">
        <span className="mono">{todoRef(todo)}</span>
        {urgent && <StateBadge state={urgent} unread={todo.sessions.some((s) => s.unread) || undefined} />}
      </div>
      <div className="card-title">{todo.title}</div>
      {(todo.pr_url || todo.issue_url || rel || direct) && (
        <div className="card-foot">
          <GhChip todo={todo} report={report} />
          <CiChip todo={todo} />
          {rel && <span className="tag">{rel}</span>}
          <span className="grow" />
          {direct && <OpenMenu session={direct} report={report} primary={urgent === "needs_input"} />}
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

/// あなた待ち above the board; it opens the sessions page on them, and the
/// review requests (one chip for them all) the PR page.
function WaitingStrip({ items, onShow, onShowPrs }: { items: WaitItem[]; onShow: () => void; onShowPrs: () => void }) {
  if (items.length === 0) return null;
  const asks = items.filter(isReviewAsk).length;
  const rest = items.filter((w) => !isReviewAsk(w));
  return (
    <div className="waiting-strip">
      <button className="waiting-strip-main" title="セッション画面のあなた待ちを開く" onClick={onShow}>
        <span className="pill waiting">
          <i />
          あなた待ち {items.length}
        </span>
        {rest.slice(0, WAITING_STRIP_MAX).map((w) => (
          <span key={w.key} className="waiting-item">
            <span className="ellipsis">{w.session ? sessionLabel(w.session) : w.todo?.title}</span>
            <span className="muted ellipsis">{w.line}</span>
          </span>
        ))}
        {rest.length > WAITING_STRIP_MAX && <span className="muted">ほか {rest.length - WAITING_STRIP_MAX} 件</span>}
      </button>
      {asks > 0 && (
        <button className="waiting-item" title="PR の画面のレビュー依頼を開く" onClick={onShowPrs}>
          新着のレビュー依頼 {asks} 件
        </button>
      )}
    </div>
  );
}
/// The sessions page's one line for the review requests, as its row.
const ASKS_ROW = "w:reviews";
/// Items the strip over the board names; the rest are counted.
const WAITING_STRIP_MAX = 3;

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
    const urgent = urgentState(liveSessions(t));
    const direct = directSession(t);
    return (
      <li key={t.id} data-row={`todo:${t.id}`} className={`row${t.id === selectedId ? " selected" : ""}${t.status === "done" ? " done" : ""}`} onClick={() => onSelectTodo(t.id)}>
        <StatusIcon status={t.status} />
        <span className="mono muted ref">{todoRef(t)}</span>
        <span className="row-title">{t.title}</span>
        {urgent && <StateBadge state={urgent} unread={t.sessions.some((s) => s.unread) || undefined} />}
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
        {direct && <OpenMenu session={direct} report={report} primary={urgent === "needs_input"} />}
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

/// A page in the browser pane.
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
  /// Set on an in-app terminal tab, which shows no web page.
  term?: TerminalRun;
  /// The page's zoom from the keys, when not 1.
  zoom?: number;
  /// One of PINNED_PAGES.
  pinned?: boolean;
  /// The Input mode's own page (on its left or right), apart from the pane's tabs.
  focus?: boolean;
  /// The Input mode's space it belongs to (InputSpace's key, subjectKey).
  space?: string;
  /// On the right: which page it is (a FOCUS_PAGES id or NOTE_TAB).
  kind?: string;
  /// A Cloud session being made for it (BeginWeb): not kept across restarts.
  creating?: boolean;
  /// A review's session page, in the strip's review group (made again from
  /// the sessions after a restart, not kept).
  review?: ReviewTab;
  /// Its page is translated where it is (原文 / 日本語).
  translated?: boolean;
}

/// A review tab's PR, and the session reviewing it once it is made (`seen`
/// once the board has it, so it goes when the board no longer does).
interface ReviewTab {
  url: string;
  /// "web#61", the tab's label.
  ref: string;
  title: string;
  session?: string;
  seen?: boolean;
}
/// Review tabs the strip shows before folding them into "レビュー n ▾", and
/// the pane width under which they fold anyway.
const REVIEW_TABS_MAX = 3;
const REVIEW_FOLD_W = 560;

/// The pane's tabs kept from the last run (PANE_TABS_KEY), with new ids; the
/// pages load when shown.
function restoreTabs(): { tabs: BrowserTab[]; active: string | null } {
  const saved = loadJson<SavedTabs>(PANE_TABS_KEY, { tabs: [], active: -1 });
  let n = 1;
  const tabs = saved.tabs.map((t): BrowserTab => {
    const pinned = PINNED_PAGES.find((p) => p.id === t.pinned);
    return { id: pinned?.id ?? `t${n++}`, url: t.url, openedFor: t.openedFor, title: t.title, loading: false, nav: 0, pinned: pinned ? true : undefined, term: t.term };
  });
  return { tabs, active: tabs[saved.active]?.id ?? null };
}

/// One Input mode space: the pages a todo or an input (or FREE_SPACE) has open on the
/// left and right, kept while the app runs (hidden while another is shown).
interface InputSpace {
  /// Tab ids on the left (its own pages, and the pane's terminals), and the
  /// one shown, or a new tab (⌘T) in front of them.
  lefts: string[];
  active: string | null;
  newTab?: boolean;
  /// The right page shown (a FOCUS_PAGES id or NOTE_TAB).
  right: string;
  /// The pages put on its left, so a subject's added since are known.
  pages: string[];
  /// Right pages to open where they were (a resumed space's), by kind.
  rightUrls: Record<string, string>;
}

/// What is kept of a subject's space across restarts (INPUT_SPACES_KEY).
interface SavedSpace {
  lefts: { url: string; title: string | null }[];
  active: number;
  right: string;
  rightUrls: Record<string, string>;
  pages: string[];
}

/// The browser pane: tabs of web pages, each a webview laid over this one on
/// a placeholder that follows the layout. `covered` hides them while a dialog
/// is up, since a native webview draws above everything in the page.
/// Pages offered on a new tab.
/// Pages the new tab page offers, which the user sets there (none at first).
interface StartPage {
  label: string;
  url: string;
}
const START_PAGES_KEY = "startPages";
/// Pages that stay in the pane as fixed tabs ahead of the others, opened
/// from there or the sidebar and never closed, so they keep their state.
/// Ids are letters and digits only, as the backend takes tab ids.
const PINNED_PAGES: { id: string; label: string; url: string; icon: IconName }[] = [
  { id: "pinchatgpt", label: "ChatGPT", url: "https://chatgpt.com/", icon: "chat" },
  { id: "pinclaude", label: "Claude Code", url: CLOUD_HOME, icon: "spark" },
];
/// Pinned pages whose text box takes the typing when the keyboard comes over
/// (⌃l), and the focus mode's selection pasted in.
const CHAT_PAGES = ["pinchatgpt", "pinclaude"];
/// What the focus mode's right side can keep: the pinned pages.
const FOCUS_PAGES = PINNED_PAGES;

/// The browser pane: a tab strip over the active tab's page, or a new-tab
/// page when no tab is picked.
function BrowserDock({ tabs, reviews, narrow, sessionOf, active, covered, report, onSelect, onPinned, onClose, onStopReview, onNewTab, onHide, onOpen, onAddress, onMove, onArchive, onToInput, onStrip }: {
  /// The review group's tabs, apart from `tabs` (the others).
  reviews: BrowserTab[];
  /// Too narrow for review tabs: they fold.
  narrow: boolean;
  sessionOf: (id: string | undefined) => Session | undefined;
  /// × on a review's tab, once confirmed: the review stops.
  onStopReview: (id: string) => void;
  /// A click on the tab strip: the page shown (the tab picked) takes the keyboard.
  onStrip: () => void;
  /// Puts the shown page in an input (AddToInputDialog).
  onToInput: () => void;
  tabs: BrowserTab[];
  active: BrowserTab | null;
  covered: boolean;
  report: (e: unknown) => void;
  onSelect: (id: string) => void;
  /// Shows a pinned page, opening it the first time.
  onPinned: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  onHide: () => void;
  /// Opens what was typed on the new tab page, in a new tab with the keyboard.
  onOpen: (url: string) => void;
  onAddress: (tab: string, url: string) => void;
  /// Moves a dragged tab to where another one is.
  onMove: (tab: string, to: string) => void;
  /// Archives the cloud session the shown tab is on and closes it (⌘⇧A).
  onArchive: () => void;
}) {
  // Tabs move by dragging with the pointer; the tab under it takes the dragged
  // one's place. (Pointer events rather than HTML drag and drop, which the
  // webview's file drop handling can swallow.)
  const [dragging, setDragging] = useState<string | null>(null);
  // Reviews waiting for a reply stay out when the others fold.
  const urgent = (t: BrowserTab) => sessionOf(t.review?.session)?.state === "needs_input";
  const { shown: shownReviews, folded } = foldReviews(reviews, urgent, narrow ? 0 : REVIEW_TABS_MAX);
  const [foldOpen, setFoldOpen] = useState(false);
  // The review whose × asks once before it stops it.
  const [stopping, setStopping] = useState<string | null>(null);
  const reviewTab = (t: BrowserTab) => {
    const r = t.review!;
    const s = sessionOf(r.session);
    return (
      <span key={t.id} data-tab={t.id} className={`browser-tab review${t.id === active?.id ? " on" : ""}${urgent(t) ? " urgent" : ""}`}>
        <button role="tab" aria-selected={t.id === active?.id} className="browser-tab-main" title={`${r.ref} ${r.title}${urgent(t) ? "（返事待ち）" : ""}`} onClick={() => onSelect(t.id)}>
          {(t.creating || s?.state === "running") && <span className="spinner" aria-label="作業中" />}
          <span className="mono review-ref">
            <span className="ellipsis">{r.ref.split("#")[0]}</span>#{r.ref.split("#")[1]}
          </span>
        </button>
        {stopping === t.id ? (
          <span className="review-stop">
            <button className="small danger" onClick={() => (setStopping(null), onStopReview(t.id))}>
              やめる
            </button>
            <button className="ghost small" onClick={() => setStopping(null)}>
              戻す
            </button>
          </span>
        ) : (
          <button className="ghost icon browser-tab-close" aria-label={`${r.ref} のレビューをやめる`} title="このレビューをやめる（セッションも止めます）" onClick={() => setStopping(t.id)}>
            <Icon name="close" size={11} />
          </button>
        )}
      </span>
    );
  };
  const dragTab = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < TAB_DRAG_PX) return;
      moved = true;
      setDragging(id);
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-tab]")?.dataset.tab;
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
  return (
    <section className="browser" aria-label="ブラウザ">
      {/* A press around the tabs leaves the keyboard with the page shown (a tab's own click gives it to its page). */}
      <div className="browser-tabs" role="tablist" onMouseDown={(e) => !(e.target as HTMLElement).closest("input, button, .browser-tab") && onStrip()}>
        {PINNED_PAGES.map((p) => {
          const t = tabs.find((x) => x.id === p.id);
          return (
            <span key={p.id} className={`browser-tab pinned${p.id === active?.id ? " on" : ""}`}>
              <button role="tab" aria-selected={p.id === active?.id} aria-busy={t?.loading} className="browser-tab-main" title={t?.url ?? p.url} onClick={() => onPinned(p.id)}>
                {t?.loading ? <span className="spinner" aria-label="読み込み中" /> : <Icon name={p.icon} size={13} />}
                <span className="ellipsis">{p.label}</span>
              </button>
            </span>
          );
        })}
        <span className="browser-tabs-sep" />
        {reviews.length > 0 && (
          <>
            {/* Folded, the reviews open in the strip itself (a menu would go under the page). */}
            {folded.length > 0 && (
              <span className={`browser-tab review-fold${!foldOpen && folded.some((t) => t.id === active?.id) ? " on" : ""}`}>
                <button className="browser-tab-main" aria-expanded={foldOpen} title={folded.map((t) => `${t.review!.ref} ${t.review!.title}`).join("\n")} onClick={() => setFoldOpen((o) => !o)}>
                  レビュー {folded.length}
                  <Icon name={foldOpen ? "chevron" : "chevronRight"} size={10} />
                </button>
              </span>
            )}
            {foldOpen && folded.map(reviewTab)}
            {shownReviews.map(reviewTab)}
            <span className="browser-tabs-sep" />
          </>
        )}
        {tabs.filter((t) => !t.pinned && !t.focus).map((t) => (
          <span
            key={t.id}
            data-tab={t.id}
            className={`browser-tab${t.id === active?.id ? " on" : ""}${t.id === dragging ? " dragging" : ""}`}
            onPointerDown={(e) => dragTab(e, t.id)}
          >
            <button role="tab" aria-selected={t.id === active?.id} aria-busy={t.loading} className="browser-tab-main" title={t.term?.command ?? t.url} onClick={() => onSelect(t.id)}>
              {t.loading && <span className="spinner" aria-label="読み込み中" />}
              {t.term && <span className="muted mono">$</span>}
              <span className="ellipsis">{t.title || hostOf(t.url)}</span>
            </button>
            <button className="ghost icon browser-tab-close" aria-label={`${t.title || hostOf(t.url)} を閉じる`} onClick={() => onClose(t.id)}>
              <Icon name="close" size={11} />
            </button>
          </span>
        ))}
        {!active && (
          <span className="browser-tab on">
            <button role="tab" aria-selected className="browser-tab-main">
              <span className="ellipsis">新しいタブ</span>
            </button>
          </span>
        )}
        <button className="ghost icon browser-new-tab" aria-label="新しいタブ（⌘T）" title="新しいタブ（⌘T）" onClick={onNewTab}>
          <Icon name="plus" size={13} />
        </button>
        <span className="grow" />
        <button className="ghost icon browser-hide" aria-label="ブラウザを隠す" title="ブラウザを隠す（タブは残ります）" onClick={onHide}>
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
      {active?.term ? (
        <TerminalView key={active.id} id={active.id} run={active.term} report={report} />
      ) : active ? (
        <TabView tab={active} covered={covered} report={report} onAddress={(url) => onAddress(active.id, url)} onArchive={cloudIdOfPage(active.url) ? onArchive : undefined} onToInput={active.pinned ? undefined : onToInput} />
      ) : (
        <NewTabPage onOpen={onOpen} />
      )}
    </section>
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

/// What the focus mode's left opens: a page, or a terminal the pane has.
type FocusItem = { url: string } | { terminal: string };

/// Picks a page for the study time's left: a URL, one of the theme's
/// inputs, or a terminal the pane has open.
function FocusPicker({ terminals, inputs, onPick, onClose }: {
  terminals: BrowserTab[];
  /// The theme's inputs, their pages to pick from.
  inputs: Input[];
  onPick: (item: FocusItem) => void;
  onClose: () => void;
}) {
  const toUrl = (text: string) => {
    const url = addressToUrl(text);
    return url && !url.startsWith(SEARCH_URL) ? url : null;
  };
  const pages = inputs.flatMap((i) => i.links.map((l) => ({ label: l.title || i.title, url: l.url, done: i.done })));
  return (
    <Modal title="左に開くページ" onClose={onClose}>
      <div className="focus-picker">
        <input
          autoFocus
          className="mono"
          placeholder="URL を入力して Enter"
          aria-label="開く URL"
          onKeyDown={(e) => {
            const url = isEnter(e) ? toUrl(e.currentTarget.value) : null;
            if (url) onPick({ url });
          }}
        />
        {pages.length > 0 && <h3>このテーマで読むもの</h3>}
        {pages.map((p) => (
          <div key={p.url} className="start-page">
            <button onClick={() => onPick({ url: p.url })}>
              {p.label}
              <span className="muted mono">
                {hostOf(p.url)}
                {p.done ? " · 読み終わった" : ""}
              </span>
            </button>
          </div>
        ))}
        {terminals.length > 0 && (
          <>
            <h3>ターミナル</h3>
            {terminals.map((t) => (
              <div key={t.id} className="start-page">
                <button onClick={() => onPick({ terminal: t.id })}>
                  <span>
                    <span className="muted mono">$ </span>
                    {t.title}
                  </span>
                  <span className="muted mono ellipsis">{t.term?.cwd}</span>
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}

/// The study time: the theme's pages on the left, an LLM to ask on the
/// right (its conversation the theme's own), after the review (`overlay`,
/// over both while it is up); 「読み終わった」 writes what was read into the
/// theme's document.
function FocusMode({ theme, lefts, left, right, rightKind, overlay, finishing, onFinish, covered, report, width, onResize, onRight, onAddress, onSelectLeft, onCloseLeft, onAddLeft, onOpenLeft, onLeftStrip, onExit, typing }: {
  theme: Theme | undefined;
  /// Which side has the keyboard: the browser's keys (⌘[ ⌘] ⌘L) are that side's only.
  typing: "left" | "right" | null;
  /// A click on the left's tab strip: its page shown (the tab picked) takes the keyboard.
  onLeftStrip: () => void;
  /// The left side's tabs (its own pages, and terminals), and the one shown
  /// (none for a new tab).
  lefts: BrowserTab[];
  left: BrowserTab | null;
  right: BrowserTab | undefined;
  /// Which right page is picked (a FOCUS_PAGES id).
  rightKind: string;
  /// The review, over the pages until it is done or skipped.
  overlay: React.ReactNode;
  /// While what was read goes into the theme's document.
  finishing: boolean;
  /// 「読み終わった」.
  onFinish: () => void;
  covered: boolean;
  report: (e: unknown) => void;
  width: number;
  onResize: (w: number) => void;
  /// A pinned page's id.
  onRight: (id: string) => void;
  onAddress: (tab: string, url: string) => void;
  onSelectLeft: (id: string) => void;
  onCloseLeft: (id: string) => void;
  /// Picks another page (or terminal) for the left.
  onAddLeft: () => void;
  /// A page from the left's new tab.
  onOpenLeft: (url: string) => void;
  onExit: () => void;
}) {
  const leftWeb = left && !left.term ? left.id : undefined;
  const hidden = covered || !!overlay;
  return (
    <div className="focus-mode">
      <section className="browser focus-left" aria-label="学ぶ時間の左側">
        <div className="browser-tabs" role="tablist" onMouseDown={(e) => !(e.target as HTMLElement).closest("input, button, .browser-tab") && onLeftStrip()}>
          {lefts.map((t) => (
            <span key={t.id} className={`browser-tab${t.id === left?.id ? " on" : ""}`}>
              <button role="tab" aria-selected={t.id === left?.id} className="browser-tab-main" title={t.term?.command ?? t.url} onClick={() => onSelectLeft(t.id)}>
                {t.loading && <span className="spinner" aria-label="読み込み中" />}
                {t.term && <span className="muted mono">$</span>}
                <span className="ellipsis">{t.title || hostOf(t.url)}</span>
              </button>
              <button className="ghost icon browser-tab-close" aria-label={`${t.title || hostOf(t.url)} を左から外す`} onClick={() => onCloseLeft(t.id)}>
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
          {!left && (
            <span className="browser-tab on">
              <button role="tab" aria-selected className="browser-tab-main">
                <span className="ellipsis">新しいタブ</span>
              </button>
            </span>
          )}
          <button className="ghost icon browser-new-tab" aria-label="左に開くページを選ぶ" title="左に開くページを選ぶ（⌘T で新しいタブ）" onClick={onAddLeft}>
            <Icon name="plus" size={13} />
          </button>
        </div>
        {left?.term ? (
          <TerminalView key={left.id} id={left.id} run={left.term} report={report} />
        ) : left ? (
          <TabView tab={left} covered={hidden} report={report} onAddress={(url) => onAddress(left.id, url)} keep={right?.id} keysOn={typing === "left"} />
        ) : (
          <NewTabPage onOpen={onOpenLeft} />
        )}
      </section>
      <aside className="browser-dock focus-right">
        <Resizer label="右側の幅" cssVar="--focus-right-w" width={width} min={DOCK_MIN_W} max={() => window.innerWidth - FOCUS_LEFT_MIN_W} onResize={onResize} />
        <section className="browser">
          <div className="browser-tabs focus-head">
            {theme && <b className="ellipsis study-theme">{theme.name}</b>}
            <div className="segmented" role="group" aria-label="右側で聞く LLM">
              {FOCUS_PAGES.map((p) => (
                <button key={p.id} className={rightKind === p.id ? "on" : ""} aria-pressed={rightKind === p.id} onClick={() => onRight(p.id)}>
                  <Icon name={p.icon} size={12} /> {p.label}
                </button>
              ))}
            </div>
            <span className="grow" />
            <span className="muted small-text" title="学ぶ時間のあいだは macOS の通知を出しません。終えたときに、増えたあなた待ちを知らせます">
              通知は止めています
            </span>
            <button className="small primary" disabled={finishing || !theme} title="左のページと右の会話から、要点とつまずいたところをテーマのノートに書き足します（Mac の Claude。少しかかります）" onClick={onFinish}>
              {finishing ? "書き足しています…" : "読み終わった"}
            </button>
            <button className="ghost small" title="学ぶ時間を終える（Esc）" onClick={onExit}>
              終える <span className="kbd">Esc</span>
            </button>
          </div>
          {right?.term ? (
            <TerminalView key={right.id} id={right.id} run={right.term} report={report} />
          ) : (
            right && <TabView key={right.id} tab={right} covered={hidden} report={report} onAddress={(url) => onAddress(right.id, url)} keep={leftWeb} keysOn={typing === "right"} />
          )}
        </section>
      </aside>
      {overlay && <div className="study-overlay">{overlay}</div>}
    </div>
  );
}

/// A study time's review: the questions Claude asks from the theme's
/// document, answered in one's own words (by voice too: macOS's dictation),
/// graded; skipping it takes one step more.
function ReviewPanel({ theme, report, onDone, onExit }: { theme: Theme; report: (e: unknown) => void; onDone: () => void; onExit: () => void }) {
  const [questions, setQuestions] = useState<ReviewQuestion[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [grading, setGrading] = useState(false);
  const [result, setResult] = useState<FeynmanAttempt | null>(null);
  const [skipping, setSkipping] = useState(false);
  useEffect(() => {
    api.reviewQuestions(theme.id).then(
      (qs) => (qs.length === 0 ? onDone() : (setQuestions(qs), setAnswers(qs.map(() => "")))),
      (e) => setFailed(String(e)),
    );
  }, [theme.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const grade = () => {
    if (!questions || grading) return;
    setGrading(true);
    api
      .reviewGrade(theme.id, questions, answers)
      .then(setResult, report)
      .finally(() => setGrading(false));
  };
  const gradeRef = useRef(grade);
  gradeRef.current = grade;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matches(e, "start") || e.isComposing) return;
      e.preventDefault();
      gradeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="review-panel">
      <header>
        <div className="actions">
          <span className="study-steps grow">
            <b>1 復習</b> · 2 読む · 3 残す　<span className="muted">通知は止めています</span>
          </span>
          <button className="ghost small" onClick={onExit}>
            学ぶ時間を終える
          </button>
        </div>
        <h2>前回までの「{theme.name}」から</h2>
        <p className="muted">ノートは見ずに、自分の言葉で。話して答えるときは、fn キーを2回押すと音声入力になります。答えは採点されて、テーマのノートに残ります。</p>
      </header>
      {failed && (
        <div className="notice danger-notice">
          <span className="grow">質問を作れませんでした：{failed}</span>
          <button onClick={onDone}>読みに進む</button>
        </div>
      )}
      {!questions && !failed && (
        <p className="muted">
          <span className="spinner" /> テーマのノートを読んで、質問を作っています…
        </p>
      )}
      {questions?.map((q, i) => {
        const verdict = result?.grade.verdicts.find((v) => v.point === i);
        return (
          <section key={i} className="review-question">
            <h3>
              {i + 1} / {questions.length}　{q.question}
            </h3>
            <textarea rows={4} value={answers[i] ?? ""} disabled={!!result} aria-label={`問${i + 1}の答え`} placeholder="自分の言葉で" onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))} />
            {verdict && (
              <p className={`verdict verdict-${verdict.verdict}`}>
                {VERDICT_MARK[verdict.verdict]} {VERDICT_LABEL[verdict.verdict]}：{verdict.note}
              </p>
            )}
          </section>
        );
      })}
      {questions && (
        <footer>
          {result ? (
            <>
              <span className="grow">
                理解度 <b>{result.score}%</b>（次の復習は {reviewAfterDays(result.score)} 日後）
              </span>
              <button className="primary" onClick={onDone}>
                読みに進む
              </button>
            </>
          ) : skipping ? (
            <>
              <span className="grow">復習を飛ばしますか？ 復習どきは変わりません。</span>
              <button className="ghost" onClick={() => setSkipping(false)}>
                戻る
              </button>
              <button className="danger" onClick={onDone}>
                飛ばす
              </button>
            </>
          ) : (
            <>
              <button className="ghost small" onClick={() => setSkipping(true)}>
                復習を飛ばす…
              </button>
              <span className="grow" />
              <button className="primary" disabled={grading || answers.every((a) => !a.trim())} onClick={grade}>
                {grading ? "採点しています…" : "採点する"} {!grading && <span className="kbd">⌘↵</span>}
              </button>
            </>
          )}
        </footer>
      )}
    </div>
  );
}

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

function TabView({ tab: active, covered: dialogUp, report, onAddress, onArchive, onToInput, keep, keysOn = true }: {
  /// Whether the browser's keys (⌘[ ⌘] ⌘L, zoom) are this tab's: in the Input
  /// mode, only the side that has the keyboard's.
  keysOn?: boolean;
  /// Set in the 作業スペース: puts the page in an input.
  onToInput?: () => void;
  tab: BrowserTab;
  covered: boolean;
  report: (e: unknown) => void;
  onAddress: (url: string) => void;
  /// Set on a cloud session's page.
  onArchive?: () => void;
  /// The tab shown beside this one (the focus mode's other side), left shown.
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
      .then(() => {
        // Only when the user asked for it and has not done anything since: a
        // page that took long to come up does not take the keyboard back.
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
        // Only from its own address: the Input mode shows two of these.
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
          {onToInput && (
            <button className="ghost small" title={`このページを学びに入れる（${keyLabel(keyOf("toInput"))}。テーマか、まだテーマにないものに）`} onClick={onToInput}>
              学びに入れる
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

function TodoPanel({ todo, allTodos, waiting, artifacts, local, groups, run, report, setStatus, onOpenTodo, onStart, onClose }: {
  todo: Todo;
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
      if ((e.target as HTMLElement).closest(TYPING) || document.querySelector("[role=dialog], .app.focus, .app[data-zone=sidebar]")) return;
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
  // A parent: its orchestrator (its own session), its plan, what waits under it, and what happened (経過).
  const isParent = children.length > 0 || !!todo.plan;
  const orchestrator = isParent ? liveSessions(todo).sort((a, b) => b.state_at - a.state_at)[0] : undefined;
  const under = waiting.filter((w) => w.todo && (w.todo.id === todo.id || w.todo.parent_id === todo.id));
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

        {isParent && (
          <section className="parent-head">
            <h3>指揮役</h3>
            {orchestrator ? (
              <div className="session-row">
                <StateBadge state={orchestrator.state} unread={orchestrator.unread} />
                <span className="session-main">
                  <span className="ellipsis">{sessionLabel(orchestrator)}</span>
                  <span className="muted">{placeOf(orchestrator)} · {ago(orchestrator.state_at)}</span>
                </span>
                <OpenMenu session={orchestrator} report={report} primary={orchestrator.state === "needs_input"} />
              </div>
            ) : (
              <p className="muted hint">動いていません。「計画させる」で始めると、指揮役がサブタスクを始めて見守ります。</p>
            )}
            {under.length > 0 && (
              <>
                <h3>
                  <span className="pill waiting">あなた待ち {under.length}</span>
                </h3>
                <ul className="rows compact">
                  {under.map((w) => (
                    <li key={w.key} className="row" onClick={() => w.todo && onOpenTodo(w.todo.id)}>
                      <span className="state state-needs_input">
                        <i />
                        {w.reasons.map((r) => WAIT_WORD[r]).join("・")}
                      </span>
                      <span className="mono muted">#{w.todo?.id}</span>
                      <span className="row-title ellipsis" title={w.line}>
                        {w.line}
                      </span>
                      {w.session && <OpenMenu session={w.session} report={report} primary />}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

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

        <section>
          <h3>セッション {liveSessions(todo).length > 0 && <span className="muted">{liveSessions(todo).length}</span>}</h3>
          {todo.sessions.length === 0 && <p className="muted hint">まだありません。⌘Enter で始めます。</p>}
          <ul className="sessions">
            {todo.sessions.map((s) => (
              <li key={s.session_id} className={`session-row state-bg-${s.state}`}>
                <StateBadge state={s.state} unread={s.unread} />
                <span className="session-main">
                  <span className="ellipsis">{sessionLabel(s)}</span>
                  <span className="muted">
                    {placeOf(s)} · {ago(s.state_at)}
                  </span>
                </span>
                <OpenMenu session={s} report={report} primary={s.state === "needs_input"} />
                <button className="ghost small" onClick={() => run(() => api.unlinkSession(s.session_id))}>
                  解除
                </button>
              </li>
            ))}
          </ul>
        </section>

        <div className="sheet-start">
          <button className="primary" onClick={onStart}>
            セッションを始める <span className="kbd">{keyLabel(keyOf("start"))}</span>
          </button>
          <span className="muted hint">
            {keyLabel(keyOf("editTitle"))} タイトル · {keyLabel(keyOf("editMemo"))} メモ · {keyLabel(keyOf("addSubtask"))} サブタスク · {keyLabel(keyOf("status"))} ステータス ·{" "}
            {keyLabel(keyOf("session"))} セッション · {keyLabel(keyOf("down"))} {keyLabel(keyOf("up"))} 前後の todo · Esc 閉じる
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

type SessionItem = import("./sessionTree").SessionItem;

/// The status as the kanban names it.
const statusLabel = (status: Status) => COLUMNS.find((c) => c.status === status)?.label ?? status;

/// A todo in the sessions table: its status, number and title.
function TodoCell({ todo, onOpen }: { todo: Todo; onOpen: (id: number) => void }) {
  return (
    <button className="link-button todo-cell" title={`${statusLabel(todo.status)} · #${todo.id} ${todo.title}`} onClick={(e) => (e.stopPropagation(), onOpen(todo.id))}>
      <StatusIcon status={todo.status} />
      <span className="mono">#{todo.id}</span>
      <span className="ellipsis">{todo.title}</span>
    </button>
  );
}
/// Repositories as tags, the first few and how many more.
const REPO_TAGS_MAX = 3;
function RepoTags({ repos }: { repos: string[] }) {
  if (repos.length === 0) return <span className="muted">—</span>;
  return (
    <span className="repos" title={repos.join("\n")}>
      {repos.slice(0, REPO_TAGS_MAX).map((repo) => (
        <span key={repo} className="tag ellipsis">
          {repoName(repo)}
        </span>
      ))}
      {repos.length > REPO_TAGS_MAX && <span className="muted">+{repos.length - REPO_TAGS_MAX}</span>}
    </span>
  );
}
/// A session row's colour backs its state's word: waiting for a reply, else
/// 新着, else running (idle and ended have none).
const rowState = (s: Session) => (s.state === "needs_input" ? " needs-input" : s.unread ? " unread" : s.state === "running" ? " running" : "");

/// What a subtask row without a session says.
const TODO_ROW: Record<"none" | "ended", [string, string]> = {
  none: ["未起動", "まだ始めていません"],
  ended: ["終了", "セッションは終わりました"],
};

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

/// Opens an artifact: a claude.ai page in the pane, a file with its app.
function useOpenArtifact(report: (e: unknown) => void) {
  const openInBrowser = useContext(BrowserContext);
  return (a: Artifact) => (a.kind === "file" && !/^https?:/.test(a.url) ? api.openPath(a.url).catch(report) : openInBrowser?.(a.url));
}

/// Artifacts as rows: their kind, name, todo and when.
function ArtifactRows({ artifacts, todos, report, onOpenTodo }: { artifacts: Artifact[]; todos: Todo[]; report: (e: unknown) => void; onOpenTodo: (id: number) => void }) {
  const open = useOpenArtifact(report);
  return (
    <ul className="rows compact">
      {artifacts.map((a) => {
        const todo = todos.find((t) => t.id === a.todo_id);
        return (
          <li key={a.id} className="row artifact-row" title={a.url} onClick={() => open(a)}>
            <span className="tag">{ARTIFACT_KIND[a.kind]}</span>
            <span className="row-title ellipsis">{artifactName(a)}</span>
            {todo && (
              <button className="tag todo-chip" onClick={(e) => (e.stopPropagation(), onOpenTodo(todo.id))} title={todo.title}>
                #{todo.id} {todo.title}
              </button>
            )}
            <span className="muted when">{ago(a.created_at)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/// What sessions made besides PRs, newest first, narrowed to a todo (a parent
/// with its subtasks).
function ArtifactsPage({ artifacts, todos, report, onOpenTodo }: { artifacts: Artifact[]; todos: Todo[]; report: (e: unknown) => void; onOpenTodo: (id: number) => void }) {
  const [todoFilter, setTodoFilter] = useState<number | null>(null);
  const parentOf = (id: number | null) => todos.find((t) => t.id === id)?.parent_id ?? null;
  const shown = todoFilter === null ? artifacts : artifacts.filter((a) => a.todo_id === todoFilter || parentOf(a.todo_id) === todoFilter);
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
      <div className="content">
        {shown.length === 0 && (
          <p className="muted empty">まだありません。セッションが claude.ai にアーティファクトやドキュメントを作ると、ひと区切りしたときにここへ並びます。Mac のファイルは、セッションが todo-sessions の add_artifact で登録します。</p>
        )}
        <ArtifactRows artifacts={shown} todos={todos} report={report} onOpenTodo={onOpenTodo} />
      </div>
    </>
  );
}

type SlackFilter = "unread" | "mention" | "thread" | "read";
const SLACK_FILTERS: SlackFilter[] = ["unread", "mention", "thread", "read"];
const SLACK_FILTER_LABEL: Record<SlackFilter, string> = { unread: "未読", mention: "メンション", thread: "スレッド", read: "既読" };
/// The Slack page's list width (px), dragged by its edge and kept.
const SLACK_LIST_KEY = "slackListWidth";
const SLACK_LIST_WIDTH = { min: 260, max: 720, initial: 380, step: 40 };
/// How far ⇧J / ⇧K scroll the thread.
const SLACK_SCROLL_PX = 160;

/// A row of the Slack page: a mention (#27) or a thread with new replies (#28).
interface SlackItem {
  key: string;
  kind: "mention" | "thread";
  channel: string;
  /// The thread it opens (a message not in one is its own).
  threadTs: string;
  /// The message it stands for: the mention, or the thread's latest reply.
  ts: string;
  channelName: string;
  userName: string;
  userImage: string | null;
  text: string;
  /// The user group mentioned, for a group's mention.
  via: string | null;
  read: boolean;
  permalink: string;
  newReplies: number;
}

const mentionKey = (m: { channel: string; ts: string }) => `m:${m.channel}:${m.ts}`;

function slackItems(slack: SlackView): SlackItem[] {
  const mentions: SlackItem[] = slack.messages.map((m) => ({
    key: mentionKey(m),
    kind: "mention",
    channel: m.channel,
    threadTs: m.thread_ts ?? m.ts,
    ts: m.ts,
    channelName: m.channel_name,
    userName: m.user_name,
    userImage: m.user_image,
    text: m.text,
    via: m.via,
    read: m.read,
    permalink: m.permalink,
    newReplies: 0,
  }));
  const threads: SlackItem[] = slack.threads.map((t) => ({
    key: `t:${t.channel}:${t.thread_ts}`,
    kind: "thread",
    channel: t.channel,
    threadTs: t.thread_ts,
    ts: t.latest_ts ?? t.thread_ts,
    channelName: t.channel_name,
    userName: t.latest_user_name ?? "",
    userImage: t.latest_image,
    text: t.latest_text ?? "",
    via: null,
    read: false,
    permalink: t.permalink,
    newReplies: t.new_replies,
  }));
  return [...mentions, ...threads].sort((a, b) => Number(b.ts) - Number(a.ts));
}

/// 「Todo にする」's memo: who said it where, what, and its link.
const slackMemo = (i: SlackItem) => `Slack #${i.channelName} の ${i.userName}さんから:\n${i.text}\n\n${i.permalink}`;

/// Slack (#27, #28): the unread mentions of the user and of their user
/// groups, and the threads they are in with new replies, newest first. One
/// stays unread until 既読にする (e) takes it off; 既読 shows the read mentions.
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
  const [selected, setSelected] = useState<string | null>(pick);
  useEffect(() => {
    if (pick) setSelected(pick);
  }, [pick]);
  const [width, setWidth] = useState(() => loadJson<number>(SLACK_LIST_KEY, SLACK_LIST_WIDTH.initial));
  const openInBrowser = useContext(BrowserContext);
  const openLink = (url: string) => (openInBrowser ? openInBrowser(url) : void api.openLink(url).catch(report));
  const items = slackItems(slack);
  const unread = items.filter((i) => !i.read);
  const counts: Record<SlackFilter, number> = {
    unread: unread.length,
    mention: unread.filter((i) => i.kind === "mention" && i.via === null).length,
    thread: unread.filter((i) => i.kind === "thread").length,
    read: items.length - unread.length,
  };
  const inFilter = (i: SlackItem) => (filter === "read" ? i.read : !i.read && (filter === "unread" || (filter === "thread" ? i.kind === "thread" : i.kind === "mention" && i.via === null)));
  // The one picked stays while it is read, so it does not jump away.
  const shown = items.filter((i) => i.key === selected || inFilter(i));
  const current = items.find((i) => i.key === selected) ?? null;
  // ↑↓ or j k pick a row, Enter shows its thread.
  const { cursorId, setCursor, list } = useRowCursor(
    shown.map((i) => i.key),
    (id) => setSelected(id),
  );
  /// 既読にする: off the unread, and on to the next row.
  const done = (item: SlackItem) => {
    const at = shown.findIndex((i) => i.key === item.key);
    const next = shown.slice(at + 1).find((i) => !i.read) ?? shown.slice(0, at).reverse().find((i) => !i.read);
    run(() => (item.kind === "mention" ? api.slackRead(item.channel, item.ts) : api.slackThreadSeen(item.channel, item.threadTs)));
    setSelected(next?.key ?? null);
    if (next) setCursor(next.key);
  };
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const muteRef = useRef<() => void>(() => {});
  const keepWidth = (w: number) => {
    const next = Math.min(Math.max(w, SLACK_LIST_WIDTH.min), SLACK_LIST_WIDTH.max);
    setWidth(next);
    remember(SLACK_LIST_KEY, JSON.stringify(next));
  };
  // The page's keys (keymap.ts, "Slack の画面"); j k and Enter are the list's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest(TYPING) || document.querySelector(".app.focus, .app[data-zone=sidebar], .sheet-backdrop, [role=dialog]")) return;
      if (matches(e, "slackFilter")) setFilter((f) => SLACK_FILTERS[(SLACK_FILTERS.indexOf(f) + 1) % SLACK_FILTERS.length]);
      else if (matches(e, "slackNarrower")) keepWidth(width - SLACK_LIST_WIDTH.step);
      else if (matches(e, "slackWider")) keepWidth(width + SLACK_LIST_WIDTH.step);
      else if (!current) return;
      else if (e.key === "Escape") setSelected(null);
      else if (matches(e, "slackDone")) done(current);
      else if (matches(e, "slackReply")) replyRef.current?.focus();
      else if (matches(e, "slackTodo")) onTodo(slackMemo(current));
      else if (matches(e, "slackOpen")) openLink(current.permalink);
      else if (matches(e, "slackMute")) muteRef.current();
      else if (matches(e, "slackScrollDown")) threadRef.current?.scrollBy({ top: SLACK_SCROLL_PX });
      else if (matches(e, "slackScrollUp")) threadRef.current?.scrollBy({ top: -SLACK_SCROLL_PX });
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
        {slack.connected && (
          <span className="muted slack-live" title={slack.live ? "Socket Mode でつながっています。投稿されたその場で届きます" : "設定でアプリのトークン（xapp-…）を入れると、その場で届きます"}>
            <span className={`dot ${slack.live ? "live" : ""}`} /> {slack.live ? `リアルタイム（${slack.last_event_at ? `最後の受信 ${ago(slack.last_event_at)}` : "まだ受信なし"}）` : "2分おきに確認"}
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
        <div className="content flush slack-page" style={{ gridTemplateColumns: current ? `${width}px 6px minmax(0, 1fr)` : "minmax(0, 1fr)" }}>
          <div className="slack-list" ref={list}>
            {slack.error && <p className="error-text pad">Slack から読めませんでした：{slack.error}</p>}
            {shown.length === 0 && <p className="muted pad">{filter === "read" ? "既読はまだありません。" : "未読はありません。"}</p>}
            <ul className="rows">
              {shown.map((i) => (
                <li key={i.key} data-row={i.key} className={`row slack-row${i.read ? "" : " slack-unread"}${i.key === selected ? " selected" : ""}${i.key === cursorId ? " cursor" : ""}`} onClick={() => (setCursor(i.key), setSelected(i.key))}>
                  <SlackAvatar name={i.userName} image={i.userImage} size={32} />
                  <span className="slack-row-main">
                    <span className="slack-meta">
                      <b className="ellipsis">{i.userName}</b>
                      <span className="ellipsis">#{i.channelName}</span>
                      {i.via && <span className="tag">@{i.via}</span>}
                      {i.kind === "thread" && <span className="tag">スレッド・新しい返信 {i.newReplies}</span>}
                      <span className="grow" />
                      <span className="slack-time">{ago(Number(i.ts))}</span>
                    </span>
                    <span className="slack-body">{i.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {current && (
            <>
              <div className="slack-split" role="separator" aria-orientation="vertical" aria-label="一覧の幅" onPointerDown={resize} />
              <SlackThread
                key={current.key}
                item={current}
                me={slack.user_id}
                replyRef={replyRef}
                bodyRef={threadRef}
                muteRef={muteRef}
                report={report}
                onLink={openLink}
                onDone={() => done(current)}
                onTodo={() => onTodo(slackMemo(current))}
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
function SlackText({ text, me, onLink }: { text: string; me?: string; onLink: (url: string) => void }) {
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
          return (
            <span key={i} className={p.v.startsWith(":") ? "slack-emoji-name" : undefined}>
              {p.v}
            </span>
          );
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

/// Messages from one person within this many seconds read as one.
const SLACK_GROUP_SECS = 300;
/// Mention suggestions shown at once.
const SLACK_SUGGESTIONS = 8;
/// The people and groups to mention, asked once a run.
let slackDirectory: Promise<SlackMentionable[]> | null = null;
/// The `@…` being written just before the caret.
const MENTION_TYPED = /(?:^|[\s　])@([^\s@　]*)$/;

/// A Slack row's thread (a message not in one, alone), the message itself
/// marked: read again as the thread moves (Socket Mode), and answered from
/// here (#30) with mentions suggested after "@".
function SlackThread({ item, me, replyRef, bodyRef, muteRef, report, onLink, onDone, onTodo, onClose }: {
  item: SlackItem;
  me: string | null;
  /// The reply box and the messages' scroller, for the page's keys.
  replyRef: React.RefObject<HTMLTextAreaElement | null>;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  /// Set to this thread's mute toggle, for the page's m.
  muteRef: React.RefObject<() => void>;
  report: (e: unknown) => void;
  onLink: (url: string) => void;
  onDone: () => void;
  onTodo: () => void;
  /// Closes the thread (Esc too); the list takes the width.
  onClose: () => void;
}) {
  const [thread, setThread] = useState<SlackThreadMessage[] | null>(null);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [thread?.length]);
  const toggleMute = () => api.slackMuteThread(channel, threadTs, !muted).then(() => setMuted(!muted), report);
  muteRef.current = toggleMute;
  // Mentions: what is being written after "@", the candidates, and the ones picked (name → how Slack writes it).
  const [people, setPeople] = useState<SlackMentionable[]>([]);
  const [typed, setTyped] = useState<{ query: string; from: number } | null>(null);
  const [active, setActive] = useState(0);
  const picked = useRef(new Map<string, string>());
  const inThread = new Set(thread?.map((t) => t.user_name));
  const candidates = typed
    ? people
        .map((p) => {
          const q = typed.query.toLowerCase();
          const names = [p.name, ...p.also].map((n) => n.toLowerCase());
          const rank = !q ? 1 : names.some((n) => n.startsWith(q)) ? 0 : names.some((n) => n.includes(q)) ? 1 : 2;
          return { p, rank: rank - (inThread.has(p.name) ? 0.5 : 0) };
        })
        .filter((c) => c.rank < 2)
        .sort((a, b) => a.rank - b.rank)
        .slice(0, SLACK_SUGGESTIONS)
        .map((c) => c.p)
    : [];
  const watchTyping = (text: string, caret: number) => {
    const m = MENTION_TYPED.exec(text.slice(0, caret));
    setTyped(m ? { query: m[1], from: caret - m[1].length - 1 } : null);
    setActive(0);
    if (m && !slackDirectory) slackDirectory = api.slackDirectory();
    if (m) slackDirectory?.then(setPeople, (e) => ((slackDirectory = null), report(e)));
  };
  const pick = (p: SlackMentionable) => {
    const box = replyRef.current;
    if (!typed || !box) return;
    const caret = box.selectionStart;
    const next = `${reply.slice(0, typed.from)}@${p.name} ${reply.slice(caret)}`;
    picked.current.set(p.name, p.token);
    setReply(next);
    setTyped(null);
    const at = typed.from + p.name.length + 2;
    requestAnimationFrame(() => box.setSelectionRange(at, at));
  };
  /// The reply as Slack takes it: the picked mentions written as Slack writes them.
  const withMentions = (text: string) =>
    [...picked.current.entries()].sort((a, b) => b[0].length - a[0].length).reduce((t, [name, token]) => t.split(`@${name}`).join(token), text);
  const send = () => {
    if (!reply.trim() || sending) return;
    setSending(true);
    api
      .slackReply(channel, threadTs, withMentions(reply))
      .then(() => {
        setReply("");
        picked.current.clear();
        read();
      }, report)
      .finally(() => setSending(false));
  };
  const title = item.kind === "thread" ? `スレッド・新しい返信 ${item.newReplies} 件` : item.via ? `@${item.via} へのメンション` : `${item.userName}さんからのメンション`;
  return (
    <section className="slack-thread" aria-label="スレッド">
      <div className="slack-thread-head">
        <span className="grow ellipsis">
          <b>#{item.channelName}</b> <span className="muted">· {title}</span>
        </span>
        {!item.read && (
          <button className="small" title="一覧から消して次へ" onClick={onDone}>
            既読にする <span className="kbd">{keyLabel(keyOf("slackDone"))}</span>
          </button>
        )}
        <button className="ghost small" onClick={onTodo}>
          Todo にする <span className="kbd">{keyLabel(keyOf("slackTodo"))}</span>
        </button>
        <button className="ghost small" title="このスレッドの新しい返信を、未読に数えない（メンションは届きます）" onClick={toggleMute}>
          {muted ? "返信をまた数える" : "返信を数えない"} <span className="kbd">{keyLabel(keyOf("slackMute"))}</span>
        </button>
        <button className="ghost small" onClick={() => onLink(item.permalink)}>
          Slack で開く <span className="kbd">{keyLabel(keyOf("slackOpen"))}</span>
        </button>
        <button className="ghost icon" aria-label="スレッドを閉じる（Esc）" title="スレッドを閉じる（Esc）" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="slack-thread-body" ref={bodyRef}>
        {error && <p className="error-text pad">スレッドを読めませんでした：{error}</p>}
        {!thread && !error && <p className="muted pad">読んでいます…</p>}
        {thread?.map((t, i) => {
          const prev = thread[i - 1];
          const joined = i > 1 && prev && prev.user_name === t.user_name && Number(t.ts) - Number(prev.ts) < SLACK_GROUP_SECS;
          return (
            <div key={t.ts}>
              {i === 1 && <div className="slack-replies">{thread.length - 1} 件の返信</div>}
              <div className={`slack-msg${joined ? " joined" : ""}${t.ts === item.ts ? " this" : ""}`}>
                {joined ? <span className="slack-avatar-space slack-time">{slackTime(t.ts).slice(-5)}</span> : <SlackAvatar name={t.user_name} image={t.user_image} size={36} />}
                <div className="slack-msg-main">
                  {!joined && (
                    <div className="slack-msg-head">
                      <b className={t.mine ? "slack-me" : ""}>{t.user_name}</b>
                      <span className="slack-time">{slackTime(t.ts)}</span>
                    </div>
                  )}
                  <SlackText text={t.text} me={me ?? undefined} onLink={onLink} />
                </div>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      <div className="slack-reply">
        {candidates.length > 0 && (
          <ul className="slack-suggest" role="listbox" aria-label="メンションの候補">
            {candidates.map((p, i) => (
              <li key={p.token} role="option" aria-selected={i === active} className={i === active ? "on" : ""} onMouseDown={(e) => (e.preventDefault(), pick(p))}>
                <SlackAvatar name={p.name} image={p.image} size={20} />
                <b>{p.name}</b>
                <span className="muted ellipsis">{p.token.startsWith("<!subteam") ? "ユーザーグループ" : p.also.join(" · ")}</span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={replyRef}
          rows={2}
          value={reply}
          placeholder={`スレッドに返信（${keyLabel(keyOf("slackReply"))} でここへ、@ でメンション、⌘Enter で送る、Esc で一覧へ）`}
          aria-label="スレッドに返信"
          onChange={(e) => {
            setReply(e.target.value);
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
        <button className="primary small" disabled={!reply.trim() || sending} onClick={send}>
          {sending ? "送っています…" : "返信する"} <span className="kbd">⌘↵</span>
        </button>
      </div>
    </section>
  );
}

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
      {account && <SlackRealtime realtime={account.realtime} report={report} onChange={(realtime) => setAccount({ ...account, realtime })} />}
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
      <p className="muted">アプリのトークン（xapp-…、connections:write）を入れると、Socket Mode で投稿されたその場でメンションが届きます。入れないあいだは2分おきに確かめます。</p>
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

export type SessionFilter = "all" | "waiting" | "running" | "unread";
const SESSION_FILTERS: { key: SessionFilter; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "waiting", label: "あなた待ち" },
  { key: "running", label: "作業中" },
  { key: "unread", label: "新着" },
];

/// Where a session runs and what runs it: "Cloud · Claude", "herdr · Codex".
const placeOf = (s: Session) => `${isCloud(s) ? "Cloud" : "herdr"} · ${s.agent === "codex" ? "Codex" : "Claude"}`;

/// The sessions page, the place to keep up with what runs: あなた待ち pinned
/// on top, then the sessions as they changed last (a parent's under it).
function SessionsPage({ board, waiting, filter, onFilter, run, report, onOpenTodo, onQuick, onShowPrs }: {
  board: Board;
  waiting: WaitItem[];
  filter: SessionFilter;
  onFilter: (f: SessionFilter) => void;
  run: (f: () => Promise<unknown>) => void;
  report: (e: unknown) => void;
  onOpenTodo: (id: number) => void;
  onQuick: () => void;
  onShowPrs: () => void;
}) {
  const [showEnded, setShowEnded] = useState(false);
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const openInBrowser = useContext(BrowserContext);
  const openCloud = useContext(OpenCloudContext);
  const terminal = useContext(TerminalContext);
  const fix = useContext(FixContext);
  // A row opens its session as 開く does (⌥Enter: the ways to open it).
  const open = (s: Session) => (isCloud(s) && openCloud ? openCloud(s.session_id) : openLocal(terminal, s.session_id, report, true));
  const inRepo = (repos: string[] | undefined) => repoFilter === null || laneKey(repos) === repoFilter;
  const waits = waiting.filter((w) => inRepo(w.todo?.repos ?? w.session?.repos ?? (w.review ? [w.review.repo] : undefined)));
  const waitingIds = new Set(waits.flatMap((w) => (w.session ? [w.session.session_id] : [])));
  // Todos set aside (pending), and the subtasks of one, are out with their
  // sessions (one asking is in あなた待ち). Reviews show only there too.
  const aside = new Set(board.todos.filter((t) => t.status === "pending" || board.todos.find((p) => p.id === t.parent_id)?.status === "pending").map((t) => t.id));
  const all = sessionItemsOf(board).filter(
    (i) => inRepo(i.todo?.repos ?? i.session.repos) && !(i.todo && aside.has(i.todo.id)) && listedSession(i.session) && !waitingIds.has(i.session.session_id),
  );
  const live = all.filter((i) => i.session.state !== "ended");
  const counts: Record<SessionFilter, number> = {
    all: live.length + waits.length,
    waiting: waits.length,
    running: live.filter((i) => i.session.state === "running").length,
    unread: live.filter((i) => i.session.unread).length,
  };
  const pass = (i: SessionItem) => filter === "all" || (filter === "unread" ? i.session.unread : filter === "running" && i.session.state === "running");
  // Todos with subtasks head groups (sessionTree.ts); a folded group shows its head only.
  // Whether a subtask ever had a session goes by all of them (one asking is above, in あなた待ち).
  const { ordered } = sessionTree(filter === "waiting" ? [] : (showEnded ? all : live).filter(pass), sessionItemsOf(board), board.todos, showEnded, filter === "all");
  const [folded, setFolded] = useState<Set<number>>(new Set());
  const fold = (id: number, on?: boolean) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (on ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  const rows: TreeRow[] = ordered.flatMap((g) => g.filter((r) => r.kind === "group" || !folded.has(r.group ?? -1)));
  const waitsShown = filter === "all" || filter === "waiting" ? waits : [];
  // Review requests are no sessions: one line for them, which opens the PR page.
  const asks = waitsShown.filter(isReviewAsk).length;
  const shownWaits = waitsShown.filter((w) => !isReviewAsk(w));
  const ended = all.length - live.length;
  // Cloud sessions done with their turn, which the bulk archive takes.
  const archivable = live.filter((i) => isCloud(i.session) && i.session.state === "idle").map((i) => i.session.session_id);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const startable = (r: TreeRow) => r.kind === "todo" && r.state !== "ended" && r.todo.status !== "done";
  // A subtask row with no session: its PR when it has one, else its sheet.
  const openTodoRow = (todo: Todo) => (todo.pr_url && openInBrowser ? openInBrowser(todo.pr_url) : onOpenTodo(todo.id));
  /// あなた待ち's row: its session, else its todo's sheet, else the PR asking for a review.
  const openWait = (w: WaitItem) => (w.session ? open(w.session) : w.todo ? onOpenTodo(w.todo.id) : w.review && openInBrowser?.(w.review.url));
  // ↑↓ or j k pick a row, Enter opens it (a group's head its todo, a
  // subtask not started its launch sheet), ⌥Enter the ways to open it; h
  // folds the group the row is in, l opens it.
  const ids = [...shownWaits.map((w) => `w:${w.key}`), ...(asks > 0 ? [ASKS_ROW] : []), ...rows.map((r) => r.id)];
  const { cursorId, setCursor, list: listRef } = useRowCursor(
    ids,
    (id, alt, row) => {
      if (alt) return row.querySelector<HTMLButtonElement>(".open-caret")?.click();
      if (id === ASKS_ROW) return onShowPrs();
      const w = shownWaits.find((x) => `w:${x.key}` === id);
      if (w) return openWait(w);
      const r = rows.find((x) => x.id === id);
      if (r?.kind === "group") return onOpenTodo(r.todo.id);
      if (r?.kind === "todo") return openTodoRow(r.todo);
      if (r?.kind === "session") open(r.session);
    },
    (e, id) => {
      const r = rows.find((x) => x.id === id);
      const w = shownWaits.find((x) => `w:${x.key}` === id);
      // ⌘⇧A puts the session away: a Cloud one archived, a Local one off the list.
      if (matches(e, "archive")) {
        const s = r?.kind === "session" ? r.session : w?.session;
        if (!s) return false;
        run(() => (isCloud(s) ? api.archiveSessions([s.session_id]) : api.hideSession(s.session_id)));
        return true;
      }
      const group = r?.kind === "group" ? r.todo.id : r?.group;
      if (group === undefined || !(matches(e, "left") || matches(e, "right"))) return false;
      fold(group, matches(e, "left"));
      if (matches(e, "left")) setCursor(groupRowId(group));
      return true;
    },
  );
  return (
    <>
      <header className="toolbar">
        <h1>セッション</h1>
        <div className="segmented" role="group" aria-label="絞り込み">
          {SESSION_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`${filter === f.key ? "on" : ""}${f.key === "waiting" && counts.waiting > 0 ? " warn" : ""}`}
              aria-pressed={filter === f.key}
              onClick={() => onFilter(f.key)}
            >
              {f.label} {counts[f.key]}
            </button>
          ))}
        </div>
        <PlaceFilter places={[...new Set(sessionItemsOf(board).map((i) => laneKey(i.todo?.repos ?? i.session.repos)))]} value={repoFilter} onChange={setRepoFilter} />
        <span className="grow" />
        {confirmArchive ? (
          <span className="inline-confirm">
            ひと区切りの Cloud {archivable.length} 件をアーカイブしますか？
            <button className="primary small" onClick={() => (setConfirmArchive(false), run(() => api.archiveSessions(archivable)))}>
              アーカイブ
            </button>
            <button className="ghost small" onClick={() => setConfirmArchive(false)}>
              やめる
            </button>
          </span>
        ) : (
          archivable.length > 0 && (
            <button onClick={() => setConfirmArchive(true)} title="ひと区切り（返事待ち・作業中でない）の Cloud セッションをまとめてアーカイブ">
              ひと区切りの Cloud をアーカイブ {archivable.length}
            </button>
          )
        )}
        <button onClick={onQuick} title="todo に紐づけずにホームフォルダの claude を開く">
          <Icon name="spark" size={13} /> ちょっと Claude
        </button>
      </header>
      <div className="content" ref={listRef}>
        {waitsShown.length > 0 && (
          <section className="waiting-section">
            <div className="section-head">
              <span className="pill waiting">
                <i />
                あなた待ち {waitsShown.length}
              </span>
              <span className="muted">返事待ち・CI 失敗・修正依頼・未着手のレビュー依頼</span>
            </div>
            <ul className="rows">
              {shownWaits.map((w) => {
                const s = w.session;
                const todo = w.todo;
                return (
                  <li key={w.key} data-row={`w:${w.key}`} className={`row wait-row${`w:${w.key}` === cursorId ? " cursor" : ""}`} onClick={() => (setCursor(`w:${w.key}`), openWait(w))}>
                    <span className="state state-needs_input">
                      <i />
                      {w.reasons.map((r) => WAIT_WORD[r]).join("・")}
                    </span>
                    <span className="wait-main">
                      <span className="row-title ellipsis">
                        {todo && <span className="mono muted">#{todo.id} </span>}
                        {s ? sessionLabel(s) : (todo?.title ?? w.review?.title)}
                      </span>
                      <span className="wait-line ellipsis" title={w.line}>
                        {w.line}
                      </span>
                    </span>
                    <span className="muted ellipsis wait-meta">
                      {[todo?.parent_id ? `親 #${todo.parent_id}` : null, s ? placeOf(s) : null, s ? ago(s.state_at) : null].filter(Boolean).join(" · ")}
                    </span>
                    <span className="row-actions">
                      {todo && w.reasons.includes("escalated") && (
                        <button className="small" title="指揮役から回されたことに対応しました（あなた待ちから外します）" onClick={(e) => (e.stopPropagation(), run(() => api.clearEscalation(todo.id)))}>
                          対応した
                        </button>
                      )}
                      {s && todo && fix && (w.reasons.includes("ci") || w.reasons.includes("changes")) && (
                        <button className="small" title="元のセッションに、直すところを送ります（画面もフォーカスも動きません）" onClick={(e) => (e.stopPropagation(), fix(s, todo))}>
                          再開して直させる
                        </button>
                      )}
                      {s && <OpenMenu session={s} report={report} primary={w.reasons.includes("needs_input")} />}
                    </span>
                  </li>
                );
              })}
              {asks > 0 && (
                <li data-row={ASKS_ROW} className={`row wait-row${ASKS_ROW === cursorId ? " cursor" : ""}`} onClick={() => (setCursor(ASKS_ROW), onShowPrs())}>
                  <span className="state state-needs_input">
                    <i />
                    {WAIT_WORD.review}
                  </span>
                  <span className="row-title">新着のレビュー依頼が {asks} 件あります</span>
                  <span className="muted wait-meta">PR の画面で始めます</span>
                  <span className="row-actions">
                    <Icon name="pr" size={13} />
                  </span>
                </li>
              )}
            </ul>
          </section>
        )}

        {filter !== "waiting" && (
          <section>
            {rows.length === 0 && waitsShown.length === 0 && <p className="muted empty">該当するセッションはありません。</p>}
            <ul className="rows">
              {rows.map((r) => {
                const cursor = r.id === cursorId ? " cursor" : "";
                if (r.kind === "group") {
                  const open = !folded.has(r.todo.id);
                  const under = waiting.filter((w) => w.todo && (w.todo.id === r.todo.id || w.todo.parent_id === r.todo.id)).length;
                  return (
                    <li key={r.id} data-row={r.id} className={`row session-group${cursor}`} onClick={() => (setCursor(r.id), onOpenTodo(r.todo.id))}>
                      <button className="ghost icon" aria-label={open ? "畳む" : "開く"} aria-expanded={open} onClick={(e) => (e.stopPropagation(), fold(r.todo.id))}>
                        <Icon name={open ? "chevron" : "chevronRight"} size={12} />
                      </button>
                      <StatusIcon status={r.todo.status} />
                      <span className="mono muted">#{r.todo.id}</span>
                      <span className="row-title ellipsis">{r.todo.title}</span>
                      {r.todo.repos.length > 0 && <RepoTags repos={r.todo.repos} />}
                      <span className="muted">{statusLabel(r.todo.status)}</span>
                      <span className="tag" title="サブタスクのうち Done になったもの">
                        サブタスク {r.done}/{r.total}
                      </span>
                      {under > 0 && <span className="pill waiting">あなた待ち {under}</span>}
                    </li>
                  );
                }
                // In a group: its parent's own sessions one step in, its subtasks' two.
                // Outside any group: a block of its own, at a group's level.
                const tree = r.group !== undefined ? ` in-group${r.child ? " child" : ""}${r.last ? " last" : ""}` : " lone";
                if (r.kind === "todo") {
                  const [state, says] = TODO_ROW[r.state];
                  return (
                    <li
                      key={r.id}
                      data-row={r.id}
                      className={`row sessions-grid${tree}${cursor}${r.todo.status === "done" ? " done" : ""}`}
                      title={r.todo.pr_url ? "PR を開く" : undefined}
                      onClick={() => (setCursor(r.id), openTodoRow(r.todo))}
                    >
                      <span className="muted ellipsis" title={says}>
                        {state}
                      </span>
                      <TodoCell todo={r.todo} onOpen={onOpenTodo} />
                      <span className="muted ellipsis">{r.todo.pr_state ? `PR ${PR_STAGE[r.todo.pr_state][1]}` : ""}</span>
                      <span className="muted">{r.todo.pr_url ? "Enter で PR" : startable(r) ? "Enter で開始" : "—"}</span>
                      <span />
                    </li>
                  );
                }
                const { session: s, todo } = r;
                return (
                  <li
                    key={r.id}
                    data-row={r.id}
                    className={`row sessions-grid${tree}${cursor}${s.state === "ended" ? " done" : ""}${rowState(s)}`}
                    onClick={() => (setCursor(r.id), open(s))}
                  >
                    <StateBadge state={s.state} unread={s.unread} />
                    <span className="ellipsis">{sessionLabel(s)}</span>
                    {todo ? <TodoCell todo={todo} onOpen={onOpenTodo} /> : <span className="muted">Todo なし</span>}
                    <span className="muted ellipsis">
                      {placeOf(s)} · {ago(s.state_at)}
                    </span>
                    <OpenMenu session={s} report={report} />
                  </li>
                );
              })}
            </ul>
            {ended > 0 && (
              <button className="ghost small show-ended" onClick={() => setShowEnded((v) => !v)}>
                {showEnded ? "終了したセッションを隠す" : `終了したセッション ${ended} 件`}
              </button>
            )}
          </section>
        )}
      </div>
    </>
  );
}

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
  const beginWeb = useContext(BeginWebContext);
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
    run(async () => {
      // A review asking before it submits on Cloud gets its tab, made behind; one submitting on its own none.
      const finish = prefs.runner === "cloud" && !prefs.auto ? beginWeb?.({ url: p.url, ref: `${repoName(p.repo)}#${p.number}`, title: p.title }) : undefined;
      try {
        const id = await api.startReview({
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
        finish?.(id);
      } catch (e) {
        finish?.(null);
        throw e;
      } finally {
        mark(p.url, false);
      }
    });
  };
  return { startReview, starting };
}

type PrFilter = "all" | "review" | "mine";

/// Where a review asked of the user stands, by its session.
function reviewStanding(p: Pr, sessions: Session[], submitted: Map<string, string>, now: number): { word: string; cls: string; failed?: Session } {
  const s = sessions.filter((x) => x.review_url === p.url && !x.hidden).sort((a, b) => b.state_at - a.state_at)[0];
  if (!s) return submitted.has(p.url) ? { word: `提出済み（${REVIEW_VERDICT[submitted.get(p.url)!] ?? submitted.get(p.url)}）`, cls: "state-merged" } : { word: "未着手", cls: "state-needs_input" };
  if (s.state === "needs_input") return { word: "返事待ち", cls: "state-needs_input" };
  if (isFailedReview(s, now)) return { word: "失敗", cls: "state-ended", failed: s };
  return { word: s.review_auto ? "レビュー中（自動で提出）" : "レビュー中", cls: "state-running" };
}

function PrsPage({ prs, prsLoading, prError, todos, sessions, submitted, local, browserUrl, run, onRefresh, onOpenTodo }: {
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
  /// The page the browser pane shows, to mark its row.
  browserUrl: string | null;
  run: (f: () => Promise<unknown>) => void;
  onRefresh: () => void;
  onOpenTodo: (id: number) => void;
}) {
  // Review requests first: they are what waits on the user.
  const [filter, setFilter] = useState<PrFilter>("review");
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const openInBrowser = useContext(BrowserContext);
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
  // ↑↓ or j k pick a PR, Enter starts reviewing a request not started yet
  // (other rows it opens in the pane), ⌘Enter (and ⌥Enter) opens it in the
  // pane; a, s and r switch how reviews start.
  const { cursorId, setCursor, list } = useRowCursor([...shownReview.map((p) => rowId("review", p.url)), ...shownMine.map((p) => rowId("mine", p.url))], (id, alt, row) => {
    const p = review.find((x) => rowId("review", x.url) === id);
    if (p && !alt && !starting.has(p.url) && reviewStanding(p, sessions, submitted, now).word === "未着手") return startReview(p);
    row.click();
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest(TYPING) || document.querySelector(".app.focus, .app[data-zone=sidebar], .sheet-backdrop")) return;
      if (matches(e, "start") && cursorId) list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(cursorId)}"]`)?.click();
      else if (filter !== "mine" && matches(e, "reviewAgent")) setPrefs({ agent: prefs.agent === "claude" ? "codex" : "claude" });
      else if (filter !== "mine" && matches(e, "reviewSubmit")) setPrefs({ auto: !prefs.auto });
      else if (filter !== "mine" && matches(e, "reviewRunner") && prefs.agent !== "codex") setPrefs({ runner: prefs.runner === "cloud" ? "herdr" : "cloud" });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const reviewerLabel = (names: string[]) => (names.length === 0 ? "レビュー未依頼" : `${names.slice(0, 2).join("・")}${names.length > 2 ? ` ほか ${names.length - 2}` : ""}`);
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
      <div className="content flush" ref={list}>
        {prError && <p className="error-text pad">{prError}</p>}
        {!prs && !prError && <p className="muted pad">gh で取得しています…</p>}
        {filter !== "mine" && (
          <section>
            <div className="section-head review-prefs">
              <b>レビュー依頼</b>
              <span className="muted">{review.length}</span>
              <span className="grow" />
              <span className="muted">
                エージェント <span className="kbd">{keyLabel(keyOf("reviewAgent"))}</span>
              </span>
              <div className="segmented" role="group" aria-label="レビューするエージェント">
                {(["claude", "codex"] as const).map((a) => (
                  <button key={a} className={prefs.agent === a ? "on" : ""} aria-pressed={prefs.agent === a} onClick={() => setPrefs({ agent: a })}>
                    {a === "claude" ? "Claude" : "Codex"}
                  </button>
                ))}
              </div>
              <span className="muted">
                提出 <span className="kbd">{keyLabel(keyOf("reviewSubmit"))}</span>
              </span>
              <div className="segmented" role="group" aria-label="レビューの提出">
                <button className={!prefs.auto ? "on" : ""} aria-pressed={!prefs.auto} title="指摘がまとまると、Request changes・Comment・Approve のどれで出すかを聞いてきます（あなた待ちに入ります）" onClick={() => setPrefs({ auto: false })}>
                  提出前に確認する
                </button>
                <button className={prefs.auto ? "on" : ""} aria-pressed={prefs.auto} title="確かめずに提出し、提出したら片付けます" onClick={() => setPrefs({ auto: true })}>
                  自動で提出する
                </button>
              </div>
              <span className="muted">
                動く場所 <span className="kbd">{keyLabel(keyOf("reviewRunner"))}</span>
              </span>
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
            {prs && review.length === 0 && <p className="muted pad">ありません。</p>}
            <ul className="rows">
              {review.map((p) => {
                const st = reviewStanding(p, sessions, submitted, now);
                const id = rowId("review", p.url);
                const busy = starting.has(p.url);
                return (
                  <li key={p.url} data-row={id} className={`row pr-row${browserUrl === p.url ? " selected" : ""}${id === cursorId ? " cursor" : ""}`} onClick={() => (setCursor(id), openInBrowser?.(p.url))}>
                    <span className={`state ${st.cls}`}>
                      <i />
                      {busy ? "始めています…" : st.word}
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
                    {st.word === "未着手" && (
                      <button className="small primary" disabled={busy} title="上の選び方でレビューを始めます（Enter。画面もフォーカスも動きません）" onClick={(e) => (e.stopPropagation(), startReview(p))}>
                        レビューを始める <span className="kbd">↵</span>
                      </button>
                    )}
                    {st.failed && (
                      <button
                        className="small"
                        disabled={busy}
                        title="止まったレビューを片付けて、もう一度始めます"
                        onClick={(e) => {
                          e.stopPropagation();
                          const failed = st.failed!;
                          run(() => api.hideSession(failed.session_id));
                          startReview(p);
                        }}
                      >
                        もう一度
                      </button>
                    )}
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
              <span className="muted">自分が出している open の PR</span>
            </div>
            {prs && mine.length === 0 && <p className="muted pad">ありません。</p>}
            <ul className="rows">
              {mine.map((p) => {
                const todo = todoOf(p.url);
                const latest = todo && [...todo.sessions].sort((a, b) => b.state_at - a.state_at)[0];
                const needsFix = p.ci?.state === "failure" || p.stage === "changes_requested";
                const id = rowId("mine", p.url);
                return (
                  <li key={p.url} data-row={id} className={`row pr-row${browserUrl === p.url ? " selected" : ""}${id === cursorId ? " cursor" : ""}`} onClick={() => (setCursor(id), openInBrowser?.(p.url))}>
                    <span className={`gh gh-pr-${p.stage}`}>{PR_LABEL[p.stage]}</span>
                    <span className="pr-main">
                      <span className="ellipsis">{p.title}</span>
                      <span className="pr-meta">
                        <span className="mono">
                          {repoName(p.repo)}#{p.number}
                        </span>
                        {p.ci && <span className={`gh ci-${p.ci.state}`} title={p.ci.failed.join("\n") || undefined}>{CI_LABEL[p.ci.state]}{p.ci.failed.length > 0 && ` ${p.ci.failed.length}`}</span>}
                        <span>{reviewerLabel(p.reviewers)}</span>
                        <span>{isoAgo(p.updated_at)}</span>
                      </span>
                    </span>
                    {todo && (
                      <button className="tag todo-chip" onClick={(e) => (e.stopPropagation(), onOpenTodo(todo.id))} title={todo.title}>
                        #{todo.id} {todo.title}
                      </button>
                    )}
                    {fix && todo && latest && needsFix && latest.state !== "running" && (
                      <button className="small" title="元のセッションに、直すところを送ります（画面もフォーカスも動きません）" onClick={(e) => (e.stopPropagation(), fix(latest, todo))}>
                        元のセッションに直させる
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}

/// A theme's understanding (its last review's score) and whether it is time to review.
function ReviewTags({ summary }: { summary: FeynmanSummary | undefined }) {
  if (!summary) return null;
  return (
    <>
      <span className="tag" title={`最後の復習 ${ago(summary.attempted_at)}`}>
        理解度 {summary.score}%
      </span>
      {summary.due_at * 1000 <= Date.now() && (
        <span className="tag due" title="前回の理解度から決めた、復習するとよい時期です">
          復習どき
        </span>
      )}
    </>
  );
}

/// The learning page: the themes, and what waits unsorted (an article put in
/// with ⌥-click, a URL pasted here). Claude proposes where the unsorted go,
/// and what of a theme to read next; a study time starts from a theme.
function ThemesPage({ themes, inputs, feynman, run, report, onStudy }: {
  themes: Theme[];
  inputs: Input[];
  /// Each theme's last review, by subjectKey.
  feynman: Map<string, FeynmanSummary>;
  run: (f: () => Promise<unknown>) => void;
  report: (e: unknown) => void;
  /// A study time for the theme, with these inputs' pages on the left (or what it had).
  onStudy: (theme: Theme, inputs: Input[]) => void;
}) {
  const openInBrowser = useContext(BrowserContext);
  const [picked, setPicked] = useState<number | "unsorted">(() => (inputs.some((i) => i.theme_id === null && !i.done) || themes.length === 0 ? "unsorted" : themes[0].id));
  const theme = picked === "unsorted" ? undefined : themes.find((t) => t.id === picked);
  const unsorted = inputs.filter((i) => i.theme_id === null && !i.done);
  const [showRead, setShowRead] = useState(false);
  const mine = theme ? inputs.filter((i) => i.theme_id === theme.id && (showRead || !i.done)) : unsorted;
  const read = theme ? inputs.filter((i) => i.theme_id === theme.id && i.done).length : 0;
  const [proposals, setProposals] = useState<Placement[] | null>(null);
  const [nexts, setNexts] = useState<{ input_id: number; why: string }[] | null>(null);
  const [thinking, setThinking] = useState(false);
  const [naming, setNaming] = useState(false);
  useEffect(() => setNexts(null), [picked]);
  const ask = <T,>(f: () => Promise<T>, then: (v: T) => void) => {
    setThinking(true);
    f().then(then, report).finally(() => setThinking(false));
  };
  /// One input for all the URLs typed, in the theme shown (or unsorted).
  const add = (text: string) => {
    const input = parseInput(text);
    if (input) run(async () => {
      const made = await addInput(input.urls, await inputTitle(input.urls, input.title));
      if (theme) await api.setInputTheme(made.id, theme.id);
    });
    return input !== null;
  };
  /// Claude's placements, as proposed: new themes made once each.
  const apply = (list: Placement[]) =>
    run(async () => {
      const made = new Map<string, number>();
      for (const p of list) {
        let id = "theme" in p.place ? p.place.theme : made.get(p.place.new_theme);
        if (id === undefined && "new_theme" in p.place) {
          id = (await api.createTheme(p.place.new_theme)).id;
          made.set(p.place.new_theme, id);
        }
        await api.setInputTheme(p.input, id ?? null);
      }
      setProposals(null);
    });
  const titleOf = (id: number) => inputs.find((i) => i.id === id)?.title ?? `#${id}`;
  const themeName = (p: Placement) => ("theme" in p.place ? (themes.find((t) => t.id === (p.place as { theme: number }).theme)?.name ?? "") : `新しいテーマ「${p.place.new_theme}」`);
  return (
    <>
      <header className="toolbar">
        <h1>学び</h1>
        <input
          className="filter-search input-add"
          placeholder={`URL を貼って Enter（${theme ? `「${theme.name}」` : "まだテーマにないもの"}に入れる）`}
          aria-label="学びたいページの URL"
          onKeyDown={(e) => isEnter(e) && add(e.currentTarget.value) && (e.currentTarget.value = "")}
        />
        <span className="grow" />
        {naming ? (
          <SubmitInput autoFocus placeholder="テーマの名前を入れて Enter" onSubmit={(name) => (setNaming(false), run(async () => setPicked((await api.createTheme(name)).id)))} onClose={() => setNaming(false)} />
        ) : (
          <button className="primary" onClick={() => setNaming(true)}>
            <Icon name="plus" size={13} /> 新しいテーマ
          </button>
        )}
      </header>
      <div className="content learn">
        <nav className="theme-list" aria-label="テーマ">
          <button className={`theme-item${picked === "unsorted" ? " on" : ""}`} onClick={() => setPicked("unsorted")}>
            <span className="grow">まだテーマにないもの</span>
            <span className="muted">{unsorted.length}</span>
          </button>
          {themes.map((t) => {
            const summary = feynman.get(subjectKey({ kind: "theme", id: t.id }));
            const due = summary && summary.due_at * 1000 <= Date.now();
            return (
              <button key={t.id} className={`theme-item${picked === t.id ? " on" : ""}`} onClick={() => setPicked(t.id)}>
                <span className="grow ellipsis">{t.name}</span>
                {due && <span className="tag due">復習</span>}
                <span className="muted">{inputs.filter((i) => i.theme_id === t.id && !i.done).length}</span>
              </button>
            );
          })}
        </nav>
        <section className="theme-detail">
          {theme ? (
            <>
              <div className="theme-head">
                <InlineInput key={`n${theme.id}`} className="panel-title" value={theme.name} label="テーマの名前" placeholder="テーマの名前" required onSave={(name) => run(() => api.updateTheme(theme.id, { name }))} />
                <span className="grow" />
                <ReviewTags summary={feynman.get(subjectKey({ kind: "theme", id: theme.id }))} />
                <button className="primary" onClick={() => onStudy(theme, mine.filter((i) => !i.done && (!nexts || nexts.some((n) => n.input_id === i.id))))}>
                  学ぶ時間を始める
                </button>
              </div>
              <InlineInput key={`g${theme.id}`} value={theme.goal ?? ""} label="目標" placeholder="目標（何ができるようになりたいか）" onSave={(goal) => run(() => api.updateTheme(theme.id, { goal }))} />
              <div className="actions">
                {theme.doc_url ? (
                  <button className="link-button" onClick={() => openInBrowser?.(theme.doc_url!)}>
                    テーマのノートを開く
                  </button>
                ) : (
                  <span className="muted">ノートは、学ぶ時間の「読み終わった」で claude.ai に作られます。</span>
                )}
                <span className="grow" />
                <button disabled={thinking || mine.every((i) => i.done)} onClick={() => ask(() => api.nextReads(theme.id), setNexts)}>
                  {thinking ? "考えています…" : "次に読むものを Claude に聞く"}
                </button>
              </div>
              {nexts && (
                <div className="proposals">
                  {nexts.length === 0 && <p className="muted">提案はありませんでした。</p>}
                  {nexts.map((n) => (
                    <p key={n.input_id}>
                      <b>{titleOf(n.input_id)}</b> <span className="muted">— {n.why}</span>
                    </p>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="actions">
              <span className="muted">⌥ + クリックしたリンクや、上に貼った URL がここに入ります。</span>
              <span className="grow" />
              <button disabled={thinking || unsorted.length === 0} onClick={() => ask(api.sortUnsorted, setProposals)}>
                {thinking ? "考えています…" : "Claude に振り分けてもらう"}
              </button>
            </div>
          )}
          {proposals && !theme && (
            <div className="proposals">
              {proposals.length === 0 && <p className="muted">提案はありませんでした。</p>}
              {proposals.map((p) => (
                <p key={p.input}>
                  <b>{titleOf(p.input)}</b> → {themeName(p)} <span className="muted">— {p.why}</span>
                </p>
              ))}
              {proposals.length > 0 && (
                <div className="actions">
                  <button className="primary small" onClick={() => apply(proposals)}>
                    この通りにする
                  </button>
                  <button className="ghost small" onClick={() => setProposals(null)}>
                    やめる
                  </button>
                </div>
              )}
            </div>
          )}
          <ul className="rows">
            {mine.map((i) => (
              <li key={i.id} className={`row${i.done ? " done" : ""}`} onClick={() => i.links[0] && openInBrowser?.(i.links[0].url)}>
                <button
                  className="ghost icon"
                  aria-label={i.done ? `${i.title} を読み終わっていないことにする` : `${i.title} を読み終わったことにする`}
                  title={i.done ? "読み終わっていないことにする" : "読み終わった"}
                  onClick={(e) => (e.stopPropagation(), run(() => api.updateInput(i.id, { done: !i.done })))}
                >
                  <StatusIcon status={i.done ? "done" : "todo"} />
                </button>
                <span className="row-title ellipsis">{i.title}</span>
                {i.links[0] && <span className="muted mono ellipsis">{hostOf(i.links[0].url)}</span>}
                {nexts?.some((n) => n.input_id === i.id) && <span className="tag due">次に読む</span>}
                <select
                  className="select compact"
                  value={i.theme_id ?? ""}
                  aria-label={`${i.title} のテーマ`}
                  onClick={stop}
                  onChange={(e) => run(() => api.setInputTheme(i.id, e.target.value ? Number(e.target.value) : null))}
                >
                  <option value="">まだテーマにない</option>
                  {themes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button className="ghost icon" aria-label={`${i.title} を消す`} title="消す" onClick={(e) => (e.stopPropagation(), run(() => api.deleteInput(i.id)))}>
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
          {mine.length === 0 && <p className="muted empty">{theme ? "このテーマで読むものは、まだありません。上に URL を貼ると入ります。" : "まだテーマにないものはありません。"}</p>}
          {theme && read > 0 && (
            <button className="ghost small show-ended" onClick={() => setShowRead((v) => !v)}>
              {showRead ? "読み終わったものを隠す" : `読み終わったもの ${read} 件`}
            </button>
          )}
          {theme && (
            <button className="ghost small danger-text" onClick={() => run(() => api.deleteTheme(theme.id).then(() => setPicked("unsorted")))}>
              このテーマを消す（読むものは「まだテーマにないもの」に戻ります）
            </button>
          )}
        </section>
      </div>
    </>
  );
}

/// An input from what was typed in the Input page: its URLs (or one bare
/// address, `example.com`), the other words its title (empty when there are
/// none; see inputTitle). Null when there is no page in it.
function parseInput(text: string): { title: string; urls: string[] } | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const urls = [...new Set(words.filter((w) => /^https?:\/\//i.test(w)))];
  if (urls.length === 0) {
    const url = addressToUrl(text);
    return url && !url.startsWith(SEARCH_URL) ? { title: "", urls: [url] } : null;
  }
  return { title: words.filter((w) => !/^https?:\/\//i.test(w)).join(" "), urls };
}

/// What an input is called: the words given with it, else its first page's
/// own title (OGP), else that page's host.
async function inputTitle(urls: string[], given: string) {
  if (given.trim()) return given.trim();
  const title = await api.pageTitle(urls[0]).catch(() => null);
  return title || hostOf(urls[0]);
}

/// Adds an input with `urls` as its pages, in that order; it comes back with
/// them (to open it before the board catches up).
async function addInput(urls: string[], title: string): Promise<Input> {
  const input = await api.createInput(title);
  const links = [];
  for (const url of urls) links.push(await api.addInputLink(input.id, url));
  return { ...input, links };
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
function AddTodoDialog({ local, groups, initialRepo, initialMemo, run, onClose, onOpenTodo, onImport }: {
  local: LocalRepo[];
  groups: string[];
  initialRepo: string | null;
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
  const [plan, setPlan] = useState(false);
  const [added, setAdded] = useState<Todo[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const launch = prefs[plan ? "plan" : "direct"];
  const make = () => api.createTodo({ title: title.trim(), memo: memo.trim() || undefined, repos: repo ? [repo] : [], cwd: local.find((r) => r.key === repo)?.path, issue_url: issueUrl.trim() || undefined });
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

/// ⌘⇧D: the page shown goes into a theme (or among the unsorted) to read.
function AddToThemeDialog({ page, themes, run, onDone, onClose }: {
  page: { url: string; title: string | null };
  themes: Theme[];
  run: (f: () => Promise<unknown>) => void;
  /// Told where the page went.
  onDone: (where: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = themes.filter((t) => words.every((w) => t.name.toLowerCase().includes(w)));
  // The unsorted come last, as one more choice.
  const count = shown.length + 1;
  const put = (t: Theme | undefined) =>
    run(async () => {
      const input = await addInput([page.url], page.title || (await inputTitle([page.url], "")));
      if (t) await api.setInputTheme(input.id, t.id);
      onDone(t ? `「${t.name}」` : "まだテーマにないもの");
      onClose();
    });
  return (
    <Modal title="このページを学びに入れる" onClose={onClose}>
      <p className="muted ellipsis">{page.title || page.url}</p>
      <input
        autoFocus
        className="filter-search"
        value={query}
        placeholder="テーマを絞り込む"
        aria-label="入れるテーマを絞り込む"
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          const d = e.key === "ArrowDown" || matches(e.nativeEvent, "paletteDown") ? 1 : e.key === "ArrowUp" || matches(e.nativeEvent, "paletteUp") ? -1 : 0;
          if (d) {
            e.preventDefault();
            return setActive((i) => (i + d + count) % count);
          }
          if (isEnter(e)) put(shown[active]);
        }}
      />
      <ul className="rows compact to-input" role="listbox">
        {shown.map((t, i) => (
          <li key={t.id} role="option" aria-selected={i === active} className={`row${i === active ? " cursor" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => put(t)}>
            <span className="row-title">{t.name}</span>
          </li>
        ))}
        <li role="option" aria-selected={active === shown.length} className={`row${active === shown.length ? " cursor" : ""}`} onMouseEnter={() => setActive(shown.length)} onClick={() => put(undefined)}>
          <span className="row-title muted">まだテーマにないもの（あとで振り分ける）</span>
        </li>
      </ul>
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
  input: ["インプット", "読む", "reading", "学習"],
  カンバン: ["kanban", "board", "ボード"],
  モード: ["focus", "フォーカス", "集中", "mode"],
  リスト: ["list"],
  フィルター: ["filter", "絞り込み", "view", "ビュー"],
  キー: ["shortcut", "ショートカット", "key", "keys", "keymap"],
  ブラウザ: ["browser", "web", "タブ", "tab"],
  作業スペース: ["ブラウザ", "browser", "web", "タブ", "tab", "ターミナル", "terminal", "pane", "ペイン", "workspace"],
  タブ: ["tab"],
  同期: ["sync", "更新", "refresh", "reload"],
  issue: ["イシュー", "課題", "import", "取り込み"],
  chatgpt: ["gpt", "openai", "チャット", "chat"],
  "claude code": ["クロード", "cloud", "web"],
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

/// ⌘K: the actions that used to crowd the sidebar, the screens, and a jump to any todo.
function CommandPalette({ commands, todos, themes, start, onOpenTodo, onStudy, onClose }: {
  commands: Command[];
  /// A list to open on (a terminal's links), which Esc closes from.
  start?: Command;
  todos: Todo[];
  themes: Theme[];
  onOpenTodo: (id: number) => void;
  /// A study time for the theme.
  onStudy: (theme: Theme) => void;
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
    // A theme starts its study time.
    ...(q
      ? themes
          .filter((t) => t.name.toLowerCase().includes(q))
          .slice(0, 20)
          .map((t) => ({ key: `theme:${t.id}`, label: `学ぶ時間：${t.name}`, run: () => onStudy(t) }))
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
          placeholder={page ? `${page.label}を絞り込む` : "操作を選ぶ、または todo や input を検索"}
          aria-label={page ? `${page.label}を絞り込む` : "操作を選ぶ、または todo や input を検索"}
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

/// Plan usage kept in view (session, weekly, per model), warning colours from the API.
function UsageBox({ limits, error }: { limits: Limit[] | null; error: string | null }) {
  return (
    <div className="usage" title={error ?? undefined}>
      <div className="section-title">Claude の使用量</div>
      {error && !limits && <span className="muted small-text">取得できませんでした</span>}
      {!limits && !error && <span className="muted small-text">取得しています…</span>}
      {limits?.map((l) => (
        <div key={l.label} className={`meter${l.severity !== "normal" || l.percent >= 80 ? " warn" : ""}`}>
          <div className="meter-row">
            <span>{l.label}</span>
            <b>{Math.round(l.percent)}%</b>
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

type Selection = { kind: "todo"; id: number } | null;
type DialogKind = "add" | "toInput" | "import" | "quick" | "palette" | "keys" | "exitFocus" | "focusPick" | "start" | "settings" | null;

/// Keys the focus mode still lets through with ⌘: editing text (copy, paste, …).
const FOCUS_EDIT_KEYS = ["c", "v", "x", "a", "z"];

/// Asked on Esc in the focus mode: Esc again leaves, Enter stays.
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

function ExitFocusDialog({ onExit, onStay }: { onExit: () => void; onStay: () => void }) {
  useEffect(() => {
    // Ahead of the dialog's own Esc (which would only close it).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      (e.key === "Escape" ? onExit : onStay)();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onExit, onStay]);
  return (
    <Modal
      title="学ぶ時間を終えますか？"
      onClose={onStay}
      footer={
        <>
          <span className="grow" />
          <button className="ghost" onClick={onStay}>
            続ける <span className="kbd">Enter</span>
          </button>
          <button className="primary" onClick={onExit}>
            終える <span className="kbd">Esc</span>
          </button>
        </>
      }
    >
      <p className="muted">もう一度 Esc で終わります。</p>
    </Modal>
  );
}

/// Keys that stay as they are, shown under the ones that can change.
const FIXED_KEYS: [string, string][] = [
  ["↑↓←→", "一覧・カンバンの移動（変えたキーと一緒に使えます）"],
  ["Enter", "開く（todo のシート、セッション、メニューの項目）"],
  ["⌥Enter", "開き方を選ぶ（セッション）/ PR を開く（PR）"],
  ["Esc", "シートやパネル、メニューを閉じる（学ぶ時間では終えるか聞く）"],
];

/// Every shortcut, and changing one: its key's button, then the new key
/// (Esc keeps the old one). ? and ⌘K's "ショートカット" open it.
/// Where things open and run, and what the browser keeps for sites: the
/// logins (their sites and users), the sites not asked about, and the
/// microphone and camera answers.
function SettingsDialog({ cloudTarget, onCloudTarget, terminalTarget, onTerminalTarget, herdr, onLoadHerdr, onPickHerdr, report, onClose }: {
  cloudTarget: CloudTarget;
  onCloudTarget: (t: CloudTarget) => void;
  terminalTarget: TerminalTarget;
  onTerminalTarget: (t: TerminalTarget) => void;
  herdr: HerdrSessions | null;
  onLoadHerdr: () => void;
  onPickHerdr: (name: string) => void;
  report: (e: unknown) => void;
  onClose: () => void;
}) {
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

export default function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  // Pages in the browser pane. The pane stays across screens, shown or
  // hidden from the sidebar; hiding it keeps the tabs.
  // Kept across restarts (see `restoreTabs`).
  const restored = useRef<ReturnType<typeof restoreTabs> | null>(null);
  restored.current ??= restoreTabs();
  const [tabs, setTabs] = useState<BrowserTab[]>(() => restored.current!.tabs);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(() => restored.current!.active);
  const [newTab, setNewTab] = useState(false);
  const [browserShown, setBrowserShownState] = useState(() => load(BROWSER_SHOWN_KEY, ["1", "0"] as const, "0") === "1");
  const setBrowserShown = (v: boolean) => {
    remember(BROWSER_SHOWN_KEY, v ? "1" : "0");
    setBrowserShownState(v);
  };
  const setActiveTabId = (id: string | null) => {
    setActiveTabIdState(id);
    setNewTab(false);
  };
  const nextTab = useRef(tabs.filter((t) => !t.pinned).length + 1);
  // The pane's tabs: the focus mode's own pages are apart from them.
  const paneTabs = tabs.filter((t) => !t.focus);
  // The strip: the pinned pages, the reviews, then the others.
  const reviewTabs = paneTabs.filter((t) => t.review);
  const normalTabs = paneTabs.filter((t) => !t.pinned && !t.review);
  const activeTab = newTab ? null : (paneTabs.find((t) => t.id === activeTabId) ?? paneTabs[paneTabs.length - 1] ?? null);
  const browserUrl = browserShown ? (activeTab?.url ?? null) : null;
  /// The previous (-1) or next (1) tab, wrapping around (⌘⇧[ ⌘⇧]), in the order
  /// of the strip: the pinned pages (a page not opened yet opens), then the others.
  const switchTab = (delta: number) => {
    const shown = [...PINNED_PAGES.map((p) => p.id), ...reviewTabs.map((t) => t.id), ...normalTabs.map((t) => t.id)];
    if (!browserShown || shown.length === 0) return;
    const i = activeTab ? shown.indexOf(activeTab.id) : delta > 0 ? -1 : shown.length;
    const nextId = shown[(i + delta + shown.length) % shown.length];
    if (PINNED_PAGES.some((p) => p.id === nextId)) return showPinned(nextId);
    const next = tabs.find((t) => t.id === nextId) ?? null;
    keysToTab(next, activeTab?.id, report);
    setActiveTabId(nextId);
  };
  const switchRef = useRef(switchTab);
  switchRef.current = switchTab;
  /// Shows the pane on a new tab page (⌘T).
  const openNewTab = () => {
    setBrowserShown(true);
    setNewTab(true);
  };
  const toggleBrowser = () => {
    if (browserShown) return setBrowserShown(false);
    setBrowserShown(true);
    if (tabs.length === 0) setNewTab(true);
  };
  const [cloudTarget, setCloudTargetState] = useState<CloudTarget>(() => load(CLOUD_TARGET_KEY, ["web", "desktop"] as const, "web"));
  const setCloudTarget = (t: CloudTarget) => {
    remember(CLOUD_TARGET_KEY, t);
    setCloudTargetState(t);
  };
  /// Opens a page of the app's own (a session, a PR) in the pane: the tab
  /// opened for it comes to the front, else a new tab next to the one shown.
  /// Opening is the user's action, so
  /// the page takes the keyboard (`keys` false leaves it), its text box with
  /// `text` typed in; `behind` leaves the tab shown as it is.
  const openInBrowser = (url: string, keys = true, behind = false, text?: string) => {
    const open = findTabFor(paneTabs.filter((t) => !t.pinned && !t.term), url);
    if (open) {
      if (behind) return;
      setBrowserShown(true);
      if (keys) keysToTab(open, activeTab?.id, report, text);
      return setActiveTabId(open.id);
    }
    const id = `t${nextTab.current++}`;
    if (keys && !behind) focusSoon(id, !!text, text);
    setTabs((prev) => insertAfter(prev, { id, url, openedFor: url, title: null, loading: true, nav: 0 }, activeTab?.id ?? null));
    if (!behind) {
      setBrowserShown(true);
      setActiveTabId(id);
    }
  };
  /// A link a page opens in a new window: a new tab right after that page's
  /// tab, in front with the keyboard (the user clicked it), or `behind` (⌘-click).
  const openFromPage = (url: string, from: string, behind: boolean) => {
    const id = `t${nextTab.current++}`;
    if (!behind) focusSoon(id);
    setTabs((prev) => insertAfter(prev, { id, url, title: null, loading: true, nav: 0 }, prev.some((t) => t.id === from && !t.pinned) ? from : (activeTab?.id ?? null)));
    if (!behind) {
      setBrowserShown(true);
      setActiveTabId(id);
    }
  };
  /// Starting a Cloud session to be watched on the web: its tab is made
  /// behind the one shown (starting does not change what is seen or where the
  /// keyboard is), marked while the session is made, and then goes to it.
  const beginWeb: BeginWeb = (review) => {
    const id = `t${nextTab.current++}`;
    setTabs((prev) => insertAfter(prev, { id, url: CLOUD_HOME, title: "セッションを作成中…", loading: true, nav: 0, creating: true, review }, activeTab?.id ?? null));
    return (sessionId) => {
      if (sessionId) {
        const url = cloudWebUrl(sessionId);
        setTabs((prev) =>
          prev.map((t) => (t.id === id ? { ...t, url, openedFor: url, title: null, loading: false, nav: t.nav + 1, creating: undefined, review: t.review && { ...t.review, session: sessionId } } : t)),
        );
      } else {
        api.browserClose(id).catch(report);
        setTabs((prev) => prev.filter((t) => t.id !== id));
      }
    };
  };
  const [terminalTarget, setTerminalTargetState] = useState<TerminalTarget>(() => load(TERMINAL_TARGET_KEY, ["ghostty", "app"] as const, "ghostty"));
  const setTerminalTarget = (t: TerminalTarget) => {
    remember(TERMINAL_TARGET_KEY, t);
    setTerminalTargetState(t);
  };
  // The Input mode (FocusMode): a space per subject (an input, or a todo's
  // pages; FREE_SPACE for pages picked without one), each with its own pages
  // on the left and right. A subject's space stays (hidden) when the mode
  // ends and comes back when it is opened again; it is saved to come back
  // after a restart too.
  const [focusMode, setFocusMode] = useState(false);
  /// The right page a new space shows, the one picked last.
  const [focusRightPref, setFocusRightPref] = useState<string>(() => load(FOCUS_RIGHT_KEY, RIGHT_KINDS, "pinchatgpt"));
  // What the Input mode is open for (its space), null for FREE_SPACE.
  const [focusSubject, setFocusSubject] = useState<Subject | null>(null);
  const [spaces, setSpaces] = useState<Record<string, InputSpace>>({});
  const spaceKey = subjectKey(focusSubject);
  const space = spaces[spaceKey] ?? newSpace(focusRightPref);
  const patchSpace = (key: string, f: (s: InputSpace) => InputSpace) =>
    setSpaces((prev) => ({ ...prev, [key]: f(prev[key] ?? newSpace(focusRightPref)) }));
  const focusRight = space.right;
  const focusRightId = rightTabId(spaceKey, focusRight);
  /// A space's right page, opened (not shown) if it is not yet; the note's
  /// tab comes from its address (below).
  const ensureRight = (key: string, kind: string, url?: string) => {
    const page = FOCUS_PAGES.find((p) => p.id === kind);
    const id = rightTabId(key, kind);
    if (page && !tabs.some((t) => t.id === id)) {
      setTabs((prev) => [...prev, { id, url: url ?? page.url, title: page.label, loading: true, nav: 0, focus: true, space: key, kind }]);
    }
  };
  /// Picks the right page; it takes the typing (its text box, with `text` typed in).
  const setFocusRight = (kind: string, text?: string) => {
    remember(FOCUS_RIGHT_KEY, kind);
    setFocusRightPref(kind);
    patchSpace(spaceKey, (s) => ({ ...s, right: kind }));
    ensureRight(spaceKey, kind, space.rightUrls[kind]);
    focusSoon(rightTabId(spaceKey, kind), true, text);
  };
  // The pages take the keys as they are set (their script reads them).
  useEffect(() => void api.setPageKeys(JSON.stringify(allKeys())).catch((e) => setError(String(e))), []);
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  useEffect(() => void api.setFocusMode(focusMode).catch((e) => setError(String(e))), [focusMode]);
  // Notifications wait while the focus mode is on (the backend posts none);
  // on leaving, the page tells how much more waits on the user.
  const waitingAtFocus = useRef<Set<string>>(new Set());
  const waitingKeys = useRef<string[]>([]);
  const [heldWaiting, setHeldWaiting] = useState(0);
  const exitFocus = () => {
    setDialog(null);
    setFocusMode(false);
    // A todo's space stays to be resumed; pages picked without one go (the
    // terminals were the pane's all along).
    if (focusSubject === null) {
      const free = tabs.filter((t) => t.focus && t.space === FREE_SPACE);
      for (const t of free) api.browserClose(t.id).catch(report);
      setTabs((prev) => prev.filter((t) => !(t.focus && t.space === FREE_SPACE)));
      setSpaces(({ [FREE_SPACE]: _, ...rest }) => rest);
    }
    setFocusSubject(null);
    setHeldWaiting(waitingKeys.current.filter((k) => !waitingAtFocus.current.has(k)).length);
  };
  // The space's left: its own tabs (apart from the pane's) and terminals the
  // pane has, and the one shown.
  const focusLefts = space.lefts.map((id) => tabs.find((t) => t.id === id)).filter((t): t is BrowserTab => t !== undefined);
  const focusLeft = space.newTab ? null : (focusLefts.find((t) => t.id === space.active) ?? focusLefts[0] ?? null);
  /// Puts items on the left of space `key` (the one shown, by default), the
  /// first of them shown unless `behind`; gives their tab ids.
  const addToFocus = (items: FocusItem[], key = spaceKey, behind = false) => {
    const ids = items.map((item) => {
      if ("terminal" in item) return item.terminal;
      const id = `f${nextTab.current++}`;
      setTabs((prev) => [...prev, { id, url: item.url, title: null, loading: true, nav: 0, focus: true, space: key }]);
      return id;
    });
    patchSpace(key, (s) => ({
      ...s,
      pages: [...s.pages, ...items.flatMap((item) => ("url" in item ? [item.url] : []))],
      lefts: [...s.lefts, ...ids.filter((id) => !s.lefts.includes(id))],
      active: behind ? s.active : (ids[0] ?? s.active),
      newTab: (behind || ids.length === 0) && s.newTab,
    }));
    return ids;
  };
  /// Takes a tab off the left (its own page closes; a terminal stays the pane's).
  const removeFromFocus = (id: string) => {
    patchSpace(spaceKey, (s) => ({ ...s, lefts: s.lefts.filter((x) => x !== id) }));
    if (tabs.find((t) => t.id === id)?.focus) {
      api.browserClose(id).catch(report);
      setTabs((prev) => prev.filter((t) => t.id !== id));
    }
  };
  /// ⌘T on the Input mode's left: a new tab in front of its tabs.
  const newFocusTab = () => patchSpace(spaceKey, (s) => ({ ...s, newTab: true }));
  /// ⌘W on the left: its tab shown goes, as a new tab does (back to the one shown before).
  const closeFocusTab = () => {
    const rest = focusLefts.filter((t) => t.id !== focusLeft?.id);
    // The one shown instead takes the keyboard.
    if (space.newTab) {
      patchSpace(spaceKey, (s) => ({ ...s, newTab: false }));
      keysToTab(focusLefts.find((t) => t.id === space.active) ?? focusLefts[0] ?? null, undefined, report);
    } else if (focusLeft) {
      removeFromFocus(focusLeft.id);
      keysToTab(rest[0] ?? null, undefined, report);
    }
  };
  // A theme's space is saved as it changes, to be resumed after a restart.
  const savedSpace: SavedSpace | null =
    focusMode && focusSubject !== null
      ? (() => {
          const pages = focusLefts.filter((t) => !t.term);
          const rights = tabs.filter((t) => t.space === spaceKey && t.kind);
          return {
            lefts: pages.map((t) => ({ url: t.url, title: t.title })),
            active: Math.max(0, pages.findIndex((t) => t.id === focusLeft?.id)),
            right: space.right,
            rightUrls: Object.fromEntries(rights.map((t) => [t.kind!, t.url])),
            pages: space.pages,
          };
        })()
      : null;
  const savedSpaceJson = savedSpace && JSON.stringify(savedSpace);
  useEffect(() => {
    if (focusSubject === null || !savedSpaceJson) return;
    remember(INPUT_SPACES_KEY, JSON.stringify({ ...savedSpaces(), [spaceKey]: JSON.parse(savedSpaceJson) }));
  }, [savedSpaceJson]); // eslint-disable-line react-hooks/exhaustive-deps
  /// The theme the study time is open for, and the right side's tab (its LLM).
  const focusTheme = focusSubject ? board?.themes.find((t) => t.id === focusSubject.id) : undefined;
  const focusRightTab = tabs.find((t) => t.id === focusRightId);
  // The review a study time starts with, over the pages until done or skipped.
  const [reviewing, setReviewing] = useState(false);
  // 「読み終わった」: the left's pages and the right's conversation go into the
  // theme's document (THEME_DOC_EVENT says when it is written).
  const [finishing, setFinishing] = useState<Set<number>>(new Set());
  const finishReading = () =>
    run(async () => {
      if (!focusTheme) return;
      const pages: PageText[] = [];
      for (const t of focusLefts.filter((t) => !t.term && /^https?:/.test(t.url))) {
        const text = (await api.browserText(t.id).catch(() => null)) ?? (await api.pageText(t.url).catch(() => ""));
        pages.push({ url: t.url, title: t.title, text });
      }
      const conversation = focusRightTab ? await api.browserText(focusRightTab.id).catch(() => null) : null;
      const shown = new Set(focusLefts.flatMap((t) => [t.url, t.openedFor].filter((u): u is string => !!u)));
      const read = (board?.inputs ?? []).filter((i) => i.theme_id === focusTheme.id && i.links.some((l) => shown.has(l.url))).map((i) => i.id);
      await api.finishReading(focusTheme.id, pages, conversation, read);
      setFinishing((prev) => new Set(prev).add(focusTheme.id));
      showToast(`「${focusTheme.name}」のノートに書き足しています（少しかかります）`);
    });
  // A short note at the bottom of what was done in the background (an input
  // added, a session sent what to fix).
  const [toast, setToastState] = useState<string | null>(null);
  const showToast = (text: string) => {
    setToastState(text);
    setTimeout(() => setToastState((now) => (now === text ? null : now)), TOAST_MS);
  };
  // A link ⌥-clicked in a page waits unsorted in the learning page; the page
  // says so (and where a page went, from AddToThemeDialog).
  const setAddedInput = (where: string) => showToast(`学びに入れました：${where}`);
  const addInputFrom = (url: string, title: string) =>
    run(async () => {
      await addInput([url], title);
      setAddedInput(title);
    });
  /// The page AddToThemeDialog puts in a theme: the 作業スペース's shown one.
  const [toInputPage, setToInputPage] = useState<{ url: string; title: string | null } | null>(null);
  const toInputRef = useRef(() => {});
  const toInput = () => {
    if (!activeTab || activeTab.term || !/^https?:\/\//.test(activeTab.url)) return;
    setToInputPage({ url: activeTab.url, title: activeTab.title });
    setDialog("toInput");
  };
  toInputRef.current = toInput;

  const addInputRef = useRef(addInputFrom);
  addInputRef.current = addInputFrom;
  const addToFocusRef = useRef(addToFocus);
  addToFocusRef.current = addToFocus;
  const newFocusTabRef = useRef(newFocusTab);
  newFocusTabRef.current = newFocusTab;
  const closeFocusTabRef = useRef(closeFocusTab);
  closeFocusTabRef.current = closeFocusTab;
  const pickFocus = () => setDialog("focusPick");
  /// A study time for the theme: its space as it was left (or saved), with
  /// the pages of `inputs` it lacks added; it starts with a review when the
  /// theme has its document.
  const studyTheme = (theme: Theme, inputs: Input[]) => {
    setView("inputs");
    enterFocus(inputs.flatMap((i) => i.links.slice(0, 1).map((l) => ({ url: l.url }))), { kind: "theme", id: theme.id });
    setReviewing(!!theme.doc_url);
  };
  /// Themes whose review is due (by their last score).
  const reviewsDue = (board?.feynman ?? []).filter((f) => f.due_at * 1000 <= Date.now()).length;
  /// A theme's inputs not read yet, the pages a study time opens with.
  const unreadOf = (t: Theme) => (board?.inputs ?? []).filter((i) => i.theme_id === t.id && !i.done);
  /// By subjectKey: each theme's latest review.
  const feynmanOf = new Map((board?.feynman ?? []).map((s) => [subjectKey(s.subject), s]));
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
  /// ⌘K: the login kept for the site the pane shows, taken out.
  const forgetShownLogin = () => {
    const site = activeTab && !activeTab.term ? hostOf(activeTab.url) : null;
    if (site) api.forgetLogin(site).catch(report);
  };
  const savedSpaces = () => loadJson<Record<string, SavedSpace>>(INPUT_SPACES_KEY, {});
  /// ⌘⇧[ ⌘⇧] in the Input mode: the previous or next tab of the side that has
  /// the keyboard, the left's own or the right's pages (which take the typing).
  const switchFocusTab = (right: boolean, delta: number) => {
    setFocusTyping(right ? "right" : "left");
    if (right) return setFocusRight(RIGHT_KINDS[(RIGHT_KINDS.indexOf(focusRight) + delta + RIGHT_KINDS.length) % RIGHT_KINDS.length]);
    if (focusLefts.length === 0) return;
    // From a new tab, the first or the last.
    const i = focusLeft ? focusLefts.findIndex((t) => t.id === focusLeft.id) : delta > 0 ? -1 : focusLefts.length;
    const next = focusLefts[(i + delta + focusLefts.length) % focusLefts.length];
    patchSpace(spaceKey, (s) => ({ ...s, active: next.id, newTab: false }));
    keysToTab(next, focusLeft?.id, report);
  };
  // Which side of the Input mode has the keyboard (see `typingSide`), or
  // neither while the app's other parts or another app have it.
  const [focusTyping, setFocusTyping] = useState<"left" | "right" | null>("right");
  /// ⌘K: the commands, leaving the Input mode (a todo's pages stay) on the way.
  // A terminal's links open in a new tab, in front (with the keyboard) or
  // behind; in the Input mode, on its left.
  const openTerminalLink = (url: string, front: boolean) => {
    if (!focusModeRef.current) return openInBrowser(url, front, !front);
    const [id] = addToFocus([{ url }], spaceKey, !front);
    if (front && id) focusSoon(id);
  };
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
  const togglePalette = () => {
    if (focusModeRef.current) {
      exitFocus();
      return setDialog("palette");
    }
    setDialog((d) => (d === "palette" ? null : "palette"));
  };
  const paletteRef = useRef(togglePalette);
  paletteRef.current = togglePalette;
  const switchFocusTabRef = useRef(switchFocusTab);
  switchFocusTabRef.current = switchFocusTab;
  /// Whether tab `id` is on the Input mode's right (a right page, or the terminal making the note).
  const onFocusRight = (id: string) => tabs.find((t) => t.id === id)?.kind !== undefined || focusRightTab?.id === id;
  const onFocusRightRef = useRef(onFocusRight);
  onFocusRightRef.current = onFocusRight;
  /// Shows the subject's space: the one open still, else the saved one
  /// opened again (either with what of `items` it lacks), else a new one with
  /// `items` on the left.
  const enterFocus = (items: FocusItem[], subject = focusSubject) => {
    const key = subjectKey(subject);
    waitingAtFocus.current = new Set(waitingKeys.current);
    setFocusSubject(subject);
    const saved = subject === null ? undefined : savedSpaces()[key];
    let right = spaces[key]?.right ?? focusRightPref;
    let rightUrls = spaces[key]?.rightUrls ?? {};
    // Pages added to the subject since its space was left.
    const known = spaces[key]?.pages ?? saved?.pages ?? [];
    const lacking = items.filter((item) => "url" in item && !known.includes(item.url));
    if (!spaces[key] && saved) {
      const ids = saved.lefts.map(({ url, title }) => {
        const id = `f${nextTab.current++}`;
        setTabs((prev) => [...prev, { id, url, title, loading: true, nav: 0, focus: true, space: key }]);
        return id;
      });
      ({ right, rightUrls } = saved);
      setSpaces((prev) => ({ ...prev, [key]: { lefts: ids, active: ids[saved.active] ?? ids[0] ?? null, right, pages: saved.pages, rightUrls } }));
      if (lacking.length > 0) addToFocus(lacking, key);
    } else if (!spaces[key]) {
      setSpaces((prev) => ({ ...prev, [key]: newSpace(right) }));
      addToFocus(items, key);
    } else if (lacking.length > 0) addToFocus(lacking, key);
    ensureRight(key, right, rightUrls[right]);
    focusSoon(rightTabId(key, right), true);
    setFocusTyping("right");
    setFocusMode(true);
  };
  /// Brings up a pinned page, opening its tab the first time, with its text
  /// box ready for typing.
  const showPinned = (id: string) => {
    const page = PINNED_PAGES.find((p) => p.id === id);
    if (!page) return;
    focusSoon(id, true);
    if (!tabs.some((t) => t.id === id)) setTabs((prev) => [{ id, url: page.url, title: page.label, loading: true, nav: 0, pinned: true }, ...prev]);
    setBrowserShown(true);
    setActiveTabId(id);
  };
  const terminalTab = (sessionId: string) => tabs.find((t) => !t.focus && t.term?.session === sessionId);
  const showTab = (id: string) => {
    setBrowserShown(true);
    setActiveTabId(id);
  };
  const inAppTerminal: InAppTerminal | null =
    terminalTarget === "app"
      ? {
          open: (run, focus = false) => {
            // herdr is attached once per herdr session; its pane is already focused.
            const attached = run.herdr ? tabs.find((t) => t.term?.herdr === run.herdr) : undefined;
            if (attached) {
              if (!focus) return;
              showTab(attached.id);
              focusSoon(attached.id);
              return void requestAnimationFrame(() => focusTerminal(attached.id));
            }
            // Started (not opened): the tab is made behind, as a page's is.
            const id = `t${nextTab.current++}`;
            if (focus) focusSoon(id);
            setTabs((prev) => insertAfter(prev, { id, url: "", title: run.title, loading: false, nav: 0, term: run }, activeTab?.id ?? null));
            if (focus) showTab(id);
          },
          focus: (sessionId) => {
            const tab = terminalTab(sessionId);
            if (!tab) return false;
            showTab(tab.id);
            // After the tab is shown, so its terminal is in the page.
            focusSoon(tab.id);
            requestAnimationFrame(() => focusTerminal(tab.id));
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
  const closeTab = (id: string) => {
    if (tabs.find((t) => t.id === id)?.term) closeTerminal(id);
    else api.browserClose(id).catch(report);
    // The tab shown next is its right neighbour (else its left one) on the
    // strip, among the pane's own tabs; with none left, a new tab page. It
    // takes the keyboard only if the pane had it.
    const next = nextAfterClose(tabs.find((t) => t.id === id)?.review ? [...reviewTabs, ...normalTabs] : normalTabs, id);
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
  /// page for the last tab. False when the pane is hidden and ⌘W is not ours.
  const closeShown = () => {
    if (!browserShown) return false;
    if (activeTab && !activeTab.pinned) closeTab(activeTab.id);
    else if (!activeTab && tabs.length > 0) setNewTab(false);
    return true;
  };
  /// ⌃l gives the typing to the pane's page or terminal, ⌃h back to this
  /// side (from a page, ⌃h comes back through FOCUS_APP_EVENT).
  // The sidebar as a place for the keyboard (⌃h from the Todo side): j k
  // move over its entries, Enter picks one (and goes to it), ⌃l or Esc go back.
  const [sideZone, setSideZoneState] = useState(false);
  const sideZoneRef = useRef(sideZone);
  sideZoneRef.current = sideZone;
  const [sideCursor, setSideCursor] = useState(0);
  const sideCursorRef = useRef(sideCursor);
  sideCursorRef.current = sideCursor;
  const sideItems = () => [...document.querySelectorAll<HTMLElement>(".sidebar nav button")];
  const setSideZone = (on: boolean) => {
    sideZoneRef.current = on;
    setSideZoneState(on);
    // It starts on the page shown.
    if (on) setSideCursor(Math.max(0, sideItems().findIndex((el) => el.classList.contains("on"))));
  };
  useEffect(() => {
    sideItems().forEach((el, i) => el.toggleAttribute("data-cursor", sideZone && i === sideCursor));
  });
  /// `text` (selected on the focus mode's left) is typed into the right's box.
  const focusSide = (pane: boolean, text?: string) => {
    // The focus mode's two sides: its left tab and the pinned page on the right,
    // whose text box (ChatGPT's) takes the typing, in a chat going on too.
    if (focusMode) {
      const side = pane ? focusRightTab : focusLeft;
      if (side || !pane) setFocusTyping(pane ? "right" : "left");
      // The left's new tab: its address field.
      if (!side && !pane) document.querySelector<HTMLInputElement>(".focus-left .browser-bar input")?.focus();
      if (side?.term) focusTerminal(side.id);
      else if (side) {
        const chat = pane && CHAT_PAGES.includes(side.kind ?? side.id);
        giveKeys(side.id, report, chat, chat ? text : undefined);
      }
      return;
    }
    // Left from the Todo side is the sidebar; right from the sidebar, the Todo side.
    if (!pane) {
      if (typingSideRef.current === "app" && !sideZoneRef.current) setSideZone(true);
      setTypingSide("app");
      return void (document.activeElement as HTMLElement | null)?.blur();
    }
    if (sideZoneRef.current) return setSideZone(false);
    if (!browserShown || !activeTab) return;
    setTypingSide("pane");
    if (activeTab.term) focusTerminal(activeTab.id);
    else giveKeys(activeTab.id, report, CHAT_PAGES.includes(activeTab.id));
  };
  const focusLeftRef = useRef(focusLeft);
  focusLeftRef.current = focusLeft;
  const focusSideRef = useRef(focusSide);
  focusSideRef.current = focusSide;
  // Which side has the typing, marked on the page: this one, the pane (its
  // terminal, a page), or neither while another app is in front; in the Input
  // mode, its left or right. The keys moving the typing (⌃h ⌃l, ⌘⇧[ ⌘⇧]) mark
  // it as they move it; a click, or a page taking it, as that happens.
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
    // This page has it: its fields and terminals by where they are (the
    // pane's address bar is the pane's). Nothing focused in it leaves the
    // Input mode's side to the key that is moving the typing.
    // A press on the pane's own parts (its tab strip) gives this page the
    // keyboard for a moment, which goes on to the page or terminal shown: the
    // pane keeps the mark meanwhile.
    let pressedInPane = false;
    const press = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      pressedInPane = !!t.closest(".browser-tabs") && !t.closest("input");
    };
    const here = () => {
      const el = document.activeElement;
      if (pressedInPane && (!el || el === document.body)) return;
      setTypingSide(el?.closest(".xterm, .browser-dock") ? "pane" : "app");
      if (!el || el === document.body) return;
      const side = el.closest(".focus-left, .focus-right");
      setFocusTyping(side ? (side.classList.contains("focus-right") ? "right" : "left") : null);
    };
    // A page took it. What was focused here would come back as this page
    // takes the keyboard on the way to a side (a page's ⌃h ⌃l), marking the
    // side it is on, so it lets go; a click puts the focus back.
    const toPage = () => {
      setTypingSide("pane");
      if (!document.hasFocus()) (document.activeElement as HTMLElement | null)?.blur();
    };
    // This page lost it, to a page (which says so in the Input mode) or to
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
        setFocusTyping(onFocusRightRef.current(payload.tab) ? "right" : "left");
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
  // The pane's tabs are kept across restarts: their pages (not the pages'
  // state), the pinned pages' too, and terminals attached to herdr sessions.
  const savedTabsJson = JSON.stringify({
    tabs: paneTabs
      .filter((t) => !t.creating && !t.review && (!t.term || t.term.herdr))
      .map((t): SavedTabs["tabs"][number] => ({ url: t.url, openedFor: t.openedFor, title: t.title, pinned: t.pinned ? t.id : undefined, term: t.term })),
    active: paneTabs.filter((t) => !t.creating && !t.review && (!t.term || t.term.herdr)).findIndex((t) => t.id === activeTab?.id),
  });
  useEffect(() => remember(PANE_TABS_KEY, savedTabsJson), [savedTabsJson]);
  // A kept terminal comes back only while its herdr session still runs.
  useEffect(() => {
    if (!tabs.some((t) => t.term?.herdr)) return;
    api.herdrSessions().then(({ running }) => setTabs((prev) => prev.filter((t) => !t.term?.herdr || running.includes(t.term.herdr))), report);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const closeShownRef = useRef(closeShown);
  closeShownRef.current = closeShown;
  /// ⌘⇧A: archives the cloud session the shown tab is on and closes the tab.
  /// False when the tab shows no cloud session.
  const archiveShown = () => {
    const id = browserShown && activeTab ? cloudIdOfPage(activeTab.url) : null;
    if (!id || !activeTab) return false;
    if (!activeTab.pinned) closeTab(activeTab.id);
    api.archiveSessions([id]).then(refresh, report);
    return true;
  };
  const archiveShownRef = useRef(archiveShown);
  archiveShownRef.current = archiveShown;
  // Pages report where they went and what they are called; links they open in
  // a new window arrive as new tabs.
  /// A tab moved on its own; the address bar follows without navigating it again.
  const setTabUrl = (id: string, url: string) => setTabs((prev) => prev.map((t) => (t.id === id && t.url !== url ? { ...t, url } : t)));
  const openRef = useRef(openInBrowser);
  openRef.current = openInBrowser;
  const openFromPageRef = useRef(openFromPage);
  openFromPageRef.current = openFromPage;
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
  const openCloud = (sessionId: string) => {
    api.markSessionSeen(sessionId).catch(report);
    return cloudTarget === "desktop" ? api.openSession(sessionId, "desktop").catch(report) : openInBrowser(cloudWebUrl(sessionId));
  };
  /// Starts a todo's session behind (StartTodo): a Cloud one's page is made
  /// behind when Cloud sessions open on the web, an in-app terminal's tab too.
  const startTodo: StartTodo = async (todoId, plan, launch) => {
    const e = effectiveLaunch(launch, plan);
    const options: StartOptions = { plan, agent: e.agent, ...(e.agent === "claude" ? { model: e.model || undefined, effort: e.effort || undefined } : {}) };
    if (e.runner === "cloud") {
      const finish = cloudTarget === "web" ? beginWeb() : undefined;
      try {
        finish?.(await api.startCloud(todoId, options));
      } catch (err) {
        finish?.(null);
        throw err;
      }
    } else if (inAppTerminal) inAppTerminal.open(await terminalApi.start(todoId, options));
    else await api.startTerminal(todoId, options);
  };
  /// 「再開して直させる」: the todo's session is sent what to fix in its PR,
  /// without the keyboard or the screen moving. A Cloud session cannot be
  /// sent anything from here yet: its page opens with the request typed in.
  const fixInSession: FixInSession = (s, todo) =>
    run(async () => {
      const r = await api.fixInSession(s.session_id, todo.id);
      if (r.sent) return showToast(`#${todo.id} のセッションに、直すように送りました`);
      api.markSessionSeen(s.session_id).catch(report);
      openInBrowser(cloudWebUrl(s.session_id), true, false, r.prompt);
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
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const openCloudRef = useRef(openCloud);
  openCloudRef.current = openCloud;
  useEffect(() => {
    const offs = [
      listen<{ tab: string; url: string; loading: boolean }>(BROWSER_URL_EVENT, ({ payload }) => {
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
      // In the Input mode a page's new window is a new tab on the left.
      listen<{ url: string; tab: string; behind: boolean }>(BROWSER_NEW_TAB_EVENT, ({ payload }) => {
        if (!focusModeRef.current) return openFromPageRef.current(payload.url, payload.tab, payload.behind);
        const [id] = addToFocusRef.current([{ url: payload.url }], undefined, payload.behind);
        if (id && !payload.behind) focusSoon(id);
      }),
      // A notification's PR: opened by the user, so it takes the keyboard.
      listen<{ url: string }>(OPEN_URL_EVENT, ({ payload }) => openRef.current(payload.url, true)),
      listen(OPEN_NEW_TODO_EVENT, () => {
        dialogFromPage.current = true;
        setDialog("add");
      }),
      listen<{ path: string; name: string }>(BROWSER_DOWNLOADED_EVENT, ({ payload }) => setDownloaded(payload)),
      listen<PageDialogAsk>(PAGE_DIALOG_EVENT, ({ payload }) => setPageDialog(payload)),
      listen<SiteAsk>(SITE_PERMISSION_EVENT, ({ payload }) => setSiteAsk(payload)),
      listen<{ url: string; title: string }>(ADD_INPUT_EVENT, ({ payload }) => addInputRef.current(payload.url, payload.title)),
      // The Input mode's left takes the browser's keys; it lets the app's other shortcuts through.
      listen(BROWSER_OPEN_NEW_TAB_EVENT, () => (focusModeRef.current ? newFocusTabRef.current() : openNewTab())),
      listen<{ tab: string; delta: number }>(BROWSER_SWITCH_TAB_EVENT, ({ payload }) =>
        focusModeRef.current ? switchFocusTabRef.current(onFocusRightRef.current(payload.tab), payload.delta) : switchRef.current(payload.delta),
      ),
      listen<{ tab: string }>(BROWSER_CLOSE_TAB_EVENT, ({ payload }) =>
        focusModeRef.current ? !onFocusRightRef.current(payload.tab) && closeFocusTabRef.current() : closeShownRef.current(),
      ),
      listen<{ tab: string }>(BROWSER_ARCHIVE_EVENT, () => !focusModeRef.current && archiveShownRef.current()),
      listen<{ tab: string }>(BROWSER_TO_INPUT_EVENT, () => {
        if (focusModeRef.current) return;
        dialogFromPage.current = true;
        toInputRef.current();
      }),
      listen(OPEN_PALETTE_EVENT, () => {
        dialogFromPage.current = true;
        paletteRef.current();
      }),
      listen(OPEN_SESSIONS_EVENT, () => {
        dialogFromPage.current = true;
        openSessionsRef.current();
      }),
      listen<{ theme_id: number; error: string | null }>(THEME_DOC_EVENT, ({ payload }) => {
        setFinishing((prev) => {
          const next = new Set(prev);
          next.delete(payload.theme_id);
          return next;
        });
        showToastRef.current(payload.error ? `ノートに書き足せませんでした：${payload.error}` : "テーマのノートに書き足しました");
      }),
      listen<{ id: number }>(OPEN_TODO_EVENT, ({ payload }) => goTodoRef.current(payload.id)),
      listen<{ channel: string; ts: string }>(OPEN_SLACK_EVENT, ({ payload }) => {
        setSlackPick(mentionKey(payload));
        setViewRef.current("slack");
      }),
      listen(FOCUS_EXIT_EVENT, () => setDialog("exitFocus")),
      listen<{ tab: string; text: string | null }>(FOCUS_PANE_EVENT, ({ payload }) => focusSideRef.current(true, payload.text ?? undefined)),
      // Back from the pane: nothing on this side keeps the typing, so j k work.
      listen(FOCUS_APP_EVENT, () => (focusModeRef.current ? focusSideRef.current(false) : (document.activeElement as HTMLElement | null)?.blur())),
      // Notifications open cloud sessions as set here.
      listen<{ session_id: string }>(OPEN_CLOUD_EVENT, ({ payload }) => openCloudRef.current(payload.session_id)),
    ];
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
    if (before.side === "pane" && before.tab && browserShown && !focusMode) {
      if (before.tab.term) focusTerminal(before.tab.id);
      else giveKeys(before.tab.id, report);
    } else if (before.side === "app") {
      if (before.el?.isConnected) before.el.focus();
      else (document.activeElement as HTMLElement | null)?.blur();
    }
  }, [dialogUp]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("all");
  const [view, setViewState] = useState<View>(() => load(VIEW_KEY, ["todos", "inputs", "sessions", "prs", "artifacts", "slack"] as const, "todos"));
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
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [limits, setLimits] = useState<Limit[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [prs, setPrs] = useState<PrLists | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } }));

  const setView = (v: View) => {
    remember(VIEW_KEY, v);
    setViewState(v);
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
  const [dockW, setDockWState] = useState(() => loadJson<number>(DOCK_W_KEY, Math.max(DOCK_MIN_W, Math.round(window.innerWidth * DOCK_DEFAULT_SHARE))));
  const setDockW = (w: number) => {
    remember(DOCK_W_KEY, String(w));
    setDockWState(w);
  };
  const [focusRightW, setFocusRightWState] = useState(() => loadJson<number>(FOCUS_RIGHT_W_KEY, Math.max(DOCK_MIN_W, Math.round(window.innerWidth * FOCUS_RIGHT_SHARE))));
  const setFocusRightW = (w: number) => {
    remember(FOCUS_RIGHT_W_KEY, String(w));
    setFocusRightWState(w);
  };
  const [prsLoading, setPrsLoading] = useState(false);
  const loadPrs = useCallback(() => {
    prsLoadedAt.current = Date.now();
    setPrsLoading(true);
    api
      .ghPrs()
      .then(
        (p) => (setPrs(p), setPrError(null)),
        (e) => setPrError(String(e)),
      )
      .finally(() => setPrsLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    api.localRepos().then(setLocal, () => setLocal([]));
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
        // A selection in the focus mode's terminal goes along to the right.
        const inTerminal = (e.target as HTMLElement).closest(".xterm");
        focusSideRef.current(matches(e, "sidePane"), inTerminal && focusLeftRef.current ? terminalSelection(focusLeftRef.current.id) : undefined);
        return;
      }
      if (sideZoneRef.current && !e.metaKey && !e.ctrlKey) {
        // The sidebar's keys are its own (picking an entry re-renders at once,
        // and the pages' keys must not take the same Enter after it).
        e.stopImmediatePropagation();
        const step = stepOf(e);
        if (step) {
          e.preventDefault();
          setSideCursor((i) => Math.min(Math.max(i + step, 0), sideItems().length - 1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          // Picks the entry and goes over to what it shows.
          sideItems()[sideCursorRef.current]?.click();
          setSideZone(false);
        } else if (e.key === "Escape") setSideZone(false);
        return;
      }
      // The focus mode: Esc asks about leaving (a terminal keeps its Esc, and
      // the address bar its own), the left takes ⌘T ⌘W as a browser, and ⌘
      // otherwise only edits text.
      if (focusModeRef.current) {
        const t = e.target as HTMLElement;
        if (matches(e, "newTab")) {
          e.preventDefault();
          newFocusTabRef.current();
        } else if (matches(e, "closeTab")) {
          e.preventDefault();
          if (!t.closest(".focus-right")) closeFocusTabRef.current();
        } else if (matches(e, "prevTab") || matches(e, "nextTab")) {
          e.preventDefault();
          switchFocusTabRef.current(!!t.closest(".focus-right"), matches(e, "prevTab") ? -1 : 1);
        } else if (matches(e, "palette")) {
          e.preventDefault();
          paletteRef.current();
        } else if (e.key === "Escape" && !t.closest(".xterm, input, textarea") && !document.querySelector("[role=dialog]")) {
          e.preventDefault();
          setDialog("exitFocus");
        } else if (e.metaKey && !FOCUS_EDIT_KEYS.includes(e.key.toLowerCase())) e.preventDefault();
        return;
      }
      // The tabs move only while the pane has the typing (as marked); on the
      // Todo side these keys go through the lanes (todoKeys.ts).
      if ((matches(e, "prevTab") || matches(e, "nextTab")) && typingSideRef.current !== "pane" && !(e.target as HTMLElement).closest(".browser-dock")) return;
      const run: [Action, () => unknown][] = [
        // The pane's page, while the pane has the typing (on the sessions page ⌘⇧A puts its row away).
        ["archive", () => typingSideRef.current === "pane" && archiveShownRef.current()],
        ["toInput", () => toInputRef.current()],
        ["prevTab", () => switchRef.current(-1)],
        ["nextTab", () => switchRef.current(1)],
        // On the Input page it adds an input.
        ["newTodo", () => setDialog("add")],
        // Again closes the commands.
        ["palette", () => setDialog((d) => (d === "palette" ? null : "palette"))],
        ["newTab", () => openNewTab()],
        ["closeTab", () => closeShownRef.current()],
        // This side's reload takes the page's data again (a page's own reloads the page).
        ["reload", () => reloadRef.current()],
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
  const allInputs = board?.inputs ?? [];
  const selectedTodo = selection?.kind === "todo" ? allTodos.find((t) => t.id === selection.id) ?? null : null;

  // "+ 新規" in a lane: a todo there with that status, a subtask when the lane is a parent's.
  const addTodoIn = (lane: Lane, status: Status, title: string) =>
    run(async () => {
      const repos = lane.parent ? (lane.parent.repos.length === 1 && !lane.parent.repos_derived ? lane.parent.repos : []) : lane.repo && lane.repo !== NO_REPO_LANE ? [lane.repo] : [];
      const cwd = repos.length === 1 ? local.find((r) => r.key === repos[0])?.path : undefined;
      const todo = await api.createTodo({ title, repos, cwd, parent_id: lane.parent?.id });
      if (status !== "todo") await api.updateTodo(todo.id, { status });
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
  // A Done parent without shown subtasks is a card like any other.
  const lanes = buildLanes(visibleTodos, groupBy, shownTodos);
  const repoLanes = buildLanes(shownTodos, "repo", shownTodos);
  // Free group names in use, offered beside repositories when picking.
  const groups = [...new Set(allTodos.flatMap((t) => t.repos).filter((r) => !isGithubRepo(r)))].sort();
  const allSessions = [...allTodos.flatMap(liveSessions), ...(board?.inbox ?? []).filter((s) => s.state !== "ended")];
  /// A terminal's title: the session it shows, as the session list names it.
  const sessionTitle = (id: string) => (board ? (sessionItemsOf(board).find((i) => i.session.session_id === id)?.session.title ?? null) : null);
  // A session whose page or terminal the pane shows (the app in front) is looked at.
  const watchedSession = browserShown && typingSide !== null && activeTab ? (activeTab.term?.session ?? cloudIdOfPage(activeTab.url)) : null;
  const watchedUnread = !!watchedSession && allSessions.some((s) => s.session_id === watchedSession && s.unread);
  useEffect(() => {
    if (watchedSession && watchedUnread && pageVisible()) api.markSessionSeen(watchedSession).then(refresh, report);
  }, [watchedSession, watchedUnread]); // eslint-disable-line react-hooks/exhaustive-deps
  // The review group follows the reviews asking before they submit on Cloud:
  // one put away (submitted, stopped) loses its tab, and one without a tab
  // (after a restart) gets it again, behind.
  useEffect(() => {
    if (!board) return;
    const known = new Map(board.inbox.map((s) => [s.session_id, s]));
    const live = (s: Session | undefined) => !!s && !s.hidden && s.state !== "ended";
    const gone = tabs.filter((t) => t.review?.session && (t.review.seen || known.has(t.review.session)) && !live(known.get(t.review.session)));
    for (const t of gone) api.browserClose(t.id).catch(report);
    const wanted = board.inbox.filter((s) => s.review_url && isCloud(s) && !s.review_auto && live(s) && !tabs.some((t) => t.review?.session === s.session_id || (t.creating && t.review?.url === s.review_url)));
    if (gone.length === 0 && wanted.length === 0 && !tabs.some((t) => t.review?.session && !t.review.seen && known.has(t.review.session))) return;
    setTabs((prev) => [
      ...prev
        .filter((t) => !gone.some((g) => g.id === t.id))
        .map((t) => (t.review?.session && !t.review.seen && known.has(t.review.session) ? { ...t, review: { ...t.review, seen: true } } : t)),
      ...wanted.map((s): BrowserTab => {
        const url = cloudWebUrl(s.session_id);
        const pr = s.review_url!;
        return { id: `t${nextTab.current++}`, url, openedFor: url, title: null, loading: false, nav: 0, review: { url: pr, ref: prRef(pr).split("/").pop() ?? pr, title: (s.title ?? "").replace(REVIEW_TITLE_PREFIX, ""), session: s.session_id, seen: true } };
      }),
    ]);
    // The tab shown went: the first of the others comes up, else a new tab page.
    if (gone.some((t) => t.id === activeTab?.id)) {
      const rest = normalTabs.filter((t) => !gone.includes(t));
      if (rest.length > 0) setActiveTabId(rest[0].id);
      else setNewTab(true);
    }
  }, [board]); // eslint-disable-line react-hooks/exhaustive-deps
  /// ×  on a review's tab: the review stops (its session archived or closed) and the tab goes.
  const stopReview = (id: string) => {
    const session = tabs.find((t) => t.id === id)?.review?.session;
    if (session) run(() => api.stopReview(session));
    closeTab(id);
  };
  const waiting = waitingOnYou({ todos: allTodos, inbox: board?.inbox ?? [], reviews: prs?.review ?? [], now: Date.now() / 1000 });
  waitingKeys.current = waiting.map((w) => w.key);
  /// The sessions page on あなた待ち (the strip over the kanban, the banner after the focus mode).
  const showWaiting = () => {
    setSessionFilter("waiting");
    setView("sessions");
  };
  const openTodoCount = allTodos.filter((t) => t.status !== "done").length;
  const colCounts = Object.fromEntries(COLUMNS.map((c) => [c.status, visibleTodos.filter((t) => t.status === c.status).length])) as Record<Status, number>;


  const openTodo = (id: number) => {
    setSelection({ kind: "todo", id });
    // The panel shows issue and PR state; fetch this todo's now.
    api.syncNow(id).catch(() => {});
  };
  const goTodo = (id: number) => {
    setView("todos");
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
  const reload = () => (view === "prs" ? loadPrs() : syncAll());
  const reloadRef = useRef(reload);
  reloadRef.current = reload;


  const covered = dialog !== null || pageDialog !== null;
  // j k / h l and the other keys of the Todo pages (todoKeys.ts).
  const todoPage = useRef<HTMLDivElement>(null);
  const [statusMenuFor, setStatusMenuFor] = useState<number | null>(null);
  const statusMenuTodo = statusMenuFor !== null ? allTodos.find((t) => t.id === statusMenuFor) : undefined;
  const { setCursor: setTodoCursor } = useTodoKeys(todoPage, layout, view === "todos" && !covered && !focusMode && !sideZone, selectedTodo !== null, {
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
    // Over the todo's sheet, which shows the session once it starts.
    start: (id) => {
      openTodo(id);
      setDialog("start");
    },
    close: () => setSelection(null),
    toggleLane,
    isCollapsed: (lane) => collapsed.has(lane),
  });
  // The sheet over the sessions page, where the Todo pages' keys are not: Esc closes it, ⌘Enter the launch sheet.
  const sessionsSheet = view === "sessions" && selectedTodo !== null && !covered;
  useEffect(() => {
    if (!sessionsSheet) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest(TYPING)) return;
      if (e.key === "Escape") setSelection(null);
      else if (matches(e, "start")) setDialog("start");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessionsSheet]);
  // The keys act on the todo the sheet shows, however it was opened.
  useEffect(() => {
    if (selection?.kind === "todo") setTodoCursor(`todo:${selection.id}`);
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps
  const draggedTodo = dragging !== null ? allTodos.find((t) => t.id === dragging) : undefined;
  // Review requests no review session has taken yet.
  const reviewCount = waiting.filter((w) => w.reasons.includes("review")).length;
  const slackUnread = board?.slack.connected ? board.slack.messages.filter((m) => !m.read).length + board.slack.threads.length : 0;

  // The sidebar lists the objects only, each with what of it waits on the
  // user (or how many there are); how a list shows is chosen on its page.
  const nav: { key: string; group: NavGroup; label: string; icon: IconName; badge?: React.ReactNode; count?: number; on: boolean; go: () => void }[] = [
    { key: "todos", group: "仕事", label: "Todo", icon: "board", count: openTodoCount, on: view === "todos", go: () => setView("todos") },
    {
      group: "仕事",
      key: "sessions",
      label: "セッション",
      icon: "spark",
      // Its badge is what waits on the user; the count only without it.
      count: waiting.length > 0 ? undefined : allSessions.length,
      on: view === "sessions",
      go: () => setView("sessions"),
      badge: waiting.length > 0 && (
        <span className="pill waiting" title="あなたが動かないと進まないもの：返事待ち・CI 失敗・修正依頼・未着手のレビュー依頼">
          <i />
          あなた待ち {waiting.length}
        </span>
      ),
    },
    { key: "prs", group: "仕事", label: "PR", icon: "pr", on: view === "prs", go: () => setView("prs"), badge: reviewCount > 0 && <span className="pill accent" title="まだレビューを始めていないレビュー依頼">レビュー {reviewCount}</span> },
    { key: "artifacts", group: "仕事", label: "成果物", icon: "open", count: board?.artifacts.length, on: view === "artifacts", go: () => setView("artifacts") },
    {
      key: "slack",
      group: "連絡",
      label: "Slack",
      icon: "chat",
      on: view === "slack",
      go: () => setView("slack"),
      badge: slackUnread > 0 && <span className="pill accent" title="未読のメンションと、新しい返信があるスレッド">{slackUnread}</span>,
    },
    {
      key: "inputs",
      group: "学び",
      label: "テーマ",
      icon: "import",
      on: view === "inputs",
      go: () => setView("inputs"),
      badge: reviewsDue > 0 && <span className="pill accent" title="理解度から決めた復習どきのテーマ">復習 {reviewsDue}</span>,
    },
  ];

  // ⌘K lists the sidebar's entries first, in its order, then the actions.
  // The live sessions, the one that changed last first, each opened as its "開く" does.
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
        run: () => (isCloud(s) ? openCloud(s.session_id) : openLocal(inAppTerminal, s.session_id, report, true)),
      }));
  const sessionsCommand: Command = { key: "sessions", label: "セッション一覧", hint: `${allSessions.length}件`, run: () => {}, items: sessionCommands };
  /// ⌘⇧K: ⌘K's list of sessions straight away (leaving the Input mode, as ⌘K does).
  const openSessions = () => {
    if (focusModeRef.current) exitFocus();
    setPaletteStart({ command: sessionsCommand });
    setDialog("palette");
  };
  const openSessionsRef = useRef(openSessions);
  openSessionsRef.current = openSessions;
  const commands: Command[] = [
    sessionsCommand,
    ...nav.map((n) => ({ key: `nav:${n.key}`, label: n.label, run: n.go })),
    { key: "browser", label: browserShown ? "ペインを隠す" : "ペインを出す", run: toggleBrowser },
    ...PINNED_PAGES.map((p) => ({ key: p.id, label: p.label, run: () => showPinned(p.id) })),
    ...savedFilters.map((f) => ({ key: `filter:${f.id}`, label: `フィルター: ${f.name}`, run: () => applyFilter(f) })),
    {
      key: "study",
      label: "学ぶ時間を始める（テーマを選ぶ）",
      run: () => {},
      items: () => (board?.themes ?? []).map((t) => ({ key: `theme:${t.id}`, label: t.name, hint: t.goal ?? undefined, run: () => studyTheme(t, unreadOf(t)) })),
    },
    { key: "shortcuts", label: "キーの一覧", hint: keyLabel(keyOf("help")), run: () => setDialog("keys") },
    { key: "settings", label: "設定（開く場所・ターミナル・herdr・ログイン・サイトの許可）", run: () => setDialog("settings") },
    { key: "forgetLogin", label: "表示中のサイトの保存したログインを消す", run: forgetShownLogin },
    { key: "add", label: "新しい Todo", hint: "⌘N", run: () => setDialog("add") },
    ...(browserShown && activeTab && !activeTab.term && !activeTab.pinned
      ? [{ key: "toInput", label: "表示中のページを学びに入れる", run: toInput }]
      : []),
    { key: "import", label: "自分に割り当てられた issue を取り込む", run: () => setDialog("import") },
    { key: "quick", label: "ちょっと Claude（todo に紐づけずに起動）", run: () => setDialog("quick") },
    { key: "sync", label: "GitHub とクラウドを今すぐ同期", run: syncAll },
    ...(filterCount(todoFilter) > 0 ? [{ key: "clearFilter", label: "フィルターを外す", run: () => setTodoFilter(NO_FILTER, true) }] : []),
    { key: "newTab", label: "ブラウザで新しいタブを開く", hint: "⌘T", run: openNewTab },
  ];

  // A todo picked on the sessions page opens in the same sheet, over the sessions.
  const panel = (view === "todos" || view === "sessions") && selectedTodo ? "todo" : null;

  return (
    <BrowserContext.Provider value={openInBrowser}>
    <BeginWebContext.Provider value={beginWeb}>
    <OpenCloudContext.Provider value={openCloud}>
    <FixContext.Provider value={fixInSession}>
    <StartTodoContext.Provider value={startTodo}>
    <TerminalContext.Provider value={inAppTerminal}>
    <SessionTitleContext.Provider value={sessionTitle}>
      <div
        className={`app${browserShown ? " with-browser" : ""}${browserShown && !focusMode && typingSide ? ` typing-${typingSide}` : ""}${focusMode ? ` focus${focusTyping ? ` typing-${focusTyping}` : ""}` : ""}`}
        data-zone={sideZone ? "sidebar" : undefined}
        style={{ "--panel-w": `${panelW}px`, "--dock-w": `${dockW}px`, "--focus-right-w": `${focusRightW}px` } as React.CSSProperties}
      >
        <aside className="sidebar" onPointerDown={() => sideZoneRef.current && setSideZone(false)}>
          <div className="brand">
            <img className="brand-mark" src={logoUrl} alt="" aria-hidden="true" />
            <span>Shosai</span>
          </div>
          <button className="search" onClick={() => setDialog("palette")}>
            <Icon name="search" size={13} />
            <span className="grow ellipsis">検索・操作</span>
            <span className="kbd">⌘K</span>
          </button>
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
            <div className="foot-row">
              <button className={`ghost small${browserShown ? " on" : ""}`} aria-pressed={browserShown} title="右のペイン（開いたページとターミナル）を出す・隠す。⌘T で新しいタブ" onClick={toggleBrowser}>
                <Icon name="globe" size={13} /> ペイン
              </button>
              <span className="grow" />
              <button className="ghost small" onClick={() => setDialog("settings")}>
                設定
              </button>
            </div>
            <UsageBox limits={limits} error={usageError} />
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
          {(closePrompt || error || heldWaiting > 0) && (
            <div className="banners">
              {heldWaiting > 0 && (
                <div className="notice" role="status">
                  <span className="grow">学ぶ時間のあいだに、あなた待ちが {heldWaiting} 件増えました。</span>
                  <button className="primary small" onClick={() => (setHeldWaiting(0), showWaiting())}>
                    あなた待ちを見る
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

          {view === "todos" && (
            <>
              <header className="toolbar">
                <h1>Todo</h1>
                <div className="segmented" role="group" aria-label="見え方">
                  {(["board", "list"] as const).map((l) => (
                    <button key={l} className={layout === l ? "on" : ""} aria-pressed={layout === l} onClick={() => showTodos(l)}>
                      {l === "board" ? "カンバン" : "リスト"}
                    </button>
                  ))}
                </div>
                <div className="segmented" role="group" aria-label="まとめ方">
                  {GROUPINGS.map((g) => (
                    <button key={g.key} className={groupBy === g.key ? "on" : ""} aria-pressed={groupBy === g.key} onClick={() => setGroupBy(g.key)}>
                      {g.label}
                    </button>
                  ))}
                </div>
                  <TodoFilterBar
                  filter={todoFilter}
                  version={`${layout}:${filterVersion}`}
                  places={repoLanes.map((l) => l.key)}
                  onChange={(f) => setTodoFilter(f, f === NO_FILTER)}
                  onSave={saveFilter}
                />
                {savedFilters.length > 0 && (
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
                {savedFilters.some((f) => f.layout === layout && sameFilter(todoFilter, f.filter)) && (
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
                <button className="primary" onClick={() => setDialog("add")}>
                  <Icon name="plus" size={13} /> 新しい Todo <span className="kbd">⌘N</span>
                </button>
              </header>
              <WaitingStrip items={waiting} onShow={showWaiting} onShowPrs={() => setView("prs")} />
              <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
                <div className="content" ref={todoPage}>
                  {layout === "board" && lanes.length > 0 && (
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
                    layout === "board" ? (
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
                        folded={foldedCols}
                        onUnfold={toggleColumn}
                        onAdd={(title) => addTodoIn(lane, "todo", title)}
                      />
                    ),
                  )}
                  {board && lanes.length === 0 && (
                    <p className="muted empty">
                      {filterCount(todoFilter) > 0 ? "フィルターに合う todo はありません。" : "表示できる todo がありません。⌘N で追加するか、⌘K から issue を取り込めます。"}
                    </p>
                  )}
                </div>
                {statusMenuTodo && <StatusMenu todo={statusMenuTodo} onPick={(st) => setStatus(statusMenuTodo, st)} onClose={() => setStatusMenuFor(null)} />}
                <DragOverlay dropAnimation={null}>{draggedTodo && <div className="card overlay">{draggedTodo.title}</div>}</DragOverlay>
              </DndContext>
            </>
          )}
          {view === "sessions" && board && (
            <SessionsPage
              board={board}
              waiting={waiting}
              filter={sessionFilter}
              onFilter={setSessionFilter}
              run={run}
              report={report}
              onOpenTodo={openTodo}
              onQuick={() => setDialog("quick")}
              onShowPrs={() => setView("prs")}
            />
          )}
          {view === "inputs" && board && <ThemesPage themes={board.themes} inputs={allInputs} feynman={feynmanOf} run={run} report={report} onStudy={studyTheme} />}
          {view === "prs" && (
            <PrsPage
              prs={prs}
              prsLoading={prsLoading}
              prError={prError}
              todos={allTodos}
              sessions={board?.inbox ?? []}
              submitted={submittedReviews}
              local={local}
              browserUrl={browserUrl}
              run={run}
              onRefresh={loadPrs}
              onOpenTodo={goTodo}
            />
          )}
          {view === "artifacts" && board && <ArtifactsPage artifacts={board.artifacts} todos={allTodos} report={report} onOpenTodo={goTodo} />}
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
            // A sheet over the Todo page, not a dialog: the pane stays, and j k go on to the next todo.
            <div className="sheet-backdrop" onClick={() => setSelection(null)}>
              <TodoPanel
                todo={selectedTodo}
                allTodos={allTodos}
                waiting={waiting}
                artifacts={board?.artifacts ?? []}
                local={local}
                groups={groups}
                run={run}
                report={report}
                setStatus={setStatus}
                onOpenTodo={openTodo}
                onStart={() => setDialog("start")}
                onClose={() => setSelection(null)}
              />
            </div>
          )}
        </main>

        {focusMode && (
          <FocusMode
            theme={focusTheme}
            overlay={reviewing && focusTheme ? <ReviewPanel theme={focusTheme} report={report} onDone={() => setReviewing(false)} onExit={exitFocus} /> : null}
            finishing={!!focusTheme && finishing.has(focusTheme.id)}
            onFinish={finishReading}
            lefts={focusLefts}
            left={focusLeft}
            onSelectLeft={(id) => {
              keysToTab(tabs.find((t) => t.id === id) ?? null, focusLeft?.id, report);
              patchSpace(spaceKey, (s) => ({ ...s, active: id, newTab: false }));
            }}
            onLeftStrip={() => focusLeft && keysToTab(focusLeft, focusLeft.id, report)}
            onCloseLeft={removeFromFocus}
            onAddLeft={pickFocus}
            onOpenLeft={(url) => {
              const [id] = addToFocus([{ url }]);
              if (id) focusSoon(id);
            }}
            right={focusRightTab}
            rightKind={focusRight}
            covered={covered}
            report={report}
            width={focusRightW}
            onResize={setFocusRightW}
            onRight={setFocusRight}
            onAddress={setTabUrl}
            onExit={exitFocus}
            typing={focusTyping}
          />
        )}
        {browserShown && !focusMode && (
          <aside className="browser-dock">
            <Resizer label="ブラウザの幅" cssVar="--dock-w" width={dockW} min={DOCK_MIN_W} max={() => maxPaneWidth(0)} onResize={setDockW} />
            <BrowserDock
              tabs={paneTabs.filter((t) => !t.review)}
              reviews={reviewTabs}
              narrow={dockW < REVIEW_FOLD_W}
              sessionOf={(id) => (id ? board?.inbox.find((s) => s.session_id === id) : undefined)}
              onStopReview={stopReview}
              active={activeTab}
              covered={covered}
              report={report}
              onSelect={(id) => {
                keysToTab(tabs.find((t) => t.id === id) ?? null, activeTab?.id, report);
                setActiveTabId(id);
              }}
              onStrip={() => activeTab && keysToTab(activeTab, activeTab.id, report)}
              onPinned={showPinned}
              onArchive={() => archiveShownRef.current()}
              onClose={closeTab}
              onNewTab={openNewTab}
              onHide={() => setBrowserShown(false)}
              // What is typed on a new tab page opens in a new tab, as a page's link does.
              onOpen={(url) => openFromPage(url, activeTab?.id ?? "", false)}
              onAddress={setTabUrl}
              onToInput={toInput}
              onMove={(id, to) =>
                setTabs((prev) => {
                  const from = prev.findIndex((t) => t.id === id);
                  const target = prev.findIndex((t) => t.id === to);
                  if (from < 0 || target < 0) return prev;
                  const next = [...prev];
                  next.splice(target, 0, ...next.splice(from, 1));
                  return next;
                })
              }
            />
          </aside>
        )}

        {dialog === "toInput" && toInputPage && (
          <AddToThemeDialog page={toInputPage} themes={board?.themes ?? []} run={run} onDone={setAddedInput} onClose={() => setDialog(null)} />
        )}
        {dialog === "add" && (
          <AddTodoDialog
            local={local}
            groups={groups}
            initialRepo={todoFilter.places.length === 1 ? todoFilter.places[0] : null}
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
        {dialog === "exitFocus" && (
          <ExitFocusDialog
            onExit={exitFocus}
            onStay={() => {
              setDialog(null);
              // Back to typing on the right once its page is up again.
              focusSoon(focusRightId, true);
            }}
          />
        )}
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
            report={report}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === "start" && selectedTodo && (
          <StartDialog todo={selectedTodo} allTodos={allTodos} run={run} onClose={() => setDialog(null)} />
        )}
        {dialog === "focusPick" && (
          <FocusPicker
            terminals={paneTabs.filter((t) => t.term)}
            inputs={focusTheme ? allInputs.filter((i) => i.theme_id === focusTheme.id) : []}
            onClose={() => setDialog(null)}
            onPick={(item) => {
              setDialog(null);
              addToFocus([item]);
            }}
          />
        )}
        {dialog === "palette" && (
          <CommandPalette
            commands={commands}
            todos={allTodos}
            themes={board?.themes ?? []}
            start={paletteStart?.command}
            onOpenTodo={goTodo}
            onStudy={(t) => studyTheme(t, unreadOf(t))}
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
    </BeginWebContext.Provider>
    </BrowserContext.Provider>
  );
}
