// The sessions page's tree: a todo with subtasks (an orchestrator planning
// locally, its children running on Cloud) heads a group, its own sessions
// first and its children's under them; a child not started yet is a row of
// its own, to start there. Sessions of todos without parent or children,
// and unlinked ones, follow flat.
import type { Session, SessionState, Todo } from "./api";

export interface SessionItem {
  session: Session;
  todo?: Todo;
}

export type TreeRow =
  /// A parent todo's head: its subtasks' progress.
  | { kind: "group"; id: string; todo: Todo; done: number; total: number }
  /// `group` is the parent todo it sits under (folded with it), `child` set on a subtask's.
  | { kind: "session"; id: string; session: Session; todo?: Todo; group?: number; child?: boolean; last?: boolean }
  /// A subtask with no session to show: not started, queued, or over.
  | { kind: "todo"; id: string; todo: Todo; group: number; child: true; last?: boolean; state: "none" | "queued" | "ended" };

/// How much a state asks for the user (sessions sort by it).
const STATE_RANK: Record<SessionState, number> = { needs_input: 0, running: 1, idle: 2, ended: 3 };
const TODO_RANK = 4;

export const groupRowId = (todoId: number) => `g:${todoId}`;
export const todoRowId = (todoId: number) => `t:${todoId}`;

/// `items` are the sessions to show (filtered already). `all` is every
/// session the board knows, to tell a subtask never started from one whose
/// sessions are just hidden.
export function sessionTree(items: SessionItem[], all: SessionItem[], todos: Todo[], showIdleChildren: boolean): { groups: TreeRow[][]; flat: TreeRow[] } {
  const children = (parent: Todo) => todos.filter((t) => t.parent_id === parent.id).sort((a, b) => a.id - b.id);
  const parents = todos.filter((t) => !t.parent_id && children(t).length > 0);
  const sessionsOf = (todo: Todo) => items.filter((i) => i.todo?.id === todo.id).sort(bySession);
  const groups: TreeRow[][] = [];
  for (const parent of parents) {
    const kids = children(parent);
    const rows: TreeRow[] = [{ kind: "group", id: groupRowId(parent.id), todo: parent, done: kids.filter((k) => k.status === "done").length, total: kids.length }];
    for (const { session, todo } of sessionsOf(parent)) rows.push({ kind: "session", id: session.session_id, session, todo, group: parent.id });
    const under: TreeRow[] = [];
    for (const kid of kids) {
      const shown = sessionsOf(kid);
      if (shown.length > 0) {
        for (const { session, todo } of shown) under.push({ kind: "session", id: session.session_id, session, todo, group: parent.id, child: true });
        continue;
      }
      const ever = all.some((i) => i.todo?.id === kid.id);
      const state = kid.queue_runner ? "queued" : ever ? "ended" : "none";
      // A subtask over (or done) is only shown when the hidden ones are.
      if (!showIdleChildren && (state === "ended" || kid.status === "done")) continue;
      under.push({ kind: "todo", id: todoRowId(kid.id), todo: kid, group: parent.id, child: true, state });
    }
    const tail = under[under.length - 1];
    if (tail && tail.kind !== "group") tail.last = true;
    rows.push(...under);
    // A group with nothing but its head is not shown.
    if (rows.length > 1) groups.push(rows);
  }
  const urgency = (rows: TreeRow[]) => Math.min(...rows.map((r) => (r.kind === "session" ? STATE_RANK[r.session.state] : TODO_RANK)));
  const latest = (rows: TreeRow[]) => Math.max(0, ...rows.map((r) => (r.kind === "session" ? r.session.state_at : 0)));
  groups.sort((a, b) => urgency(a) - urgency(b) || latest(b) - latest(a));
  const inTree = new Set(parents.flatMap((p) => [p.id, ...children(p).map((c) => c.id)]));
  const flat: TreeRow[] = items
    .filter((i) => !i.todo || !inTree.has(i.todo.id))
    .sort(bySession)
    .map(({ session, todo }) => ({ kind: "session", id: session.session_id, session, todo }));
  return { groups, flat };
}

const bySession = (a: SessionItem, b: SessionItem) => STATE_RANK[a.session.state] - STATE_RANK[b.session.state] || b.session.state_at - a.session.state_at;
