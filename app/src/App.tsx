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
  FOCUS_APP_EVENT,
  PAGE_FOCUSED_EVENT,
  FOCUS_PANE_EVENT,
  FOCUS_EXIT_EVENT,
  FOCUS_LINK_EVENT,
  ADD_INPUT_EVENT,
  WINDOW_FOCUS_EVENT,
  BROWSER_NEW_TAB_EVENT,
  OPEN_CLOUD_EVENT,
  BROWSER_TITLE_EVENT,
  BROWSER_URL_EVENT,
  CLOUD_HOME,
  cloudWebUrl,
  EFFORTS,
  isCloud,
  issueRef,
  JEV_NO_KEY,
  MODELS,
  type Board,
  type Input,
  type NoteFormat,
  type Subject,
  type Issue,
  type HerdrSessions,
  type Limit,
  type LocalRepo,
  type Notice,
  type Pr,
  type PrLists,
  type PrState,
  type Runner,
  type Session,
  type SessionDetail,
  type SessionState,
  type Skill,
  type StartOptions,
  type Status,
  type Todo,
  type Verdict,
} from "./api";
import { useTodoKeys } from "./todoKeys";
import { ACTIONS, comboOf, DEFAULT_KEYS, keyLabel, keyOf, matches, resetKeys, setKeys, useKeymap, type Action } from "./keymap";
import { closeTerminal, focusTerminal, terminalSelection, OPEN_LOCAL_EVENT, TERMINAL_TARGET_KEY, terminalApi, TerminalView, type TerminalRun, type TerminalTarget } from "./Terminal";

const REFRESH_MS = 3000;
/// The usage API answers 429 when asked often (status lines poll it too), so
/// it is asked rarely once there are numbers, which then stay on errors.
const USAGE_REFRESH_MS = 5 * 60_000;
/// Until the first numbers arrive, asked again this soon.
const USAGE_RETRY_MS = 60_000;
const PR_REFRESH_MS = 5 * 60_000;
/// How long the focus events are let settle before marking the typing's side.
const FOCUS_SETTLE_MS = 120;
const DETAIL_REFRESH_MS = 10_000;
/// The shown tab's address is checked this often, for pages that move
/// without loading or changing their title.
const ADDRESS_POLL_MS = 500;
/// A tab starts moving once the pointer has gone this far with the button down.
const TAB_DRAG_PX = 4;

/// The window is on screen. Closing it only hides it (the app stays in the
/// menu bar), and there is no point polling for a page nobody sees.
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
const DONE_RECENT = 3;
/// Skill chips shown before the rest go into the "その他" menu.
const SKILL_CHIPS = 5;
const VIEW_KEY = "view";
const LAYOUT_KEY = "layout";
const COLLAPSED_KEY = "collapsedLanes";
const DONE_RECENT_KEY = "doneRecent";
const GROUP_KEY = "groupBy";
const START_KEY = "startChoice";
const REVIEW_RUNNER_KEY = "reviewRunner";
const LINK_TARGET_KEY = "linkTarget";
const BROWSER_SHOWN_KEY = "browserShown";
const HERDR_SESSION_KEY = "herdrSession";

/// Where pages open: the app's browser pane, or Dia with its own sign-ins.
type LinkTarget = "app" | "dia";

type View = "todos" | "inputs" | "sessions" | "prs" | "notices";
type Layout = "board" | "list";
type GroupBy = "repo" | "parent";

const GROUPINGS: { key: GroupBy; label: string }[] = [
  { key: "repo", label: "リポジトリ" },
  { key: "parent", label: "親タスク" },
];

const RUNNER_LABEL: Record<Runner, string> = {
  auto: "自動（Cloud 優先）",
  cloud: "Cloud",
  local: "Local（herdr）",
};

/// Where a new session starts. "web" is a cloud session shown on claude.ai
/// in the app's browser pane; "cloud" opens it in Claude Desktop instead.
type Target = "web" | "cloud" | "desktop" | "terminal" | "queue";
const TARGETS: { key: Target; label: string }[] = [
  { key: "web", label: "Cloud・Web" },
  { key: "cloud", label: "Cloud・Desktop" },
  { key: "desktop", label: "Local・Desktop" },
  { key: "terminal", label: "herdr" },
  { key: "queue", label: "キュー" },
];
const isCloudTarget = (t: Target) => t === "web" || t === "cloud";

/// Opens a page in the browser pane docked on the right. It stays open across
/// screens until closed, so opening a page never leaves the current one.
type OpenInBrowser = (url: string) => void;
const BrowserContext = createContext<OpenInBrowser | null>(null);

/// Creating a cloud session takes seconds, so its tab opens at once on
/// claude.ai (loading alongside) and moves to the session once it exists.
/// Call the returned function with the session id, or null if it failed.
type BeginWeb = () => (sessionId: string | null) => void;
const BeginWebContext = createContext<BeginWeb | null>(null);

/// Where "開く" takes a cloud session: its web page, or Claude Desktop.
type CloudTarget = "web" | "desktop";
const CLOUD_TARGET_KEY = "cloudTarget";
const OpenCloudContext = createContext<((sessionId: string) => void) | null>(null);

/// With the in-app terminal chosen: opens a run in a terminal tab, and brings
/// up the tab a session already runs in (false when there is none).
interface InAppTerminal {
  open: (run: TerminalRun) => void;
  focus: (sessionId: string) => boolean;
}
const TerminalContext = createContext<InAppTerminal | null>(null);
/// Opens a local session in herdr, or in a terminal tab when the in-app
/// terminal is chosen; one still running comes to the front where it runs.
/// `main` is "開く": with herdr it falls back to Desktop, and with the
/// in-app terminal a session Desktop knows opens there.
function openLocal(terminal: InAppTerminal | null, sessionId: string, report: (e: unknown) => void, main = false) {
  if (!terminal) return void api.openSession(sessionId, main ? undefined : "herdr").catch(report);
  if (terminal.focus(sessionId)) return;
  terminalApi.resume(sessionId, main).then((r) => r && terminal.open(r), report);
}

const COLUMNS: { status: Status; label: string }[] = [
  { status: "todo", label: "Todo" },
  { status: "doing", label: "Doing" },
  { status: "review", label: "Review" },
  { status: "pending", label: "Pending" },
  { status: "done", label: "Done" },
];

const STATE_LABEL: Record<SessionState, string> = {
  running: "実行中",
  needs_input: "入力待ち",
  idle: "待機中",
  ended: "終了",
};

/// The state that needs the user comes first.
const STATE_ORDER: SessionState[] = ["needs_input", "running", "idle", "ended"];

/// Status order for the list: what is in progress first, done last.
const STATUS_RANK: Record<Status, number> = { review: 0, doing: 1, todo: 2, pending: 3, done: 4 };

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

function tokensLabel(n: number) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

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
/// The Input mode: the page a new space shows on the right, and that side's width.
const FOCUS_RIGHT_KEY = "focusRight";
/// Each subject's space, saved to be resumed (SavedSpace by subjectKey).
const INPUT_SPACES_KEY = "inputSpaces";
/// The space of pages picked without a todo or an input; it closes with the Input mode.
const FREE_SPACE = "free";
/// A subject's spaces and notes are kept under this (letters and digits, as tab ids are).
const subjectKey = (s: Subject | null) => (s === null ? FREE_SPACE : `${s.kind === "todo" ? "t" : "i"}${s.id}`);
const FOCUS_RIGHT_W_KEY = "focusRightWidth";
const FOCUS_RIGHT_SHARE = 0.45;
/// The focus mode's note: an artifact (a doc, page, deck or design) a
/// session makes of the left's pages, commented on to ask it (FocusNote). Its
/// tab on the right, its address, and the session making it for each todo
/// (kept, as it goes on answering).
const NOTE_TAB = "fnote";
const NOTE_PAGE = /^https:\/\/claude\.ai\/(code\/)?artifact\//;
const NOTE_SESSIONS_KEY = "noteSessions";
const NOTE_FORMAT_KEY = "noteFormat";
const NOTE_FORMATS: [NoteFormat, string][] = [
  ["docs", "Docs"],
  ["page", "HTML"],
  ["slides", "スライド"],
  ["design", "デザイン"],
];
interface NoteSession {
  session: string;
  cloud: boolean;
}
/// How often a note being made is looked for in its session.
const NOTE_POLL_MS = 5000;
/// The right pages a space may show.
const RIGHT_KINDS = [NOTE_TAB, "pinchatgpt", "pinclaude", "pinnotion"];
/// A space's tab for a right page (ids are letters and digits only).
const rightTabId = (space: string, kind: string) => `s${space}${kind}`;
const newSpace = (right: string): InputSpace => ({ lefts: [], active: null, right, pages: [], accepted: [], rightUrls: {} });
/// Where the focus mode's right pages may go (address prefixes), with the
/// sign-in pages they send to.
const SIGN_IN_PAGES = ["https://accounts.google.com/", "https://appleid.apple.com/", "https://login.microsoftonline.com/"];
const FOCUS_RIGHT_ALLOW: Record<string, string[]> = {
  pinchatgpt: ["https://chatgpt.com/", "https://auth.openai.com/", ...SIGN_IN_PAGES],
  pinclaude: ["https://claude.ai/", ...SIGN_IN_PAGES],
  pinnotion: ["https://www.notion.so/", "https://notion.so/", ...SIGN_IN_PAGES],
  // The note, and its Cloud session's page while it is made.
  [NOTE_TAB]: ["https://claude.ai/", ...SIGN_IN_PAGES],
};
/// The prefix a page's address allows: the page and the ones under it.
const pagePrefix = (url: string) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
};
/// A study page allows its whole site.
const sitePrefix = (url: string) => {
  try {
    return new URL(url).origin + "/";
  } catch {
    return url;
  }
};
/// How long "input に追加しました" stays.
const ADDED_INPUT_MS = 3000;
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
  | "up" | "down" | "chevron" | "chevronRight" | "more" | "back" | "forward" | "reload" | "bell" | "chat"
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
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4",
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

/// Linear-style status mark: empty, half, three quarters, checked.
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

function StateBadge({ state }: { state: SessionState }) {
  return (
    <span className={`state state-${state}`}>
      <i />
      {STATE_LABEL[state]}
    </span>
  );
}

function RepoDot({ repo }: { repo: string }) {
  const bg = repo === NO_REPO_LANE ? "var(--text-3)" : `hsl(${repoHue(repo)} 70% 64%)`;
  return <span className="repo-dot" style={{ background: bg }} />;
}

/// Clicks inside cards and rows must not also select them or start a drag.
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/// Opens a link where the sidebar's "リンクを開く" says: the browser pane or
/// Dia (the default browser outside the app's tree of providers).
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

/// "親 #3", "サブ 1/4 完了" or "+1 リポジトリ": how the todo relates to others.
function relationLabel(todo: Todo, allTodos: Todo[]): string | null {
  if (todo.parent_id) return `親 #${todo.parent_id}`;
  const children = allTodos.filter((c) => c.parent_id === todo.id);
  if (children.length > 0) return `サブ ${children.filter((c) => c.status === "done").length}/${children.length} 完了`;
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
      if (t.closest("input, textarea, select, [role=menu], [role=dialog], .xterm") || document.querySelector(".app.focus, .app[data-zone=sidebar]")) return;
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
        {urgent && <StateBadge state={urgent} />}
      </div>
      <div className="card-title">{todo.title}</div>
      {(todo.pr_url || todo.issue_url || rel || direct || todo.queue_runner) && (
        <div className="card-foot">
          <GhChip todo={todo} report={report} />
          {rel && <span className="tag">{rel}</span>}
          {todo.queue_runner && <span className={`tag${todo.queue_error ? " failed" : ""}`}>{todo.queue_error ? "起動失敗" : "起動待ち"}</span>}
          <span className="grow" />
          {direct && <OpenMenu session={direct} report={report} primary={urgent === "needs_input"} />}
        </div>
      )}
    </article>
  );
}

