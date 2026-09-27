import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  isCloud,
  issueRef,
  type Board,
  type Issue,
  type Kind,
  type LocalRepo,
  type PrState,
  type Runner,
  type Session,
  type SessionState,
  type Status,
  type Todo,
} from "./api";

const REFRESH_MS = 3000;
/// Pointer must move this far before a click turns into a drag.
const DRAG_DISTANCE_PX = 6;
const VIEW_KEY = "view";
const COLLAPSED_KEY = "collapsedLanes";
const HIDE_DONE_KEY = "hideDone";

type View = "board" | "list" | "backlog" | "inbox" | "queue";
const VIEWS: { key: View; label: string }[] = [
  { key: "board", label: "ボード" },
  { key: "list", label: "リスト" },
  { key: "backlog", label: "バックログ" },
  { key: "inbox", label: "受信箱" },
  { key: "queue", label: "キュー" },
];

const KINDS: { key: Kind; label: string }[] = [
  { key: "implementation", label: "実装" },
  { key: "research", label: "調査" },
];

const RUNNER_LABEL: Record<Runner, string> = {
  auto: "自動（Cloud 優先）",
  cloud: "Cloud",
  local: "Local（herdr）",
};

type StateFilter = "all" | "needs_input" | "running";
const STATE_FILTERS: { key: StateFilter; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "needs_input", label: "入力待ち" },
  { key: "running", label: "実行中" },
];

/// Cards sit inside columns, so a point is inside both. Sessions only drop
/// onto cards and todos only onto columns. The point is the centre of the
/// dragged item rather than the pointer, whose coordinates did not match the
/// droppables inside the Tauri webview.
const collision: CollisionDetection = ({ active, collisionRect, droppableRects, droppableContainers }) => {
  const want = String(active.id).startsWith("session:") ? "card:" : "col:";
  const x = collisionRect.left + collisionRect.width / 2;
  const y = collisionRect.top + collisionRect.height / 2;
  return droppableContainers
    .filter((c) => {
      const r = droppableRects.get(c.id);
      return String(c.id).startsWith(want) && r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    })
    .map((c) => ({ id: c.id }));
};

/// Todos start here, unattached to any repository, and move once a repo is picked.
const BACKLOG_LANE = "バックログ";
const MULTI_LANE = "複数リポジトリ";

/// Lane a todo or session belongs to: its one repo, the shared multi-repo
/// lane when it spans several, or the backlog when none is known.
function laneKey(repos: string[] | undefined): string {
  if (!repos || repos.length === 0) return BACKLOG_LANE;
  return repos.length === 1 ? repos[0] : MULTI_LANE;
}

/// "Atrae/wevox-rest-bff" → "wevox-rest-bff" for compact tags.
const repoName = (repo: string) => repo.split("/").pop() ?? repo;

/// A stable hue per repository for its dot in the sidebar and lane headers.
function repoHue(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

interface Lane {
  key: string;
  todos: Todo[];
  inbox: Session[];
}

/// One lane per group or repository, groups first, the multi-repo lane last;
/// the backlog has its own page.
function buildLanes(board: Board): Lane[] {
  const lanes = new Map<string, Lane>();
  const lane = (repos: string[] | undefined) => {
    const key = laneKey(repos);
    let l = lanes.get(key);
    if (!l) lanes.set(key, (l = { key, todos: [], inbox: [] }));
    return l;
  };
  for (const t of board.todos) lane(t.repos).todos.push(t);
  for (const s of board.inbox) lane(s.repos).inbox.push(s);
  lanes.delete(BACKLOG_LANE);
  // Free groups ("調査") first, then repositories, the multi-repo lane last.
  const rank = (key: string) => (key === MULTI_LANE ? 2 : key.includes("/") ? 1 : 0);
  return [...lanes.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key, "en", { sensitivity: "base" }));
}

