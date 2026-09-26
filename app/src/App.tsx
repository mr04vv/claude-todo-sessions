import { useCallback, useEffect, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { api, isCloud, type Board, type Session, type SessionState, type Status, type Todo } from "./api";

const REFRESH_MS = 3000;
/// Pointer must move this far before a click turns into a drag.
const DRAG_DISTANCE_PX = 6;

/// Cards sit inside columns, so both are under the pointer. Sessions only
/// drop onto cards and todos only onto columns.
const collision: CollisionDetection = (args) => {
  const want = String(args.active.id).startsWith("session:") ? "card:" : "col:";
  return pointerWithin(args).filter((c) => String(c.id).startsWith(want));
};

const COLUMNS: { status: Status; label: string }[] = [
  { status: "todo", label: "todo" },
  { status: "doing", label: "doing" },
  { status: "done", label: "done" },
];

const STATE_LABEL: Record<SessionState, string> = {
  running: "実行中",
  needs_input: "入力待ち",
  idle: "待機中",
  ended: "終了",
};

function sessionLabel(s: Session) {
  return s.title ?? s.session_id.slice(0, 12);
}

function StateBadge({ state }: { state: SessionState }) {
  return <span className={`badge badge-${state}`}>{STATE_LABEL[state]}</span>;
}

function KindBadge({ session }: { session: Session }) {
  return <span className="kind">{isCloud(session) ? "クラウド" : "ローカル"}</span>;
}

function TodoCard({ todo, selected, onSelect }: { todo: Todo; selected: boolean; onSelect: () => void }) {
  const drag = useDraggable({ id: `todo:${todo.id}` });
  const drop = useDroppable({ id: `card:${todo.id}` });
  const live = todo.sessions.filter((s) => s.state !== "ended");
  const states = new Set(live.map((s) => s.state));
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
      <div className="card-title">
        <span className="card-id">#{todo.id}</span> {todo.title}
      </div>
      {live.length > 0 && (
        <div className="card-meta">
          {(["needs_input", "running", "idle"] as SessionState[])
            .filter((st) => states.has(st))
            .map((st) => (
              <StateBadge key={st} state={st} />
            ))}
          <span className="muted">{live.length} セッション</span>
        </div>
      )}
    </div>
  );
}

