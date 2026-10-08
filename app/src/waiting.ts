// あなた待ち: what does not move on until the user does. A session waiting
// for a reply; a todo's PR whose CI failed or that was sent back for changes
// (through the todo's latest session, unless it is fixing them already); a
// review asked of the user that no review session has taken; and a review
// session that stopped without submitting; and what an orchestrator handed
// over. A subtask's PR is its orchestrator's to have fixed while one runs on
// the Mac. One session counts once, whatever its reasons.
import type { Session, Todo } from "./api";

export type WaitReason = "escalated" | "needs_input" | "changes" | "ci" | "review" | "review_failed";

/// A PR asking for the user's review.
export interface ReviewAsk {
  url: string;
  repo: string;
  number: number;
  title: string;
}

export interface WaitItem {
  /// The session's id, or `todo:<id>` / `pr:<url>` when no session stands for it.
  key: string;
  reasons: WaitReason[];
  /// What it waits for, in one line.
  line: string;
  session?: Session;
  todo?: Todo;
  review?: ReviewAsk;
  /// For the order: newest first.
  at: number;
}

/// A review session's turn may end a little before clean_reviews (each
/// minute) finds its review in and puts it away.
export const REVIEW_SETTLE_SECS = 150;

/// A review the app started that stopped (its turn over, or ended) and was
/// not put away as submitted.
export const isFailedReview = (s: Session, now: number) =>
  !!s.review_url && !s.hidden && (s.state === "idle" || s.state === "ended") && now - s.state_at >= REVIEW_SETTLE_SECS;

/// A review asked of the user, not a session's: these show as one line
/// that opens the PR page.
export const isReviewAsk = (w: WaitItem) => !!w.review && !w.session;

const PR_DONE = ["merged", "closed"];
/// Checks named in a failure's line before "ほか".
const CI_NAMES_SHOWN = 2;

/// "acme/api#120" for a PR's URL.
export const prRef = (url: string) => url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)?.slice(1).join("#") ?? url;
/// "web#61": a PR by its repository's name and number.
const shortRef = (r: ReviewAsk) => `${r.repo.split("/").pop()}#${r.number}`;

/// "acme/api#120 の test-api・lint が失敗（2件）": why a PR's CI waits on the user.
export function ciFailureLine(todo: Todo) {
  const on = todo.pr_url ? `${prRef(todo.pr_url)} の ` : "";
  const n = todo.ci_failed.length;
  if (n === 0) return `${on}CI が失敗`;
  return `${on}${todo.ci_failed.slice(0, CI_NAMES_SHOWN).join("・")}${n > CI_NAMES_SHOWN ? " ほか" : ""} が失敗（${n}件）`;
}

const LINE: Record<WaitReason, (i: WaitItem) => string> = {
  escalated: (i) => i.todo?.escalation ?? "指揮役から回されました",
  needs_input: (i) => i.session?.question ?? "返事を待っています",
  changes: (i) => `${i.todo?.pr_url ? prRef(i.todo.pr_url) : "PR"} に修正を頼まれました`,
  ci: (i) => (i.todo ? ciFailureLine(i.todo) : "CI が失敗"),
  review: (i) => (i.review ? `${shortRef(i.review)} のレビュー依頼` : "レビュー依頼"),
  review_failed: () => "レビューが提出されずに止まりました",
};

export function waitingOnYou({ todos, inbox, reviews, now }: { todos: Todo[]; inbox: Session[]; reviews: ReviewAsk[]; now: number }): WaitItem[] {
  const items = new Map<string, WaitItem>();
  const add = (key: string, reason: WaitReason, item: Omit<WaitItem, "key" | "reasons" | "line">) => {
    const known = items.get(key);
    if (known) {
      if (!known.reasons.includes(reason)) known.reasons.push(reason);
      known.todo ??= item.todo;
      return;
    }
    items.set(key, { key, reasons: [reason], line: "", ...item });
  };
  const sessions = [...todos.flatMap((t) => t.sessions.map((s) => ({ s, t }))), ...inbox.map((s) => ({ s, t: undefined }))];
  for (const { s, t } of sessions) {
    if (s.state === "needs_input") add(s.session_id, "needs_input", { session: s, todo: t, at: s.state_at });
  }
  // A todo's latest session stands for it (the board lists them newest first).
  const latestOf = (t: Todo) => [...t.sessions].sort((a, b) => b.state_at - a.state_at)[0];
  for (const t of todos) {
    if (t.status === "done" || !t.escalation) continue;
    const latest = latestOf(t);
    if (latest) add(latest.session_id, "escalated", { session: latest, todo: t, at: latest.state_at });
    else add(`todo:${t.id}`, "escalated", { todo: t, at: t.updated_at });
  }
  // A subtask's PR is its orchestrator's to have fixed while it runs on the Mac.
  const orchestrated = (t: Todo) => {
    const parent = todos.find((p) => p.id === t.parent_id);
    return !!parent?.sessions.some((s) => s.state !== "ended" && !s.session_id.startsWith("cse_"));
  };
  for (const t of todos) {
    if (t.status === "done" || !t.pr_url || (t.pr_state && PR_DONE.includes(t.pr_state)) || orchestrated(t)) continue;
    const reasons: WaitReason[] = [...(t.pr_state === "changes_requested" ? ["changes" as const] : []), ...(t.ci_state === "failure" ? ["ci" as const] : [])];
    if (reasons.length === 0) continue;
    const latest = latestOf(t);
    if (latest?.state === "running") continue;
    for (const reason of reasons) {
      if (latest) add(latest.session_id, reason, { session: latest, todo: t, at: latest.state_at });
      else add(`todo:${t.id}`, reason, { todo: t, at: t.updated_at });
    }
  }
  const reviewSessions = sessions.map(({ s }) => s).filter((s) => s.review_url);
  for (const s of reviewSessions) {
    if (isFailedReview(s, now)) add(s.session_id, "review_failed", { session: s, at: s.state_at });
  }
  for (const r of reviews) {
    if (reviewSessions.some((s) => s.review_url === r.url && !s.hidden)) continue;
    add(`pr:${r.url}`, "review", { review: r, at: 0 });
  }
  return [...items.values()].map((i) => ({ ...i, line: LINE[i.reasons[0]](i) })).sort((a, b) => b.at - a.at);
}