function loadView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return VIEWS.some((x) => x.key === v) ? (v as View) : "board";
  } catch {
    return "board";
  }
}

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function loadHideDone(): boolean {
  try {
    return localStorage.getItem(HIDE_DONE_KEY) === "1";
  } catch {
    return false;
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

const COLUMNS: { status: Status; label: string }[] = [
  { status: "todo", label: "Todo" },
  { status: "doing", label: "Doing" },
  { status: "done", label: "Done" },
];

const STATE_LABEL: Record<SessionState, string> = {
  running: "実行中",
  needs_input: "入力待ち",
  idle: "待機中",
  ended: "終了",
};

const PR_LABEL: Record<PrState, string> = {
  draft: "Draft",
  open: "PR open",
  review_requested: "レビュー待ち",
  changes_requested: "修正依頼",
  approved: "Approve 済み",
  merged: "マージ済み",
  closed: "PR closed",
};

/// Issue and PR badges; clicking one opens it on GitHub.
function GhBadges({ todo }: { todo: Todo }) {
  const go = (url: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    api.openGithub(url).catch(() => {});
  };
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <>
      {todo.issue_url && (
        <button className={`gh gh-issue-${todo.issue_state ?? "open"}`} title={todo.issue_url} onPointerDown={stop} onClick={go(todo.issue_url)}>
          issue {todo.issue_state ?? ""} <Icon name="open" />
        </button>
      )}
      {todo.pr_url && (
        <button className={`gh gh-pr-${todo.pr_state ?? "open"}`} title={todo.pr_url} onPointerDown={stop} onClick={go(todo.pr_url)}>
          {todo.pr_state ? PR_LABEL[todo.pr_state] : "PR"} <Icon name="open" />
        </button>
      )}
    </>
  );
}

/// Order badges on a card: the state that needs the user comes first.
const STATE_ORDER: SessionState[] = ["needs_input", "running", "idle"];

/// Status order for the list: what is in progress first, done last.
const STATUS_RANK: Record<Status, number> = { doing: 0, todo: 1, done: 2 };

function sessionLabel(s: Session) {
  return s.title ?? s.session_id.slice(0, 12);
}

function basename(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/// One obvious session to jump to: the only live one, or the only one at all.
function directSession(todo: Todo): Session | null {
  const live = todo.sessions.filter((s) => s.state !== "ended");
  return live.length === 1 ? live[0] : todo.sessions.length === 1 ? todo.sessions[0] : null;
}

type IconName = "board" | "list" | "backlog" | "inbox" | "queue" | "plus" | "import" | "close" | "open" | "up" | "down";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    board: "M4 4h6v16H4zM14 4h6v9h-6z",
    list: "M4 6h16M4 12h16M4 18h10",
    backlog: "M4 7h16M4 12h10M4 17h6",
    inbox: "M3 13l2-8h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h5l2 3h4l2-3h5",
    queue: "M5 6l4 3-4 3zM12 7h8M12 12h8M5 17h15",
    up: "M6 15l6-6 6 6",
    down: "M6 9l6 6 6-6",
    plus: "M12 5v14M5 12h14",
    import: "M12 4v11M7 10l5 5 5-5M4 19h16",
    close: "M6 6l12 12M18 6L6 18",
    open: "M7 17L17 7M9 7h8v8",
  };
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
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

function KindTag({ session }: { session: Session }) {
  return <span className="tag">{isCloud(session) ? "cloud" : "local"}</span>;
}

function RepoDot({ repo }: { repo: string }) {
  return <span className="repo-dot" style={{ background: `hsl(${repoHue(repo)} 80% 65%)` }} />;
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
  // The panel is portaled to the body so scrolling parents (drawer, dialog) cannot clip it.
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const r = root.current.getBoundingClientRect();
    setRect({ top: r.bottom + 4, left: r.left, width: r.width });
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
    <div ref={root} className="combo" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={`combo-button${value ? "" : " placeholder"}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        {value ? (
          <>
            <RepoDot repo={value} />
            <span className="ellipsis">{value}</span>
          </>
        ) : (
          <span className="ellipsis">{placeholder}</span>
        )}
        <span className="combo-caret">▾</span>
      </button>
      {open &&
        rect &&
        createPortal(
        <div ref={panel} className="combo-panel glass" style={{ top: rect.top, left: rect.left, width: rect.width }} onClick={(e) => e.stopPropagation()}>
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
              } else if (e.key === "Enter") {
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
                className={`combo-item${i === active ? " active" : ""}${c.kind === "new" ? " new" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
              >
                {c.kind === "new" ? <Icon name="plus" /> : <RepoDot repo={c.key} />}
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

/// Cloud sessions open in Desktop; local ones offer Desktop or their herdr pane.
function OpenButton({ session, run, primary }: { session: Session; run: (f: () => Promise<unknown>) => void; primary?: boolean }) {
  const open = (target?: "desktop" | "herdr") => (e: React.MouseEvent) => {
    e.stopPropagation();
    run(() => api.openSession(session.session_id, target));
  };
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  if (isCloud(session)) {
    return (
      <button className={`open${primary ? " primary" : ""}`} title={`${sessionLabel(session)} を開く`} onPointerDown={stop} onClick={open("desktop")}>
        開く <Icon name="open" />
      </button>
    );
  }
  return (
    <span className="open-pair" onPointerDown={stop}>
      <button className={`open${primary ? " primary" : ""}`} title="Claude Desktop で開く" onClick={open("desktop")}>
        Desktop
      </button>
      <button className={`open${primary ? " primary" : ""}`} title="herdr の pane に移動" onClick={open("herdr")}>
        herdr
      </button>
    </span>
  );
}

function TodoCard({ todo, selected, onSelect, run }: {
  todo: Todo;
  selected: boolean;
  onSelect: () => void;
  run: (f: () => Promise<unknown>) => void;
}) {
  const drag = useDraggable({ id: `todo:${todo.id}` });
  const drop = useDroppable({ id: `card:${todo.id}` });
  const live = todo.sessions.filter((s) => s.state !== "ended");
  const states = new Set(live.map((s) => s.state));
  const direct = directSession(todo);
  const ref = issueRef(todo.issue_url);
  const tags = todo.repos.length > 0 ? todo.repos.map(repoName) : todo.cwd ? [basename(todo.cwd)] : [];
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...drag.listeners}
      {...drag.attributes}
      className={`card${selected ? " selected" : ""}${drop.isOver ? " drop-target" : ""}${drag.isDragging ? " dragging" : ""}${states.has("needs_input") ? " waiting" : ""}`}
      onClick={onSelect}
    >
      <div className="card-head">
        <span className="mono muted">{ref ?? `#${todo.id}`}</span>
        <span className="muted">{ago(todo.updated_at)}</span>
      </div>
      <div className="card-title">{todo.title}</div>
      <div className="card-meta">
        {todo.kind === "research" && <span className="tag research">調査</span>}
        {todo.queue_runner && <span className={`tag queued${todo.queue_error ? " failed" : ""}`}>{todo.queue_error ? "起動失敗" : "キュー"}</span>}
        <GhBadges todo={todo} />
        {STATE_ORDER.filter((st) => states.has(st)).map((st) => (
          <StateBadge key={st} state={st} />
        ))}
        {tags.map((t) => (
          <span key={t} className="tag" title={todo.repos.join(", ")}>
            {t}
          </span>
        ))}
        {live.length > 1 && <span className="muted">{live.length} sessions</span>}
        {direct && <OpenButton session={direct} run={run} primary={states.has("needs_input")} />}
      </div>
    </div>
  );
}

function LaneColumn({ status, laneKey, todos, selectedId, onSelect, run }: {
  status: Status;
  laneKey: string;
  todos: Todo[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  run: (f: () => Promise<unknown>) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}:${laneKey}` });
  return (
    <div ref={setNodeRef} className={`cell${isOver ? " drop-target" : ""}`}>
      {todos.map((t) => (
        <TodoCard key={t.id} todo={t} selected={t.id === selectedId} onSelect={() => onSelect(t.id)} run={run} />
      ))}
    </div>
  );
}

function InboxItem({ session, selected, onSelect }: { session: Session; selected: boolean; onSelect: () => void }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: `session:${session.session_id}` });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`card inbox-item${selected ? " selected" : ""}${isDragging ? " dragging" : ""}`}
      onClick={onSelect}
    >
      <div className="card-head">
        <KindTag session={session} />
        <span className="muted">{ago(session.state_at)}</span>
      </div>
      <div className="card-title">{sessionLabel(session)}</div>
      <div className="card-meta">
        <StateBadge state={session.state} />
        {(session.repos ?? []).length === 0 && <span className="muted ellipsis">{basename(session.cwd)}</span>}
      </div>
    </div>
  );
}

function LaneHeader({ lane, collapsed, onToggle }: { lane: Lane; collapsed?: boolean; onToggle?: () => void }) {
  const [owner, name] = lane.key.includes("/") ? lane.key.split(/\/(.*)/s) : [null, lane.key];
  const waiting = lane.todos.flatMap((t) => t.sessions).concat(lane.inbox).filter((s) => s.state === "needs_input").length;
  const body = (
    <>
      {onToggle && <span className="chevron">{collapsed ? "▸" : "▾"}</span>}
      <RepoDot repo={lane.key} />
      {owner && <span className="muted">{owner}/</span>}
      <span className="lane-name">{name}</span>
      {lane.todos.length > 0 && <span className="count">{lane.todos.length}</span>}
      {lane.inbox.length > 0 && <span className="muted">受信箱 {lane.inbox.length}</span>}
      {waiting > 0 && (
        <span className="pill waiting">
          <i />
          入力待ち {waiting}
        </span>
      )}
    </>
  );
  return onToggle ? (
    <button className="lane-head" onClick={onToggle} aria-expanded={!collapsed}>
      {body}
    </button>
  ) : (
    <div className="lane-head">{body}</div>
  );
}

function LaneView({ lane, collapsed, onToggle, selectedId, selectedSessionId, onSelectTodo, onSelectSession, run }: {
  lane: Lane;
  collapsed: boolean;
  onToggle: () => void;
  selectedId: number | null;
  selectedSessionId: string | null;
  onSelectTodo: (id: number) => void;
  onSelectSession: (id: string) => void;
  run: (f: () => Promise<unknown>) => void;
}) {
  return (
    <section className={`lane glass${collapsed ? " collapsed" : ""}`}>
      <LaneHeader lane={lane} collapsed={collapsed} onToggle={onToggle} />
      {!collapsed && (
        <div className="lane-grid">
          {COLUMNS.map((c) => (
            <LaneColumn
              key={c.status}
              status={c.status}
              laneKey={lane.key}
              todos={lane.todos.filter((t) => t.status === c.status).sort((a, b) => a.id - b.id)}
              selectedId={selectedId}
              onSelect={onSelectTodo}
              run={run}
            />
          ))}
          <div className="cell inbox-cell">
            {lane.inbox.map((s) => (
              <InboxItem key={s.session_id} session={s} selected={selectedSessionId === s.session_id} onSelect={() => onSelectSession(s.session_id)} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function InlineInput({ value, placeholder, onSave }: { value: string; placeholder?: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function Field({ label, value, placeholder, multiline, rows = 6, onSave }: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onSave(draft);
  return (
    <label className="field">
      <span>{label}</span>
      {multiline ? (
        <textarea rows={rows} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      ) : (
        <input value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      )}
    </label>
  );
}

/// Adds `key` to the todo's own repo list; the first pick also fills an empty working folder.
function addRepo(todo: Todo, local: LocalRepo[], key: string): Parameters<typeof api.updateTodo>[1] | null {
  const own = todo.repos_derived ? [] : todo.repos;
  if (!key || own.includes(key)) return null;
  const repos = [...own, key];
  const path = local.find((r) => r.key === key)?.path;
  return todo.cwd || !path ? { repos } : { repos, cwd: path };
}

function RepoPicker({ todo, local, groups, update }: {
  todo: Todo;
  local: LocalRepo[];
  groups: string[];
  update: (u: Parameters<typeof api.updateTodo>[1]) => void;
}) {
  const own = todo.repos_derived ? [] : todo.repos;
  const remove = (key: string) => update({ repos: own.filter((r) => r !== key) });
  return (
    <div className="field">
      <span>リポジトリ / グループ{todo.repos_derived && todo.repos.length > 0 && "（issue URL / 作業フォルダから判定）"}</span>
      <div className="chips">
        {todo.repos.map((r) => (
          <span key={r} className={`chip${todo.repos_derived ? " derived" : ""}`} title={r}>
            <RepoDot repo={r} />
            {r}
            {!todo.repos_derived && (
              <button className="ghost icon chip-remove" onClick={() => remove(r)} aria-label={`${r} を外す`}>
                <Icon name="close" />
              </button>
            )}
          </span>
        ))}
        {todo.repos.length === 0 && <span className="muted">未設定（バックログ）</span>}
      </div>
      <RepoChoice
        local={local}
        groups={groups}
        exclude={own}
        placeholder="リポジトリかグループを追加…"
        onPick={(key) => {
          const u = addRepo(todo, local, key);
          if (u) update(u);
        }}
      />
    </div>
  );
}

function SessionRow({ session, run, onUnlink }: {
  session: Session;
  run: (f: () => Promise<unknown>) => void;
  onUnlink?: () => void;
}) {
  return (
    <li className={`session-row${session.state === "needs_input" ? " waiting" : ""}`}>
      <span className={`state-dot state-${session.state}`} />
      <div className="session-main">
        <div className="card-title">{sessionLabel(session)}</div>
        <div className="card-meta">
          <KindTag session={session} />
          <span className="muted">{STATE_LABEL[session.state]}</span>
          <span className="muted">{ago(session.state_at)}</span>
        </div>
      </div>
      <div className="row-actions">
        <OpenButton session={session} run={run} primary={session.state === "needs_input"} />
        {onUnlink && (
          <button className="ghost" onClick={onUnlink}>
            解除
          </button>
        )}
      </div>
    </li>
  );
}

/// Read-mostly view of a todo: what it is linked to and the ways into it.
/// Editing and starting sessions happen in dialogs.
function Drawer({ todo, run, setStatus, onClose, onEdit, onStart }: {
  todo: Todo;
  run: (f: () => Promise<unknown>) => void;
  setStatus: (todo: Todo, status: Status) => void;
  onClose: () => void;
  onEdit: () => void;
  onStart: () => void;
}) {
  // window.confirm never returns true inside the Tauri webview, so confirm in place.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => setConfirmingDelete(false), [todo.id]);
  const gh = (url: string) => () => run(() => api.openGithub(url));
  const live = todo.sessions.filter((s) => s.state !== "ended");
  return (
    <aside className="drawer glass">
      <header>
        <span className="mono muted">
          #{todo.id} · {KINDS.find((k) => k.key === todo.kind)?.label}
        </span>
        <span className="header-actions">
          <button className="ghost" onClick={onEdit}>
            編集
          </button>
          <button className="ghost icon" onClick={onClose} aria-label="閉じる">
            <Icon name="close" />
          </button>
        </span>
      </header>
      <h2 className="drawer-title">{todo.title}</h2>
      <div className="segmented status-seg">
        {COLUMNS.map((c) => (
          <button key={c.status} className={todo.status === c.status ? "on" : ""} onClick={() => setStatus(todo, c.status)}>
            {c.label}
          </button>
        ))}
      </div>

      <button className="primary start-button" onClick={onStart}>
        <Icon name="plus" /> セッションを開始
      </button>
      {todo.queue_runner && (
        <div className="notice small">
          <span>キューで待機中（{RUNNER_LABEL[todo.queue_runner]}）{todo.queue_error && ` — ${todo.queue_error}`}</span>
          <button className="ghost" onClick={() => run(() => api.dequeue(todo.id))}>
            外す
          </button>
        </div>
      )}

      <h3>セッション{live.length > 0 && <span className="count">{live.length}</span>}</h3>
      {todo.sessions.length === 0 && <p className="muted">まだありません。「セッションを開始」か、受信箱からカードにドラッグして紐づけます。</p>}
      <ul className="sessions">
        {todo.sessions.map((s) => (
          <SessionRow key={s.session_id} session={s} run={run} onUnlink={() => run(() => api.unlinkSession(s.session_id))} />
        ))}
      </ul>

      <h3>GitHub</h3>
      <ul className="links">
        <li>
          <span className="link-label">Issue</span>
          {todo.issue_url ? (
            <>
              <button className="link" onClick={gh(todo.issue_url)} title={todo.issue_url}>
                {issueRef(todo.issue_url) ?? todo.issue_url} <Icon name="open" />
              </button>
              {todo.issue_state && <span className={`gh gh-issue-${todo.issue_state}`}>{todo.issue_state}</span>}
              {todo.issue_state === "open" && (
                <button className="ghost small" onClick={() => run(() => api.closeIssue(todo.id))}>
                  close
                </button>
              )}
            </>
          ) : (
            <button className="small" onClick={() => run(() => api.createIssue(todo.id))} title="タイトルとメモから issue を作って紐づけます">
              issue を作る
            </button>
          )}
        </li>
        <li>
          <span className="link-label">PR</span>
          {todo.pr_url ? (
            <>
              <button className="link" onClick={gh(todo.pr_url)} title={todo.pr_url}>
                {issueRef(todo.pr_url) ?? todo.pr_url} <Icon name="open" />
              </button>
              {todo.pr_state && <span className={`gh gh-pr-${todo.pr_state}`}>{PR_LABEL[todo.pr_state]}</span>}
            </>
          ) : (
            <span className="muted">未連携（編集で URL を入れるか、claude/todo-{todo.id}- のブランチで自動連携）</span>
          )}
        </li>
      </ul>

      <h3>詳細</h3>
      <dl className="props">
        <dt>repo</dt>
        <dd>
          {todo.repos.length > 0 ? (
            <span className="chips">
              {todo.repos.map((r) => (
                <span key={r} className={`chip${todo.repos_derived ? " derived" : ""}`}>
                  <RepoDot repo={r} />
                  {r}
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">バックログ</span>
          )}
        </dd>
        <dt>フォルダ</dt>
        <dd className="mono">{todo.cwd ?? <span className="muted">未設定</span>}</dd>
        <dt>更新</dt>
        <dd>{ago(todo.updated_at)}</dd>
      </dl>
      {todo.memo && (
        <>
          <h3>メモ</h3>
          <div className="memo">{todo.memo}</div>
        </>
      )}

      {confirmingDelete ? (
        <div className="actions delete-confirm">
          <span className="muted">#{todo.id} を削除しますか？ 紐づいたセッションは受信箱に戻ります。</span>
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
      ) : (
        <button className="ghost danger" onClick={() => setConfirmingDelete(true)}>
          todo を削除
        </button>
      )}
    </aside>
  );
}

function EditTodoDialog({ todo, local, groups, run, onClose }: {
  todo: Todo;
  local: LocalRepo[];
  groups: string[];
  run: (f: () => Promise<unknown>) => void;
  onClose: () => void;
}) {
  const update = (u: Parameters<typeof api.updateTodo>[1]) => run(() => api.updateTodo(todo.id, u));
  return (
    <Modal title={`#${todo.id} を編集`} onClose={onClose} footer={<><span className="muted">欄を離れると保存されます</span><button className="primary" onClick={onClose}>完了</button></>}>
      <Field label="タイトル" value={todo.title} onSave={(title) => update({ title })} />
      <div className="field">
        <span>種類（最初のプロンプトの既定文が変わります）</span>
        <div className="segmented">
          {KINDS.map((k) => (
            <button key={k.key} className={todo.kind === k.key ? "on" : ""} onClick={() => update({ kind: k.key })}>
              {k.label}
            </button>
          ))}
        </div>
      </div>
      <RepoPicker todo={todo} local={local} groups={groups} update={update} />
      <div className="two-col">
        <Field label="Issue URL" value={todo.issue_url ?? ""} placeholder="https://github.com/…/issues/…" onSave={(issue_url) => update({ issue_url })} />
        <Field label="PR URL" value={todo.pr_url ?? ""} placeholder="https://github.com/…/pull/…" onSave={(pr_url) => update({ pr_url })} />
      </div>
      <Field label="作業フォルダ" value={todo.cwd ?? ""} placeholder="/Users/…/repo" onSave={(cwd) => update({ cwd })} />
      <Field label="メモ" value={todo.memo ?? ""} multiline onSave={(memo) => update({ memo })} />
    </Modal>
  );
}

type StartTarget = "cloud" | "desktop" | "terminal" | "queue";
const START_TARGETS: { key: StartTarget; title: string; sub: string }[] = [
  { key: "cloud", title: "Cloud", sub: "Desktop で開く" },
  { key: "desktop", title: "Local", sub: "Desktop" },
  { key: "terminal", title: "Local", sub: "ターミナル（herdr）" },
  { key: "queue", title: "キュー", sub: "ループで自動起動" },
];

function StartSessionDialog({ todo, run, onClose }: {
  todo: Todo;
  run: (f: () => Promise<unknown>) => void;
  onClose: () => void;
}) {
  const hasGithub = todo.repos.some((r) => r.includes("/"));
  const [target, setTarget] = useState<StartTarget>(hasGithub ? "cloud" : "desktop");
  const [kind, setKind] = useState<Kind>(todo.kind);
  const [prompt, setPrompt] = useState(todo.prompt ?? "");
  const [runner, setRunner] = useState<Runner>("auto");
  const start = () =>
    run(async () => {
      // Kind and prompt live on the todo, so the next start (and the loop) reuse them.
      if (kind !== todo.kind || prompt !== (todo.prompt ?? "")) await api.updateTodo(todo.id, { kind, prompt });
      if (target === "cloud") await api.startCloud(todo.id);
      else if (target === "desktop") await api.startDesktop(todo.id);
      else if (target === "terminal") await api.startTerminal(todo.id);
      else await api.enqueue(todo.id, runner);
      onClose();
    });
  return (
    <Modal
      title={`セッションを開始 — ${todo.title}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            キャンセル
          </button>
          <button className="primary" disabled={target === "cloud" && !hasGithub} onClick={start}>
            {target === "queue" ? "キューに入れる" : "開始"}
          </button>
        </>
      }
    >
      <div className="field">
        <span>どこで始める</span>
        <div className="launchers four">
          {START_TARGETS.map((t) => (
            <button
              key={t.key}
              className={`launcher${target === t.key ? " primary" : ""}`}
              disabled={t.key === "cloud" && !hasGithub}
              title={t.key === "cloud" && !hasGithub ? "Cloud には GitHub のリポジトリが必要です" : undefined}
              onClick={() => setTarget(t.key)}
            >
              <b>{t.title}</b>
              <span>{t.sub}</span>
            </button>
          ))}
        </div>
      </div>
      {target === "queue" && (
        <label className="field">
          <span>キューからの起動方法</span>
          <select value={runner} onChange={(e) => setRunner(e.target.value as Runner)}>
            {(Object.keys(RUNNER_LABEL) as Runner[]).map((r) => (
              <option key={r} value={r}>
                {RUNNER_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="field">
        <span>種類</span>
        <div className="segmented">
          {KINDS.map((k) => (
            <button key={k.key} className={kind === k.key ? "on" : ""} onClick={() => setKind(k.key)}>
              {k.label}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>最初のプロンプト（空なら種類に応じた既定文。[todo:{todo.id}] は自動で付きます）</span>
        <textarea rows={5} value={prompt} placeholder={kind === "research" ? "調査: タイトル＋メモ＋完了条件・出力条件を確認する指示" : "/grilling タイトル＋メモ"} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      {!prompt && kind === todo.kind && <pre className="prompt-preview">{todo.prompt_preview}</pre>}
      <p className="muted hint">
        作業フォルダ: <span className="mono">{todo.cwd ?? "未設定（Desktop は一時フォルダ、ターミナルはホーム）"}</span>
      </p>
    </Modal>
  );
}

function SessionDrawer({ session, todos, run, onClose, onCreated }: {
  session: Session;
  todos: Todo[];
  run: (f: () => Promise<unknown>) => void;
  onClose: () => void;
  onCreated: (todoId: number) => void;
}) {
  const [target, setTarget] = useState<number | "">("");
  const [newTitle, setNewTitle] = useState(session.title ?? "");
  useEffect(() => setNewTitle(session.title ?? ""), [session.session_id, session.title]);
  // A local session's cwd is a folder the todo can reuse; a cloud session's is a repo URL.
  const cwd = session.cwd.startsWith("/") ? session.cwd : undefined;
  const createAndLink = () => {
    const title = newTitle.trim();
    if (!title) return;
    run(async () => {
      const todo = await api.createTodo({ title, cwd, repos: session.repos ?? [] });
      await api.linkSession(session.session_id, todo.id);
      onCreated(todo.id);
    });
  };
  return (
    <aside className="drawer glass">
      <header>
        <span className="mono muted">セッション</span>
        <button className="ghost icon" onClick={onClose} aria-label="閉じる">
          <Icon name="close" />
        </button>
      </header>
      <h2 className="drawer-title">{sessionLabel(session)}</h2>
      <div className="card-meta">
        <StateBadge state={session.state} />
        <KindTag session={session} />
        <span className="muted">{ago(session.state_at)}</span>
      </div>
      <dl className="props">
        {(session.repos ?? []).length > 0 && (
          <>
            <dt>repo</dt>
            <dd>{(session.repos ?? []).join(", ")}</dd>
          </>
        )}
        <dt>場所</dt>
        <dd className="mono">{session.cwd}</dd>
        <dt>ID</dt>
        <dd className="mono">{session.session_id}</dd>
      </dl>
      <div className="actions">
        <OpenButton session={session} run={run} primary />
      </div>
      <h3>このセッションから todo を作る</h3>
      <div className="actions">
        <input value={newTitle} placeholder="todo のタイトル" onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createAndLink()} />
        <button className="primary" disabled={!newTitle.trim()} onClick={createAndLink}>
          作って紐づける
        </button>
      </div>
      <h3>既存の todo に紐づける</h3>
      <div className="actions">
        <select value={target} onChange={(e) => setTarget(e.target.value === "" ? "" : Number(e.target.value))}>
          <option value="">todo を選ぶ</option>
          {todos.map((t) => (
            <option key={t.id} value={t.id}>
              #{t.id} {t.title}
            </option>
          ))}
        </select>
        <button disabled={target === ""} onClick={() => target !== "" && run(() => api.linkSession(session.session_id, target))}>
          紐づける
        </button>
      </div>
    </aside>
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
      <div className={`modal glass${wide ? " wide" : ""}`} role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="ghost icon" onClick={onClose} aria-label="閉じる">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/// Adds todos one after another: the dialog stays open and lists what it added.
function AddTodoDialog({ local, groups, run, onClose, onOpenTodo }: {
  local: LocalRepo[];
  groups: string[];
  run: (f: () => Promise<unknown>) => void;
  onClose: () => void;
  onOpenTodo: (id: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState("");
  const [issueUrl, setIssueUrl] = useState("");
  const [kind, setKind] = useState<Kind>("implementation");
  const [added, setAdded] = useState<Todo[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const submit = () => {
    const t = title.trim();
    if (!t) return;
    const path = local.find((r) => r.key === repo)?.path;
    run(async () => {
      const todo = await api.createTodo({ title: t, kind, repos: repo ? [repo] : [], cwd: path, issue_url: issueUrl.trim() || undefined });
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
        <input ref={titleRef} value={title} placeholder="何をする？" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      </label>
      <div className="field">
        <span>種類</span>
        <div className="segmented">
          {KINDS.map((k) => (
            <button key={k.key} className={kind === k.key ? "on" : ""} onClick={() => setKind(k.key)}>
              {k.label}
            </button>
          ))}
        </div>
      </div>
      <div className="two-col">
        <div className="field">
          <span>リポジトリ / グループ（任意。空ならバックログへ）</span>
          <RepoChoice local={local} groups={repo && !repo.includes("/") && !groups.includes(repo) ? [repo, ...groups] : groups} value={repo} placeholder="バックログ" onPick={setRepo} />
        </div>
        <label className="field">
          <span>Issue / PR URL（任意）</span>
          <input value={issueUrl} placeholder="https://github.com/…" onChange={(e) => setIssueUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </label>
      </div>
      {added.length > 0 && (
        <div className="added">
          <span className="muted">追加済み {added.length} 件</span>
          <ul className="list">
            {added.map((t) => (
              <li key={t.id} className="list-row" onClick={() => onOpenTodo(t.id)}>
                <span className="mono muted">#{t.id}</span>
                <span className="list-title">{t.title}</span>
                {t.repos.length > 0 ? <span className="tag">{repoName(t.repos[0])}</span> : <span className="muted">バックログ</span>}
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
                <span className="card-title">{i.title}</span>
                <span className="card-meta">
                  <span className="mono muted">
                    {i.repo}#{i.number}
                  </span>
                  {i.cwd ? <span className="tag">{basename(i.cwd)}</span> : <span className="muted">ローカルに未 clone</span>}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function ListPage({ lanes, selectedId, run, setStatus, onSelectTodo }: {
  lanes: Lane[];
  selectedId: number | null;
  run: (f: () => Promise<unknown>) => void;
  setStatus: (todo: Todo, status: Status) => void;
  onSelectTodo: (id: number) => void;
}) {
  if (lanes.length === 0) return <p className="muted empty">リポジトリに紐づいた todo はまだありません。</p>;
  return (
    <div className="stack">
      {lanes.map((lane) => {
        const todos = [...lane.todos].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.id - b.id);
        return (
          <section key={lane.key} className="glass panel">
            <LaneHeader lane={lane} />
            <ul className="list">
              {todos.map((t) => {
                const live = t.sessions.filter((x) => x.state !== "ended");
                const direct = directSession(t);
                const states = new Set(live.map((x) => x.state));
                return (
                  <li key={t.id} className={`list-row${t.id === selectedId ? " selected" : ""}${states.has("needs_input") ? " waiting" : ""}`} onClick={() => onSelectTodo(t.id)}>
                    <select
                      className={`status-select st-${t.status}`}
                      value={t.status}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setStatus(t, e.target.value as Status)}
                    >
                      {COLUMNS.map((c) => (
                        <option key={c.status} value={c.status}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <span className="mono muted ref">{issueRef(t.issue_url) ?? `#${t.id}`}</span>
                    <span className="list-title">{t.title}</span>
                    <GhBadges todo={t} />
                    {STATE_ORDER.filter((st) => states.has(st)).map((st) => (
                      <StateBadge key={st} state={st} />
                    ))}
                    {live.length > 1 && <span className="muted">{live.length} sessions</span>}
                    <span className="muted when">{ago(t.updated_at)}</span>
                    {direct && <OpenButton session={direct} run={run} primary={states.has("needs_input")} />}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function BacklogPage({ board, local, groups, selectedId, run, onSelectTodo }: {
  board: Board;
  local: LocalRepo[];
  groups: string[];
  selectedId: number | null;
  run: (f: () => Promise<unknown>) => void;
  onSelectTodo: (id: number) => void;
}) {
  const todos = board.todos.filter((t) => t.repos.length === 0).sort((a, b) => b.updated_at - a.updated_at);
  return (
    <div className="stack">
      <p className="muted hint">リポジトリもグループも未設定の todo。どちらかを選ぶとボードに移ります。調査など、リポジトリに紐づかないものは「＋ 新しいグループ…」で分けられます。</p>
      {todos.length === 0 && <p className="muted empty">バックログは空です。サイドバーの「追加」から todo を作れます。</p>}
      {todos.length > 0 && (
        <section className="glass panel">
          <ul className="list">
            {todos.map((t) => (
              <li key={t.id} className={`list-row${t.id === selectedId ? " selected" : ""}`} onClick={() => onSelectTodo(t.id)}>
                <span className="mono muted">#{t.id}</span>
                <span className="list-title">{t.title}</span>
                {t.status !== "todo" && <span className="tag">{t.status}</span>}
                <span className="muted when">{ago(t.updated_at)}</span>
                <div className="row-choice" onClick={(e) => e.stopPropagation()}>
                  <RepoChoice
                    local={local}
                    groups={groups}
                    placeholder="リポジトリかグループを選ぶ…"
                    onPick={(key) => {
                      const u = addRepo(t, local, key);
                      if (u) run(() => api.updateTodo(t.id, u));
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function InboxPage({ board, selectedSessionId, run, onSelectSession }: {
  board: Board;
  selectedSessionId: string | null;
  run: (f: () => Promise<unknown>) => void;
  onSelectSession: (id: string) => void;
}) {
  const groups = new Map<string, Session[]>();
  for (const s of board.inbox) {
    const key = laneKey(s.repos);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === BACKLOG_LANE ? 1 : b === BACKLOG_LANE ? -1 : a.localeCompare(b, "en", { sensitivity: "base" })));
  return (
    <div className="stack">
      <p className="muted hint">todo に紐づいていないセッション。クリックして todo を作るか、ボードでカードにドラッグします。</p>
      {board.inbox.length === 0 && <p className="muted empty">受信箱は空です。</p>}
      {keys.map((key) => (
        <section key={key} className="glass panel">
          <LaneHeader lane={{ key: key === BACKLOG_LANE ? "リポジトリ不明" : key, todos: [], inbox: groups.get(key) ?? [] }} />
          <ul className="list">
            {(groups.get(key) ?? []).map((s) => (
              <li key={s.session_id} className={`list-row${s.session_id === selectedSessionId ? " selected" : ""}${s.state === "needs_input" ? " waiting" : ""}`} onClick={() => onSelectSession(s.session_id)}>
                <span className={`state-dot state-${s.state}`} />
                <KindTag session={s} />
                <span className="list-title">{sessionLabel(s)}</span>
                <span className="muted">{STATE_LABEL[s.state]}</span>
                <span className="muted when">{ago(s.state_at)}</span>
                <OpenButton session={s} run={run} primary={s.state === "needs_input"} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function QueuePage({ board, selectedId, run, onSelectTodo }: {
  board: Board;
  selectedId: number | null;
  run: (f: () => Promise<unknown>) => void;
  onSelectTodo: (id: number) => void;
}) {
  const rows = board.todos.filter((t) => t.queue_runner).sort((a, b) => (a.queue_pos ?? 0) - (b.queue_pos ?? 0) || a.id - b.id);
  return (
    <div className="stack">
      <div className="panel glass loop-head">
        <div>
          <b>ループ</b>
          <p className="muted hint">キューに入れた todo を、上から順にすべて同時にセッションとして始めます。始まった todo はキューから外れ、ボードで状態を追えます。入力待ちになったら通知します。</p>
        </div>
        <label className="toggle big">
          <input type="checkbox" checked={board.loop_enabled} onChange={(e) => run(() => api.setLoopEnabled(e.target.checked))} />
          {board.loop_enabled ? "実行中" : "停止中"}
        </label>
      </div>
      {rows.length === 0 && <p className="muted empty">キューは空です。todo のパネルの「キューに入れる」から追加できます。</p>}
      {rows.length > 0 && (
        <section className="glass panel">
          <ul className="list">
            {rows.map((t, i) => (
              <li key={t.id} className={`list-row${t.id === selectedId ? " selected" : ""}`} onClick={() => onSelectTodo(t.id)}>
                <span className="mono muted">{i + 1}</span>
                <span className="order-buttons" onClick={(e) => e.stopPropagation()}>
                  <button className="ghost icon" disabled={i === 0} aria-label="上へ" onClick={() => run(() => api.moveInQueue(t.id, -1))}>
                    <Icon name="up" />
                  </button>
                  <button className="ghost icon" disabled={i === rows.length - 1} aria-label="下へ" onClick={() => run(() => api.moveInQueue(t.id, 1))}>
                    <Icon name="down" />
                  </button>
                </span>
                <span className="list-title">
                  {t.title}
                  {t.queue_error && <span className="error-text queue-error">{t.queue_error}</span>}
                </span>
                {t.repos.map((r) => (
                  <span key={r} className="tag">
                    {repoName(r)}
                  </span>
                ))}
                <select
                  className="runner-select"
                  value={t.queue_runner ?? "auto"}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => run(() => api.enqueue(t.id, e.target.value as Runner))}
                >
                  {(Object.keys(RUNNER_LABEL) as Runner[]).map((r) => (
                    <option key={r} value={r}>
                      {RUNNER_LABEL[r]}
                    </option>
                  ))}
                </select>
                {t.queue_error && (
                  <button onClick={(e) => { e.stopPropagation(); run(() => api.enqueue(t.id, t.queue_runner ?? "auto")); }}>
                    再試行
                  </button>
                )}
                <button className="ghost" onClick={(e) => { e.stopPropagation(); run(() => api.dequeue(t.id)); }}>
                  外す
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

type Selection = { kind: "todo"; id: number } | { kind: "session"; id: string } | null;

export default function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"add" | "import" | "edit" | "start" | null>(null);
  const [view, setViewState] = useState<View>(loadView);
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [hideDone, setHideDoneState] = useState<boolean>(loadHideDone);
  const [local, setLocal] = useState<LocalRepo[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } }));

  const setView = (v: View) => {
    remember(VIEW_KEY, v);
    setViewState(v);
  };
  const setHideDone = (v: boolean) => {
    remember(HIDE_DONE_KEY, v ? "1" : "0");
    setHideDoneState(v);
  };
  const toggleLane = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      remember(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });

  const refresh = useCallback(() => {
    api.board().then(setBoard, (e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    api.localRepos().then(setLocal, () => setLocal([]));
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // ⌘N adds a todo from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setDialog("add");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = (f: () => Promise<unknown>) => {
    setError(null);
    f().then(refresh, (e) => setError(String(e)));
  };

  // Moving a todo with an open issue to Done offers to close the issue too.
  const [closePrompt, setClosePrompt] = useState<Todo | null>(null);
  const setStatus = (todo: Todo, status: Status) => {
    run(() => api.updateTodo(todo.id, { status }));
    if (status === "done" && todo.issue_url && todo.issue_state !== "closed") setClosePrompt(todo);
  };

  const onDragStart = ({ active }: DragStartEvent) => setDragging(String(active.id));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const [kind, id] = String(active.id).split(/:(.*)/s);
    const [target, targetId] = String(over.id).split(/:(.*)/s);
    if (kind === "todo" && target === "col") {
      const status = targetId.split(":")[0] as Status;
      const todo = board?.todos.find((t) => t.id === Number(id));
      if (todo) setStatus(todo, status);
    } else if (kind === "session" && target === "card") {
      run(() => api.linkSession(id, Number(targetId)));
    }
  };

  // Sidebar counts come from the unfiltered board; the pages get the filtered one.
  const allLanes = board ? buildLanes(board) : [];
  const matchesState = (sessions: Session[]) => stateFilter === "all" || sessions.some((s) => s.state === stateFilter);
  const visible: Board | null = board && {
    ...board,
    todos: board.todos.filter(
      (t) =>
        (!hideDone || t.status !== "done") &&
        (repoFilter === null || laneKey(t.repos) === repoFilter) &&
        matchesState(t.sessions.filter((s) => s.state !== "ended")),
    ),
    inbox: board.inbox.filter((s) => (repoFilter === null || laneKey(s.repos) === repoFilter) && matchesState([s])),
  };
  const lanes = visible ? buildLanes(visible) : [];
  // Free group names in use, offered beside repositories when picking.
  const groups = [...new Set((board?.todos ?? []).flatMap((t) => t.repos).filter((r) => !r.includes("/")))].sort();
  const waiting = board ? board.todos.flatMap((t) => t.sessions).filter((s) => s.state === "needs_input").length : 0;
  const backlogCount = board?.todos.filter((t) => t.repos.length === 0).length ?? 0;
  const queuedCount = board?.todos.filter((t) => t.queue_runner).length ?? 0;
  const doneHidden = hideDone ? (board?.todos.filter((t) => t.status === "done").length ?? 0) : 0;

  const selectedTodo = selection?.kind === "todo" ? board?.todos.find((t) => t.id === selection.id) ?? null : null;
  const selectedSession =
    selection?.kind === "session" ? board?.inbox.find((s) => s.session_id === selection.id) ?? null : null;
  const selectedId = selectedTodo?.id ?? null;
  const overlay = (() => {
    if (!dragging || !board) return null;
    const [kind, id] = dragging.split(/:(.*)/s);
    if (kind === "todo") {
      const t = board.todos.find((x) => x.id === Number(id));
      return t && <div className="card overlay">{t.title}</div>;
    }
    const s = board.inbox.find((x) => x.session_id === id);
    return s && <div className="card overlay">{sessionLabel(s)}</div>;
  })();

  const openTodo = (id: number) => setSelection({ kind: "todo", id });
  const openSession = (id: string) => setSelection({ kind: "session", id });

  return (
    <div className={`app${selectedTodo || selectedSession ? " with-drawer" : ""}`}>
      <aside className="sidebar glass">
        <div className="brand">
          <span className="brand-mark" />
          <span>Todo Sessions</span>
        </div>
        <div className="sidebar-actions">
          <button className="primary" title="追加（⌘N）" onClick={() => setDialog("add")}>
            <Icon name="plus" /> <span className="label">追加</span> <kbd>⌘N</kbd>
          </button>
          <button title="issue を取り込む" onClick={() => setDialog("import")}>
            <Icon name="import" /> <span className="label">issue を取り込む</span>
          </button>
        </div>
        <nav className="nav">
          {VIEWS.map((v) => (
            <button key={v.key} className={view === v.key ? "on" : ""} title={v.label} onClick={() => setView(v.key)}>
              <Icon name={v.key} />
              <span className="label">{v.label}</span>
              {v.key === "backlog" && backlogCount > 0 && <span className="count">{backlogCount}</span>}
              {v.key === "inbox" && (board?.inbox.length ?? 0) > 0 && <span className="count">{board?.inbox.length}</span>}
              {v.key === "queue" && queuedCount > 0 && <span className="count">{queuedCount}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-section">
          <div className="section-title">リポジトリ</div>
          {allLanes.map((lane) => {
            const w = lane.todos.flatMap((t) => t.sessions).concat(lane.inbox).filter((s) => s.state === "needs_input").length;
            return (
              <button
                key={lane.key}
                className={`repo${repoFilter === lane.key ? " on" : ""}`}
                title={lane.key}
                onClick={() => setRepoFilter(repoFilter === lane.key ? null : lane.key)}
              >
                <RepoDot repo={lane.key} />
                <span className="ellipsis label">{lane.key.includes("/") ? repoName(lane.key) : lane.key}</span>
                {w > 0 && <span className="pill waiting">{w}</span>}
                <span className="count">{lane.todos.length}</span>
              </button>
            );
          })}
          {allLanes.length === 0 && <p className="muted hint">まだありません</p>}
        </div>
        <div className="sidebar-foot">
          <div className={`waiting-box${waiting > 0 ? " on" : ""}`} title={`入力待ち ${waiting}`}>
            <i />
            <span className="label">入力待ち</span> <b>{waiting}</b>
          </div>
          <div className="muted sync label">{board?.sync_status}</div>
        </div>
      </aside>

      <main className="main">
        <header className="toolbar">
          <h1>{VIEWS.find((v) => v.key === view)?.label}</h1>
          {repoFilter && (
            <button className="chip-filter" onClick={() => setRepoFilter(null)}>
              <RepoDot repo={repoFilter} />
              {repoFilter} <Icon name="close" />
            </button>
          )}
          <div className="segmented">
            {STATE_FILTERS.map((f) => (
              <button key={f.key} className={stateFilter === f.key ? "on" : ""} onClick={() => setStateFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
          <label className="toggle">
            <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
            Done を隠す{doneHidden > 0 && <span className="count">{doneHidden}</span>}
          </label>
        </header>
        {closePrompt && (
          <div className="notice" role="status">
            <span>
              #{closePrompt.id} を Done にしました。{issueRef(closePrompt.issue_url) ?? "issue"} も close しますか？
            </span>
            <button
              className="primary"
              onClick={() => {
                const id = closePrompt.id;
                setClosePrompt(null);
                run(() => api.closeIssue(id));
              }}
            >
              close する
            </button>
            <button className="ghost" onClick={() => setClosePrompt(null)}>
              そのまま
            </button>
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
            <button className="ghost icon" onClick={() => setError(null)} aria-label="閉じる">
              <Icon name="close" />
            </button>
          </div>
        )}
        <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className="content">
            {view === "board" && (
              <>
                <div className="col-heads">
                  {COLUMNS.map((c) => (
                    <h2 key={c.status}>
                      {c.label} <span className="count">{visible?.todos.filter((t) => t.status === c.status).length ?? 0}</span>
                    </h2>
                  ))}
                  <h2>
                    受信箱 <span className="count">{visible?.inbox.length ?? 0}</span>
                  </h2>
                </div>
                {lanes.map((lane) => (
                  <LaneView
                    key={lane.key}
                    lane={lane}
                    collapsed={collapsed.has(lane.key)}
                    onToggle={() => toggleLane(lane.key)}
                    selectedId={selectedId}
                    selectedSessionId={selectedSession?.session_id ?? null}
                    onSelectTodo={openTodo}
                    onSelectSession={openSession}
                    run={run}
                  />
                ))}
                {board && lanes.length === 0 && (
                  <p className="muted empty">表示できる todo がありません。フィルタを外すか、バックログでリポジトリを選ぶか、issue を取り込んでください。</p>
                )}
              </>
            )}
            {view === "list" && <ListPage lanes={lanes} selectedId={selectedId} run={run} setStatus={setStatus} onSelectTodo={openTodo} />}
            {view === "backlog" && visible && <BacklogPage board={visible} local={local} groups={groups} selectedId={selectedId} run={run} onSelectTodo={openTodo} />}
            {view === "queue" && board && <QueuePage board={board} selectedId={selectedId} run={run} onSelectTodo={openTodo} />}
            {view === "inbox" && visible && <InboxPage board={visible} selectedSessionId={selectedSession?.session_id ?? null} run={run} onSelectSession={openSession} />}
          </div>
          {/* The overlay follows the pointer across columns; the originals stay in place. */}
          <DragOverlay dropAnimation={null}>{overlay}</DragOverlay>
        </DndContext>
      </main>

      {selectedTodo && (
        <Drawer
          todo={selectedTodo}
          run={run}
          setStatus={setStatus}
          onClose={() => setSelection(null)}
          onEdit={() => setDialog("edit")}
          onStart={() => setDialog("start")}
        />
      )}
      {dialog === "edit" && selectedTodo && <EditTodoDialog todo={selectedTodo} local={local} groups={groups} run={run} onClose={() => setDialog(null)} />}
      {dialog === "start" && selectedTodo && <StartSessionDialog todo={selectedTodo} run={run} onClose={() => setDialog(null)} />}
      {selectedSession && board && (
        <SessionDrawer session={selectedSession} todos={board.todos} run={run} onClose={() => setSelection(null)} onCreated={openTodo} />
      )}
      {dialog === "add" && (
        <AddTodoDialog
          local={local}
          groups={groups}
          run={run}
          onClose={() => setDialog(null)}
          onOpenTodo={(id) => {
            setDialog(null);
            openTodo(id);
          }}
        />
      )}
      {dialog === "import" && <ImportDialog run={run} onClose={() => setDialog(null)} />}
    </div>
  );
}
