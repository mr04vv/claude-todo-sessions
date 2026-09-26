import { useCallback, useEffect, useState } from "react";
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
  type LocalRepo,
  type Session,
  type SessionState,
  type Status,
  type Todo,
} from "./api";

const REFRESH_MS = 3000;
const VIEW_KEY = "view";
type View = "board" | "backlog";
/// Pointer must move this far before a click turns into a drag.
const DRAG_DISTANCE_PX = 6;

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
const COLLAPSED_KEY = "collapsedLanes";

interface Lane {
  key: string;
  todos: Todo[];
  inbox: Session[];
  /// Latest activity in the lane, for ordering.
  latest: number;
}

/// One lane per repository; todos and inbox sessions without one belong to the backlog page.
function buildLanes(board: Board): Lane[] {
  const lanes = new Map<string, Lane>();
  const lane = (repos: string[] | undefined) => {
    const key = laneKey(repos);
    let l = lanes.get(key);
    if (!l) lanes.set(key, (l = { key, todos: [], inbox: [], latest: 0 }));
    return l;
  };
  for (const t of board.todos) {
    const l = lane(t.repos);
    l.todos.push(t);
    l.latest = Math.max(l.latest, t.updated_at, ...t.sessions.map((s) => s.state_at));
  }
  for (const s of board.inbox) {
    const l = lane(s.repos);
    l.inbox.push(s);
    l.latest = Math.max(l.latest, s.state_at);
  }
  // The backlog has its own page. Lanes keep a fixed alphabetical order so a
  // moved card never reshuffles the board; the multi-repo lane stays last.
  lanes.delete(BACKLOG_LANE);
  const rank = (key: string) => (key === MULTI_LANE ? 1 : 0);
  return [...lanes.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key, "en", { sensitivity: "base" }));
}

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "backlog" ? "backlog" : "board";
  } catch {
    return "board";
  }
}

function saveView(view: View) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Per-viewer convenience only.
  }
}

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function saveCollapsed(keys: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    // Per-viewer convenience only; losing it is fine.
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

/// Order badges on a card: the state that needs the user comes first.
const STATE_ORDER: SessionState[] = ["needs_input", "running", "idle"];

function sessionLabel(s: Session) {
  return s.title ?? s.session_id.slice(0, 12);
}

function basename(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
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

function TodoCard({ todo, selected, onSelect, onOpen }: {
  todo: Todo;
  selected: boolean;
  onSelect: () => void;
  onOpen: (sessionId: string) => void;
}) {
  const drag = useDraggable({ id: `todo:${todo.id}` });
  const drop = useDroppable({ id: `card:${todo.id}` });
  const live = todo.sessions.filter((s) => s.state !== "ended");
  // One obvious session to jump to: the only live one, or the only one at all.
  const direct = live.length === 1 ? live[0] : todo.sessions.length === 1 ? todo.sessions[0] : null;
  const states = new Set(live.map((s) => s.state));
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
      className={`card${selected ? " selected" : ""}${drop.isOver ? " drop-target" : ""}${drag.isDragging ? " dragging" : ""}`}
      onClick={onSelect}
    >
      <div className="card-head">
        <span className="mono muted">{ref ?? `#${todo.id}`}</span>
        <span className="muted">{ago(todo.updated_at)}</span>
      </div>
      <div className="card-title">{todo.title}</div>
      <div className="card-meta">
        {STATE_ORDER.filter((st) => states.has(st)).map((st) => (
          <StateBadge key={st} state={st} />
        ))}
        {tags.map((t) => (
          <span key={t} className="tag" title={todo.repos.join(", ")}>
            {t}
          </span>
        ))}
        {live.length > 1 && <span className="muted">{live.length} sessions</span>}
        {direct && (
          <button
            className="card-open"
            title={`${sessionLabel(direct)} を開く`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(direct.session_id);
            }}
          >
            開く ↗
          </button>
        )}
      </div>
    </div>
  );
}

