// What 作業's cards show, worked out apart from the page.

const KILO = 1000;
const MEGA = 1_000_000;
/// The model families a card names a Claude model by.
const FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"];

/// A parent's subtasks at a glance: done, one asking (any of its sessions
/// waits for a reply), one running, and the rest (not started, idle, in review).
export function subtaskSummary(children: { status: string; sessions: { state: string }[] }[]) {
  const asking = children.filter((c) => c.status !== "done" && c.sessions.some((s) => s.state === "needs_input")).length;
  const running = children.filter((c) => c.status !== "done" && !c.sessions.some((s) => s.state === "needs_input") && c.sessions.some((s) => s.state === "running")).length;
  const done = children.filter((c) => c.status === "done").length;
  return { total: children.length, done, asking, running, other: children.length - done - asking - running };
}

/// A model as a card names it: a Claude model by its family (opus), another as it is.
export const modelLabel = (model: string) => FAMILIES.find((f) => model.includes(f)) ?? model;

/// A context's size: 82k, 1.2M.
export const sizeLabel = (tokens: number) => (tokens >= MEGA ? `${(tokens / MEGA).toFixed(1)}M` : `${Math.max(1, Math.round(tokens / KILO))}k`);
