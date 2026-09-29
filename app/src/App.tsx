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
  BROWSER_FOCUS_URL_EVENT,
  BROWSER_OPEN_NEW_TAB_EVENT,
  BROWSER_NEW_TAB_EVENT,
  OPEN_CLOUD_EVENT,
  BROWSER_TITLE_EVENT,
  BROWSER_URL_EVENT,
  CLOUD_HOME,
  cloudWebUrl,
  EFFORTS,
  isCloud,
  issueRef,
  MODELS,
  type Board,
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
} from "./api";

const REFRESH_MS = 3000;
/// The usage API answers 429 when asked often (status lines poll it too), so
/// it is asked rarely once there are numbers, which then stay on errors.
const USAGE_REFRESH_MS = 5 * 60_000;
/// Until the first numbers arrive, asked again this soon.
const USAGE_RETRY_MS = 60_000;
const PR_REFRESH_MS = 5 * 60_000;
const DETAIL_REFRESH_MS = 10_000;
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

type View = "todos" | "sessions" | "prs" | "notices";
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
const SIDEBAR_W = 232;
/// Room always left for the screen in the middle.
const MAIN_MIN_W = 320;
/// Arrow keys on a resizer move it this far.
const RESIZE_STEP = 24;

/// Widest a side pane may get, leaving the sidebar, `others` and the middle.
const maxPaneWidth = (others: number) => Math.max(PANEL_MIN_W, window.innerWidth - SIDEBAR_W - MAIN_MIN_W - others);