function LaneColumn({ status, laneKey, todos, selectedId, onSelect, onOpen }: {
  status: Status;
  laneKey: string;
  todos: Todo[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onOpen: (sessionId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}:${laneKey}` });
  return (
    <div ref={setNodeRef} className={`cell${isOver ? " drop-target" : ""}`}>
      {todos.map((t) => (
        <TodoCard key={t.id} todo={t} selected={t.id === selectedId} onSelect={() => onSelect(t.id)} onOpen={onOpen} />
      ))}
    </div>
  );
}

function LaneView({ lane, collapsed, onToggle, selectedId, selectedSessionId, onSelectTodo, onSelectSession, onOpen }: {
  lane: Lane;
  collapsed: boolean;
  onToggle: () => void;
  selectedId: number | null;
  selectedSessionId: string | null;
  onSelectTodo: (id: number) => void;
  onSelectSession: (id: string) => void;
  onOpen: (sessionId: string) => void;
}) {
  const [owner, name] = lane.key.includes("/") ? lane.key.split(/\/(.*)/s) : [null, lane.key];
  const waiting = lane.todos.flatMap((t) => t.sessions).concat(lane.inbox).filter((s) => s.state === "needs_input").length;
  return (
    <section className={`lane${collapsed ? " collapsed" : ""}`}>
      <button className="lane-head" onClick={onToggle} aria-expanded={!collapsed}>
        <span className="chevron">{collapsed ? "▸" : "▾"}</span>
        {owner && <span className="muted">{owner}/</span>}
        <span className="lane-name">{name}</span>
        <span className="count">{lane.todos.length}</span>
        {lane.inbox.length > 0 && <span className="muted">受信箱 {lane.inbox.length}</span>}
        {waiting > 0 && (
          <span className="state state-needs_input">
            <i />
            {waiting}
          </span>
        )}
      </button>
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
              onOpen={onOpen}
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
        {(session.repos ?? []).map((r) => (
          <span key={r} className="tag" title={r}>
            {repoName(r)}
          </span>
        ))}
        {(session.repos ?? []).length === 0 && <span className="muted ellipsis">{basename(session.cwd)}</span>}
      </div>
    </div>
  );
}

function Field({ label, value, placeholder, multiline, rows = 8, onSave }: {
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

function SessionRow({ session, run, onUnlink }: {
  session: Session;
  run: (f: () => Promise<unknown>) => void;
  onUnlink?: () => void;
}) {
  return (
    <li className="session-row">
      <div className="session-main">
        <div className="card-title">{sessionLabel(session)}</div>
        <div className="card-meta">
          <StateBadge state={session.state} />
          <KindTag session={session} />
          <span className="muted">{ago(session.state_at)}</span>
        </div>
      </div>
      <div className="row-actions">
        <button className="primary" onClick={() => run(() => api.openSession(session.session_id))}>
          開く
        </button>
        {onUnlink && (
          <button className="ghost" onClick={onUnlink}>
            解除
          </button>
        )}
      </div>
    </li>
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

function RepoPicker({ todo, local, update }: {
  todo: Todo;
  local: LocalRepo[];
  update: (u: Parameters<typeof api.updateTodo>[1]) => void;
}) {
  // Derived repos are not stored on the todo; picking one starts an explicit list.
  const own = todo.repos_derived ? [] : todo.repos;
  const add = (key: string) => {
    const u = addRepo(todo, local, key);
    if (u) update(u);
  };
  const remove = (key: string) => update({ repos: own.filter((r) => r !== key) });
  const choices = local.filter((r) => !own.includes(r.key));
  return (
    <div className="field">
      <span>リポジトリ{todo.repos_derived && todo.repos.length > 0 && "（issue URL / 作業フォルダから判定）"}</span>
      <div className="chips">
        {todo.repos.map((r) => (
          <span key={r} className={`chip${todo.repos_derived ? " derived" : ""}`} title={r}>
            {r}
            {!todo.repos_derived && (
              <button className="ghost icon chip-remove" onClick={() => remove(r)} aria-label={`${r} を外す`}>
                ×
              </button>
            )}
          </span>
        ))}
        {todo.repos.length === 0 && <span className="muted">未設定（バックログ）</span>}
      </div>
      <select value="" onChange={(e) => add(e.target.value)}>
        <option value="">リポジトリを追加…</option>
        {choices.map((r) => (
          <option key={r.key} value={r.key}>
            {r.key}
          </option>
        ))}
      </select>
    </div>
  );
}

function Drawer({ todo, local, run, onClose }: {
  todo: Todo;
  local: LocalRepo[];
  run: (f: () => Promise<unknown>) => void;
  onClose: () => void;
}) {
  const update = (u: Parameters<typeof api.updateTodo>[1]) => run(() => api.updateTodo(todo.id, u));
  const ref = issueRef(todo.issue_url);
  // window.confirm never returns true inside the Tauri webview, so confirm in place.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => setConfirmingDelete(false), [todo.id]);
  return (
    <aside className="drawer">
      <header>
        <span className="mono muted">
          #{todo.id}
          {ref && (
            <>
              {" · "}
              <a href={todo.issue_url!} target="_blank" rel="noreferrer">
                {ref}
              </a>
            </>
          )}
        </span>
        <button className="ghost icon" onClick={onClose} aria-label="閉じる">
          ×
        </button>
      </header>
      <Field label="タイトル" value={todo.title} onSave={(title) => update({ title })} />
      <label className="field">
        <span>Status</span>
        <select value={todo.status} onChange={(e) => update({ status: e.target.value as Status })}>
          {COLUMNS.map((c) => (
            <option key={c.status} value={c.status}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <RepoPicker todo={todo} local={local} update={update} />
      <Field label="Issue / PR URL" value={todo.issue_url ?? ""} placeholder="https://github.com/…" onSave={(issue_url) => update({ issue_url })} />
      <Field label="作業フォルダ" value={todo.cwd ?? ""} placeholder="/Users/…/repo" onSave={(cwd) => update({ cwd })} />
      <Field label="メモ" value={todo.memo ?? ""} multiline onSave={(memo) => update({ memo })} />

      <h3>新しいセッション</h3>
      <Field
        label={`最初のプロンプト（先頭に [todo:${todo.id}] が付きます。空ならタイトル）`}
        value={todo.prompt ?? ""}
        placeholder={todo.title}
        multiline
        rows={3}
        onSave={(prompt) => update({ prompt })}
      />
      <div className="actions">
        <button onClick={() => run(() => api.startDesktop(todo.id))}>Desktop</button>
        <button onClick={() => run(() => api.startCloud(todo.id))}>クラウド</button>
        <button onClick={() => run(() => api.startTerminal(todo.id))}>ターミナル</button>
      </div>

      <h3>セッション</h3>
      {todo.sessions.length === 0 && <p className="muted">まだありません。受信箱からカードにドラッグすると紐づきます。</p>}
      <ul className="sessions">
        {todo.sessions.map((s) => (
          <SessionRow key={s.session_id} session={s} run={run} onUnlink={() => run(() => api.unlinkSession(s.session_id))} />
        ))}
      </ul>

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
    <aside className="drawer">
      <header>
        <span className="mono muted">セッション</span>
        <button className="ghost icon" onClick={onClose} aria-label="閉じる">
          ×
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
        <button className="primary" onClick={() => run(() => api.openSession(session.session_id))}>
          開く
        </button>
      </div>
      <h3>このセッションから todo を作る</h3>
      <div className="actions">
        <input value={newTitle} placeholder="todo のタイトル" onChange={(e) => setNewTitle(e.target.value)} />
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

function ImportModal({ run, onClose }: { run: (f: () => Promise<unknown>) => void; onClose: () => void }) {
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>自分に割り当てられた issue</h2>
          <button className="ghost icon" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </header>
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
        <footer>
          <button className="ghost" onClick={onClose}>
            キャンセル
          </button>
          <button className="primary" disabled={checked.size === 0} onClick={submit}>
            {checked.size} 件を取り込む
          </button>
        </footer>
      </div>
    </div>
  );
}

function BacklogPage({ board, local, selectedId, selectedSessionId, run, onSelectTodo, onSelectSession }: {
  board: Board;
  local: LocalRepo[];
  selectedId: number | null;
  selectedSessionId: string | null;
  run: (f: () => Promise<unknown>) => void;
  onSelectTodo: (id: number) => void;
  onSelectSession: (id: string) => void;
}) {
  const todos = board.todos.filter((t) => t.repos.length === 0).sort((a, b) => b.updated_at - a.updated_at);
  const inbox = board.inbox.filter((s) => (s.repos ?? []).length === 0);
  return (
    <div className="backlog">
      <h2>
        バックログ <span className="count">{todos.length}</span>
        <span className="muted hint">リポジトリ未設定の todo。リポジトリを選ぶとボードに移ります</span>
      </h2>
      {todos.length === 0 && <p className="muted empty">バックログは空です。上の欄から todo を追加できます。</p>}
      <ul className="list">
        {todos.map((t) => (
          <li key={t.id} className={`list-row${t.id === selectedId ? " selected" : ""}`} onClick={() => onSelectTodo(t.id)}>
            <span className="mono muted">#{t.id}</span>
            <span className="list-title">{t.title}</span>
            {t.status !== "todo" && <span className="tag">{t.status}</span>}
            <span className="muted">{ago(t.updated_at)}</span>
            <select
              value=""
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const u = addRepo(t, local, e.target.value);
                if (u) run(() => api.updateTodo(t.id, u));
              }}
            >
              <option value="">リポジトリを選ぶ…</option>
              {local.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.key}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      <h2>
        受信箱 <span className="count">{inbox.length}</span>
        <span className="muted hint">リポジトリの分からないセッション</span>
      </h2>
      {inbox.length === 0 && <p className="muted empty">ありません。</p>}
      <ul className="list">
        {inbox.map((s) => (
          <li key={s.session_id} className={`list-row${s.session_id === selectedSessionId ? " selected" : ""}`} onClick={() => onSelectSession(s.session_id)}>
            <KindTag session={s} />
            <span className="list-title">{sessionLabel(s)}</span>
            <StateBadge state={s.state} />
            <span className="muted">{ago(s.state_at)}</span>
            <span className="muted mono ellipsis">{basename(s.cwd)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Selection = { kind: "todo"; id: number } | { kind: "session"; id: string } | null;

export default function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [importing, setImporting] = useState(false);
  const [view, setViewState] = useState<View>(loadView);
  const setView = (v: View) => {
    saveView(v);
    setViewState(v);
  };
  const [local, setLocal] = useState<LocalRepo[]>([]);
  useEffect(() => {
    api.localRepos().then(setLocal, () => setLocal([]));
  }, []);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const toggleLane = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      saveCollapsed(next);
      return next;
    });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } }));

  const refresh = useCallback(() => {
    api.board().then(setBoard, (e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const run = (f: () => Promise<unknown>) => {
    setError(null);
    f().then(refresh, (e) => setError(String(e)));
  };

  const onDragStart = ({ active }: DragStartEvent) => setDragging(String(active.id));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const [kind, id] = String(active.id).split(/:(.*)/s);
    const [target, targetId] = String(over.id).split(/:(.*)/s);
    if (kind === "todo" && target === "col") {
      const status = targetId.split(":")[0] as Status;
      run(() => api.updateTodo(Number(id), { status }));
    } else if (kind === "session" && target === "card") {
      run(() => api.linkSession(id, Number(targetId)));
    }
  };

  const addTodo = (e: React.FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setNewTitle("");
    run(async () => {
      const todo = await api.createTodo({ title });
      setView("backlog");
      setSelection({ kind: "todo", id: todo.id });
    });
  };

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

  return (
    <div className={`app${selectedTodo || selectedSession ? " with-drawer" : ""}`}>
      <header className="topbar">
        <div className="topbar-inner">
          <h1>Todo Sessions</h1>
          <div className="segmented" role="tablist">
            <button role="tab" aria-selected={view === "board"} className={view === "board" ? "on" : ""} onClick={() => setView("board")}>
              ボード
            </button>
            <button role="tab" aria-selected={view === "backlog"} className={view === "backlog" ? "on" : ""} onClick={() => setView("backlog")}>
              バックログ <span className="count">{board?.todos.filter((t) => t.repos.length === 0).length ?? 0}</span>
            </button>
          </div>
          <form onSubmit={addTodo}>
            <input value={newTitle} placeholder="新しい todo…" onChange={(e) => setNewTitle(e.target.value)} />
            <button type="submit" disabled={!newTitle.trim()}>
              追加
            </button>
          </form>
          <button onClick={() => setImporting(true)}>issue を取り込む</button>
          <span className="muted sync">{board?.sync_status}</span>
        </div>
      </header>
      {error && (
        <div className="error" role="alert">
          {error}
          <button className="ghost icon" onClick={() => setError(null)} aria-label="閉じる">
            ×
          </button>
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        <main className="board">
          <div className="board-inner">
          {view === "backlog" && board && (
            <BacklogPage
              board={board}
              local={local}
              selectedId={selectedId}
              selectedSessionId={selectedSession?.session_id ?? null}
              run={run}
              onSelectTodo={(id) => setSelection({ kind: "todo", id })}
              onSelectSession={(id) => setSelection({ kind: "session", id })}
            />
          )}
          {view === "board" && (
          <div className="col-heads">
            {COLUMNS.map((c) => (
              <h2 key={c.status}>
                {c.label} <span className="count">{board?.todos.filter((t) => t.status === c.status).length ?? 0}</span>
              </h2>
            ))}
            <h2>
              受信箱 <span className="count">{board?.inbox.length ?? 0}</span>
              <span className="muted hint">未紐づけのセッション。カードにドラッグで紐づけ</span>
            </h2>
          </div>
          )}
          {view === "board" && board &&
            buildLanes(board).map((lane) => (
              <LaneView
                key={lane.key}
                lane={lane}
                collapsed={collapsed.has(lane.key)}
                onToggle={() => toggleLane(lane.key)}
                selectedId={selectedId}
                selectedSessionId={selectedSession?.session_id ?? null}
                onSelectTodo={(id) => setSelection({ kind: "todo", id })}
                onSelectSession={(id) => setSelection({ kind: "session", id })}
                onOpen={(sessionId) => run(() => api.openSession(sessionId))}
              />
            ))}
          {view === "board" && board && buildLanes(board).length === 0 && (
            <p className="muted empty">リポジトリに紐づいた todo はまだありません。バックログでリポジトリを選ぶか、issue を取り込んでください。</p>
          )}
          </div>
        </main>
        {/* The overlay follows the pointer across columns; the originals stay in place. */}
        <DragOverlay dropAnimation={null}>{overlay}</DragOverlay>
      </DndContext>
      {selectedTodo && <Drawer todo={selectedTodo} local={local} run={run} onClose={() => setSelection(null)} />}
      {selectedSession && board && (
        <SessionDrawer
          session={selectedSession}
          todos={board.todos}
          run={run}
          onClose={() => setSelection(null)}
          onCreated={(id) => setSelection({ kind: "todo", id })}
        />
      )}
      {importing && <ImportModal run={run} onClose={() => setImporting(false)} />}
    </div>
  );
}
