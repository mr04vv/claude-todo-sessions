// The sessions page's tree: a todo with subtasks (an orchestrator planning
// locally, its children running on Cloud) heads a group, its own sessions
// first and its children's under them; a child not started yet is a row of
// its own, to start there. Sessions of todos without parent or children,
// and unlinked ones, follow flat. Todos set aside (pending) are left out,
// with their sessions.
import type { PrState, Session, Todo } from "./api";

export interface SessionItem {
  session: Session;
  todo?: Todo;
}

export type TreeRow =
  /// A parent todo's head: its subtasks' progress.
  | { kind: "group"; id: string; todo: Todo; done: number; total: number }
  /// `group` is the parent todo it sits under (folded with it), `child` set on a subtask's.
  | { kind: "session"; id: string; session: Session; todo?: Todo; group?: number; child?: boolean; last?: boolean }
  /// A subtask with no session to show: not started, or over.
  | { kind: "todo"; id: string; todo: Todo; group: number; child: true; last?: boolean; state: "none" | "ended" };

/// A PR still on its way: a subtask with one stays in sight when its sessions are over.
const PR_UNDER_WAY: PrState[] = ["open", "review_requested", "changes_requested", "approved"];

export const groupRowId = (todoId: number) => `g:${todoId}`;
export const todoRowId = (todoId: number) => `t:${todoId}`;

/// `items` are the sessions to show (filtered already). `all` is every
/// session the board knows, to tell a subtask never started from one whose
/// sessions are just hidden. Without `withTodos` (a filter is on) only
/// sessions show: no rows of subtasks without one, no group without a session.
export function sessionTree(
  items: SessionItem[],
  all: SessionItem[],
  todos: Todo[],
  showIdleChildren: boolean,
  withTodos = true,
): { groups: TreeRow[][]; flat: TreeRow[]; ordered: TreeRow[][] } {
  const aside = (todo: Todo | undefined) => todo?.status === "pending";
  const children = (parent: Todo) => todos.filter((t) => t.parent_id === parent.id).sort((a, b) => a.id - b.id);
  const parents = todos.filter((t) => !t.parent_id && !aside(t) && children(t).length > 0);
  const sessionsOf = (todo: Todo) => items.filter((i) => i.todo?.id === todo.id).sort(bySession);
  const groups: TreeRow[][] = [];
  for (const parent of parents) {
    const kids = children(parent);
    const rows: TreeRow[] = [{ kind: "group", id: groupRowId(parent.id), todo: parent, done: kids.filter((k) => k.status === "done").length, total: kids.length }];
    for (const { session, todo } of sessionsOf(parent)) rows.push({ kind: "session", id: session.session_id, session, todo, group: parent.id });
    const under: TreeRow[] = [];
    for (const kid of kids) {
      if (aside(kid)) continue;
      const shown = sessionsOf(kid);
      if (shown.length > 0) {
        for (const { session, todo } of shown) under.push({ kind: "session", id: session.session_id, session, todo, group: parent.id, child: true });
        continue;
      }
      if (!withTodos) continue;
      const ever = all.some((i) => i.todo?.id === kid.id);
      const state = ever ? "ended" : "none";
      // A subtask done, or over with no PR under way, is only shown when the hidden ones are.
      const prUnderWay = kid.pr_state !== null && PR_UNDER_WAY.includes(kid.pr_state);
      if (!showIdleChildren && (kid.status === "done" || (state === "ended" && !prUnderWay))) continue;
      under.push({ kind: "todo", id: todoRowId(kid.id), todo: kid, group: parent.id, child: true, state });
    }
    const tail = under[under.length - 1];
    if (tail && tail.kind !== "group") tail.last = true;
    rows.push(...under);
    // A group with nothing but its head is not shown.
    if (rows.length > 1) groups.push(rows);
  }
  // The group whose session changed last first.
  const latest = (rows: TreeRow[]) => Math.max(0, ...rows.map((r) => (r.kind === "session" ? r.session.state_at : 0)));
  groups.sort((a, b) => latest(b) - latest(a));
  // A pending parent takes its subtasks out with it.
  const inTree = new Set(todos.filter((t) => !t.parent_id && children(t).length > 0).flatMap((p) => [p.id, ...children(p).map((c) => c.id)]));
  const flat: TreeRow[] = items
    .filter((i) => !aside(i.todo) && (!i.todo || !inTree.has(i.todo.id)))
    .sort(bySession)
    .map(({ session, todo }) => ({ kind: "session", id: session.session_id, session, todo }));
  // Groups and lone sessions together, the one changed last first.
  const ordered = [...groups, ...flat.map((r) => [r])].sort((a, b) => latest(b) - latest(a));
  return { groups, flat, ordered };
}

/// The session that changed last first.
const bySession = (a: SessionItem, b: SessionItem) => b.session.state_at - a.session.state_at;