/// A strip on a pane's left edge; dragging it (or the arrow keys) sets the
/// pane's width.
function Resizer({ label, width, min, max, onResize }: { label: string; width: number; min: number; max: () => number; onResize: (w: number) => void }) {
  const clamp = (w: number) => Math.round(Math.min(max(), Math.max(min, w)));
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const move = (ev: PointerEvent) => onResize(clamp(width + startX - ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
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
/// parent with its subtasks, then the top-level todos without subtasks;
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
    const rank = (l: Lane) => (l.parent ? l.parent.id : Number.MAX_SAFE_INTEGER);
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
  | "up" | "down" | "chevron" | "chevronRight" | "more" | "back" | "forward" | "reload" | "bell" | "globe";

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

/// Opens `url` on GitHub in the default browser.
function openGithub(url: string, report: (e: unknown) => void) {
  api.openGithub(url).catch(report);
}

/// Issue or PR chip; the PR wins when there is one. Opens it in the browser pane.
function GhChip({ todo, report }: { todo: Todo; report: (e: unknown) => void }) {
  const openInBrowser = useContext(BrowserContext);
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
        if (openInBrowser) openInBrowser(url);
        else openGithub(url, report);
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

/// "開く" jumps to the session where it runs (its herdr pane, else Desktop);
/// the caret picks Desktop or herdr explicitly.
function OpenMenu({ session, report, primary, label = "開く" }: { session: Session; report: (e: unknown) => void; primary?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useOutsideClose(root, open, () => setOpen(false));
  const openInBrowser = useContext(BrowserContext);
  const openCloud = useContext(OpenCloudContext);
  const cloud = isCloud(session);
  const go = (target?: "desktop" | "herdr" | "web") => {
    setOpen(false);
    if (target === "web" && openInBrowser) openInBrowser(cloudWebUrl(session.session_id));
    else api.openSession(session.session_id, target === "web" ? "desktop" : target).catch(report);
  };
  const openMain = () => {
    if (cloud && openCloud) {
      setOpen(false);
      openCloud(session.session_id);
    } else go();
  };
  return (
    <span ref={root} className={`open-menu${primary ? " primary" : ""}`} onPointerDown={stop} onClick={stop}>
      <button className="open-main" title={`${sessionLabel(session)} を開く`} onClick={openMain}>
        {label}
      </button>
      <button className="open-caret" aria-label="開く場所を選ぶ" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevron" size={10} />
      </button>
      {open && (
        <span className="menu" role="menu">
          {cloud && openInBrowser && (
            <button role="menuitem" onClick={() => go("web")}>
              Web で開く（アプリ内）
            </button>
          )}
          <button role="menuitem" onClick={() => go("desktop")}>
            Claude Desktop で開く
          </button>
          {!cloud && (
            <button role="menuitem" onClick={() => go("herdr")}>
              herdr で開く（閉じていれば再開）
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
    <div ref={setNodeRef} className={`cell${isOver ? " drop-target" : ""}`}>
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
  const waiting = lane.todos.flatMap(liveSessions).filter((s) => s.state === "needs_input").length;
  const open = lane.todos.filter((t) => t.status !== "done").length;
  const [owner, name] = lane.repo && isGithubRepo(lane.repo) ? lane.repo.split(/\/(.*)/s) : [null, lane.parent?.title ?? lane.key];
  return (
    <div className="lane-head">
      <button className="lane-toggle" onClick={onToggle} aria-expanded={!collapsed} disabled={!onToggle}>
        {onToggle && <Icon name={collapsed ? "chevronRight" : "chevron"} size={12} />}
        {lane.parent ? <span className="mono muted">#{lane.parent.id}</span> : lane.repo ? <RepoDot repo={lane.repo} /> : null}
        {owner && <span className="muted">{owner}/</span>}
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
      </button>
      <span className="grow" />
      {lane.parent && (
        <button className="link-button" onClick={() => onOpenTodo(lane.parent!.id)}>
          親を開く
        </button>
      )}
      {lane.repo && isGithubRepo(lane.repo) && (
        <button className="link-button" onClick={() => openGithub(GITHUB + lane.repo, report)}>
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
    <section className={`lane${collapsed ? " collapsed" : ""}`}>
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
    <section className="list-lane">
      <LaneHeader lane={lane} collapsed={collapsed} onToggle={onToggle} onOpenTodo={onSelectTodo} report={report} />
      {!collapsed && (
        <ul className="rows">
          {todos.map((t) => {
            const urgent = urgentState(liveSessions(t));
            const direct = directSession(t);
            return (
              <li key={t.id} className={`row${t.id === selectedId ? " selected" : ""}${t.status === "done" ? " done" : ""}`} onClick={() => onSelectTodo(t.id)}>
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
          api.openLink(url).catch(report);
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
        else if (target === "terminal") await api.startTerminal(todo.id, options);
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
              {t.label}
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
}

/// The browser pane: tabs of web pages, each a webview laid over this one on
/// a placeholder that follows the layout. `covered` hides them while a dialog
/// is up, since a native webview draws above everything in the page.
const SEARCH_URL = "https://www.google.com/search?q=";
/// Pages offered on a new tab.
const START_PAGES: { label: string; url: string }[] = [
  { label: "GitHub", url: "https://github.com/" },
  { label: "GitHub の通知", url: "https://github.com/notifications" },
  { label: "Claude Code", url: CLOUD_HOME },
  { label: "ChatGPT", url: "https://chatgpt.com/" },
];

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
function BrowserDock({ tabs, active, covered, report, onSelect, onClose, onNewTab, onHide, onOpen }: {
  tabs: BrowserTab[];
  active: BrowserTab | null;
  covered: boolean;
  report: (e: unknown) => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  onHide: () => void;
  onOpen: (url: string) => void;
}) {
  return (
    <section className="browser" aria-label="ブラウザ">
      <div className="browser-tabs" role="tablist">
        {tabs.map((t) => (
          <span key={t.id} className={`browser-tab${t.id === active?.id ? " on" : ""}`}>
            <button role="tab" aria-selected={t.id === active?.id} aria-busy={t.loading} className="browser-tab-main" title={t.url} onClick={() => onSelect(t.id)}>
              {t.loading && <span className="spinner" aria-label="読み込み中" />}
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
      {active ? <TabView tab={active} covered={covered} report={report} /> : <NewTabPage onOpen={onOpen} />}
    </section>
  );
}

/// A new tab: type an address or a search, or pick a start page.
function NewTabPage({ onOpen }: { onOpen: (url: string) => void }) {
  return (
    <>
      <div className="browser-bar">
        <input
          autoFocus
          className="url mono"
          placeholder="URL か検索したい言葉を入力して Enter"
          aria-label="URL か検索したい言葉"
          onKeyDown={(e) => {
            const url = isEnter(e) ? addressToUrl(e.currentTarget.value) : null;
            if (url) onOpen(url);
          }}
        />
      </div>
      <div className="new-tab">
        {START_PAGES.map((p) => (
          <button key={p.url} onClick={() => onOpen(p.url)}>
            {p.label}
            <span className="muted mono">{hostOf(p.url)}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/// One tab's page: its webview laid over a placeholder that follows the
/// layout. `covered` hides it while a dialog is up, since a native webview
/// draws above everything in the page.
function TabView({ tab: active, covered, report }: { tab: BrowserTab; covered: boolean; report: (e: unknown) => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const rect = () => {
    const r = slot.current!.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };
  const navigate = (to: string) => api.browserOpen(active.id, to, rect()).catch(report);
  // Switching tabs or coming back from under a dialog shows the page the tab
  // is on; the backend leaves a tab alone when it already shows that URL.
  useEffect(() => {
    if (covered) api.browserHide().catch(report);
    else navigate(active.url);
  }, [active.id, active.nav, covered]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (covered || !slot.current) return;
    const follow = () => api.browserBounds(rect()).catch(() => {});
    const ro = new ResizeObserver(follow);
    ro.observe(slot.current);
    window.addEventListener("resize", follow);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", follow);
    };
  }, [covered]);
  useEffect(() => () => void api.browserHide().catch(() => {}), []);
  // ⌘L edits the address and ⌘R reloads, as in a browser; a script in the
  // page sends ⌘L here too when the page has focus.
  const address = useRef<HTMLInputElement>(null);
  const tabId = useRef(active.id);
  tabId.current = active.id;
  useEffect(() => {
    const focusAddress = () => {
      address.current?.focus();
      address.current?.select();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === "r") {
        e.preventDefault();
        api.browserGo(tabId.current, "reload").catch(report);
      } else if (key === "l") {
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
        <input
          ref={address}
          key={`${active.id}:${active.url}`}
          className="url mono"
          defaultValue={active.url}
          aria-label="URL（⌘L で編集）"
          title="⌘L で編集、Enter で移動"
          onKeyDown={(e) => {
            const url = isEnter(e) ? addressToUrl(e.currentTarget.value) : null;
            if (url) navigate(url);
          }}
        />
        <button className="ghost small" title="このページを Dia で開く" onClick={() => api.openInDia(active.url).catch(report)}>
          Dia で開く
        </button>
      </div>
      <div className={`load-bar${active.loading ? " on" : ""}`} aria-hidden="true" />
      <div ref={slot} className="browser-slot">
        {covered && <span className="muted">ダイアログを閉じると表示に戻ります</span>}
      </div>
    </>
  );
}

function TodoPanel({ todo, allTodos, local, groups, skills, run, report, setStatus, onOpenTodo, onClose }: {
  todo: Todo;
  allTodos: Todo[];
  local: LocalRepo[];
  groups: string[];
  skills: Skill[];
  run: (f: () => Promise<unknown>) => void;
  report: (e: unknown) => void;
  setStatus: (todo: Todo, status: Status) => void;
  onOpenTodo: (id: number) => void;
  onClose: () => void;
}) {
  const openInBrowser = useContext(BrowserContext);
  const browse = (url: string) => (openInBrowser ? openInBrowser(url) : openGithub(url, report));
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
        {gh && (
          <button className="ghost icon" aria-label="GitHub で開く" title={gh} onClick={() => openGithub(gh, report)}>
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
              <li key={l.id} className="attachment" title={l.url} onClick={() => api.openLink(l.url).catch(report)}>
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
        <button onClick={onQuick} title="todo に紐づけずに herdr でホームフォルダの claude を開く">
          <Icon name="spark" size={13} /> ちょっと Claude
        </button>
      </header>
      <div className="content">
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
          </div>
          {rows.length === 0 && <p className="muted empty">該当するセッションはありません。</p>}
          <ul className="rows">
            {rows.map(({ session: s, todo }) => (
              <li key={s.session_id} className={`row sessions-grid${s.session_id === selectedId ? " selected" : ""}${s.state === "ended" ? " done" : ""}`} onClick={() => onSelect(s.session_id)}>
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
            </>
          ) : (
            <>
              <button className="primary grow" onClick={() => api.openSession(s.session_id, "herdr").catch(report)}>
                herdr で開く
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
        <span className="menu" role="menu">
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

type PrFilter = "all" | "review" | "mine";
type PrRow = Pr & { kind: "review" | "mine" };

function PrsPage({ prs, prError, todos, local, repoFilter, browserUrl, run, onRefresh, onOpenTodo }: {
  prs: PrLists | null;
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
  const beginWeb = useContext(BeginWebContext);
  // PRs whose review session is being started, so their button shows it.
  const [starting, setStarting] = useState<Set<string>>(new Set());
  const mark = (url: string, on: boolean) =>
    setStarting((prev) => {
      const next = new Set(prev);
      if (on) next.add(url);
      else next.delete(url);
      return next;
    });
  const startReview = (p: Pr, submit: ReviewSubmit) => {
    if (starting.has(p.url)) return;
    mark(p.url, true);
    run(async () => {
      const finish = reviewRunner === "web" ? beginWeb?.() : undefined;
      try {
        const todo = todoOf(p) ?? (await makeTodo(p, `レビュー: ${p.title}`));
        await api.updateTodo(todo.id, { prompt: reviewPrompt(p.url, submit) });
        if (reviewRunner === "desktop") await api.startDesktop(todo.id);
        else if (reviewRunner === "terminal") await api.startTerminal(todo.id);
        else finish?.(await api.startCloud(todo.id, undefined, reviewRunner === "cloud"));
      } catch (e) {
        finish?.(null);
        throw e;
      } finally {
        mark(p.url, false);
      }
    });
  };
  const sections: { key: "review" | "mine"; title: string; hint: string; rows: PrRow[] }[] = [
    { key: "review", title: "レビュー依頼", hint: "自分にレビューが来ている PR", rows: review },
    { key: "mine", title: "自分の PR", hint: "自分が出している open の PR", rows: mine },
  ];
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
          <option value="terminal">/review は herdr</option>
        </select>
        <button className="ghost icon" aria-label="PR を取り直す" title="PR を取り直す" onClick={onRefresh}>
          <Icon name="sync" size={14} />
        </button>
      </header>
      <div className="content flush">
        {prError && <p className="error-text pad">{prError}</p>}
        {!prs && !prError && <p className="muted pad">gh で取得しています…</p>}
        {sections
          .filter((sec) => filter === "all" || filter === sec.key)
          .map((sec) => (
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
                    <li key={p.url} className={`row pr-row${browserUrl === p.url ? " selected" : ""}`} onClick={() => openInBrowser?.(p.url)}>
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
};

/// Every notification the app posted, unread ones marked; opening one reads it.
function NoticesPage({ board, report, onOpenTodo, run }: {
  board: Board;
  report: (e: unknown) => void;
  onOpenTodo: (id: number) => void;
  run: (f: () => Promise<unknown>) => void;
}) {
  // Unread first: that is what the page is opened for.
  const [unreadOnly, setUnreadOnly] = useState(true);
  const openCloud = useContext(OpenCloudContext);
  const unread = board.notifications.filter((n) => !n.read).length;
  const rows = unreadOnly ? board.notifications.filter((n) => !n.read) : board.notifications;
  const todoOf = (n: Notice) => board.todos.find((t) => t.id === n.todo_id);
  const read = (n: Notice) => !n.read && run(() => api.readNotifications(n.id));
  return (
    <>
      <header className="toolbar">
        <h1>通知</h1>
        <div className="segmented" role="group" aria-label="絞り込み">
          <button className={unreadOnly ? "" : "on"} aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>
            すべて
          </button>
          <button className={unreadOnly ? "on" : ""} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>
            未読 {unread}
          </button>
        </div>
        <span className="grow" />
        <button disabled={unread === 0} onClick={() => run(() => api.readNotifications())}>
          <Icon name="check" size={13} /> すべて既読にする
        </button>
      </header>
      <div className="content">
        {rows.length === 0 && <p className="muted empty">{unreadOnly ? "未読の通知はありません。" : "まだ通知はありません。セッションの作業が終わるか入力待ちになると、ここに残ります。"}</p>}
        <ul className="rows">
          {rows.map((n) => {
            const todo = todoOf(n);
            return (
              <li key={n.id} className={`row notice-row${n.read ? " read" : ""}`} onClick={() => (read(n), todo && onOpenTodo(todo.id))}>
                <span className={`unread-dot${n.read ? "" : " on"}`} aria-label={n.read ? "既読" : "未読"} />
                <span className={`state ${n.kind === "needs_input" ? "state-needs_input" : "state-running"}`}>
                  <i />
                  {NOTICE_LABEL[n.kind]}
                </span>
                <span className="row-title">{n.title}</span>
                {todo && <span className="tag ellipsis notice-todo">#{todo.id} {todo.title}</span>}
                <span className="muted when">{ago(n.created_at)}</span>
                <button
                  className="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    read(n);
                    if (n.session_id.startsWith("cse_") && openCloud) openCloud(n.session_id);
                    else api.openSession(n.session_id).catch(report);
                  }}
                >
                  開く
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
  const start = () =>
    run(async () => {
      await api.quickClaude(prompt);
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
            herdr で起動
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

/// ⌘K: the actions that used to crowd the sidebar, the screens, and a jump to any todo.
function CommandPalette({ commands, todos, onOpenTodo, onClose }: { commands: Command[]; todos: Todo[]; onOpenTodo: (id: number) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const q = query.trim().toLowerCase();
  const items: Command[] = [
    ...commands.filter((c) => c.label.toLowerCase().includes(q)),
    ...(q
      ? todos
          .filter((t) => t.title.toLowerCase().includes(q) || `#${t.id}` === q || String(t.id) === q)
          .slice(0, 20)
          .map((t) => ({ key: `todo:${t.id}`, label: `#${t.id} ${t.title}`, hint: t.status, run: () => onOpenTodo(t.id) }))
      : []),
  ];
  useEffect(() => setActive(0), [query]);
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
          placeholder="操作を選ぶ、または todo を検索"
          aria-label="操作を選ぶ、または todo を検索"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
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
        <ul role="listbox" className="palette-list">
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

type Selection = { kind: "todo"; id: number } | { kind: "session"; id: string } | null;
type DialogKind = "add" | "import" | "quick" | "palette" | null;

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
  const activeTab = newTab ? null : (tabs.find((t) => t.id === activeTabId) ?? tabs[tabs.length - 1] ?? null);
  const browserUrl = browserShown ? (activeTab?.url ?? null) : null;
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
  const openInBrowser = (url: string) => {
    if (linkTarget === "dia") {
      api.openInDia(url).catch(report);
      return;
    }
    setBrowserShown(true);
    const open = tabs.find((t) => sameTarget(t.url, url));
    if (open) return setActiveTabId(open.id);
    const id = `t${nextTab.current++}`;
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
  const closeTab = (id: string) => {
    api.browserClose(id).catch(report);
    const i = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    // Closing the last tab leaves the pane open on a new tab.
    if (rest.length === 0) setNewTab(true);
    else if (id === activeTab?.id) setActiveTabId(rest[Math.min(i, rest.length - 1)].id);
  };
  // Pages report where they went and what they are called; links they open in
  // a new window arrive as new tabs.
  const openRef = useRef(openInBrowser);
  openRef.current = openInBrowser;
  const openCloud = (sessionId: string) =>
    cloudTarget === "desktop" ? api.openSession(sessionId, "desktop").catch(report) : openInBrowser(cloudWebUrl(sessionId));
  const openCloudRef = useRef(openCloud);
  openCloudRef.current = openCloud;
  useEffect(() => {
    const offs = [
      listen<{ tab: string; url: string; loading: boolean }>(BROWSER_URL_EVENT, ({ payload }) =>
        setTabs((prev) => prev.map((t) => (t.id === payload.tab ? { ...t, url: payload.url, loading: payload.loading } : t))),
      ),
      listen<{ tab: string; title: string }>(BROWSER_TITLE_EVENT, ({ payload }) => setTabs((prev) => prev.map((t) => (t.id === payload.tab ? { ...t, title: payload.title } : t)))),
      listen<{ url: string }>(BROWSER_NEW_TAB_EVENT, ({ payload }) => openRef.current(payload.url)),
      listen(BROWSER_OPEN_NEW_TAB_EVENT, () => openNewTab()),
      // The menu bar and notifications open cloud sessions as set here.
      listen<{ session_id: string }>(OPEN_CLOUD_EVENT, ({ payload }) => openCloudRef.current(payload.session_id)),
    ];
    return () => offs.forEach((off) => off.then((f) => f()));
  }, []);
  const [dragging, setDragging] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [view, setViewState] = useState<View>(() => load(VIEW_KEY, ["todos", "sessions", "prs", "notices"] as const, "todos"));
  const [layout, setLayoutState] = useState<Layout>(() => load(LAYOUT_KEY, ["board", "list"] as const, "board"));
  const [groupBy, setGroupByState] = useState<GroupBy>(() => load(GROUP_KEY, ["repo", "parent"] as const, "repo"));
  const [doneRecent, setDoneRecentState] = useState<boolean>(() => load(DONE_RECENT_KEY, ["1", "0"] as const, "1") === "1");
  const [waitingOnly, setWaitingOnly] = useState(false);
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalRepo[]>([]);
  // The no-repository lane starts folded; it held the old backlog page.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(loadJson<string[]>(COLLAPSED_KEY, [NO_REPO_LANE])));
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
  const loadPrs = useCallback(() => {
    api.ghPrs().then(
      (p) => (setPrs(p), setPrError(null)),
      (e) => setPrError(String(e)),
    );
  }, []);

  useEffect(() => {
    refresh();
    api.localRepos().then(setLocal, () => setLocal([]));
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

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
        .finally(() => (timer = setTimeout(load, got ? USAGE_REFRESH_MS : USAGE_RETRY_MS)));
    load();
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    loadPrs();
    const t = setInterval(loadPrs, PR_REFRESH_MS);
    return () => clearInterval(t);
  }, [loadPrs]);

  // Coming back to the window is when fresh GitHub and cloud state matters.
  useEffect(() => {
    const onFocus = () => api.syncNow().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // ⌘N adds a todo, ⌘K opens the commands and ⌘T a browser tab, from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === "n" || k === "k") {
        e.preventDefault();
        setDialog(k === "n" ? "add" : "palette");
      } else if (k === "t") {
        e.preventDefault();
        openNewTab();
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
  const visibleTodos = allTodos.filter((t) => inRepo(t.repos) && (!waitingOnly || liveSessions(t).some((s) => s.state === "needs_input")));
  const lanes = buildLanes(visibleTodos, groupBy, allTodos);
  const repoLanes = buildLanes(allTodos, "repo", allTodos);
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

  const commands: Command[] = [
    { key: "add", label: "新しい todo", hint: "⌘N", run: () => setDialog("add") },
    { key: "import", label: "自分に割り当てられた issue を取り込む", run: () => setDialog("import") },
    { key: "quick", label: "ちょっと Claude（todo に紐づけずに起動）", run: () => setDialog("quick") },
    { key: "sync", label: "GitHub とクラウドを今すぐ同期", run: syncAll },
    { key: "todos", label: "Todo を表示", run: () => setView("todos") },
    { key: "sessions", label: "セッションを表示", run: () => setView("sessions") },
    { key: "prs", label: "PR を表示", run: () => setView("prs") },
    { key: "notices", label: "通知を表示", run: () => setView("notices") },
    { key: "newTab", label: "ブラウザで新しいタブを開く", hint: "⌘T", run: openNewTab },
    { key: "browser", label: browserShown ? "ブラウザを隠す" : "ブラウザを表示", run: toggleBrowser },
    linkTarget === "app"
      ? { key: "linkDia", label: "リンクを Dia で開くようにする", run: () => setLinkTarget("dia") }
      : { key: "linkApp", label: "リンクをアプリ内のブラウザで開くようにする", run: () => setLinkTarget("app") },
  ];

  const covered = dialog !== null;
  const draggedTodo = dragging !== null ? allTodos.find((t) => t.id === dragging) : undefined;
  const reviewCount = prs?.review.length ?? 0;
  const unreadCount = board?.notifications.filter((n) => !n.read).length ?? 0;

  const nav: { key: View; label: string; icon: IconName; badge?: React.ReactNode; count?: number }[] = [
    { key: "todos", label: "Todo", icon: "board", count: openTodoCount },
    {
      key: "sessions",
      label: "セッション",
      icon: "spark",
      count: allSessions.length,
      badge: waiting.length > 0 && (
        <span className="pill waiting">
          <i />
          {waiting.length}
        </span>
      ),
    },
    { key: "prs", label: "PR", icon: "pr", badge: reviewCount > 0 && <span className="pill accent">レビュー {reviewCount}</span> },
    { key: "notices", label: "通知", icon: "bell", badge: unreadCount > 0 && <span className="pill accent">未読 {unreadCount}</span> },
  ];

  const panel = view === "todos" && selectedTodo ? "todo" : view === "sessions" && selectedSession ? "session" : null;

  return (
    <BrowserContext.Provider value={openInBrowser}>
    <BeginWebContext.Provider value={beginWeb}>
    <OpenCloudContext.Provider value={openCloud}>
      <div className={`app${browserShown ? " with-browser" : ""}`} style={{ "--panel-w": `${panelW}px`, "--dock-w": `${dockW}px` } as React.CSSProperties}>
        <aside className="sidebar">
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
              <button key={n.key} className={view === n.key ? "on" : ""} aria-current={view === n.key ? "page" : undefined} onClick={() => setView(n.key)}>
                <Icon name={n.icon} />
                <span className="grow">{n.label}</span>
                {n.badge}
                {n.count !== undefined && <span className="muted">{n.count}</span>}
              </button>
            ))}
            <button className={browserShown ? "on" : ""} aria-pressed={browserShown} title="ブラウザを表示・隠す（⌘T で新しいタブ）" onClick={toggleBrowser}>
              <Icon name="globe" />
              <span className="grow">ブラウザ</span>
              {tabs.length > 0 && <span className="muted">{tabs.length}</span>}
            </button>
          </nav>
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
                    <button className="ghost icon repo-gh" aria-label={`${lane.key} を GitHub で開く`} title="GitHub で開く" onClick={() => openGithub(GITHUB + lane.key, report)}>
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
                <button className="ghost small" title="herdr のセッションを探し直す" onClick={loadHerdr}>
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
          {(closePrompt || error) && (
            <div className="banners">
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
                <div className="segmented" role="group" aria-label="表示">
                  <button className={layout === "board" ? "on" : ""} aria-pressed={layout === "board"} onClick={() => setLayout("board")}>
                    ボード
                  </button>
                  <button className={layout === "list" ? "on" : ""} aria-pressed={layout === "list"} onClick={() => setLayout("list")}>
                    リスト
                  </button>
                </div>
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
                <button className={`filter${waitingOnly ? " on" : ""}`} aria-pressed={waitingOnly} onClick={() => setWaitingOnly((v) => !v)}>
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
                <div className="content">
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
                      {waitingOnly ? "入力待ちの todo はありません。" : "表示できる todo がありません。⌘N で追加するか、⌘K から issue を取り込めます。"}
                    </p>
                  )}
                </div>
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
          {view === "notices" && board && <NoticesPage board={board} report={report} onOpenTodo={goTodo} run={run} />}
          {view === "prs" && (
            <PrsPage prs={prs} prError={prError} todos={allTodos} local={local} repoFilter={repoFilter} browserUrl={browserUrl} run={run} onRefresh={loadPrs} onOpenTodo={goTodo} />
          )}
        </main>

        {panel && (
          <div className="side">
            <Resizer label="パネルの幅" width={panelW} min={PANEL_MIN_W} max={() => maxPaneWidth(browserShown ? dockW : 0)} onResize={setPanelW} />
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
            onClose={() => setSelection(null)}
          />
        )}
        {panel === "session" && selectedSession && (
          <SessionPanel item={selectedSession} todos={allTodos} run={run} report={report} onClose={() => setSelection(null)} onOpenTodo={goTodo} />
        )}
          </div>
        )}
        {browserShown && (
          <aside className="browser-dock">
            <Resizer label="ブラウザの幅" width={dockW} min={DOCK_MIN_W} max={() => maxPaneWidth(0)} onResize={setDockW} />
            <BrowserDock
              tabs={tabs}
              active={activeTab}
              covered={covered}
              report={report}
              onSelect={setActiveTabId}
              onClose={closeTab}
              onNewTab={openNewTab}
              onHide={() => setBrowserShown(false)}
              onOpen={openInBrowser}
            />
          </aside>
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
        {dialog === "palette" && <CommandPalette commands={commands} todos={allTodos} onOpenTodo={goTodo} onClose={() => setDialog(null)} />}
      </div>
    </OpenCloudContext.Provider>
    </BeginWebContext.Provider>
    </BrowserContext.Provider>
  );
}
