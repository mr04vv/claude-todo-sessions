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
  type Session,
  type SessionState,
  type Status,
  type Todo,
} from "./api";

const REFRESH_MS = 3000;
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

const OTHER_LANE = "その他";
const COLLAPSED_KEY = "collapsedLanes";

interface Lane {
  key: string;
  todos: Todo[];
  inbox: Session[];
  /// Latest activity in the lane, for ordering.
  latest: number;
}

/// One lane per repository; todos and inbox sessions without one share "その他", shown last.
function buildLanes(board: Board): Lane[] {
  const lanes = new Map<string, Lane>();
  const lane = (repo: string | null | undefined) => {
    const key = repo ?? OTHER_LANE;
    let l = lanes.get(key);
    if (!l) lanes.set(key, (l = { key, todos: [], inbox: [], latest: 0 }));
    return l;
  };
  for (const t of board.todos) {
    const l = lane(t.repo);
    l.todos.push(t);
    l.latest = Math.max(l.latest, t.updated_at, ...t.sessions.map((s) => s.state_at));
  }
  for (const s of board.inbox) {
    const l = lane(s.repo);
    l.inbox.push(s);
    l.latest = Math.max(l.latest, s.state_at);
  }
  return [...lanes.values()].sort((a, b) => {
    if (a.key === OTHER_LANE) return 1;
    if (b.key === OTHER_LANE) return -1;
    return b.latest - a.latest;
  });
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

function TodoCard({ todo, selected, onSelect }: { todo: Todo; selected: boolean; onSelect: () => void }) {
  const drag = useDraggable({ id: `todo:${todo.id}` });
  const drop = useDroppable({ id: `card:${todo.id}` });
  const live = todo.sessions.filter((s) => s.state !== "ended");
  const states = new Set(live.map((s) => s.state));
  const ref = issueRef(todo.issue_url);
  const repo = ref?.split("#")[0].split("/")[1] ?? (todo.cwd ? basename(todo.cwd) : null);
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
        {repo && <span className="tag">{repo}</span>}
        {live.length > 0 && <span className="muted">{live.length} sessions</span>}
      </div>
    </div>
  );
}

function LaneColumn({ status, laneKey, todos, selectedId, onSelect }: {
  status: Status;
  laneKey: string;
  todos: Todo[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}:${laneKey}` });
  return (
    <div ref={setNodeRef} className={`cell${isOver ? " drop-target" : ""}`}>
      {todos.map((t) => (
        <TodoCard key={t.id} todo={t} selected={t.id === selectedId} onSelect={() => onSelect(t.id)} />
      ))}
    </div>
  );
}

function LaneView({ lane, collapsed, onToggle, selectedId, selectedSessionId, onSelectTodo, onSelectSession }: {
  lane: Lane;
  collapsed: boolean;
  onToggle: () => void;
  selectedId: number | null;
  selectedSessionId: string | null;
  onSelectTodo: (id: number) => void;
  onSelectSession: (id: string) => void;
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
              todos={lane.todos.filter((t) => t.status === c.status)}
              selectedId={selectedId}
              onSelect={onSelectTodo}
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
        <span className="muted ellipsis">{basename(session.cwd)}</span>
      </div>
    </div>
  );
}

function Field({ label, value, placeholder, multiline, onSave }: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onSave(draft);
  return (
    <label className="field">
      <span>{label}</span>
      {multiline ? (
        <textarea rows={8} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
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

function Drawer({ todo, run, onClose }: {
  todo: Todo;
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
      <Field label="Issue / PR URL" value={todo.issue_url ?? ""} placeholder="https://github.com/…" onSave={(issue_url) => update({ issue_url })} />
      <Field label="作業フォルダ" value={todo.cwd ?? ""} placeholder="/Users/…/repo" onSave={(cwd) => update({ cwd })} />
      <Field label="メモ" value={todo.memo ?? ""} multiline onSave={(memo) => update({ memo })} />

      <h3>新しいセッション</h3>
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

function SessionDrawer({ session, todos, run, onClose }: {
  session: Session;
  todos: Todo[];
  run: (f: () => Promise<unknown>) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<number | "">("");
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
      <h3>todo に紐づける</h3>
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

type Selection = { kind: "todo"; id: number } | { kind: "session"; id: string } | null;

export default function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [importing, setImporting] = useState(false);
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
    run(async () => setSelection({ kind: "todo", id: (await api.createTodo({ title })).id }));
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
        <h1>Todo Sessions</h1>
        <form onSubmit={addTodo}>
          <input value={newTitle} placeholder="新しい todo…" onChange={(e) => setNewTitle(e.target.value)} />
          <button type="submit" disabled={!newTitle.trim()}>
            追加
          </button>
        </form>
        <button onClick={() => setImporting(true)}>issue を取り込む</button>
        <span className="muted sync">{board?.sync_status}</span>
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
          {board &&
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
              />
            ))}
          {board && board.todos.length === 0 && board.inbox.length === 0 && (
            <p className="muted empty">todo がありません。上の欄から追加するか、issue を取り込んでください。</p>
          )}
        </main>
        {/* The overlay follows the pointer across columns; the originals stay in place. */}
        <DragOverlay dropAnimation={null}>{overlay}</DragOverlay>
      </DndContext>
      {selectedTodo && <Drawer todo={selectedTodo} run={run} onClose={() => setSelection(null)} />}
      {selectedSession && board && (
        <SessionDrawer session={selectedSession} todos={board.todos} run={run} onClose={() => setSelection(null)} />
      )}
      {importing && <ImportModal run={run} onClose={() => setImporting(false)} />}
    </div>
  );
}