function LaneColumn({ status, lane, children, onAdd }: { status: Status; lane: Lane; children: React.ReactNode; onAdd?: (title: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}:${lane.key}` });
  return (
    <div ref={setNodeRef} className={`cell${isOver ? " drop-target" : ""}`} data-col={status}>
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
            入力待ち {waiting}
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

/// Done cards the lane shows: all, or the most recently updated few.
function visibleDone(todos: Todo[], doneRecent: boolean) {
  const done = todos.filter((t) => t.status === "done").sort((a, b) => b.updated_at - a.updated_at);
  return doneRecent ? done.slice(0, DONE_RECENT) : done;
}

/// What the Todo kanban and list show: words in the title or memo, some
/// statuses, some places (lanes by repository), only ones waiting for input.
/// Empty parts do not narrow anything.
interface TodoFilter {
  text: string;
  statuses: Status[];
  places: string[];
  waiting: boolean;
}
const NO_FILTER: TodoFilter = { text: "", statuses: [], places: [], waiting: false };
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
const filterCount = (f: TodoFilter) => (f.text.trim() ? 1 : 0) + f.statuses.length + f.places.length + (f.waiting ? 1 : 0);
const sameFilter = (a: TodoFilter, b: TodoFilter) => JSON.stringify(a) === JSON.stringify(b);
function matchesFilter(t: Todo, f: TodoFilter) {
  const words = f.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${t.title} ${t.memo ?? ""} #${t.id}`.toLowerCase();
  return (
    words.every((w) => hay.includes(w)) &&
    (f.statuses.length === 0 || f.statuses.includes(t.status)) &&
    (f.places.length === 0 || f.places.includes(laneKey(t.repos))) &&
    (!f.waiting || liveSessions(t).some((s) => s.state === "needs_input"))
  );
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
              <span className="muted">場所</span>
              {places.map((p) => (
                <label key={p} className="toggle">
                  <input type="checkbox" checked={filter.places.includes(p)} onChange={() => onChange({ ...filter, places: toggle(filter.places, p) })} />
                  <RepoDot repo={p} />
                  <span className="ellipsis">{isGithubRepo(p) ? repoName(p) : p}</span>
                </label>
              ))}
            </div>
            <label className="toggle">
              <input type="checkbox" checked={filter.waiting} onChange={() => onChange({ ...filter, waiting: !filter.waiting })} />
              入力待ちだけ
            </label>
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

function BoardLane({ lane, collapsed, onToggle, selectedId, onSelectTodo, report, allTodos, doneRecent, onAdd }: {
  lane: Lane;
  collapsed: boolean;
  onToggle: () => void;
  selectedId: number | null;
  onSelectTodo: (id: number) => void;
  report: (e: unknown) => void;
  allTodos: Todo[];
  doneRecent: boolean;
  onAdd: (status: Status, title: string) => void;
}) {
  return (
    <section className={`lane${collapsed ? " collapsed" : ""}`} data-lane={lane.key}>
      <LaneHeader lane={lane} collapsed={collapsed} onToggle={onToggle} onOpenTodo={onSelectTodo} report={report} />
      {!collapsed && (
        <div className="lane-grid">
          {COLUMNS.map((c) => {
            const todos = c.status === "done" ? visibleDone(lane.todos, doneRecent) : lane.todos.filter((t) => t.status === c.status).sort((a, b) => a.id - b.id);
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

/// The sessions waiting for the user, above the board.
function WaitingStrip({ sessions, report }: { sessions: Session[]; report: (e: unknown) => void }) {
  if (sessions.length === 0) return null;
  return (
    <div className="waiting-strip" role="status">
      <span className="pill waiting">
        <i />
        入力待ち {sessions.length}
      </span>
      {sessions.map((s) => (
        <span key={s.session_id} className="waiting-item">
          <span className="ellipsis">{sessionLabel(s)}</span>
          <span className="muted">
            {isCloud(s) ? "Cloud" : "Local"} · {ago(s.state_at)}
          </span>
          <OpenMenu session={s} report={report} primary />
        </span>
      ))}
    </div>
  );
}

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

function ListLane({ lane, selectedId, onSelectTodo, report, run, setStatus, allTodos, doneRecent, collapsed, onToggle, onAdd }: {
  lane: Lane;
  selectedId: number | null;
  onSelectTodo: (id: number) => void;
  report: (e: unknown) => void;
  run: (f: () => Promise<unknown>) => void;
  setStatus: (todo: Todo, status: Status) => void;
  allTodos: Todo[];
  doneRecent: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onAdd: (title: string) => void;
}) {
  const open = lane.todos.filter((t) => t.status !== "done").sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.id - b.id);
  const todos = [...open, ...visibleDone(lane.todos, doneRecent)];
  return (
    <section className="list-lane" data-lane={lane.key}>
      <div data-row={`lane:${lane.key}`}>
        <LaneHeader lane={lane} collapsed={collapsed} onToggle={onToggle} onOpenTodo={onSelectTodo} report={report} />
      </div>
      {!collapsed && (
        <ul className="rows">
          {todos.map((t) => {
            const urgent = urgentState(liveSessions(t));
            const direct = directSession(t);
            return (
              <li key={t.id} data-row={`todo:${t.id}`} className={`row${t.id === selectedId ? " selected" : ""}${t.status === "done" ? " done" : ""}`} onClick={() => onSelectTodo(t.id)}>
                <StatusIcon status={t.status} />
                <span className="mono muted ref">{todoRef(t)}</span>
                <span className="row-title">{t.title}</span>
                {urgent && <StateBadge state={urgent} />}
                <GhChip todo={t} report={report} />
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
          })}
        </ul>
      )}
      {!collapsed && (
        <div className="row-add">
          <AddInline label="新しい todo" onAdd={onAdd} />
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
function MemoEditor({ value, report, onSave }: { value: string; report: (e: unknown) => void; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <textarea
        autoFocus
        rows={6}
        defaultValue={value}
        aria-label="メモ"
        onBlur={(e) => {
          if (e.currentTarget.value !== value) onSave(e.currentTarget.value);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <div className={`memo editable${value ? "" : " muted"}`} onClick={() => setEditing(true)} title="クリックで編集">
      {value ? <Linkify text={value} report={report} /> : "メモを書く…"}
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

interface StartChoice {
  target: Target;
  runner: Runner;
  model: string;
  effort: string;
}

const DEFAULT_START: StartChoice = { target: "web", runner: "auto", model: "", effort: "" };

/// Prompt with its leading `/skill` swapped for `name` (or added).
function withSkill(prompt: string, name: string) {
  const rest = prompt.replace(/^\/\S+\s*/, "");
  return `/${name} ${rest}`;
}

/// The first prompt, the skill it starts with, where it runs and with which
/// model: everything a new session needs, in the panel instead of a dialog.
function Composer({ todo, skills, run }: { todo: Todo; skills: Skill[]; run: (f: () => Promise<unknown>) => void }) {
  // An orchestrator plans locally (its session registers child todos over the local MCP server).
  const cloudOk = !todo.is_orchestrator;
  const [choice, setChoiceState] = useState<StartChoice>(() => loadJson(START_KEY, DEFAULT_START));
  const target = !cloudOk && isCloudTarget(choice.target) ? "terminal" : choice.target;
  const setChoice = (c: Partial<StartChoice>) => {
    const next = { ...choice, ...c };
    remember(START_KEY, JSON.stringify(next));
    setChoiceState(next);
  };
  const ref = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState(todo.prompt ?? "");
  // The stored prompt comes back on another todo, not on every refresh.
  useEffect(() => setPrompt(todo.prompt ?? ""), [todo.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = prompt.match(/^\/(\S+)/)?.[1] ?? todo.prompt_preview.match(/^\/(\S+)/)?.[1];
  const chips = skills.slice(0, SKILL_CHIPS);
  const others = skills.slice(SKILL_CHIPS);
  const pickSkill = (name: string) => {
    // From the title and memo, not the preview: the preview carries lines the app adds again on start.
    const base = [todo.title, todo.memo?.trim()].filter(Boolean).join("\n\n");
    setPrompt((p) => withSkill(p || base, name));
    ref.current?.focus();
  };
  const cliOptions = target === "terminal" || isCloudTarget(target);
  const options: StartOptions = cliOptions ? { model: choice.model || undefined, effort: choice.effort || undefined } : {};
  const beginWeb = useContext(BeginWebContext);
  const terminal = useContext(TerminalContext);
  const [starting, setStarting] = useState(false);
  const start = () => {
    if (starting) return;
    setStarting(true);
    run(async () => {
      const finish = target === "web" ? beginWeb?.() : undefined;
      try {
        // The prompt lives on the todo, so the next start (and the queue) reuse it.
        if (prompt !== (todo.prompt ?? "")) await api.updateTodo(todo.id, { prompt });
        if (isCloudTarget(target)) finish?.(await api.startCloud(todo.id, options, target === "cloud"));
        else if (target === "desktop") await api.startDesktop(todo.id);
        else if (target === "terminal") terminal ? terminal.open(await terminalApi.start(todo.id, options)) : await api.startTerminal(todo.id, options);
        else await api.enqueue(todo.id, choice.runner);
      } catch (e) {
        finish?.(null);
        throw e;
      } finally {
        setStarting(false);
      }
    });
  };
  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={3}
        value={prompt}
        aria-label="最初のプロンプト"
        placeholder={todo.prompt_preview}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (isEnter(e) && e.metaKey) {
            e.preventDefault();
            start();
          }
        }}
      />
      {skills.length > 0 && (
        <div className="skills">
          <span className="muted">スキル</span>
          {chips.map((s) => (
            <button key={s.name} className={`skill${current === s.name ? " on" : ""}`} aria-pressed={current === s.name} title={s.description} onClick={() => pickSkill(s.name)}>
              /{s.name}
            </button>
          ))}
          {others.length > 0 && (
            <select className="select compact" value="" aria-label="ほかのスキル" onChange={(e) => e.target.value && pickSkill(e.target.value)}>
              <option value="">その他…</option>
              {others.map((s) => (
                <option key={s.name} value={s.name} title={s.description}>
                  /{s.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="composer-foot">
        <div className="segmented" role="group" aria-label="起動先">
          {TARGETS.map((t) => (
            <button
              key={t.key}
              className={target === t.key ? "on" : ""}
              aria-pressed={target === t.key}
              disabled={isCloudTarget(t.key) && !cloudOk}
              title={isCloudTarget(t.key) && !cloudOk ? "計画用の todo は Local で始めます" : undefined}
              onClick={() => setChoice({ target: t.key })}
            >
              {t.key === "terminal" && terminal ? "ターミナル" : t.label}
            </button>
          ))}
        </div>
        {target === "queue" ? (
          <select className="select compact" value={choice.runner} aria-label="キューからの起動方法" onChange={(e) => setChoice({ runner: e.target.value as Runner })}>
            {(Object.keys(RUNNER_LABEL) as Runner[]).map((r) => (
              <option key={r} value={r}>
                {RUNNER_LABEL[r]}
              </option>
            ))}
          </select>
        ) : (
          <>
            <select className="select compact" value={cliOptions ? choice.model : ""} disabled={!cliOptions} title={cliOptions ? "モデル" : "Desktop ではモデルを選べません"} aria-label="モデル" onChange={(e) => setChoice({ model: e.target.value })}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <select className="select compact" value={cliOptions ? choice.effort : ""} disabled={!cliOptions} title={cliOptions ? "effort" : "Desktop では effort を選べません"} aria-label="effort" onChange={(e) => setChoice({ effort: e.target.value })}>
              {EFFORTS.map((x) => (
                <option key={x} value={x}>
                  {x ? `effort: ${x}` : "既定の effort"}
                </option>
              ))}
            </select>
          </>
        )}
        <span className="grow" />
        <button className="primary" onClick={start} disabled={starting} aria-busy={starting}>
          {starting && <span className="spinner" />}
          {starting ? "開始しています…" : target === "queue" ? "キューに入れる" : "開始"} {!starting && <span className="kbd">⌘↵</span>}
        </button>
      </div>
      <p className="muted hint">
        [todo:{todo.id}] は自動で付きます · 空ならタイトルとメモから作ります
        {todo.cwd ? ` · ${tildify(todo.cwd)}` : ""}
      </p>
    </div>
  );
}

const CLOUD_SESSION_PAGE = /^https:\/\/claude\.ai\/code\/session_/;
/// The `cse_…` id of the cloud session a claude.ai page shows, if it shows one.
const cloudIdOfPage = (url: string) => url.match(/^https:\/\/claude\.ai\/code\/session_([A-Za-z0-9]+)/)?.[1]?.replace(/^/, "cse_") ?? null;

/// Whether a tab already shows `url`: the same page, or a page under it
/// (a PR's Files tab, a session page after claude.ai added a query), so
/// opening it again comes back to that tab.
function sameTarget(tabUrl: string, url: string): boolean {
  try {
    const a = new URL(tabUrl);
    const b = new URL(url);
    const path = (p: string) => p.replace(/\/+$/, "");
    return a.origin === b.origin && (path(a.pathname) === path(b.pathname) || (path(b.pathname) !== "" && path(a.pathname).startsWith(`${path(b.pathname)}/`)));
  } catch {
    return tabUrl === url;
  }
}

/// A page in the browser pane.
interface BrowserTab {
  id: string;
  url: string;
  title: string | null;
  /// From opening or a navigation until the page finishes loading.
  loading: boolean;
  /// Bumped when the app sends the tab to `url` (not when the page moves).
  nav: number;
  /// Set on an in-app terminal tab, which shows no web page.
  term?: TerminalRun;
  /// One of PINNED_PAGES.
  pinned?: boolean;
  /// The Input mode's own page (on its left or right), apart from the pane's tabs.
  focus?: boolean;
  /// The Input mode's space it belongs to (InputSpace's key, subjectKey).
  space?: string;
  /// On the right: which page it is (a FOCUS_PAGES id or NOTE_TAB).
  kind?: string;
}

/// One Input mode space: the pages a todo or an input (or FREE_SPACE) has open on the
/// left and right, kept while the app runs (hidden while another is shown).
interface InputSpace {
  /// Tab ids on the left (its own pages, and the pane's terminals), and the one shown.
  lefts: string[];
  active: string | null;
  /// The right page shown (a FOCUS_PAGES id or NOTE_TAB).
  right: string;
  /// The addresses its pages may go under, and the ones let through.
  pages: string[];
  accepted: string[];
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
  accepted: string[];
}

/// The browser pane: tabs of web pages, each a webview laid over this one on
/// a placeholder that follows the layout. `covered` hides them while a dialog
/// is up, since a native webview draws above everything in the page.
const SEARCH_URL = "https://www.google.com/search?q=";
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
/// What the focus mode's right side can keep: the pinned pages, and Notion,
/// which is pinned (kept open) only there.
const FOCUS_PAGES: typeof PINNED_PAGES = [...PINNED_PAGES, { id: "pinnotion", label: "Notion", url: "https://www.notion.so/", icon: "list" }];

/// What the address bar opens: a URL as typed, a bare host over https, and
/// anything else as a search.
function addressToUrl(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[^\s/]+\.[^\s]+$/.test(t)) return `https://${t}`;
  return SEARCH_URL + encodeURIComponent(t);
}

/// The browser pane: a tab strip over the active tab's page, or a new-tab
/// page when no tab is picked.
function BrowserDock({ tabs, active, covered, report, onSelect, onPinned, onClose, onNewTab, onHide, onOpen, onAddress, onMove, onArchive, onToInput }: {
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
  /// `keys` gives the page the keyboard.
  onOpen: (url: string, keys?: boolean) => void;
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
      <div className="browser-tabs" role="tablist">
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
        <NewTabPage onOpen={(url) => onOpen(url, true)} />
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

/// A page kept for studying, offered when picking the focus mode's left page.
interface StudyPage {
  label: string;
  url: string;
}
const STUDY_PAGES_KEY = "studyPages";
/// What the focus mode's left opens: a page, or a terminal the pane has.
type FocusItem = { url: string } | { terminal: string };
/// A page asked onto the focus mode's left (a link, or typed in) while
/// Claude judges whether it fits the work; judged not to, or not judged, it
/// waits to be answered (FocusLinkDialog).
interface FocusAsking {
  id: number;
  url: string;
  /// The text of the link that asked.
  text?: string;
  verdict?: Verdict;
  /// Why it could not be judged.
  failed?: string;
}
/// A page judged this related to the work, or more, opens on its own.
const FOCUS_RELATED_SCORE = 60;
const isAnswerable = (a: FocusAsking) => a.verdict !== undefined || a.failed !== undefined;

/// Picks the focus mode's left page: a URL, a study page (kept and edited
/// here) or a terminal the pane has open.
function FocusPicker({ terminals, adding, onPick, onClose }: {
  terminals: BrowserTab[];
  /// Adding to a running focus mode, rather than starting one.
  adding: boolean;
  onPick: (item: FocusItem) => void;
  onClose: () => void;
}) {
  const [pages, setPagesState] = useState<StudyPage[]>(() => loadJson<StudyPage[]>(STUDY_PAGES_KEY, []));
  const setPages = (list: StudyPage[]) => {
    remember(STUDY_PAGES_KEY, JSON.stringify(list));
    setPagesState(list);
  };
  const [addingPage, setAddingPage] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const toUrl = (text: string) => {
    const url = addressToUrl(text);
    return url && !url.startsWith(SEARCH_URL) ? url : null;
  };
  const addPage = (address: string) => {
    const url = toUrl(address);
    if (!url) return;
    setPages([...pages.filter((p) => p.url !== url), { label: nameRef.current?.value.trim() || hostOf(url), url }]);
    setAddingPage(false);
  };
  return (
    <Modal title={adding ? "左に開くページ" : "Input モードで開くページ"} onClose={onClose}>
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
        <h3>学習ページ</h3>
        {pages.length === 0 && !addingPage && <p className="muted">まだありません。よく読むページを足しておくと、ここから選べます。</p>}
        {pages.map((p) => (
          <div key={p.url} className="start-page">
            <button onClick={() => onPick({ url: p.url })}>
              {p.label}
              <span className="muted mono">{hostOf(p.url)}</span>
            </button>
            <button className="ghost icon" aria-label={`${p.label} を学習ページから外す`} title="外す" onClick={() => setPages(pages.filter((x) => x.url !== p.url))}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        {addingPage ? (
          <div className="start-page-add">
            <input ref={nameRef} autoFocus placeholder="名前（なくてもよい）" aria-label="名前" />
            <input className="mono" placeholder="URL を入力して Enter" aria-label="学習ページの URL" onKeyDown={(e) => isEnter(e) && addPage(e.currentTarget.value)} />
          </div>
        ) : (
          <button className="ghost add-inline" onClick={() => setAddingPage(true)}>
            <Icon name="plus" size={12} /> 学習ページを追加
          </button>
        )}
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

/// The right side's note before it is published (NOTE_TAB): whether there is a
/// todo to make it for, a session making it, and pages on the left for it.
interface FocusNote {
  subject: boolean;
  making: boolean;
  pages: boolean;
  onCreate: (format: NoteFormat, cloud: boolean) => void;
  /// Leaves the session making it (it goes on) to start another.
  onReset: () => void;
}

/// Over the session making the note (its terminal or page): what it is, and
/// a way out to make it again.
function NoteMaking({ note }: { note: FocusNote }) {
  return (
    <div className="note-making">
      <span className="spinner" aria-label="作成中" />
      <span className="grow">ノートを作っています。できたらここに替わります。</span>
      <button className="ghost small" title="このセッションは残したまま、作り直します" onClick={note.onReset}>
        作り直す
      </button>
    </div>
  );
}

/// The note's place on the right until there is a page to show: what it is
/// and how to make it, or that it is being made (in herdr, out of sight).
function NoteStart({ note }: { note: FocusNote }) {
  const [format, setFormatState] = useState<NoteFormat>(() => load(NOTE_FORMAT_KEY, NOTE_FORMATS.map(([f]) => f), "docs"));
  const setFormat = (f: NoteFormat) => {
    remember(NOTE_FORMAT_KEY, f);
    setFormatState(f);
  };
  if (!note.subject) return <p className="muted empty pad">ノートは、todo（Input など）から開いた Input モードで作れます。</p>;
  // herdr runs it behind the app, with nothing to show here.
  if (note.making) return <NoteMaking note={note} />;
  // Cloud sessions have no Claude Docs connector.
  const docs = format === "docs";
  return (
    <div className="note-start">
      <p>左のページを Claude が整理し直して、コメントできる「ノート」を claude.ai に作ります（はじめは自分だけが見られます）。</p>
      <div className="segmented" role="group" aria-label="ノートの形">
        {NOTE_FORMATS.map(([f, label]) => (
          <button key={f} className={format === f ? "on" : ""} aria-pressed={format === f} onClick={() => setFormat(f)}>
            {label}
          </button>
        ))}
      </div>
      <div className="note-actions">
        <button className="primary" disabled={!note.pages} onClick={() => note.onCreate(format, false)}>
          Mac の Claude Code で作る
        </button>
        <button className="small" disabled={!note.pages || docs} title={docs ? "Docs は Mac の Claude Code でだけ作れます" : undefined} onClick={() => note.onCreate(format, true)}>
          Cloud で作る
        </button>
      </div>
      <p className="muted small">
        {docs
          ? "コメントで @Claude と書くと、claude.ai の Claude が答えます。"
          : "Claude 宛てのコメントには、Mac の Claude Code で作ったときだけ、作ったセッションが返信します（アプリやターミナルを閉じると止まります）。Cloud で作ったノートには返信しません。"}
        Mac の Claude Code は「ターミナル」の設定（アプリ内か herdr）で動きます。どちらもセッションを1本使います。
      </p>
    </div>
  );
}

/// The focus mode: its own pages (and terminals) on the left and a pinned
/// page (ChatGPT, Claude Code or Notion) or the note on the right, nothing else.
function FocusMode({ lefts, left, asking, right, rightKind, note, onRemakeNote, covered, report, width, onResize, onRight, onAddress, onSelectLeft, onCloseLeft, onAddLeft, onAnswer, onGiveUp, onExit }: {
  /// The left side's tabs (its own pages, and terminals), and the one shown.
  lefts: BrowserTab[];
  left: BrowserTab | null;
  /// Pages asked onto the left, shown after its tabs until they open.
  asking: FocusAsking[];
  right: BrowserTab | undefined;
  /// Which right page is picked (a FOCUS_PAGES id or NOTE_TAB).
  rightKind: string;
  /// Set while the note is shown and not yet published.
  note: FocusNote | null;
  /// Set while a published note is shown: leaves it to make another.
  onRemakeNote?: () => void;
  covered: boolean;
  report: (e: unknown) => void;
  width: number;
  onResize: (w: number) => void;
  /// A pinned page's id, or NOTE_TAB.
  onRight: (id: string) => void;
  onAddress: (tab: string, url: string) => void;
  onSelectLeft: (id: string) => void;
  onCloseLeft: (id: string) => void;
  /// Picks another page (or terminal) for the left.
  onAddLeft: () => void;
  /// Asks about an asked page judged not to fit; gives it up.
  onAnswer: (asking: FocusAsking) => void;
  onGiveUp: (id: number) => void;
  onExit: () => void;
}) {
  const leftWeb = left && !left.term ? left.id : undefined;
  const noteShown = rightKind === NOTE_TAB;
  return (
    <div className="focus-mode">
      <section className="browser focus-left" aria-label="Input モードの左側">
        <div className="browser-tabs" role="tablist">
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
          {asking.map((a) => {
            const label = a.text || hostOf(a.url);
            const answerable = isAnswerable(a);
            return (
              <span
                key={`ask${a.id}`}
                className="browser-tab asking"
                title={answerable ? `${a.url}\n今の作業との関係が薄そうです。押すと開くか聞きます` : `${a.url}\n今の作業に関係するか確かめています`}
              >
                <button className="browser-tab-main" disabled={!answerable} onClick={() => onAnswer(a)}>
                  {answerable ? <span className="asking-mark">?</span> : <span className="spinner" aria-label="確かめています" />}
                  <span className="ellipsis">{label}</span>
                </button>
                <button className="ghost icon browser-tab-close" aria-label={`${label} を開くのをやめる`} onClick={() => onGiveUp(a.id)}>
                  <Icon name="close" size={11} />
                </button>
              </span>
            );
          })}
          <button className="ghost icon browser-new-tab" aria-label="左に開くページを選ぶ" title="左に開くページを選ぶ" onClick={onAddLeft}>
            <Icon name="plus" size={13} />
          </button>
        </div>
        {left?.term ? (
          <TerminalView key={left.id} id={left.id} run={left.term} report={report} />
        ) : left ? (
          <TabView tab={left} covered={covered} report={report} onAddress={(url) => onAddress(left.id, url)} keep={right?.id} noDia />
        ) : (
          <p className="muted empty">＋ から左に開くページを選びます。</p>
        )}
      </section>
      <aside className="browser-dock focus-right">
        <Resizer label="右側の幅" cssVar="--focus-right-w" width={width} min={DOCK_MIN_W} max={() => window.innerWidth - FOCUS_LEFT_MIN_W} onResize={onResize} />
        <section className="browser">
          <div className="browser-tabs focus-head">
            <div className="segmented" role="group" aria-label="右側のページ">
              <button className={noteShown ? "on" : ""} aria-pressed={noteShown} onClick={() => onRight(NOTE_TAB)}>
                <Icon name="list" size={12} /> ノート
              </button>
              {FOCUS_PAGES.map((p) => (
                <button key={p.id} className={rightKind === p.id ? "on" : ""} aria-pressed={rightKind === p.id} onClick={() => onRight(p.id)}>
                  <Icon name={p.icon} size={12} /> {p.label}
                </button>
              ))}
            </div>
            <span className="grow" />
            {onRemakeNote && (
              <button className="ghost small" title="このノートは claude.ai に残したまま、別のノートを作ります" onClick={onRemakeNote}>
                ノートを作り直す
              </button>
            )}
            <button className="ghost small" title="Input モードを終える（Esc）" onClick={onExit}>
              終える <span className="kbd">Esc</span>
            </button>
          </div>
          {right && note && <NoteMaking note={note} />}
          {right?.term ? (
            <TerminalView key={right.id} id={right.id} run={right.term} report={report} />
          ) : right ? (
            <TabView key={right.id} tab={right} covered={covered} report={report} onAddress={(url) => onAddress(right.id, url)} keep={leftWeb} noDia />
          ) : (
            note && <NoteStart note={note} />
          )}
        </section>
      </aside>
    </div>
  );
}

/// One tab's page: its webview laid over a placeholder that follows the
/// layout. `covered` hides it while a dialog is up, since a native webview
/// draws above everything in the page.
/// A tab to give the typing to (its page's text box) once it is shown.
let typeInto: string | null = null;
/// A tab to give the keyboard to (the page, not its text box) once it is shown.
let keysInto: string | null = null;
/// Each tab's `nav` when it was last sent to its address: showing it again
/// with the same one leaves its page where the user moved it.
const sentNav = new Map<string, number>();

function TabView({ tab: active, covered: dialogUp, report, onAddress, onArchive, onToInput, keep, noDia }: {
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
  /// In the focus mode, which keeps its pages here.
  noDia?: boolean;
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
        if (keysInto === active.id) {
          keysInto = null;
          return api.browserFocus(active.id);
        }
        if (typeInto !== active.id) return;
        typeInto = null;
        return api.browserFocus(active.id, true);
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
  // ⌘L edits the address, ⌘R reloads and ⌘[ ⌘] go back and forward, as in a
  // browser; a script in the page does the same when the page has focus.
  const address = useRef<HTMLInputElement>(null);
  const tabId = useRef(active.id);
  tabId.current = active.id;
  useEffect(() => {
    const focusAddress = () => {
      address.current?.focus();
      address.current?.select();
    };
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, "back") || matches(e, "forward")) {
        e.preventDefault();
        api.browserGo(tabId.current, matches(e, "back") ? "back" : "forward").catch(report);
      } else if (matches(e, "focusUrl")) {
        e.preventDefault();
        focusAddress();
      }
    };
    window.addEventListener("keydown", onKey);
    const off = listen<{ tab: string }>(BROWSER_FOCUS_URL_EVENT, ({ payload }) => payload.tab === tabId.current && focusAddress());
    return () => {
      window.removeEventListener("keydown", onKey);
      off.then((f) => f());
    };
  }, [report]);
  return (
    <>
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
            keysInto = active.id;
            navigate(url, true);
          }}
          onSuggesting={setSuggesting}
          // Esc puts the address back and returns to the page, as in a browser.
          onEscape={(input) => {
            input.value = active.url;
            input.blur();
            api.browserFocus(active.id).catch(report);
          }}
        />
        {onToInput && (
          <button className="ghost small" title={`このページを input に入れる（${keyLabel(keyOf("toInput"))}。先に作った input にも、新しい input にも）`} onClick={onToInput}>
            Input に追加
          </button>
        )}
        {onArchive && (
          <button className="ghost small" title="この Cloud セッションをアーカイブしてタブを閉じる（⌘⇧A）" onClick={onArchive}>
            アーカイブ
          </button>
        )}
        {!noDia && (
          <button className="ghost small" title="このページを Dia で開く" onClick={() => api.openInDia(active.url).catch(report)}>
            Dia で開く
          </button>
        )}
      </div>
      <div className={`load-bar${active.loading ? " on" : ""}`} aria-hidden="true" />
      <div ref={slot} className="browser-slot">
        {dialogUp && <span className="muted">ダイアログを閉じると表示に戻ります</span>}
      </div>
    </>
  );
}

function TodoPanel({ todo, allTodos, local, groups, skills, run, report, setStatus, onOpenTodo, onFocus, onClose }: {
  todo: Todo;
  allTodos: Todo[];
  local: LocalRepo[];
  groups: string[];
  skills: Skill[];
  run: (f: () => Promise<unknown>) => void;
  report: (e: unknown) => void;
  setStatus: (todo: Todo, status: Status) => void;
  onOpenTodo: (id: number) => void;
  /// The focus mode, with the todo's page on the left.
  onFocus: () => void;
  onClose: () => void;
}) {
  const browse = useOpenLink(report);
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
  const addChild = (title: string) =>
    run(() => api.createTodo({ title, parent_id: todo.id, repos: todo.repos.length === 1 && !todo.repos_derived ? todo.repos : [], cwd: todo.repos.length === 1 ? (todo.cwd ?? undefined) : undefined }));
  return (
    <aside className="panel" aria-label={`#${todo.id} ${todo.title}`}>
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
        <button className="ghost small" title={`Input モードで開く（${keyLabel(keyOf("focusTodo"))}）：添付の URL を左、ChatGPT を右に`} onClick={onFocus}>
          Input モード
        </button>
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
          <dt>場所</dt>
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

        {!parent && (
          <section>
            <h3>
              サブタスク {children.length > 0 && <span className="muted">{children.filter((c) => c.status === "done").length}/{children.length}</span>}
            </h3>
            {children.length === 0 && todo.is_orchestrator && (
              <p className="muted hint">セッションを Local で始めると、Claude がリポジトリごとのサブタスクを登録します。</p>
            )}
            <ul className="rows compact">
              {children.map((c) => (
                <li key={c.id} className="row" onClick={() => onOpenTodo(c.id)}>
                  <StatusIcon status={c.status} />
                  <span className="row-title">{c.title}</span>
                  {c.repos[0] && <span className="tag">{repoName(c.repos[0])}</span>}
                  <GhChip todo={c} report={report} />
                </li>
              ))}
            </ul>
            <AddInline label="サブタスクを追加" onAdd={addChild} />
          </section>
        )}

        <section>
          <h3>セッション {liveSessions(todo).length > 0 && <span className="muted">{liveSessions(todo).length}</span>}</h3>
          {todo.sessions.length === 0 && <p className="muted hint">まだありません。下から始めるか、セッション画面で既存のものを紐づけます。</p>}
          <ul className="sessions">
            {todo.sessions.map((s) => (
              <li key={s.session_id} className={`session-row state-bg-${s.state}`}>
                <span className={`dot state-${s.state}`} />
                <span className="session-main">
                  <span className="ellipsis">{sessionLabel(s)}</span>
                  <span className="muted">
                    {STATE_LABEL[s.state]} · {isCloud(s) ? "Cloud" : "Local"} · {ago(s.state_at)}
                  </span>
                </span>
                <OpenMenu session={s} report={report} primary={s.state === "needs_input"} />
                <button className="ghost small" onClick={() => run(() => api.unlinkSession(s.session_id))}>
                  解除
                </button>
              </li>
            ))}
          </ul>
          {todo.queue_runner && (
            <div className="notice small">
              <span>
                キューで起動待ち（{RUNNER_LABEL[todo.queue_runner]}）{todo.queue_error && ` — ${todo.queue_error}`}
              </span>
              <button className="ghost small" onClick={() => run(() => api.dequeue(todo.id))}>
                外す
              </button>
            </div>
          )}
        </section>

        <section>
          <h3>新しいセッション</h3>
          <Composer todo={todo} skills={skills} run={run} />
        </section>

        <section>
          <h3>メモ</h3>
          <MemoEditor value={todo.memo ?? ""} report={report} onSave={(memo) => update({ memo })} />
        </section>

        <section>
          <h3>リンク {todo.links.length > 0 && <span className="muted">{todo.links.length}</span>}</h3>
          <ul className="attachments">
            {todo.links.map((l) => (
              <li key={l.id} className="attachment" title={l.url} onClick={() => browse(l.url)}>
                {l.image ? (
                  <img src={l.image} alt="" />
                ) : (
                  <span className="thumb">
                    <Icon name="open" size={14} />
                  </span>
                )}
                <span className="attachment-text">
                  <span className="ellipsis">{l.title ?? hostOf(l.url)}</span>
                  <span className="muted ellipsis">{l.url}</span>
                </span>
                <button
                  className="ghost icon"
                  aria-label="外す"
                  onClick={(e) => {
                    e.stopPropagation();
                    run(() => api.removeLink(l.id));
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
          <SubmitInput placeholder="URL を貼って Enter で追加" onSubmit={(url) => run(() => api.addLink(todo.id, url))} />
        </section>
      </div>
    </aside>
  );
}

interface SessionItem {
  session: Session;
  todo?: Todo;
}

/// Every session the board knows, with the todo it belongs to.
function sessionItemsOf(board: Board): SessionItem[] {
  return [...board.todos.flatMap((todo) => todo.sessions.map((session) => ({ session, todo }))), ...board.inbox.map((session) => ({ session }))];
}

type SessionFilter = "all" | "needs_input" | "running" | "unlinked";

function SessionsPage({ board, repoFilter, selectedId, run, report, onSelect, onOpenTodo, onQuick }: {
  board: Board;
  repoFilter: string | null;
  selectedId: string | null;
  run: (f: () => Promise<unknown>) => void;
  report: (e: unknown) => void;
  onSelect: (id: string) => void;
  onOpenTodo: (id: number) => void;
  onQuick: () => void;
}) {
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [showEnded, setShowEnded] = useState(false);
  const all = sessionItemsOf(board).filter(
    (i) => repoFilter === null || laneKey(i.todo?.repos ?? i.session.repos) === repoFilter,
  );
  const live = all.filter((i) => i.session.state !== "ended");
  const counts: Record<SessionFilter, number> = {
    all: live.length,
    needs_input: live.filter((i) => i.session.state === "needs_input").length,
    running: live.filter((i) => i.session.state === "running").length,
    unlinked: live.filter((i) => !i.todo).length,
  };
  const FILTERS: { key: SessionFilter; label: string }[] = [
    { key: "all", label: "すべて" },
    { key: "needs_input", label: "入力待ち" },
    { key: "running", label: "実行中" },
    { key: "unlinked", label: "未紐づけ" },
  ];
  const pass = (i: SessionItem) => filter === "all" || (filter === "unlinked" ? !i.todo : i.session.state === filter);
  const rank = (s: Session) => STATE_ORDER.indexOf(s.state);
  const rows = (showEnded ? all : live).filter(pass).sort((a, b) => rank(a.session) - rank(b.session) || b.session.state_at - a.session.state_at);
  const ended = all.length - live.length;
  // Cloud sessions done with their turn, which the bulk archive takes.
  const archivable = live.filter((i) => isCloud(i.session) && i.session.state === "idle").map((i) => i.session.session_id);
  const [confirmArchive, setConfirmArchive] = useState(false);
  // ↑↓ or j k pick a row, Enter opens it as "開く" does, ⌥Enter opens its menu of ways.
  const { cursorId, setCursor, list: listRef } = useRowCursor(
    rows.map((i) => i.session.session_id),
    (_, choose, row) => row.querySelector<HTMLButtonElement>(choose ? ".open-caret" : ".open-main")?.click(),
  );
  const queued = board.todos.filter((t) => t.queue_runner).sort((a, b) => (a.queue_pos ?? 0) - (b.queue_pos ?? 0) || a.id - b.id);
  return (
    <>
      <header className="toolbar">
        <h1>セッション</h1>
        <div className="segmented" role="group" aria-label="絞り込み">
          {FILTERS.map((f) => (
            <button key={f.key} className={`${filter === f.key ? "on" : ""}${f.key === "needs_input" && counts.needs_input > 0 ? " warn" : ""}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label} {counts[f.key]}
            </button>
          ))}
        </div>
        <span className="grow" />
        {confirmArchive ? (
          <span className="inline-confirm">
            待機中の Cloud {archivable.length} 件をアーカイブしますか？
            <button className="primary small" onClick={() => (setConfirmArchive(false), run(() => api.archiveSessions(archivable)))}>
              アーカイブ
            </button>
            <button className="ghost small" onClick={() => setConfirmArchive(false)}>
              やめる
            </button>
          </span>
        ) : (
          archivable.length > 0 && (
            <button onClick={() => setConfirmArchive(true)} title="待機中（入力待ち・実行中でない）の Cloud セッションをまとめてアーカイブ">
              待機中の Cloud をアーカイブ {archivable.length}
            </button>
          )
        )}
        <button onClick={onQuick} title="todo に紐づけずにホームフォルダの claude を開く">
          <Icon name="spark" size={13} /> ちょっと Claude
        </button>
      </header>
      <div className="content" ref={listRef}>
        <section className="box">
          <div className="box-head">
            <b>起動待ち</b>
            <span className="muted">{queued.length}</span>
            <span className="muted">上から順に、ループが動いていれば自動で始めます</span>
            <span className="grow" />
            <label className="toggle">
              <input type="checkbox" checked={board.loop_enabled} onChange={(e) => run(() => api.setLoopEnabled(e.target.checked))} />
              ループを動かす
            </label>
          </div>
          {queued.length === 0 && <p className="muted hint pad">todo のパネルで起動先に「キュー」を選ぶと、ここに並びます。</p>}
          <ul className="rows">
            {queued.map((t, i) => (
              <li key={t.id} className="row" onClick={() => onOpenTodo(t.id)}>
                <span className="mono muted">{i + 1}</span>
                <span className="mono muted">#{t.id}</span>
                <span className="row-title">
                  {t.title}
                  {t.queue_error && <span className="error-text"> — {t.queue_error}</span>}
                </span>
                <select className="select compact" value={t.queue_runner ?? "auto"} aria-label="起動方法" onClick={stop} onChange={(e) => run(() => api.enqueue(t.id, e.target.value as Runner))}>
                  {(Object.keys(RUNNER_LABEL) as Runner[]).map((r) => (
                    <option key={r} value={r}>
                      {RUNNER_LABEL[r]}
                    </option>
                  ))}
                </select>
                <span className="order-buttons" onClick={stop}>
                  <button className="ghost icon" disabled={i === 0} aria-label="上へ" onClick={() => run(() => api.moveInQueue(t.id, -1))}>
                    <Icon name="up" size={12} />
                  </button>
                  <button className="ghost icon" disabled={i === queued.length - 1} aria-label="下へ" onClick={() => run(() => api.moveInQueue(t.id, 1))}>
                    <Icon name="down" size={12} />
                  </button>
                </span>
                {t.queue_error && (
                  <button className="small" onClick={(e) => (e.stopPropagation(), run(() => api.enqueue(t.id, t.queue_runner ?? "auto")))}>
                    再試行
                  </button>
                )}
                <button className="ghost small" onClick={(e) => (e.stopPropagation(), run(() => api.dequeue(t.id)))}>
                  外す
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <div className="table-head sessions-grid">
            <span>状態</span>
            <span>セッション</span>
            <span>todo</span>
            <span>場所</span>
            <span />
            <span />
          </div>
          {rows.length === 0 && <p className="muted empty">該当するセッションはありません。</p>}
          <ul className="rows">
            {rows.map(({ session: s, todo }) => (
              <li
                key={s.session_id}
                data-row={s.session_id}
                className={`row sessions-grid${s.session_id === selectedId ? " selected" : ""}${s.session_id === cursorId ? " cursor" : ""}${s.state === "ended" ? " done" : ""}`}
                onClick={(e) => (setCursor(s.session_id), e.currentTarget.querySelector<HTMLButtonElement>(".open-main")?.click())}
              >
                <StateBadge state={s.state} />
                <span className="ellipsis">{sessionLabel(s)}</span>
                {todo ? (
                  <button className="link-button ellipsis" onClick={(e) => (e.stopPropagation(), onOpenTodo(todo.id))}>
                    #{todo.id} {todo.title}
                  </button>
                ) : (
                  <span className="tag">未紐づけ</span>
                )}
                <span className="muted ellipsis">
                  {isCloud(s) ? "Cloud" : "Local"} · {ago(s.state_at)}
                </span>
                <OpenMenu session={s} report={report} primary={s.state === "needs_input"} />
                <button className="ghost icon" aria-label={`${sessionLabel(s)} の詳細`} title="詳細" onClick={(e) => (e.stopPropagation(), onSelect(s.session_id))}>
                  <Icon name="more" size={14} />
                </button>
              </li>
            ))}
          </ul>
          {ended > 0 && (
            <button className="ghost small show-ended" onClick={() => setShowEnded((v) => !v)}>
              {showEnded ? "終了したセッションを隠す" : `終了したセッション ${ended} 件を表示`}
            </button>
          )}
        </section>
      </div>
    </>
  );
}

function SessionPanel({ item, todos, run, report, onClose, onOpenTodo }: {
  item: SessionItem;
  todos: Todo[];
  run: (f: () => Promise<unknown>) => void;
  report: (e: unknown) => void;
  onClose: () => void;
  onOpenTodo: (id: number) => void;
}) {
  const s = item.session;
  const openInBrowser = useContext(BrowserContext);
  const terminal = useContext(TerminalContext);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    const load = () =>
      api.sessionDetail(s.session_id).then(
        (d) => (setDetail(d), setDetailError(null)),
        (e) => setDetailError(String(e)),
      );
    load();
    const t = setInterval(load, DETAIL_REFRESH_MS);
    return () => clearInterval(t);
  }, [s.session_id]);
  const [target, setTarget] = useState<number | "">("");
  const [newTitle, setNewTitle] = useState(s.title ?? "");
  useEffect(() => setNewTitle(s.title ?? ""), [s.session_id, s.title]);
  // A local session's cwd is a folder the todo can reuse; a cloud session's is a repo URL.
  const cwd = s.cwd.startsWith("/") ? s.cwd : undefined;
  const createAndLink = () => {
    const title = newTitle.trim();
    if (!title) return;
    run(async () => {
      const todo = await api.createTodo({ title, cwd, repos: s.repos ?? [] });
      await api.linkSession(s.session_id, todo.id);
      onOpenTodo(todo.id);
    });
  };
  return (
    <aside className="panel" aria-label={sessionLabel(s)}>
      <header className="panel-head">
        <StateBadge state={s.state} />
        <span className="muted">{ago(s.state_at)}から</span>
        <span className="grow" />
        <button className="ghost icon" onClick={onClose} aria-label="閉じる">
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className="panel-body">
        <div>
          <h2 className="panel-title static">{sessionLabel(s)}</h2>
          {item.todo && (
            <button className="link-button" onClick={() => onOpenTodo(item.todo!.id)}>
              todo #{item.todo.id} {item.todo.title}
            </button>
          )}
        </div>
        <div className="actions">
          {isCloud(s) ? (
            <>
              <button className="primary grow" onClick={() => openInBrowser?.(cloudWebUrl(s.session_id))}>
                Web で開く
              </button>
              <button className="grow" onClick={() => api.openSession(s.session_id, "desktop").catch(report)}>
                Desktop で開く
              </button>
              {s.state !== "ended" && (
                <button className="grow" title="claude.ai と同じようにアーカイブします" onClick={() => run(() => api.archiveSessions([s.session_id]))}>
                  アーカイブ
                </button>
              )}
            </>
          ) : (
            <>
              <button className="primary grow" onClick={() => openLocal(terminal, s.session_id, report)}>
                {terminal ? "ターミナルで開く" : "herdr で開く"}
              </button>
              <button className="grow" onClick={() => api.openSession(s.session_id, "desktop").catch(report)}>
                Desktop で開く
              </button>
            </>
          )}
        </div>

        <section>
          <h3>最後のメッセージ</h3>
          {detailError && <p className="error-text">{detailError}</p>}
          {!detail && !detailError && <p className="muted">読み込み中…</p>}
          {detail && <div className="message">{detail.last_text ?? <span className="muted">まだありません</span>}</div>}
        </section>

        {detail && (detail.context_tokens !== null || detail.model) && (
          <dl className="props">
            {detail.context_tokens !== null && (
              <>
                <dt>コンテキスト</dt>
                <dd>{tokensLabel(detail.context_tokens)} トークン</dd>
              </>
            )}
            {detail.model && (
              <>
                <dt>モデル</dt>
                <dd>{MODELS.find((m) => m.id === detail.model)?.label ?? detail.model}</dd>
              </>
            )}
          </dl>
        )}

        {detail && detail.tools.length > 0 && (
          <section>
            <h3>直近の操作</h3>
            <ul className="activity">
              {detail.tools.map((t, i) => (
                <li key={i}>
                  <span className="mono tool">{t.name}</span>
                  <span className="mono muted ellipsis">{t.summary}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <dl className="props">
          <dt>起動先</dt>
          <dd>{isCloud(s) ? "Cloud" : "Local"}</dd>
          {(s.repos ?? []).length > 0 && (
            <>
              <dt>リポジトリ</dt>
              <dd>{(s.repos ?? []).join(", ")}</dd>
            </>
          )}
          <dt>場所</dt>
          <dd className="mono small-text">{tildify(s.cwd)}</dd>
          <dt>ID</dt>
          <dd className="mono small-text">{s.session_id}</dd>
        </dl>

        {item.todo ? (
          <button className="ghost small align-start" onClick={() => run(() => api.unlinkSession(s.session_id))}>
            todo との紐づけを外す
          </button>
        ) : (
          <>
            <section>
              <h3>このセッションから todo を作る</h3>
              <div className="actions">
                <input value={newTitle} placeholder="todo のタイトル" aria-label="todo のタイトル" onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => isEnter(e) && createAndLink()} />
                <button className="primary" disabled={!newTitle.trim()} onClick={createAndLink}>
                  作って紐づける
                </button>
              </div>
            </section>
            <section>
              <h3>既存の todo に紐づける</h3>
              <div className="actions">
                <select className="select grow" value={target} aria-label="紐づける todo" onChange={(e) => setTarget(e.target.value === "" ? "" : Number(e.target.value))}>
                  <option value="">todo を選ぶ</option>
                  {todos
                    .filter((t) => t.status !== "done")
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        #{t.id} {t.title}
                      </option>
                    ))}
                </select>
                <button disabled={target === ""} onClick={() => target !== "" && run(() => api.linkSession(s.session_id, target))}>
                  紐づける
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

/// How a review session submits its review: after asking, or on its own.
type ReviewSubmit = "ask" | "auto";

const REVIEW_SUBMIT_HOW = "指摘はインラインコメントと本文にまとめて提出してください（gh pr review、使えなければ GitHub のツール）。";

/// First prompt of a review session. /review answers in English unless asked
/// otherwise; `submit` says whether it asks before posting the review.
const reviewPrompt = (url: string, submit: ReviewSubmit) =>
  [
    `/review ${url} レビューは日本語で行い、指摘や結果もすべて日本語で書いてください。`,
    submit === "ask"
      ? "レビューが終わったら、GitHub への提出方法を AskUserQuestion で私に聞いてください。ブロッカー（マージ前に直すべき問題）があれば Request changes を、なければ Comment か Approve を選択肢に出し、おすすめを先頭にしてください。私が選ぶまでは提出しないでください。"
      : "レビューが終わったら、確認せずに GitHub に提出してください。ブロッカー（マージ前に直すべき問題）があれば Request changes、なければ Approve で、ブロッカーでない指摘はコメントとして添えてください。",
    REVIEW_SUBMIT_HOW,
  ].join("\n\n");

/// "/review で開始" asks before submitting the review; the caret picks, per
/// PR, whether the session may submit on its own.
function ReviewButton({ accent, busy, onStart }: { accent: boolean; busy: boolean; onStart: (submit: ReviewSubmit) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useOutsideClose(root, open, () => setOpen(false));
  const start = (submit: ReviewSubmit) => {
    setOpen(false);
    onStart(submit);
  };
  const menuKeys = useMenuKeys(open, () => setOpen(false));
  return (
    <span ref={root} className={`open-menu${accent ? " accent" : ""}`} onClick={stop}>
      <button className="open-main" title="レビューして、提出する前に確認する" disabled={busy} aria-busy={busy} onClick={() => start("ask")}>
        {busy ? (
          <>
            <span className="spinner" />
            開始しています…
          </>
        ) : (
          <>
            <span className="mono">/review</span> で開始
          </>
        )}
      </button>
      <button className="open-caret" aria-label="提出のしかたを選んで開始" aria-expanded={open} disabled={busy} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevron" size={10} />
      </button>
      {open && (
        <span className="menu" role="menu" {...menuKeys}>
          <button role="menuitem" onClick={() => start("ask")}>
            提出前に確認して開始
          </button>
          <button role="menuitem" onClick={() => start("auto")}>
            自動で提出まで行う
          </button>
        </span>
      )}
    </span>
  );
}

/// The PR a review is for.
interface ReviewTarget {
  url: string;
  repo: string;
  title: string;
}

/// Starts reviews where the PR page's "/review は …" says, and tells which
/// PRs' reviews are starting.
function useReviewStarter(local: LocalRepo[], run: (f: () => Promise<unknown>) => void) {
  const beginWeb = useContext(BeginWebContext);
  const terminal = useContext(TerminalContext);
  const [starting, setStarting] = useState<Set<string>>(new Set());
  const mark = (url: string, on: boolean) =>
    setStarting((prev) => {
      const next = new Set(prev);
      if (on) next.add(url);
      else next.delete(url);
      return next;
    });
  const startReview = (p: ReviewTarget, submit: ReviewSubmit) => {
    if (starting.has(p.url)) return;
    mark(p.url, true);
    const runner = load(REVIEW_RUNNER_KEY, ["web", "cloud", "desktop", "terminal"] as const, "web");
    const cwd = local.find((r) => r.key === p.repo)?.path;
    run(async () => {
      const finish = runner === "web" ? beginWeb?.() : undefined;
      // A review is its own session, not a todo; the PR list is where it is followed.
      const title = `${REVIEW_TITLE_PREFIX}${p.title}`;
      const prompt = reviewPrompt(p.url, submit);
      try {
        if (runner === "desktop") await api.startDesktopPrompt(cwd, prompt);
        else if (runner === "terminal") terminal ? terminal.open(await terminalApi.quick(prompt, cwd, title)) : await api.quickClaude(prompt, cwd, title);
        else finish?.(await api.startReviewCloud(p.repo, title, prompt, runner === "cloud"));
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
type PrRow = Pr & { kind: "review" | "mine" };

function PrsPage({ prs, prsLoading, prError, todos, local, repoFilter, browserUrl, run, onRefresh, onOpenTodo }: {
  prs: PrLists | null;
  /// While the PRs are being taken again, so ↻ turns.
  prsLoading: boolean;
  prError: string | null;
  todos: Todo[];
  local: LocalRepo[];
  repoFilter: string | null;
  /// The page the browser pane shows, to mark its row.
  browserUrl: string | null;
  run: (f: () => Promise<unknown>) => void;
  onRefresh: () => void;
  onOpenTodo: (id: number) => void;
}) {
  // Review requests first: they are what waits on the user.
  const [filter, setFilter] = useState<PrFilter>("review");
  const [reviewRunner, setReviewRunnerState] = useState<Target>(() => load(REVIEW_RUNNER_KEY, ["web", "cloud", "desktop", "terminal"] as const, "web"));
  const openInBrowser = useContext(BrowserContext);
  const setReviewRunner = (t: Target) => {
    remember(REVIEW_RUNNER_KEY, t);
    setReviewRunnerState(t);
  };
  const byRepo = (p: Pr) => repoFilter === null || p.repo === repoFilter;
  const review = (prs?.review ?? []).filter(byRepo).map((p) => ({ ...p, kind: "review" as const }));
  const mine = (prs?.mine ?? []).filter(byRepo).map((p) => ({ ...p, kind: "mine" as const }));
  const todoOf = (p: Pr) => todos.find((t) => t.pr_url === p.url);
  const cwdOf = (p: Pr) => local.find((r) => r.key === p.repo)?.path;
  // A PR becomes a todo that ships as it, so its state keeps the todo current.
  const makeTodo = (p: Pr, title: string) =>
    api.createTodo({ title, repos: [p.repo], cwd: cwdOf(p) }).then((t) => api.updateTodo(t.id, { pr_url: p.url }));
  const terminal = useContext(TerminalContext);
  // PRs whose review session is being started, so their button shows it.
  const { startReview, starting } = useReviewStarter(local, run);
  const sections: { key: "review" | "mine"; title: string; hint: string; rows: PrRow[] }[] = [
    { key: "review", title: "レビュー依頼", hint: "自分にレビューが来ている PR", rows: review },
    { key: "mine", title: "自分の PR", hint: "自分が出している open の PR", rows: mine },
  ];
  const shown = sections.filter((sec) => filter === "all" || filter === sec.key);
  const rowId = (p: PrRow) => `${p.kind}:${p.url}`;
  // ↑↓ or j k pick a PR. Enter on a review request offers submitting on its
  // own or asking first; on the user's own PR, and with ⌥, it opens the PR.
  const { cursorId, setCursor, list } = useRowCursor(shown.flatMap((sec) => sec.rows.map(rowId)), (_, alt, row) =>
    ((!alt && row.querySelector<HTMLButtonElement>(".open-caret")) || row).click(),
  );
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
        <span className="grow" />
        <select className="select compact" value={reviewRunner} aria-label="/review を始める場所" title="/review を始める場所" onChange={(e) => setReviewRunner(e.target.value as Target)}>
          <option value="web">/review は Cloud・Web</option>
          <option value="cloud">/review は Cloud・Desktop</option>
          <option value="desktop">/review は Local・Desktop</option>
          <option value="terminal">/review は {terminal ? "ターミナル" : "herdr"}</option>
        </select>
        <button className={`ghost icon${prsLoading ? " turning" : ""}`} aria-label="PR を取り直す（⌘R）" title="PR を取り直す（⌘R）" aria-busy={prsLoading} onClick={onRefresh}>
          <Icon name="sync" size={14} />
        </button>
      </header>
      <div className="content flush" ref={list}>
        {prError && <p className="error-text pad">{prError}</p>}
        {!prs && !prError && <p className="muted pad">gh で取得しています…</p>}
        {shown.map((sec) => (
            <section key={sec.key}>
              <div className="section-head">
                <b>{sec.title}</b>
                <span className="muted">{sec.rows.length}</span>
                <span className="muted">{sec.hint}</span>
              </div>
              {prs && sec.rows.length === 0 && <p className="muted pad">ありません。</p>}
              <ul className="rows">
                {sec.rows.map((p) => {
                  const todo = todoOf(p);
                  return (
                    <li
                      key={p.url}
                      data-row={rowId(p)}
                      className={`row pr-row${browserUrl === p.url ? " selected" : ""}${rowId(p) === cursorId ? " cursor" : ""}`}
                      onClick={() => (setCursor(rowId(p)), openInBrowser?.(p.url))}
                    >
                      <span className="pr-main">
                        <span className="pr-meta">
                          <span className="mono">
                            {repoName(p.repo)}#{p.number}
                          </span>
                          {todo?.pr_state ? <span className={`gh gh-pr-${todo.pr_state}`}>{PR_LABEL[todo.pr_state]}</span> : p.is_draft && <span className="gh gh-pr-draft">Draft</span>}
                          <span>
                            {p.kind === "review" ? `${p.author} · ` : ""}
                            {isoAgo(p.updated_at)}
                          </span>
                        </span>
                        <span className="ellipsis">{p.title}</span>
                      </span>
                      {todo ? (
                        <button className="tag todo-chip" onClick={(e) => (e.stopPropagation(), onOpenTodo(todo.id))} title={todo.title}>
                          #{todo.id} {todo.title}
                        </button>
                      ) : (
                        p.kind === "mine" && (
                          <button className="small" onClick={(e) => (e.stopPropagation(), run(() => makeTodo(p, p.title)))}>
                            todo にする
                          </button>
                        )
                      )}
                      {p.kind === "review" && <ReviewButton accent={browserUrl === p.url} busy={starting.has(p.url)} onStart={(submit) => startReview(p, submit)} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
      </div>
    </>
  );
}

const NOTICE_LABEL: Record<Notice["kind"], string> = {
  finished: "作業が終わりました",
  needs_input: "入力待ち",
  review_requested: "レビュー依頼",
};
const NOTICE_STATE: Record<Notice["kind"], string> = {
  finished: "state-running",
  needs_input: "state-needs_input",
  review_requested: "state-review",
};

/// The inputs: reading material, apart from the todos, each opening in the
/// Input mode with its pages on the left. A URL here, the dialog, or
/// ⌥-clicking a link in the browser adds one.
function InputsPage({ inputs: all, resumable, run, onFocus, onDetail, onAdd }: {
  inputs: Input[];
  /// The dialog adding one.
  onAdd: () => void;
  /// Inputs whose Input mode pages are kept, to go on where they were left.
  resumable: Set<number>;
  run: (f: () => Promise<unknown>) => void;
  onFocus: (input: Input) => void;
  onDetail: (id: number) => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const rows = all.filter((i) => showDone || !i.done);
  const done = all.filter((i) => i.done).length;
  // ↑↓ or j k pick one, Enter opens it in the Input mode, ⌥Enter its panel.
  const { cursorId, setCursor, list } = useRowCursor(
    rows.map((i) => String(i.id)),
    (id, alt) => {
      const input = rows.find((i) => String(i.id) === id);
      if (input) (alt ? onDetail(input.id) : onFocus(input));
    },
  );
  /// One input for all the URLs typed; false when there is none.
  const add = (text: string) => {
    const input = parseInput(text);
    if (input) run(async () => addInput(input.urls, await inputTitle(input.urls, input.title)));
    return input !== null;
  };
  return (
    <>
      <header className="toolbar">
        <h1>Input</h1>
        <span className="muted">{all.length - done}</span>
        <input
          className="filter-search input-add"
          placeholder="URL（いくつでも）とタイトルを入れて Enter で追加"
          aria-label="input に追加する URL とタイトル"
          title="URL をいくつ入れても 1 件にまとまります。URL 以外の言葉がタイトルになります"
          onKeyDown={(e) => isEnter(e) && add(e.currentTarget.value) && (e.currentTarget.value = "")}
          // Lines pasted in stay apart (a one-line field drops the line breaks).
          onPaste={(e) => {
            const text = e.clipboardData.getData("text/plain");
            if (!/[\r\n]/.test(text)) return;
            e.preventDefault();
            document.execCommand("insertText", false, text.trim().replace(/\s*[\r\n]+\s*/g, " "));
          }}
        />
        <span className="grow" />
        {done > 0 && (
          <button className={`filter${showDone ? " on" : ""}`} aria-pressed={showDone} onClick={() => setShowDone((v) => !v)}>
            読み終わったものも表示 {done}
          </button>
        )}
        <button className="primary" onClick={onAdd}>
          <Icon name="plus" size={13} /> 新しい input <span className="kbd">{keyLabel(keyOf("newTodo"))}</span>
        </button>
      </header>
      <div className="content" ref={list}>
        {rows.length === 0 && (
          <p className="muted empty">まだありません。「新しい input」か、上に URL を入れるか、ブラウザでリンクを ⌥ + クリックすると追加されます。URL をいくつか入れると 1 件にまとまり、Input モードで全部左に開きます。</p>
        )}
        <ul className="rows">
          {rows.map((i) => {
            const pages = pagesOf(i);
            return (
              <li
                key={i.id}
                data-row={i.id}
                className={`row${String(i.id) === cursorId ? " cursor" : ""}${i.done ? " done" : ""}`}
                onClick={() => (setCursor(String(i.id)), onFocus(i))}
              >
                <button
                  className="ghost icon"
                  aria-label={i.done ? `${i.title} を読み終わっていないことにする` : `${i.title} を読み終わったことにする`}
                  title={i.done ? "読み終わっていないことにする" : "読み終わった"}
                  onClick={(e) => (e.stopPropagation(), run(() => api.updateInput(i.id, { done: !i.done })))}
                >
                  <StatusIcon status={i.done ? "done" : "todo"} />
                </button>
                <span className="row-title">{i.title}</span>
                {pages[0] && <span className="muted mono ellipsis">{hostOf(pages[0].url)}</span>}
                {pages.length > 1 && <span className="tag">{pages.length} ページ</span>}
                {i.links.some((l) => NOTE_PAGE.test(l.url)) && <span className="tag">ノート</span>}
                {resumable.has(i.id) && (
                  <span className="tag" title="開くと、前に開いていたページの続きから始まります">
                    続き
                  </span>
                )}
                <span className="muted when">{ago(i.updated_at)}</span>
                <button className="ghost icon" aria-label={`${i.title} の詳細`} title="詳細" onClick={(e) => (e.stopPropagation(), onDetail(i.id))}>
                  <Icon name="more" size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

/// An input's pages to read: its links but its note (NOTE_PAGE).
const pagesOf = <L extends { url: string }>(i: { links: L[] }) => i.links.filter((l) => !NOTE_PAGE.test(l.url));

/// An input's panel (InputsPage's ⌥Enter and …): its title, memo and pages,
/// read or not, and deleting it.
function InputPanel({ input, run, report, onFocus, onClose }: {
  input: Input;
  run: (f: () => Promise<unknown>) => void;
  report: (e: unknown) => void;
  onFocus: () => void;
  onClose: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  useEffect(() => setDeleting(false), [input.id]);
  const update = (u: Parameters<typeof api.updateInput>[1]) => run(() => api.updateInput(input.id, u));
  const note = input.links.find((l) => NOTE_PAGE.test(l.url));
  return (
    <aside className="panel" aria-label={input.title}>
      <header className="panel-head">
        <span className="muted">input</span>
        <span className="grow" />
        <button className="ghost small" title="Input モードで開く（Enter）" onClick={onFocus}>
          Input モード
        </button>
        <button className="ghost small" onClick={() => setDeleting(true)}>
          削除
        </button>
        <button className="ghost icon" aria-label="閉じる" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>
      {deleting && (
        <div className="notice danger-notice">
          <span>「{input.title}」を削除しますか？ ノートは claude.ai に残ります。</span>
          <button className="danger" onClick={() => run(async () => (await api.deleteInput(input.id), onClose()))}>
            削除する
          </button>
          <button className="ghost" onClick={() => setDeleting(false)}>
            やめる
          </button>
        </div>
      )}
      <InlineInput className="panel-title" value={input.title} label="タイトル" placeholder="タイトル" required onSave={(title) => update({ title: title.trim() })} />
      <div className="panel-body">
        <label className="toggle">
          <input type="checkbox" checked={input.done} onChange={() => update({ done: !input.done })} />
          読み終わった
        </label>
        <section>
          <h3>メモ</h3>
          <MemoEditor value={input.memo ?? ""} report={report} onSave={(memo) => update({ memo })} />
        </section>
        <section>
          <h3>
            ページ <span className="muted">{pagesOf(input).length}</span>
          </h3>
          <ul className="rows compact">
            {pagesOf(input).map((l) => (
              <li key={l.id} className="row">
                <span className="row-title ellipsis" title={l.url}>
                  {l.title || l.url}
                </span>
                <span className="muted mono ellipsis">{hostOf(l.url)}</span>
                <button className="ghost icon" aria-label={`${l.title || l.url} を外す`} onClick={() => run(() => api.removeInputLink(l.id))}>
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
          <SubmitInput placeholder="URL を貼って Enter で追加" onSubmit={(url) => run(() => api.addInputLink(input.id, url))} />
        </section>
        {note && (
          <section>
            <h3>ノート</h3>
            <p className="muted mono ellipsis">{note.url}</p>
          </section>
        )}
      </div>
    </aside>
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

/// The PR of a review request's notice: its URL, and the title it was posted with (`owner/repo#n title`).
function reviewTargetOf(n: Notice): ReviewTarget | null {
  const m = n.url?.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!n.url || !m) return null;
  return { url: n.url, repo: m[1], title: n.title.replace(`${m[1]}#${m[2]} `, "") };
}

function NoticesPage({ board, local, report, onOpenTodo, run }: {
  board: Board;
  local: LocalRepo[];
  report: (e: unknown) => void;
  onOpenTodo: (id: number) => void;
  run: (f: () => Promise<unknown>) => void;
}) {
  const openCloud = useContext(OpenCloudContext);
  const terminal = useContext(TerminalContext);
  const openInBrowser = useContext(BrowserContext);
  const rows = board.notifications.filter((n) => !n.read);
  const todoOf = (n: Notice) => board.todos.find((t) => t.id === n.todo_id);
  const read = (n: Notice) => !n.read && run(() => api.readNotifications(n.id));
  const { startReview, starting } = useReviewStarter(local, run);
  // ↑↓ or j k pick a notice, Enter opens its session (for a review request,
  // the choice of submitting on its own or asking first), ⌥Enter its row,
  // x dismisses it (the cursor going on to the next).
  const ids = rows.map((n) => String(n.id));
  const { cursorId, setCursor, list } = useRowCursor(
    ids,
    (_, alt, row) => (alt ? row : (row.querySelector<HTMLButtonElement>(".open-caret, .notice-open") ?? row)).click(),
    (e, id) => {
      const n = rows.find((n) => String(n.id) === id);
      if (!n || !matches(e, "dismiss")) return false;
      const i = ids.indexOf(id);
      setCursor(ids[i + 1] ?? ids[i - 1] ?? null);
      read(n);
      return true;
    },
  );
  const openSession = (n: Notice) => {
    read(n);
    if (n.session_id.startsWith("cse_") && openCloud) openCloud(n.session_id);
    else openLocal(terminal, n.session_id, report, true);
  };
  return (
    <>
      <header className="toolbar">
        <h1>通知</h1>
        <span className="muted">{rows.length}</span>
        <span className="grow" />
        <button disabled={rows.length === 0} onClick={() => run(() => api.readNotifications())}>
          <Icon name="check" size={13} /> すべて消す
        </button>
      </header>
      <div className="content" ref={list}>
        {rows.length === 0 && <p className="muted empty">通知はありません。セッションの作業が終わる、入力待ちになる、レビューを頼まれると、ここに出ます。</p>}
        <ul className="rows">
          {rows.map((n) => {
            const todo = todoOf(n);
            const review = reviewTargetOf(n);
            return (
              <li
                key={n.id}
                data-row={n.id}
                className={`row notice-row${String(n.id) === cursorId ? " cursor" : ""}`}
                onClick={() => {
                  setCursor(String(n.id));
                  read(n);
                  // A review request's row shows its PR; others open their todo.
                  if (n.url) openInBrowser?.(n.url);
                  else if (todo) onOpenTodo(todo.id);
                }}
              >
                <span className="unread-dot on" aria-hidden="true" />
                <span className={`state ${NOTICE_STATE[n.kind]}`}>
                  <i />
                  {NOTICE_LABEL[n.kind]}
                </span>
                <span className="row-title">{n.title}</span>
                {todo && <span className="tag ellipsis notice-todo">#{todo.id} {todo.title}</span>}
                <span className="muted when">{ago(n.created_at)}</span>
                {review ? (
                  <ReviewButton accent={false} busy={starting.has(review.url)} onStart={(submit) => (read(n), startReview(review, submit))} />
                ) : (
                  <button className="small notice-open" title="セッションを開く" onClick={(e) => (e.stopPropagation(), openSession(n))}>
                    開く
                  </button>
                )}
                <button className="ghost icon" aria-label="この通知を消す" title={`消す（${keyLabel(keyOf("dismiss"))}）`} onClick={(e) => (e.stopPropagation(), read(n))}>
                  <Icon name="close" size={12} />
                </button>
              </li>
            );
          })}
        </ul>
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
function AddTodoDialog({ local, groups, initialRepo, run, onClose, onOpenTodo }: {
  local: LocalRepo[];
  groups: string[];
  initialRepo: string | null;
  run: (f: () => Promise<unknown>) => void;
  onClose: () => void;
  onOpenTodo: (id: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState(initialRepo && initialRepo !== NO_REPO_LANE ? initialRepo : "");
  const [issueUrl, setIssueUrl] = useState("");
  const [added, setAdded] = useState<Todo[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const submit = () => {
    const t = title.trim();
    if (!t) return;
    const path = local.find((r) => r.key === repo)?.path;
    run(async () => {
      const todo = await api.createTodo({ title: t, repos: repo ? [repo] : [], cwd: path, issue_url: issueUrl.trim() || undefined });
      setAdded((prev) => [todo, ...prev]);
      setTitle("");
      setIssueUrl("");
      titleRef.current?.focus();
    });
  };
  return (
    <Modal
      title="todo を追加"
      onClose={onClose}
      footer={
        <>
          <span className="muted">Enter で追加。続けて入力できます</span>
          <span className="grow" />
          <button className="ghost" onClick={onClose}>
            閉じる
          </button>
          <button className="primary" disabled={!title.trim()} onClick={submit}>
            追加
          </button>
        </>
      }
    >
      <label className="field">
        <span>タイトル</span>
        <input ref={titleRef} value={title} placeholder="何をする？" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => isEnter(e) && submit()} />
      </label>
      <div className="two-col">
        <div className="field">
          <span>リポジトリ / グループ（任意）</span>
          <RepoChoice local={local} groups={repo && !isGithubRepo(repo) && !groups.includes(repo) ? [repo, ...groups] : groups} value={repo} placeholder={NO_REPO_LANE} onPick={setRepo} />
        </div>
        <label className="field">
          <span>Issue / PR URL（任意）</span>
          <input value={issueUrl} placeholder="https://github.com/…" onChange={(e) => setIssueUrl(e.target.value)} onKeyDown={(e) => isEnter(e) && submit()} />
        </label>
      </div>
      {added.length > 0 && (
        <div className="added">
          <span className="muted">追加済み {added.length} 件</span>
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

/// How long the pages typed in AddInputDialog rest before their title is read.
const TITLE_LOOKUP_MS = 400;

/// Adds input todos as AddTodoDialog adds todos: a title and the pages to
/// read (none yet, or one or more, one per line). Without a title it takes
/// the words among the pages, else the first page's own title, read as they
/// are typed. One just added opens in the Input mode.
function AddInputDialog({ openPages, run, onClose, onOpen }: {
  /// The pages open in the 作業スペース (the one shown first), to pick from.
  openPages: { url: string; title: string | null; shown: boolean }[];
  run: (f: () => Promise<unknown>) => void;
  onClose: () => void;
  onOpen: (input: Input) => void;
}) {
  const [title, setTitle] = useState("");
  const [pages, setPages] = useState("");
  const [added, setAdded] = useState<Input[]>([]);
  const pagesRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const input = parseInput(pages);
  // A title alone makes one too, its pages added later.
  const ready = input !== null || title.trim() !== "";
  // The first page's own title, read once the pages stop changing: the title
  // an input without one gets (undefined while it is read).
  const first = input?.urls[0];
  const [read, setRead] = useState<{ url: string; title: string | null } | null>(null);
  useEffect(() => {
    if (!first) return;
    const t = setTimeout(
      () => api.pageTitle(first).then((title) => setRead({ url: first, title }), () => setRead({ url: first, title: null })),
      TITLE_LOOKUP_MS,
    );
    return () => clearTimeout(t);
  }, [first]);
  // A page open here has its title already, even one behind a sign-in.
  const openTitle = openPages.find((p) => p.url === first)?.title;
  const pageTitle = openTitle || (read && read.url === first ? read.title : undefined);
  const picked = (url: string) => input?.urls.includes(url) ?? false;
  /// Adds an open page to the URLs, or takes it out again.
  const toggle = (url: string) => {
    const lines = pages.split(/\s+/).filter(Boolean);
    setPages((picked(url) ? lines.filter((l) => l !== url) : [...lines, url]).join("\n"));
    pagesRef.current?.focus();
  };
  const submit = () => {
    if (!ready) return;
    run(async () => {
      const urls = input?.urls ?? [];
      const given = title.trim() || input?.title || "";
      const name = given || pageTitle || (pageTitle === undefined ? await inputTitle(urls, "") : hostOf(urls[0]));
      const todo = await addInput(urls, name);
      setAdded((prev) => [todo, ...prev]);
      setTitle("");
      setPages("");
      titleRef.current?.focus();
    });
  };
  return (
    <Modal
      title="input を追加"
      onClose={onClose}
      footer={
        <>
          <span className="muted">⌘Enter で追加。続けて入力できます</span>
          <span className="grow" />
          <button className="ghost" onClick={onClose}>
            閉じる
          </button>
          <button className="primary" disabled={!ready} onClick={submit}>
            追加
          </button>
        </>
      }
    >
      <label className="field">
        <span>タイトル（URL を入れたときは空でも可。ページのタイトルが入ります）</span>
        <input
          ref={titleRef}
          value={title}
          placeholder={!first ? "何を読む？" : input?.title || pageTitle || (pageTitle === undefined ? "ページのタイトルを読み込み中…" : hostOf(first))}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => isEnter(e) && submit()}
        />
      </label>
      <label className="field">
        <span>読むページの URL（任意。1行に1つ、いくつでも。あとから足せます）</span>
        <textarea
          ref={pagesRef}
          rows={3}
          value={pages}
          placeholder="https://…"
          onChange={(e) => setPages(e.target.value)}
          onKeyDown={(e) => isEnter(e) && e.metaKey && (e.preventDefault(), submit())}
        />
      </label>
      {openPages.length > 0 && (
        <div className="field">
          <span>作業スペースで開いているページ（押すと URL に入ります）</span>
          <ul className="rows compact open-pages">
            {openPages.map((p) => (
              <li key={p.url} className={`row${picked(p.url) ? " on" : ""}`} onClick={() => toggle(p.url)}>
                <Icon name={picked(p.url) ? "check" : "plus"} size={12} />
                <span className="row-title">{p.title || hostOf(p.url)}</span>
                {p.shown && <span className="tag">表示中</span>}
                <span className="muted mono ellipsis">{hostOf(p.url)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {added.length > 0 && (
        <div className="added">
          <span className="muted">追加済み {added.length} 件（押すと Input モードで開きます）</span>
          <ul className="rows compact">
            {added.map((t) => (
              <li key={t.id} className="row" onClick={() => onOpen(t)}>
                <span className="mono muted">#{t.id}</span>
                <span className="row-title">{t.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

/// Puts a page (the 作業スペース's shown one) in an input made before, or in a
/// new one: ↑↓ (⌃j ⌃k) pick, Enter puts it there; the words typed narrow them.
function AddToInputDialog({ page, inputs, run, onDone, onClose }: {
  page: { url: string; title: string | null };
  /// The inputs not read yet, the latest first.
  inputs: Input[];
  run: (f: () => Promise<unknown>) => void;
  /// Told what the page went into.
  onDone: (title: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = inputs.filter((t) => words.every((w) => t.title.toLowerCase().includes(w)));
  const has = (t: Input) => t.links.some((l) => l.url === page.url);
  // The new input comes last, as one more choice.
  const count = shown.length + 1;
  const put = (t: Input | undefined) =>
    run(async () => {
      if (t) {
        if (!has(t)) await api.addInputLink(t.id, page.url);
        onDone(t.title);
      } else {
        const todo = await addInput([page.url], page.title || (await inputTitle([page.url], "")));
        onDone(todo.title);
      }
      onClose();
    });
  return (
    <Modal title="このページを input に追加" onClose={onClose}>
      <p className="muted ellipsis">{page.title || page.url}</p>
      <input
        autoFocus
        className="filter-search"
        value={query}
        placeholder="input を絞り込む"
        aria-label="追加先の input を絞り込む"
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
            <span className="row-title">{t.title}</span>
            {has(t) ? <span className="tag">追加済み</span> : <span className="muted">{pagesOf(t).length} ページ</span>}
          </li>
        ))}
        <li role="option" aria-selected={active === shown.length} className={`row${active === shown.length ? " cursor" : ""}`} onMouseEnter={() => setActive(shown.length)} onClick={() => put(undefined)}>
          <Icon name="plus" size={12} />
          <span className="row-title">新しい input にする</span>
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
  ショートカット: ["shortcut", "key", "keys", "キー", "keymap"],
  通知: ["notification", "notice", "お知らせ", "bell"],
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
function CommandPalette({ commands, todos, inputs, onOpenTodo, onOpenInput, onClose }: {
  commands: Command[];
  todos: Todo[];
  inputs: Input[];
  onOpenTodo: (id: number) => void;
  onOpenInput: (input: Input) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const q = query.trim().toLowerCase();
  const items: Command[] = [
    ...commands.filter((c) => commandMatches(c.label, q)),
    ...(q
      ? todos
          .filter((t) => t.title.toLowerCase().includes(q) || `#${t.id}` === q || String(t.id) === q)
          .slice(0, 20)
          .map((t) => ({ key: `todo:${t.id}`, label: `#${t.id} ${t.title}`, hint: t.status, run: () => onOpenTodo(t.id) }))
      : []),
    // Inputs open in the Input mode.
    ...(q
      ? inputs
          .filter((i) => i.title.toLowerCase().includes(q))
          .slice(0, 20)
          .map((i) => ({ key: `input:${i.id}`, label: `input: ${i.title}`, hint: i.done ? "読み終わった" : undefined, run: () => onOpenInput(i) }))
      : []),
  ];
  useEffect(() => setActive(0), [query]);
  // Keep the picked row in sight as the keys move it.
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const pick = (c: Command) => {
    onClose();
    c.run();
  };
  return (
    <div className="modal-backdrop palette-backdrop" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="コマンド" onClick={stop}>
        <input
          autoFocus
          value={query}
          placeholder="操作を選ぶ、または todo や input を検索"
          aria-label="操作を選ぶ、または todo や input を検索"
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
              onClose();
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
              <span className="ellipsis">{c.label}</span>
              {c.hint && <span className="muted">{c.hint}</span>}
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

type Selection = { kind: "todo"; id: number } | { kind: "input"; id: number } | { kind: "session"; id: string } | null;
type DialogKind = "add" | "addInput" | "toInput" | "import" | "quick" | "palette" | "keys" | "exitFocus" | "focusPick" | "focusLink" | "jevKey" | null;

const FOCUS_LINK_ENTER_AFTER_MS = 600;

/// Jev's API key, typed here and kept in the Keychain (an empty Enter does nothing).
function JevKeyField({ onSaved }: { onSaved?: () => void }) {
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (key: string) =>
    key &&
    api.setJevKey(key).then(
      () => (setSaved(true), setError(null), onSaved?.()),
      (e) => setError(String(e)),
    );
  return (
    <div className="jev-key">
      <input
        type="password"
        className="mono"
        autoFocus
        placeholder="TypeSafe の API キーを貼って Enter"
        aria-label="Jev の API キー"
        onKeyDown={(e) => {
          if (!isEnter(e)) return;
          e.preventDefault();
          save(e.currentTarget.value.trim());
        }}
      />
      {saved && <span className="muted">Keychain に入れました</span>}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}

/// ⌘K's "Jev の API キー": sets (or takes out) the key the focus mode's
/// judging uses.
function JevKeyDialog({ onClose }: { onClose: () => void }) {
  const [exists, setExists] = useState<boolean | null>(null);
  const check = () => api.jevKeyExists().then(setExists, () => setExists(false));
  useEffect(() => void check(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal
      title="Jev の API キー"
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          {exists && (
            <button className="ghost" onClick={() => api.setJevKey("").then(check, check)}>
              外す
            </button>
          )}
          <button onClick={onClose}>閉じる</button>
        </>
      }
    >
      <p className="muted">
        Input モードで開こうとしたページが今の作業に関係するかを、TypeSafe の Jev が判定します。キーは Keychain に入れます。
        {exists === true && "いまは設定されています。"}
        {exists === false && "まだ設定されていません。"}
      </p>
      <JevKeyField onSaved={check} />
    </Modal>
  );
}

/// Asked when a page for the focus mode's left, outside what it may open, was
/// judged not to fit the work (or could not be judged). Without a working
/// key, one can be typed in and the page judged again.
function FocusLinkDialog({ asking, onOpen, onClose, onJudgeAgain }: { asking: FocusAsking; onOpen: () => void; onClose: () => void; onJudgeAgain: () => void }) {
  const { url, verdict, failed } = asking;
  // Jev's key errors (relevance.rs): none set, or refused.
  const keyTrouble = failed === JEV_NO_KEY || failed?.startsWith("Jev の API キーが通りません");
  // It comes up on its own once the page is judged: an Enter meant for the
  // page being typed into then opens nothing.
  const shownAt = useRef(Date.now());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || Date.now() - shownAt.current < FOCUS_LINK_ENTER_AFTER_MS) return;
      // The key's field takes its own Enter.
      if ((e.target as HTMLElement).closest("input")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onOpen();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onOpen]);
  return (
    <Modal
      title="このページを開きますか？"
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button className="ghost" onClick={onClose}>
            やめる <span className="kbd">Esc</span>
          </button>
          <button className="primary" onClick={onOpen}>
            左に開く <span className="kbd">Enter</span>
          </button>
        </>
      }
    >
      {verdict?.title && <p className="focus-link-title">{verdict.title}</p>}
      <p className="mono ellipsis" title={url}>
        {url}
      </p>
      {verdict ? (
        <p className="focus-verdict">
          今の作業に関係する見込み <b>{verdict.score}%</b>（Jev の判定）
        </p>
      ) : (
        <>
          <p className="error-text">今の作業に関係するか判定できませんでした：{failed}</p>
          {keyTrouble && <JevKeyField onSaved={onJudgeAgain} />}
        </>
      )}
      <p className="muted">Input モードで開くページの外です。開くと、このページ（とその下）はこのあいだ開けるようになります。</p>
    </Modal>
  );
}

/// Keys the focus mode still lets through with ⌘: editing text (copy, paste, …).
const FOCUS_EDIT_KEYS = ["c", "v", "x", "a", "z"];

/// Asked on Esc in the focus mode: Esc again leaves, Enter stays.
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
      title="Input モードを終えますか？"
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
  ["Enter", "開く（Todo のパネル、セッション、メニューの項目）"],
  ["⌥Enter", "開き方を選ぶ（セッション）/ PR を開く（PR・通知）"],
  ["Esc", "パネルやメニューを閉じる（Input モードでは終えるか聞く）"],
];

/// Every shortcut, and changing one: its key's button, then the new key
/// (Esc keeps the old one). ? and ⌘K's "ショートカット" open it.
function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const keys = useKeymap();
  const [recording, setRecording] = useState<Action | null>(null);
  useEffect(() => {
    if (!recording) return;
    // Ahead of everything else, the app's own shortcuts too.
    const onKey = (e: KeyboardEvent) => {
      const combo = comboOf(e);
      if (!combo) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key !== "Escape") setKeys({ [recording]: combo });
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);
  const labelOf = new Map(ACTIONS.flatMap((g) => g.items));
  return (
    <Modal
      title="ショートカット"
      wide
      onClose={() => !recording && onClose()}
      footer={
        <>
          <span className="muted">キーのボタンを押してから、新しいキーを押します（Esc でやめる）。⌘Q ⌘H ⌘. など macOS が使うキーは効きません</span>
          <span className="grow" />
          <button className="ghost" onClick={resetKeys}>
            すべて既定に戻す
          </button>
        </>
      }
    >
      <div className="shortcuts">
        {ACTIONS.map((g) => (
          <section key={g.group}>
            <h3>{g.group}</h3>
            {g.items.map(([action, what]) => {
              // Another action on the same key in this list (the lists' keys are one set).
              const same = (Object.keys(keys) as Action[]).find((a) => a !== action && keys[a] === keys[action]);
              return (
                <div key={action} className="shortcut-row">
                  <span className="grow">{what}</span>
                  {same && <span className="error-text small">「{labelOf.get(same)}」と同じ</span>}
                  {keys[action] !== DEFAULT_KEYS[action] && (
                    <button className="ghost small" title={`既定（${keyLabel(DEFAULT_KEYS[action])}）に戻す`} onClick={() => setKeys({ [action]: DEFAULT_KEYS[action] })}>
                      既定に
                    </button>
                  )}
                  <button className={`kbd shortcut-key${recording === action ? " recording" : ""}`} onClick={() => setRecording(action)}>
                    {recording === action ? "キーを押す…" : keyLabel(keys[action])}
                  </button>
                </div>
              );
            })}
          </section>
        ))}
        <section>
          <h3>変えられないキー</h3>
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
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(null);
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
  const nextTab = useRef(1);
  // The pane's tabs: the focus mode's own pages are apart from them.
  const paneTabs = tabs.filter((t) => !t.focus);
  const activeTab = newTab ? null : (paneTabs.find((t) => t.id === activeTabId) ?? paneTabs[paneTabs.length - 1] ?? null);
  const browserUrl = browserShown ? (activeTab?.url ?? null) : null;
  /// The previous (-1) or next (1) tab, wrapping around (⌘⇧[ ⌘⇧]).
  const switchTab = (delta: number) => {
    // The tabs the strip shows (the focus mode's own page, Notion, is not one).
    const shown = tabs.filter((t) => !t.focus && (!t.pinned || PINNED_PAGES.some((p) => p.id === t.id)));
    if (!browserShown || shown.length === 0) return;
    const i = activeTab ? shown.findIndex((t) => t.id === activeTab.id) : delta > 0 ? -1 : shown.length;
    setActiveTabId(shown[(i + delta + shown.length) % shown.length].id);
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
  const [linkTarget, setLinkTargetState] = useState<LinkTarget>(() => load(LINK_TARGET_KEY, ["app", "dia"] as const, "app"));
  const setLinkTarget = (t: LinkTarget) => {
    remember(LINK_TARGET_KEY, t);
    setLinkTargetState(t);
  };
  /// In the pane, a page already open in a tab comes to the front and anything
  /// else gets a new tab; with Dia chosen, pages go there instead.
  /// `keys` gives the page the keyboard (one typed into the new tab page).
  const openInBrowser = (url: string, keys = false) => {
    if (linkTarget === "dia") {
      api.openInDia(url).catch(report);
      return;
    }
    setBrowserShown(true);
    // Only a Claude session's page comes back to its tab; anything else, the
    // claude.ai home included, may be open in as many tabs as asked.
    const open = CLOUD_SESSION_PAGE.test(url) ? paneTabs.find((t) => sameTarget(t.url, url)) : undefined;
    if (open) return setActiveTabId(open.id);
    const id = `t${nextTab.current++}`;
    if (keys) keysInto = id;
    setTabs((prev) => [...prev, { id, url, title: null, loading: true, nav: 0 }]);
    setActiveTabId(id);
  };
  const beginWeb: BeginWeb = () => {
    if (linkTarget === "dia") return (sessionId) => sessionId && api.openInDia(cloudWebUrl(sessionId)).catch(report);
    const id = `t${nextTab.current++}`;
    setBrowserShown(true);
    setTabs((prev) => [...prev, { id, url: CLOUD_HOME, title: "セッションを作成中…", loading: true, nav: 0 }]);
    setActiveTabId(id);
    return (sessionId) => {
      if (sessionId) {
        setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, url: cloudWebUrl(sessionId), title: null, loading: true, nav: t.nav + 1 } : t)));
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
  const setFocusRight = (kind: string) => {
    remember(FOCUS_RIGHT_KEY, kind);
    setFocusRightPref(kind);
    patchSpace(spaceKey, (s) => ({ ...s, right: kind }));
    ensureRight(spaceKey, kind, space.rightUrls[kind]);
    typeInto = rightTabId(spaceKey, kind);
  };
  // The pages take the keys as they are set (their script reads them).
  const keymap = useKeymap();
  useEffect(() => void api.setPageKeys(JSON.stringify(keymap)).catch((e) => setError(String(e))), [keymap]);
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;
  useEffect(() => void api.setFocusMode(focusMode).catch((e) => setError(String(e))), [focusMode]);
  // Notifications during the focus mode wait (the backend posts none); on
  // leaving, the page tells how many came.
  const unreadAtFocus = useRef(0);
  const [heldNotices, setHeldNotices] = useState(0);
  const unreadNow = () => board?.notifications.filter((n) => !n.read).length ?? 0;
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
    // Judgments still out are dropped as they come back.
    setAsking([]);
    setFocusLink(null);
    setFocusSubject(null);
    setHeldNotices(Math.max(0, unreadNow() - unreadAtFocus.current));
  };
  // The space's left: its own tabs (apart from the pane's) and terminals the
  // pane has, and the one shown.
  const focusLefts = space.lefts.map((id) => tabs.find((t) => t.id === id)).filter((t): t is BrowserTab => t !== undefined);
  const focusLeft = focusLefts.find((t) => t.id === space.active) ?? focusLefts[0] ?? null;
  /// Puts items on the left of space `key` (the one shown, by default), the first of them shown.
  const addToFocus = (items: FocusItem[], key = spaceKey) => {
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
      active: ids[0] ?? s.active,
    }));
  };
  /// Takes a tab off the left (its own page closes; a terminal stays the pane's).
  const removeFromFocus = (id: string) => {
    patchSpace(spaceKey, (s) => ({ ...s, lefts: s.lefts.filter((x) => x !== id) }));
    if (tabs.find((t) => t.id === id)?.focus) {
      api.browserClose(id).catch(report);
      setTabs((prev) => prev.filter((t) => t.id !== id));
    }
  };
  // Where the space's pages may go: the left's own pages (and under them),
  // the study pages' sites and the pages let through; the right its site.
  // A link anywhere else asks first (FOCUS_LINK_EVENT).
  const leftAllow = () => [...space.pages.map(pagePrefix), ...space.accepted, ...loadJson<StudyPage[]>(STUDY_PAGES_KEY, []).map((p) => sitePrefix(p.url))];
  const allowedLeft = (url: string) => leftAllow().some((p) => url.startsWith(p));
  useEffect(() => {
    if (!focusMode) return;
    const left = leftAllow();
    for (const t of focusLefts.filter((t) => t.focus)) api.setFocusAllow(t.id, left).catch(report);
    api.setFocusAllow(focusRightId, FOCUS_RIGHT_ALLOW[focusRight] ?? null).catch(report);
    return () => void api.setFocusAllow(focusRightId, null).catch(() => {});
  }, [focusMode, space.lefts.join(), space.pages.join(), space.accepted.join(), focusRightId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A todo's space is saved as it changes, to be resumed after a restart.
  const savedSpace: SavedSpace | null =
    focusMode && focusSubject !== null
      ? (() => {
          const pages = focusLefts.filter((t) => !t.term);
          const rights = tabs.filter((t) => t.space === spaceKey && t.kind && t.kind !== NOTE_TAB);
          return {
            lefts: pages.map((t) => ({ url: t.url, title: t.title })),
            active: Math.max(0, pages.findIndex((t) => t.id === focusLeft?.id)),
            right: space.right,
            rightUrls: Object.fromEntries(rights.map((t) => [t.kind!, t.url])),
            pages: space.pages,
            accepted: space.accepted,
          };
        })()
      : null;
  const savedSpaceJson = savedSpace && JSON.stringify(savedSpace);
  useEffect(() => {
    if (focusSubject === null || !savedSpaceJson) return;
    remember(INPUT_SPACES_KEY, JSON.stringify({ ...savedSpaces(), [spaceKey]: JSON.parse(savedSpaceJson) }));
  }, [savedSpaceJson]); // eslint-disable-line react-hooks/exhaustive-deps
  // The note (NOTE_TAB): the subject's, once published (one of its links),
  // else the session making it.
  const [noteSessions, setNoteSessionsState] = useState<Record<string, NoteSession>>(() => loadJson(NOTE_SESSIONS_KEY, {}));
  /// The todo or input the Input mode is open for.
  const subjectItem: { title: string; memo: string | null; links: { id: number; url: string }[] } | undefined =
    focusSubject?.kind === "todo" ? board?.todos.find((t) => t.id === focusSubject.id) : focusSubject?.kind === "input" ? board?.inputs.find((i) => i.id === focusSubject.id) : undefined;
  const noteUrl = subjectItem?.links.find((l) => NOTE_PAGE.test(l.url))?.url ?? null;
  const noteSession = focusSubject === null ? undefined : noteSessions[spaceKey];
  const noteTerminal = noteSession && tabs.find((t) => t.term?.session === noteSession.session);
  // A note being made on Cloud shows its session's page meanwhile.
  const notePage = noteUrl ?? (noteSession?.cloud ? cloudWebUrl(noteSession.session) : null);
  useEffect(() => {
    if (!focusMode || focusRight !== NOTE_TAB || !notePage) return;
    const id = focusRightId;
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev.map((t) => (t.id === id && pagePrefix(t.url) !== pagePrefix(notePage) ? { ...t, url: notePage, loading: true, nav: t.nav + 1 } : t))
        : [...prev, { id, url: notePage, title: "ノート", loading: true, nav: 0, focus: true, space: spaceKey, kind: NOTE_TAB }],
    );
  }, [focusMode, focusRightId, notePage]); // eslint-disable-line react-hooks/exhaustive-deps
  /// The right side's tab: the space's page, or the note (its page, else the
  /// terminal making it).
  const focusRightTab = focusRight !== NOTE_TAB || notePage ? tabs.find((t) => t.id === focusRightId) : noteTerminal;
  // The note is looked for in its session until it is published.
  useEffect(() => {
    if (!focusMode || focusSubject === null || !noteSession || noteUrl) return;
    const subject = focusSubject;
    const look = () => void api.noteUrl(subject, noteSession.session).then((url) => url && refresh(), report);
    const timer = setInterval(look, NOTE_POLL_MS);
    return () => clearInterval(timer);
  }, [focusMode, focusSubject, noteSession?.session, noteUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  // Spaces and notes were kept by todo id while inputs were todos (they kept
  // their ids as they moved): the keys become subjectKey's, once.
  useEffect(() => {
    if (!board) return;
    const rekey = <T,>(key: string) => {
      const old = loadJson<Record<string, T>>(key, {});
      if (!Object.keys(old).some((k) => /^\d+$/.test(k))) return null;
      const kind = (id: number) => (board.inputs.some((i) => i.id === id) ? "input" : "todo");
      const next = Object.fromEntries(Object.entries(old).map(([k, v]) => [/^\d+$/.test(k) ? subjectKey({ kind: kind(Number(k)), id: Number(k) }) : k, v]));
      remember(key, JSON.stringify(next));
      return next;
    };
    rekey<SavedSpace>(INPUT_SPACES_KEY);
    const notes = rekey<NoteSession>(NOTE_SESSIONS_KEY);
    if (notes) setNoteSessionsState(notes);
  }, [board === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const setNoteSessions = (next: Record<string, NoteSession>) => {
    remember(NOTE_SESSIONS_KEY, JSON.stringify(next));
    setNoteSessionsState(next);
  };
  /// Leaves the note (published or being made) to make another; the old one
  /// stays on claude.ai, and its session goes on.
  const resetNote = () =>
    run(async () => {
      if (focusSubject === null) return;
      const { [spaceKey]: _, ...rest } = noteSessions;
      setNoteSessions(rest);
      const link = subjectItem?.links.find((l) => NOTE_PAGE.test(l.url));
      if (link) await (focusSubject.kind === "todo" ? api.removeLink(link.id) : api.removeInputLink(link.id));
      refresh();
    });
  /// Starts the session that makes the note of the left's pages.
  const createNote = (format: NoteFormat, cloud: boolean) =>
    run(async () => {
      if (focusSubject === null) return;
      const urls = focusLefts.filter((t) => !t.term).map((t) => t.url);
      const started = await api.startNote(focusSubject, urls, format, cloud);
      setNoteSessions({ ...noteSessions, [spaceKey]: { session: started.session, cloud } });
      // Its terminal is one of the pane's, shown on the right while it works.
      const term = started.run;
      if (term) setTabs((prev) => [...prev, { id: `t${nextTab.current++}`, url: "", title: term.title, loading: false, nav: 0, term }]);
    });
  const [focusAsking, setFocusAsking] = useState<FocusAsking[]>([]);
  const focusAskingRef = useRef(focusAsking);
  focusAskingRef.current = focusAsking;
  const nextAsking = useRef(0);
  const setAsking = (list: FocusAsking[]) => {
    focusAskingRef.current = list;
    setFocusAsking(list);
  };
  /// The asked page FocusLinkDialog asks about.
  const [focusLink, setFocusLink] = useState<FocusAsking | null>(null);
  /// A page for the left (a link its pages may not go to, or one typed in):
  /// under what the left may open, it opens at once; otherwise Claude judges
  /// whether it fits the work (the todo, the left's pages), and it opens if
  /// it does, or is asked about if not (or if it could not be judged).
  const askFocusLink = (url: string, text?: string) => {
    if (allowedLeft(url)) return addToFocus([{ url }]);
    if (focusAskingRef.current.some((a) => a.url === url)) return;
    const id = nextAsking.current++;
    setAsking([...focusAskingRef.current, { id, url, text: text || undefined }]);
    const pages = focusLefts.filter((t) => !t.term).map((t) => ({ title: t.title, url: t.url }));
    api
      .judgeFocusLink({ subject: subjectItem?.title ?? null, memo: subjectItem?.memo ?? null, pages, url, text: text || null })
      .then(
        (verdict) => judged(id, { verdict }),
        (e) => judged(id, { failed: String(e) }),
      );
  };
  // Called back after a while, so it goes by the refs and state setters only.
  const judged = (id: number, result: { verdict: Verdict } | { failed: string }) => {
    const asking = focusAskingRef.current.find((a) => a.id === id);
    // Given up meanwhile, or the focus mode is over.
    if (!asking) return;
    if ("verdict" in result && result.verdict.score >= FOCUS_RELATED_SCORE) {
      setAsking(focusAskingRef.current.filter((a) => a.id !== id));
      return openAsked(asking.url);
    }
    const answerable = { ...asking, ...result };
    setAsking(focusAskingRef.current.map((a) => (a.id === id ? answerable : a)));
    // With another dialog up, its tab waits to be clicked.
    if (dialogRef.current === null) showAsking(answerable);
  };
  const showAsking = (asking: FocusAsking) => {
    setFocusLink(asking);
    setDialog("focusLink");
  };
  /// Opens an asked page on the left, and lets the left go under it from now on.
  const openAsked = (url: string) => {
    patchSpace(spaceKey, (s) => ({ ...s, accepted: [...s.accepted, pagePrefix(url)] }));
    addToFocus([{ url }]);
  };
  /// FocusLinkDialog's answer; the next page waiting for one is asked after it.
  const answerAsking = (open: boolean) => {
    if (!focusLink) return;
    const rest = focusAskingRef.current.filter((a) => a.id !== focusLink.id);
    setAsking(rest);
    if (open) openAsked(focusLink.url);
    const next = rest.find(isAnswerable);
    if (next) return showAsking(next);
    setFocusLink(null);
    setDialog(null);
  };
  /// Once Jev has a key (typed in FocusLinkDialog), the page asked about is
  /// judged again, as if just asked.
  const judgeAgain = () => {
    if (!focusLink) return;
    setAsking(focusAskingRef.current.filter((a) => a.id !== focusLink.id));
    setFocusLink(null);
    setDialog(null);
    askFocusLink(focusLink.url, focusLink.text);
  };
  // A link ⌥-clicked in a page becomes an input todo; the page says so (and
  // the input a page went into, from AddToInputDialog).
  const [addedInput, setAddedInputState] = useState<string | null>(null);
  const setAddedInput = (title: string) => {
    setAddedInputState(title);
    setTimeout(() => setAddedInputState(null), ADDED_INPUT_MS);
  };
  const addInputFrom = (url: string, title: string) =>
    run(async () => {
      await addInput([url], title);
      setAddedInput(title);
    });
  /// The page AddToInputDialog puts in an input: the 作業スペース's shown one.
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
  const askFocusLinkRef = useRef(askFocusLink);
  askFocusLinkRef.current = askFocusLink;
  const [focusPicking, setFocusPicking] = useState<"start" | "add">("start");
  const pickFocus = (mode: "start" | "add") => {
    if (mode === "start") setFocusSubject(null);
    setFocusPicking(mode);
    setDialog("focusPick");
  };
  /// The Input mode for a subject: its space as it was left (or saved), with
  /// any of `urls` it lacks added, else `urls` on the left; with none, the
  /// pages to pick from.
  const focusOn = (subject: Subject, urls: string[]) => {
    const key = subjectKey(subject);
    if (spaces[key] || savedSpaces()[key] || urls.length > 0) return enterFocus(urls.map((url) => ({ url })), subject);
    pickFocus("start");
    setFocusSubject(subject);
  };
  /// A todo's pages: its links, PR and issue.
  const focusTodo = (todo: Todo) =>
    focusOn({ kind: "todo", id: todo.id }, [...new Set([...pagesOf(todo).map((l) => l.url), todo.pr_url, todo.issue_url].filter((u): u is string => !!u))]);
  const focusInput = (input: Input) => focusOn({ kind: "input", id: input.id }, pagesOf(input).map((l) => l.url));
  const savedSpaces = () => loadJson<Record<string, SavedSpace>>(INPUT_SPACES_KEY, {});
  /// ⌘⇧[ ⌘⇧] in the Input mode: the previous or next tab of the side that has
  /// the keyboard, the left's own or the right's pages (which take the typing).
  const switchFocusTab = (right: boolean, delta: number) => {
    setFocusTyping(right ? "right" : "left");
    if (right) return setFocusRight(RIGHT_KINDS[(RIGHT_KINDS.indexOf(focusRight) + delta + RIGHT_KINDS.length) % RIGHT_KINDS.length]);
    if (focusLefts.length === 0) return;
    const i = focusLefts.findIndex((t) => t.id === focusLeft?.id);
    const next = focusLefts[(i + delta + focusLefts.length) % focusLefts.length];
    patchSpace(spaceKey, (s) => ({ ...s, active: next.id }));
    if (next.term) requestAnimationFrame(() => focusTerminal(next.id));
    // The tab shown already (the only one) is not shown again, which gives the keyboard.
    else if (next.id === focusLeft?.id) api.browserFocus(next.id).catch(report);
    else keysInto = next.id;
  };
  // Which side of the Input mode has the keyboard (see `typingSide`), or
  // neither while the app's other parts or another app have it.
  const [focusTyping, setFocusTyping] = useState<"left" | "right" | null>("right");
  /// ⌘K: the commands, leaving the Input mode (a todo's pages stay) on the way.
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
    unreadAtFocus.current = unreadNow();
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
      setSpaces((prev) => ({ ...prev, [key]: { lefts: ids, active: ids[saved.active] ?? ids[0] ?? null, right, pages: saved.pages, accepted: saved.accepted, rightUrls } }));
      if (lacking.length > 0) addToFocus(lacking, key);
    } else if (!spaces[key]) {
      setSpaces((prev) => ({ ...prev, [key]: newSpace(right) }));
      addToFocus(items, key);
    } else if (lacking.length > 0) addToFocus(lacking, key);
    ensureRight(key, right, rightUrls[right]);
    typeInto = rightTabId(key, right);
    setFocusTyping("right");
    setFocusMode(true);
  };
  /// Brings up a pinned page, opening its tab the first time, with its text
  /// box ready for typing.
  const showPinned = (id: string) => {
    const page = PINNED_PAGES.find((p) => p.id === id);
    if (!page) return;
    typeInto = id;
    if (!tabs.some((t) => t.id === id)) setTabs((prev) => [{ id, url: page.url, title: page.label, loading: true, nav: 0, pinned: true }, ...prev]);
    setBrowserShown(true);
    setActiveTabId(id);
  };
  const terminalTab = (sessionId: string) => tabs.find((t) => t.term?.session === sessionId);
  const showTab = (id: string) => {
    setBrowserShown(true);
    setActiveTabId(id);
  };
  const inAppTerminal: InAppTerminal | null =
    terminalTarget === "app"
      ? {
          open: (run) => {
            // herdr is attached once per herdr session; its pane is already focused.
            const attached = run.herdr ? tabs.find((t) => t.term?.herdr === run.herdr) : undefined;
            if (attached) {
              showTab(attached.id);
              return void requestAnimationFrame(() => focusTerminal(attached.id));
            }
            const id = `t${nextTab.current++}`;
            setBrowserShown(true);
            setTabs((prev) => [...prev, { id, url: "", title: run.title, loading: false, nav: 0, term: run }]);
            setActiveTabId(id);
          },
          focus: (sessionId) => {
            const tab = terminalTab(sessionId);
            if (!tab) return false;
            showTab(tab.id);
            // After the tab is shown, so its terminal is in the page.
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
    const i = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    // Closing the last tab leaves the pane open on a new tab (pinned pages aside).
    if (!rest.some((t) => !t.pinned)) setNewTab(true);
    else if (id === activeTab?.id) setActiveTabId(rest[Math.min(i, rest.length - 1)].id);
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
  const sideItems = () => [...document.querySelectorAll<HTMLElement>(".sidebar nav button, .sidebar .repo-main")];
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
      if (side) setFocusTyping(pane ? "right" : "left");
      if (side?.term) focusTerminal(side.id);
      else if (side) {
        const chat = pane && CHAT_PAGES.includes(side.kind ?? side.id);
        api.browserFocus(side.id, chat, chat ? text : undefined).catch(report);
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
    else api.browserFocus(activeTab.id, CHAT_PAGES.includes(activeTab.id)).catch(report);
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
  const typingSideRef = useRef(typingSide);
  typingSideRef.current = typingSide;
  useEffect(() => {
    let timer = 0;
    // This page has it: its fields and terminals by where they are (the
    // pane's address bar is the pane's). Nothing focused in it leaves the
    // Input mode's side to the key that is moving the typing.
    const here = () => {
      const el = document.activeElement;
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
      window.removeEventListener("focus", here);
      document.removeEventListener("focusin", here);
      window.removeEventListener("blur", lost);
      document.removeEventListener("focusout", lost);
    };
  }, []);
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
  const openCloud = (sessionId: string) =>
    cloudTarget === "desktop" ? api.openSession(sessionId, "desktop").catch(report) : openInBrowser(cloudWebUrl(sessionId));
  const openCloudRef = useRef(openCloud);
  openCloudRef.current = openCloud;
  useEffect(() => {
    const offs = [
      listen<{ tab: string; url: string; loading: boolean }>(BROWSER_URL_EVENT, ({ payload }) => {
        // A page loaded is a visit, for the address field's suggestions.
        if (!payload.loading) {
          tabUrls.set(payload.tab, payload.url);
          recordVisit(payload.url, null, true);
        }
        setTabs((prev) => prev.map((t) => (t.id === payload.tab ? { ...t, url: payload.url, loading: payload.loading } : t)));
      }),
      listen<{ tab: string; url: string }>(BROWSER_ADDRESS_EVENT, ({ payload }) => setTabUrl(payload.tab, payload.url)),
      listen<{ tab: string; title: string }>(BROWSER_TITLE_EVENT, ({ payload }) => {
        const url = tabUrls.get(payload.tab);
        if (url) recordVisit(url, payload.title, false);
        setTabs((prev) => prev.map((t) => (t.id === payload.tab ? { ...t, title: payload.title } : t)));
      }),
      // In the focus mode a page's new window goes to the left, if it may.
      listen<{ url: string }>(BROWSER_NEW_TAB_EVENT, ({ payload }) => (focusModeRef.current ? askFocusLinkRef.current(payload.url) : openRef.current(payload.url))),
      listen<{ tab: string; url: string; text: string | null }>(FOCUS_LINK_EVENT, ({ payload }) => askFocusLinkRef.current(payload.url, payload.text ?? undefined)),
      listen<{ url: string; title: string }>(ADD_INPUT_EVENT, ({ payload }) => addInputRef.current(payload.url, payload.title)),
      // The focus mode lets none of the app's own shortcuts through.
      listen(BROWSER_OPEN_NEW_TAB_EVENT, () => !focusModeRef.current && openNewTab()),
      listen<{ tab: string; delta: number }>(BROWSER_SWITCH_TAB_EVENT, ({ payload }) =>
        focusModeRef.current ? switchFocusTabRef.current(onFocusRightRef.current(payload.tab), payload.delta) : switchRef.current(payload.delta),
      ),
      listen<{ tab: string }>(BROWSER_CLOSE_TAB_EVENT, () => !focusModeRef.current && closeShownRef.current()),
      listen<{ tab: string }>(BROWSER_ARCHIVE_EVENT, () => !focusModeRef.current && archiveShownRef.current()),
      listen<{ tab: string }>(BROWSER_TO_INPUT_EVENT, () => !focusModeRef.current && toInputRef.current()),
      listen(OPEN_PALETTE_EVENT, () => paletteRef.current()),
      listen(FOCUS_EXIT_EVENT, () => setDialog("exitFocus")),
      listen<{ tab: string; text: string | null }>(FOCUS_PANE_EVENT, ({ payload }) => focusSideRef.current(true, payload.text ?? undefined)),
      // Back from the pane: nothing on this side keeps the typing, so j k work.
      listen(FOCUS_APP_EVENT, () => (focusModeRef.current ? focusSideRef.current(false) : (document.activeElement as HTMLElement | null)?.blur())),
      // The menu bar and notifications open cloud sessions as set here.
      listen<{ session_id: string }>(OPEN_CLOUD_EVENT, ({ payload }) => openCloudRef.current(payload.session_id)),
    ];
    return () => offs.forEach((off) => off.then((f) => f()));
  }, []);
  const [dragging, setDragging] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const [view, setViewState] = useState<View>(() => load(VIEW_KEY, ["todos", "inputs", "sessions", "prs", "notices"] as const, "todos"));
  const viewRef = useRef(view);
  viewRef.current = view;
  const [layout, setLayoutState] = useState<Layout>(() => load(LAYOUT_KEY, ["board", "list"] as const, "board"));
  const [groupBy, setGroupByState] = useState<GroupBy>(() => load(GROUP_KEY, ["repo", "parent"] as const, "repo"));
  const [doneRecent, setDoneRecentState] = useState<boolean>(() => load(DONE_RECENT_KEY, ["1", "0"] as const, "1") === "1");
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
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalRepo[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [limits, setLimits] = useState<Limit[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [prs, setPrs] = useState<PrLists | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  const [skillsByCwd, setSkillsByCwd] = useState<Record<string, Skill[]>>({});
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
  const setDoneRecent = (v: boolean) => {
    remember(DONE_RECENT_KEY, v ? "1" : "0");
    setDoneRecentState(v);
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
  const [panelW, setPanelWState] = useState(() => loadJson<number>(PANEL_W_KEY, PANEL_DEFAULT_W));
  const [dockW, setDockWState] = useState(() => loadJson<number>(DOCK_W_KEY, Math.max(DOCK_MIN_W, Math.round(window.innerWidth * DOCK_DEFAULT_SHARE))));
  const setPanelW = (w: number) => {
    remember(PANEL_W_KEY, String(w));
    setPanelWState(w);
  };
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
      // the address bar its own), and ⌘ only edits text.
      if (focusModeRef.current) {
        const t = e.target as HTMLElement;
        if (matches(e, "prevTab") || matches(e, "nextTab")) {
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
      const run: [Action, () => unknown][] = [
        ["archive", () => archiveShownRef.current()],
        ["toInput", () => toInputRef.current()],
        ["prevTab", () => switchRef.current(-1)],
        ["nextTab", () => switchRef.current(1)],
        // On the Input page it adds an input.
        ["newTodo", () => setDialog(viewRef.current === "inputs" ? "addInput" : "add")],
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

  // Skills depend on the folder a session starts in; fetch each folder's once.
  const skillsKey = selectedTodo?.cwd ?? "";
  useEffect(() => {
    if (!selectedTodo || skillsByCwd[skillsKey]) return;
    api.skills(skillsKey || null).then((s) => setSkillsByCwd((prev) => ({ ...prev, [skillsKey]: s })), report);
  }, [selectedTodo?.id, skillsKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const inRepo = (repos: string[] | undefined) => repoFilter === null || laneKey(repos) === repoFilter;
  // Subtasks of a Done parent are finished business; the parent stands for them.
  const doneParents = new Set(allTodos.filter((t) => t.status === "done").map((t) => t.id));
  const shownTodos = allTodos.filter((t) => t.parent_id === null || !doneParents.has(t.parent_id));
  const visibleTodos = shownTodos.filter((t) => inRepo(t.repos) && matchesFilter(t, todoFilter));
  // A Done parent without shown subtasks is a card like any other.
  const lanes = buildLanes(visibleTodos, groupBy, shownTodos);
  const repoLanes = buildLanes(shownTodos, "repo", shownTodos);
  // Free group names in use, offered beside repositories when picking.
  const groups = [...new Set(allTodos.flatMap((t) => t.repos).filter((r) => !isGithubRepo(r)))].sort();
  const allSessions = [...allTodos.flatMap(liveSessions), ...(board?.inbox ?? [])];
  const waiting = allSessions.filter((s) => s.state === "needs_input");
  const openTodoCount = allTodos.filter((t) => t.status !== "done").length;
  const colCounts = Object.fromEntries(COLUMNS.map((c) => [c.status, visibleTodos.filter((t) => t.status === c.status).length])) as Record<Status, number>;

  const selectedSession = selection?.kind === "session" && board ? sessionItemsOf(board).find((i) => i.session.session_id === selection.id) ?? null : null;

  const openTodo = (id: number) => {
    setSelection({ kind: "todo", id });
    // The panel shows issue and PR state; fetch this todo's now.
    api.syncNow(id).catch(() => {});
  };
  const goTodo = (id: number) => {
    setView("todos");
    openTodo(id);
  };
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


  const covered = dialog !== null;
  // j k / h l and the other keys of the Todo pages (todoKeys.ts).
  const todoPage = useRef<HTMLDivElement>(null);
  const [statusMenuFor, setStatusMenuFor] = useState<number | null>(null);
  const statusMenuTodo = statusMenuFor !== null ? allTodos.find((t) => t.id === statusMenuFor) : undefined;
  useTodoKeys(todoPage, layout, view === "todos" && !covered && !focusMode && !sideZone, selectedTodo !== null, {
    open: (id) => openTodo(id),
    select: openTodo,
    status: setStatusMenuFor,
    focus: (id) => {
      const todo = allTodos.find((t) => t.id === id);
      if (todo) focusTodo(todo);
    },
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
    close: () => setSelection(null),
    toggleLane,
    isCollapsed: (lane) => collapsed.has(lane),
  });
  const draggedTodo = dragging !== null ? allTodos.find((t) => t.id === dragging) : undefined;
  const reviewCount = prs?.review.length ?? 0;
  const unreadCount = board?.notifications.filter((n) => !n.read).length ?? 0;

  const nav: { key: string; label: string; icon: IconName; badge?: React.ReactNode; count?: number; on: boolean; go: () => void }[] = [
    { key: "board", label: "Todo カンバン", icon: "board", count: openTodoCount, on: view === "todos" && layout === "board", go: () => showTodos("board") },
    { key: "list", label: "Todo リスト", icon: "list", on: view === "todos" && layout === "list", go: () => showTodos("list") },
    {
      key: "sessions",
      label: "セッション",
      icon: "spark",
      count: allSessions.length,
      on: view === "sessions",
      go: () => setView("sessions"),
      badge: waiting.length > 0 && (
        <span className="pill waiting">
          <i />
          {waiting.length}
        </span>
      ),
    },
    { key: "inputs", label: "Input", icon: "import", count: allInputs.filter((i) => !i.done).length, on: view === "inputs", go: () => setView("inputs") },
    { key: "prs", label: "PR", icon: "pr", on: view === "prs", go: () => setView("prs"), badge: reviewCount > 0 && <span className="pill accent">レビュー {reviewCount}</span> },
    { key: "notices", label: "通知", icon: "bell", on: view === "notices", go: () => setView("notices"), badge: unreadCount > 0 && <span className="pill accent">{unreadCount}</span> },
  ];

  // ⌘K lists the sidebar's entries first, in its order, then the actions.
  const commands: Command[] = [
    ...nav.map((n) => ({ key: `nav:${n.key}`, label: n.label, run: n.go })),
    { key: "browser", label: browserShown ? "作業スペースを隠す" : "作業スペース", run: toggleBrowser },
    ...PINNED_PAGES.map((p) => ({ key: p.id, label: p.label, run: () => showPinned(p.id) })),
    ...savedFilters.map((f) => ({ key: `filter:${f.id}`, label: `フィルター: ${f.name}`, run: () => applyFilter(f) })),
    { key: "focus", label: "Input モード（ページを選んで左に、右に ChatGPT）", run: () => pickFocus("start") },
    { key: "jevKey", label: "Jev の API キーを設定（Input モードで開くページの判定）", run: () => setDialog("jevKey") },
    { key: "shortcuts", label: "ショートカットを見る・変える", hint: keyLabel(keyOf("help")), run: () => setDialog("keys") },
    { key: "add", label: "新しい todo", hint: "⌘N", run: () => setDialog("add") },
    { key: "addInput", label: "新しい input（読むページを追加）", run: () => setDialog("addInput") },
    ...(browserShown && activeTab && !activeTab.term && !activeTab.pinned
      ? [{ key: "toInput", label: "表示中のページを input に追加", run: toInput }]
      : []),
    { key: "import", label: "自分に割り当てられた issue を取り込む", run: () => setDialog("import") },
    { key: "quick", label: "ちょっと Claude（todo に紐づけずに起動）", run: () => setDialog("quick") },
    { key: "sync", label: "GitHub とクラウドを今すぐ同期", run: syncAll },
    ...(filterCount(todoFilter) > 0 ? [{ key: "clearFilter", label: "フィルターを外す", run: () => setTodoFilter(NO_FILTER, true) }] : []),
    { key: "newTab", label: "ブラウザで新しいタブを開く", hint: "⌘T", run: openNewTab },
    linkTarget === "app"
      ? { key: "linkDia", label: "リンクを Dia で開くようにする", run: () => setLinkTarget("dia") }
      : { key: "linkApp", label: "リンクをアプリ内のブラウザで開くようにする", run: () => setLinkTarget("app") },
  ];

  const selectedInput = selection?.kind === "input" ? board?.inputs.find((i) => i.id === selection.id) ?? null : null;
  const panel = view === "todos" && selectedTodo ? "todo" : view === "inputs" && selectedInput ? "input" : view === "sessions" && selectedSession ? "session" : null;

  return (
    <BrowserContext.Provider value={openInBrowser}>
    <BeginWebContext.Provider value={beginWeb}>
    <OpenCloudContext.Provider value={openCloud}>
    <TerminalContext.Provider value={inAppTerminal}>
      <div
        className={`app${browserShown ? " with-browser" : ""}${browserShown && !focusMode && typingSide ? ` typing-${typingSide}` : ""}${focusMode ? ` focus${focusTyping ? ` typing-${focusTyping}` : ""}` : ""}`}
        data-zone={sideZone ? "sidebar" : undefined}
        style={{ "--panel-w": `${panelW}px`, "--dock-w": `${dockW}px`, "--focus-right-w": `${focusRightW}px` } as React.CSSProperties}
      >
        <aside className="sidebar" onPointerDown={() => sideZoneRef.current && setSideZone(false)}>
          <div className="brand">
            <span className="brand-mark" />
            <span>Todo Sessions</span>
          </div>
          <button className="search" onClick={() => setDialog("palette")}>
            <Icon name="search" size={13} />
            <span className="grow ellipsis">検索・操作</span>
            <span className="kbd">⌘K</span>
          </button>
          <nav className="nav" aria-label="画面">
            {nav.map((n) => (
              <button key={n.key} className={n.on ? "on" : ""} aria-current={n.on ? "page" : undefined} onClick={n.go}>
                <Icon name={n.icon} />
                <span className="grow">{n.label}</span>
                {n.badge}
                {n.count !== undefined && <span className="muted">{n.count}</span>}
              </button>
            ))}
            <button className={browserShown ? "on" : ""} aria-pressed={browserShown} title="作業スペース（右のページとターミナル）を表示・隠す（⌘T で新しいタブ）" onClick={toggleBrowser}>
              <Icon name="globe" />
              <span className="grow">作業スペース</span>
              {paneTabs.some((t) => !t.pinned) && <span className="muted">{paneTabs.filter((t) => !t.pinned).length}</span>}
            </button>
            {PINNED_PAGES.map((p) => (
              <button key={p.id} className={browserShown && activeTab?.id === p.id ? "on" : ""} title={`${p.label} を右のペインで開く（開いたままになります）`} onClick={() => showPinned(p.id)}>
                <Icon name={p.icon} />
                <span className="grow">{p.label}</span>
              </button>
            ))}
          </nav>
          {savedFilters.length > 0 && (
            <div className="sidebar-section">
              <div className="section-title">フィルター</div>
              {savedFilters.map((f) => (
                <div key={f.id} className={`repo${view === "todos" && layout === f.layout && sameFilter(todoFilter, f.filter) ? " on" : ""}`}>
                  <button className="repo-main" title={`${f.name} で絞り込む`} onClick={() => applyFilter(f)}>
                    <Icon name={f.layout === "board" ? "board" : "list"} size={12} />
                    <span className="ellipsis grow">{f.name}</span>
                  </button>
                  <button className="ghost icon repo-gh" aria-label={`フィルター ${f.name} を消す`} title="消す" onClick={() => setSavedFilters(savedFilters.filter((x) => x.id !== f.id))}>
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="sidebar-section">
            <div className="section-title">場所</div>
            {repoLanes.map((lane) => {
              const w = lane.todos.flatMap(liveSessions).concat((board?.inbox ?? []).filter((s) => laneKey(s.repos) === lane.key)).filter((s) => s.state === "needs_input").length;
              return (
                <div key={lane.key} className={`repo${repoFilter === lane.key ? " on" : ""}`}>
                  <button className="repo-main" title={lane.key} aria-pressed={repoFilter === lane.key} onClick={() => setRepoFilter(repoFilter === lane.key ? null : lane.key)}>
                    <RepoDot repo={lane.key} />
                    <span className="ellipsis grow">{isGithubRepo(lane.key) ? repoName(lane.key) : lane.key}</span>
                    {w > 0 && <span className="pill waiting">{w}</span>}
                    <span className="muted">{lane.todos.filter((t) => t.status !== "done").length}</span>
                  </button>
                  {isGithubRepo(lane.key) && (
                    <button className="ghost icon repo-gh" aria-label={`${lane.key} を GitHub で開く`} title="GitHub で開く" onClick={() => openInBrowser(GITHUB + lane.key)}>
                      <Icon name="open" size={12} />
                    </button>
                  )}
                </div>
              );
            })}
            {repoLanes.length === 0 && <p className="muted hint">まだありません</p>}
          </div>
          <div className="sidebar-foot">
            <div className="link-target">
              <span className="muted">リンクを開く</span>
              <div className="segmented" role="group" aria-label="リンクを開く場所">
                <button className={linkTarget === "app" ? "on" : ""} aria-pressed={linkTarget === "app"} onClick={() => setLinkTarget("app")}>
                  アプリ内
                </button>
                <button className={linkTarget === "dia" ? "on" : ""} aria-pressed={linkTarget === "dia"} onClick={() => setLinkTarget("dia")}>
                  Dia
                </button>
              </div>
            </div>
            <div className="link-target">
              <span className="muted">Cloud を開く</span>
              <div className="segmented" role="group" aria-label="Cloud のセッションを開く場所">
                <button className={cloudTarget === "web" ? "on" : ""} aria-pressed={cloudTarget === "web"} onClick={() => setCloudTarget("web")}>
                  Web
                </button>
                <button className={cloudTarget === "desktop" ? "on" : ""} aria-pressed={cloudTarget === "desktop"} onClick={() => setCloudTarget("desktop")}>
                  Desktop
                </button>
              </div>
            </div>
            <div className="link-target">
              <span className="muted">ターミナル</span>
              <div className="segmented" role="group" aria-label="ローカルのセッションを動かす場所">
                <button className={terminalTarget === "ghostty" ? "on" : ""} aria-pressed={terminalTarget === "ghostty"} onClick={() => setTerminalTarget("ghostty")}>
                  Ghostty
                </button>
                <button className={terminalTarget === "app" ? "on" : ""} aria-pressed={terminalTarget === "app"} onClick={() => setTerminalTarget("app")}>
                  アプリ内
                </button>
              </div>
            </div>
            <div className="link-target">
              <span className="muted">herdr</span>
              {herdr && herdr.running.length > 0 ? (
                <select
                  className="select compact"
                  value={herdr.picked && herdr.running.includes(herdr.picked) ? herdr.picked : ""}
                  aria-label="新しいワークスペースを開く herdr のセッション"
                  title="新しいワークスペースを開く herdr のセッション"
                  onMouseDown={loadHerdr}
                  onChange={(e) => pickHerdr(e.target.value)}
                >
                  <option value="">自動（{herdr.target}）</option>
                  {herdr.running.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                <button className="ghost small" title="herdr のセッションを探し直す（止まっているときは、アプリ内のセッションはタブの中で直接動きます）" onClick={loadHerdr}>
                  停止中
                </button>
              )}
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
          {(closePrompt || error || heldNotices > 0) && (
            <div className="banners">
              {heldNotices > 0 && (
                <div className="notice" role="status">
                  <span className="grow">Input モードのあいだに通知が {heldNotices} 件ありました。</span>
                  <button className="primary small" onClick={() => (setHeldNotices(0), setView("notices"))}>
                    通知を見る
                  </button>
                  <button className="ghost icon" onClick={() => setHeldNotices(0)} aria-label="閉じる">
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
                <div className="segmented" role="group" aria-label="まとめ方">
                  {GROUPINGS.map((g) => (
                    <button key={g.key} className={groupBy === g.key ? "on" : ""} aria-pressed={groupBy === g.key} onClick={() => setGroupBy(g.key)}>
                      {g.label}
                    </button>
                  ))}
                </div>
                {repoFilter && (
                  <button className="filter on" onClick={() => setRepoFilter(null)} title="絞り込みを外す">
                    <RepoDot repo={repoFilter} />
                    {repoFilter} <Icon name="close" size={11} />
                  </button>
                )}
                <TodoFilterBar
                  filter={todoFilter}
                  version={`${layout}:${filterVersion}`}
                  places={repoLanes.map((l) => l.key)}
                  onChange={(f) => setTodoFilter(f, f === NO_FILTER)}
                  onSave={saveFilter}
                />
                <button className={`filter${todoFilter.waiting ? " on" : ""}`} aria-pressed={todoFilter.waiting} onClick={() => setTodoFilter({ ...todoFilter, waiting: !todoFilter.waiting })}>
                  入力待ちだけ
                </button>
                <button className={`filter${doneRecent ? " on" : ""}`} aria-pressed={doneRecent} onClick={() => setDoneRecent(!doneRecent)}>
                  Done は直近{DONE_RECENT}件
                </button>
                <span className="grow" />
                <button className="primary" onClick={() => setDialog("add")}>
                  <Icon name="plus" size={13} /> 新しい todo <span className="kbd">⌘N</span>
                </button>
              </header>
              <WaitingStrip sessions={waiting} report={report} />
              <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
                <div className="content" ref={todoPage}>
                  {layout === "board" && lanes.length > 0 && (
                    <div className="col-heads">
                      {COLUMNS.map((c) => (
                        <h2 key={c.status}>
                          <StatusIcon status={c.status} />
                          {c.label} <span className="muted">{colCounts[c.status]}</span>
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
                        doneRecent={doneRecent}
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
                        doneRecent={doneRecent}
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
              repoFilter={repoFilter}
              selectedId={selectedSession?.session.session_id ?? null}
              run={run}
              report={report}
              onSelect={(id) => setSelection({ kind: "session", id })}
              onOpenTodo={goTodo}
              onQuick={() => setDialog("quick")}
            />
          )}
          {view === "inputs" && board && (
            <InputsPage
              inputs={allInputs}
              resumable={new Set([...Object.keys(spaces), ...Object.keys(savedSpaces())].filter((k) => k.startsWith("i")).map((k) => Number(k.slice(1))))}
              run={run}
              onFocus={focusInput}
              onDetail={(id) => setSelection({ kind: "input", id })}
              onAdd={() => setDialog("addInput")}
            />
          )}
          {view === "notices" && board && <NoticesPage board={board} local={local} report={report} onOpenTodo={goTodo} run={run} />}
          {view === "prs" && (
            <PrsPage prs={prs} prsLoading={prsLoading} prError={prError} todos={allTodos} local={local} repoFilter={repoFilter} browserUrl={browserUrl} run={run} onRefresh={loadPrs} onOpenTodo={goTodo} />
          )}
        </main>

        {panel && (
          <div className="side">
            <Resizer label="パネルの幅" cssVar="--panel-w" width={panelW} min={PANEL_MIN_W} max={() => maxPaneWidth(browserShown ? dockW : 0)} onResize={setPanelW} />
        {panel === "todo" && selectedTodo && (
          <TodoPanel
            todo={selectedTodo}
            allTodos={allTodos}
            local={local}
            groups={groups}
            skills={skillsByCwd[skillsKey] ?? []}
            run={run}
            report={report}
            setStatus={setStatus}
            onOpenTodo={openTodo}
            onFocus={() => focusTodo(selectedTodo)}
            onClose={() => setSelection(null)}
          />
        )}
        {panel === "input" && selectedInput && (
          <InputPanel input={selectedInput} run={run} report={report} onFocus={() => focusInput(selectedInput)} onClose={() => setSelection(null)} />
        )}
        {panel === "session" && selectedSession && (
          <SessionPanel item={selectedSession} todos={allTodos} run={run} report={report} onClose={() => setSelection(null)} onOpenTodo={goTodo} />
        )}
          </div>
        )}
        {focusMode && (
          <FocusMode
            lefts={focusLefts}
            left={focusLeft}
            onSelectLeft={(id) => patchSpace(spaceKey, (s) => ({ ...s, active: id }))}
            onCloseLeft={removeFromFocus}
            onAddLeft={() => pickFocus("add")}
            asking={focusAsking}
            onAnswer={showAsking}
            onGiveUp={(id) => setAsking(focusAskingRef.current.filter((a) => a.id !== id))}
            right={focusRightTab}
            rightKind={focusRight}
            note={
              focusRight !== NOTE_TAB || noteUrl
                ? null
                : { subject: focusSubject !== null, making: noteSession !== undefined, pages: focusLefts.some((t) => !t.term), onCreate: createNote, onReset: resetNote }
            }
            onRemakeNote={focusRight === NOTE_TAB && noteUrl ? resetNote : undefined}
            covered={covered}
            report={report}
            width={focusRightW}
            onResize={setFocusRightW}
            onRight={setFocusRight}
            onAddress={setTabUrl}
            onExit={exitFocus}
          />
        )}
        {browserShown && !focusMode && (
          <aside className="browser-dock">
            <Resizer label="ブラウザの幅" cssVar="--dock-w" width={dockW} min={DOCK_MIN_W} max={() => maxPaneWidth(0)} onResize={setDockW} />
            <BrowserDock
              tabs={tabs}
              active={activeTab}
              covered={covered}
              report={report}
              onSelect={setActiveTabId}
              onPinned={showPinned}
              onArchive={() => archiveShownRef.current()}
              onClose={closeTab}
              onNewTab={openNewTab}
              onHide={() => setBrowserShown(false)}
              onOpen={openInBrowser}
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
          <AddToInputDialog
            page={toInputPage}
            inputs={allInputs.filter((i) => !i.done)}
            run={run}
            onDone={setAddedInput}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog === "addInput" && (
          <AddInputDialog
            // The page shown first, then the other tabs' pages (the pinned chats aside).
            openPages={[...(activeTab ? [activeTab] : []), ...paneTabs.filter((t) => t !== activeTab)]
              .filter((t) => !t.term && !t.pinned && /^https?:\/\//.test(t.url))
              .map((t) => ({ url: t.url, title: t.title, shown: browserShown && t === activeTab }))}
            run={run}
            onClose={() => setDialog(null)}
            onOpen={(input) => {
              setDialog(null);
              focusInput(input);
            }}
          />
        )}
        {dialog === "add" && (
          <AddTodoDialog
            local={local}
            groups={groups}
            initialRepo={repoFilter}
            run={run}
            onClose={() => setDialog(null)}
            onOpenTodo={(id) => {
              setDialog(null);
              goTodo(id);
            }}
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
              typeInto = focusRightId;
            }}
          />
        )}
        {addedInput && (
          <div className="toast" role="status">
            input に追加しました：{addedInput}
          </div>
        )}
        {dialog === "keys" && <ShortcutsDialog onClose={() => setDialog(null)} />}
        {dialog === "focusLink" && focusLink && (
          <FocusLinkDialog key={focusLink.id} asking={focusLink} onClose={() => answerAsking(false)} onOpen={() => answerAsking(true)} onJudgeAgain={judgeAgain} />
        )}
        {dialog === "jevKey" && <JevKeyDialog onClose={() => setDialog(null)} />}
        {dialog === "focusPick" && (
          <FocusPicker
            adding={focusPicking === "add"}
            terminals={paneTabs.filter((t) => t.term)}
            onClose={() => setDialog(null)}
            onPick={(item) => {
              setDialog(null);
              // A page added in the focus mode is judged like a link.
              if (focusPicking !== "add") enterFocus([item]);
              else if ("url" in item) askFocusLink(item.url);
              else addToFocus([item]);
            }}
          />
        )}
        {dialog === "palette" && <CommandPalette commands={commands} todos={allTodos} inputs={allInputs} onOpenTodo={goTodo} onOpenInput={focusInput} onClose={() => setDialog(null)} />}
      </div>
    </TerminalContext.Provider>
    </OpenCloudContext.Provider>
    </BeginWebContext.Provider>
    </BrowserContext.Provider>
  );
}