function Column({ status, label, todos, selectedId, onSelect }: {
  status: Status;
  label: string;
  todos: Todo[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });
  return (
    <section ref={setNodeRef} className={`column${isOver ? " drop-target" : ""}`}>
      <h2>
        {label} <span className="muted">{todos.length}</span>
      </h2>
      {todos.map((t) => (
        <TodoCard key={t.id} todo={t} selected={t.id === selectedId} onSelect={() => onSelect(t.id)} />
      ))}
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
      className={`inbox-item${selected ? " selected" : ""}${isDragging ? " dragging" : ""}`}
      onClick={onSelect}
    >
      <div className="card-title">{sessionLabel(session)}</div>
      <div className="card-meta">
        <StateBadge state={session.state} />
        <KindBadge session={session} />
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

function Drawer({ todo, run, onClose }: {
  todo: Todo;
  run: (f: () => Promise<unknown>) => void;
  onClose: () => void;
}) {
  const update = (u: Parameters<typeof api.updateTodo>[1]) => run(() => api.updateTodo(todo.id, u));
  return (
    <aside className="drawer">
      <header>
        <span className="card-id">#{todo.id}</span>
        <button className="ghost" onClick={onClose} aria-label="閉じる">
          ×
        </button>
      </header>
      <Field label="タイトル" value={todo.title} onSave={(title) => update({ title })} />
      <label className="field">
        <span>status</span>
        <select value={todo.status} onChange={(e) => update({ status: e.target.value as Status })}>
          {COLUMNS.map((c) => (
            <option key={c.status} value={c.status}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <Field label="issue / PR URL" value={todo.issue_url ?? ""} placeholder="https://github.com/…" onSave={(issue_url) => update({ issue_url })} />
      <Field label="作業フォルダ（cwd）" value={todo.cwd ?? ""} placeholder="/Users/…/repo" onSave={(cwd) => update({ cwd })} />
      <Field label="メモ" value={todo.memo ?? ""} multiline onSave={(memo) => update({ memo })} />

      <h3>新しいセッションを始める</h3>
      <div className="actions">
        <button onClick={() => run(() => api.startDesktop(todo.id))}>Desktop</button>
        <button onClick={() => run(() => api.startCloud(todo.id))}>クラウド</button>
        <button onClick={() => run(() => api.startTerminal(todo.id))}>ターミナル（herdr）</button>
      </div>

      <h3>セッション</h3>
      {todo.sessions.length === 0 && <p className="muted">まだありません。受信箱からドラッグして紐づけられます。</p>}
      <ul className="sessions">
        {todo.sessions.map((s) => (
          <li key={s.session_id}>
            <div className="card-title">{sessionLabel(s)}</div>
            <div className="card-meta">
              <StateBadge state={s.state} />
              <KindBadge session={s} />
              <span className="spacer" />
              <button onClick={() => run(() => api.openSession(s.session_id))}>開く</button>
              <button className="ghost" onClick={() => run(() => api.unlinkSession(s.session_id))}>
                解除
              </button>
            </div>
          </li>
        ))}
      </ul>

      <button
        className="danger"
        onClick={() => window.confirm(`#${todo.id} を削除しますか？`) && run(async () => { await api.deleteTodo(todo.id); onClose(); })}
      >
        todo を削除
      </button>
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
        <span className="card-id">セッション</span>
        <button className="ghost" onClick={onClose} aria-label="閉じる">
          ×
        </button>
      </header>
      <h3 className="drawer-title">{sessionLabel(session)}</h3>
      <div className="card-meta">
        <StateBadge state={session.state} />
        <KindBadge session={session} />
      </div>
      <p className="muted mono">{session.cwd}</p>
      <p className="muted mono">{session.session_id}</p>
      <div className="actions">
        <button onClick={() => run(() => api.openSession(session.session_id))}>開く</button>
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

type Selection = { kind: "todo"; id: number } | { kind: "session"; id: string } | null;

export default function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
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
      run(() => api.updateTodo(Number(id), { status: targetId as Status }));
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
      return t && <div className="card overlay"><span className="card-id">#{t.id}</span> {t.title}</div>;
    }
    const s = board.inbox.find((x) => x.session_id === id);
    return s && <div className="inbox-item overlay">{sessionLabel(s)}</div>;
  })();

  return (
    <div className={`app${selectedTodo || selectedSession ? " with-drawer" : ""}`}>
      <header className="topbar">
        <h1>Todo Sessions</h1>
        <form onSubmit={addTodo}>
          <input value={newTitle} placeholder="新しい todo のタイトル" onChange={(e) => setNewTitle(e.target.value)} />
          <button type="submit">＋ 追加</button>
        </form>
        <span className="muted sync">{board?.sync_status}</span>
      </header>
      {error && (
        <div className="error" role="alert">
          {error}
          <button className="ghost" onClick={() => setError(null)} aria-label="閉じる">
            ×
          </button>
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        <main className="board">
          {COLUMNS.map((c) => (
            <Column
              key={c.status}
              status={c.status}
              label={c.label}
              todos={board?.todos.filter((t) => t.status === c.status) ?? []}
              selectedId={selectedId}
              onSelect={(id) => setSelection({ kind: "todo", id })}
            />
          ))}
          <section className="column inbox">
            <h2>
              受信箱 <span className="muted">{board?.inbox.length ?? 0}</span>
            </h2>
            <p className="muted hint">未紐づけのセッション。カードにドラッグして紐づけます。</p>
            {board?.inbox.map((s) => (
              <InboxItem
                key={s.session_id}
                session={s}
                selected={selectedSession?.session_id === s.session_id}
                onSelect={() => setSelection({ kind: "session", id: s.session_id })}
              />
            ))}
          </section>
        </main>
        {/* The overlay follows the pointer across columns; the originals stay in place. */}
        <DragOverlay dropAnimation={null}>{overlay}</DragOverlay>
      </DndContext>
      {selectedTodo && <Drawer todo={selectedTodo} run={run} onClose={() => setSelection(null)} />}
      {selectedSession && board && (
        <SessionDrawer session={selectedSession} todos={board.todos} run={run} onClose={() => setSelection(null)} />
      )}
    </div>
  );
}
