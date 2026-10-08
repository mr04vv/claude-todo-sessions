import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session, Todo } from "./api.ts";
import { REVIEW_SETTLE_SECS, isFailedReview, waitingOnYou } from "./waiting.ts";

const NOW = 10_000;

const session = (id: string, patch: Partial<Session> = {}): Session => ({
  session_id: id,
  title: id,
  todo_id: null,
  cwd: "/w",
  state: "idle",
  state_at: NOW - 60,
  unread: false,
  agent: "claude",
  review_url: null,
  hidden: false,
  question: null,
  review_auto: false,
  ...patch,
});

const todo = (id: number, patch: Partial<Todo> = {}): Todo =>
  ({
    id,
    title: `todo ${id}`,
    status: "doing",
    sessions: [],
    pr_url: null,
    pr_state: null,
    ci_state: null,
    ci_failed: [],
    plan: null,
    fix_count: 0,
    escalation: null,
    parent_id: null,
    ...patch,
  }) as Todo;

const pr = (n: number) => ({ url: `https://github.com/o/web/pull/${n}`, repo: "o/web", number: n, title: `PR ${n}` });

const keys = (items: { key: string }[]) => items.map((i) => i.key);

test("a session waiting for a reply waits on you, with what it asks", () => {
  const s = session("a", { state: "needs_input", question: "どちらにしますか？" });
  const items = waitingOnYou({ todos: [], inbox: [s], reviews: [], now: NOW });
  assert.deepEqual(keys(items), ["a"]);
  assert.deepEqual(items[0].reasons, ["needs_input"]);
  assert.equal(items[0].line, "どちらにしますか？");
});

test("a pending todo's session asking still waits on you", () => {
  const s = session("a", { state: "needs_input", todo_id: 1 });
  const items = waitingOnYou({ todos: [todo(1, { status: "pending", sessions: [s] })], inbox: [], reviews: [], now: NOW });
  assert.deepEqual(keys(items), ["a"]);
});

test("a failed CI waits on you through the todo's latest session, with the checks that failed", () => {
  const latest = session("new", { todo_id: 1, state_at: NOW - 10 });
  const older = session("old", { todo_id: 1, state_at: NOW - 100, state: "ended" });
  const t = todo(1, { sessions: [latest, older], pr_url: "https://github.com/acme/api/pull/120", pr_state: "review_requested", ci_state: "failure", ci_failed: ["test-api", "lint"] });
  const items = waitingOnYou({ todos: [t], inbox: [], reviews: [], now: NOW });
  assert.deepEqual(keys(items), ["new"]);
  assert.deepEqual(items[0].reasons, ["ci"]);
  assert.equal(items[0].line, "acme/api#120 の test-api・lint が失敗（2件）");
});

test("a session asking with a failed CI counts once, for both reasons", () => {
  const s = session("a", { todo_id: 1, state: "needs_input", question: "直しますか？" });
  const t = todo(1, { sessions: [s], pr_url: "https://github.com/o/r/pull/1", pr_state: "changes_requested", ci_state: "failure" });
  const items = waitingOnYou({ todos: [t], inbox: [], reviews: [], now: NOW });
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].reasons, ["needs_input", "changes", "ci"]);
  assert.equal(items[0].line, "直しますか？");
});

test("changes asked for wait on you; not while the session is fixing them", () => {
  const t = (state: Session["state"]) =>
    todo(1, { sessions: [session("a", { todo_id: 1, state })], pr_url: "https://github.com/o/r/pull/7", pr_state: "changes_requested" });
  const idle = waitingOnYou({ todos: [t("idle")], inbox: [], reviews: [], now: NOW });
  assert.deepEqual(idle[0].reasons, ["changes"]);
  assert.equal(idle[0].line, "o/r#7 に修正を頼まれました");
  assert.deepEqual(waitingOnYou({ todos: [t("running")], inbox: [], reviews: [], now: NOW }), []);
});

test("a todo done, or with its PR merged, waits on no one", () => {
  const s = session("a", { todo_id: 1 });
  const failing = { sessions: [s], pr_url: "https://github.com/o/r/pull/1", ci_state: "failure" as const };
  assert.deepEqual(waitingOnYou({ todos: [todo(1, { ...failing, status: "done", pr_state: "open" })], inbox: [], reviews: [], now: NOW }), []);
  assert.deepEqual(waitingOnYou({ todos: [todo(1, { ...failing, pr_state: "merged" })], inbox: [], reviews: [], now: NOW }), []);
});

test("a failed CI on a todo with no session waits on you through the todo", () => {
  const t = todo(3, { pr_url: "https://github.com/o/r/pull/3", pr_state: "open", ci_state: "failure" });
  const items = waitingOnYou({ todos: [t], inbox: [], reviews: [], now: NOW });
  assert.deepEqual(keys(items), ["todo:3"]);
  assert.equal(items[0].todo?.id, 3);
});

test("a review asked of you waits until a review session takes it", () => {
  const asked = waitingOnYou({ todos: [], inbox: [], reviews: [pr(61)], now: NOW });
  assert.deepEqual(keys(asked), ["pr:https://github.com/o/web/pull/61"]);
  assert.deepEqual(asked[0].reasons, ["review"]);
  assert.equal(asked[0].line, "web#61 のレビュー依頼");
  const running = session("r", { state: "running", review_url: pr(61).url });
  assert.deepEqual(waitingOnYou({ todos: [], inbox: [running], reviews: [pr(61)], now: NOW }), []);
});

test("a review that stopped without submitting waits on you once it settles", () => {
  const stopped = (ago: number, patch: Partial<Session> = {}) => session("r", { state: "idle", state_at: NOW - ago, review_url: pr(61).url, ...patch });
  assert.ok(!isFailedReview(stopped(REVIEW_SETTLE_SECS - 1), NOW), "the review may still be going in");
  assert.ok(isFailedReview(stopped(REVIEW_SETTLE_SECS), NOW));
  assert.ok(isFailedReview(stopped(REVIEW_SETTLE_SECS, { state: "ended" }), NOW));
  assert.ok(!isFailedReview(stopped(REVIEW_SETTLE_SECS, { hidden: true }), NOW), "a review put away is in");
  assert.ok(!isFailedReview(stopped(REVIEW_SETTLE_SECS, { review_url: null }), NOW));
  const items = waitingOnYou({ todos: [], inbox: [stopped(REVIEW_SETTLE_SECS)], reviews: [pr(61)], now: NOW });
  assert.deepEqual(keys(items), ["r"], "the request is taken; the stopped session is what waits");
  assert.deepEqual(items[0].reasons, ["review_failed"]);
});

test("the newest comes first", () => {
  const a = session("a", { state: "needs_input", state_at: NOW - 50 });
  const b = session("b", { state: "needs_input", state_at: NOW - 5 });
  assert.deepEqual(keys(waitingOnYou({ todos: [], inbox: [a, b], reviews: [], now: NOW })), ["b", "a"]);
});

test("a todo handed over by its orchestrator waits on you, with why", () => {
  const s = session("a", { todo_id: 2, state: "running" });
  const t = todo(2, { sessions: [s], escalation: "計画にない仕様の選択です", parent_id: 1 });
  const items = waitingOnYou({ todos: [todo(1), t], inbox: [], reviews: [], now: NOW });
  assert.deepEqual(keys(items), ["a"]);
  assert.deepEqual(items[0].reasons, ["escalated"]);
  assert.equal(items[0].line, "計画にない仕様の選択です");
  assert.deepEqual(waitingOnYou({ todos: [todo(1), { ...t, status: "done" }], inbox: [], reviews: [], now: NOW }), [], "not once it is done");
});

test("a subtask's failed CI is its orchestrator's to fix, not yours", () => {
  const orchestrator = session("o", { todo_id: 1, state: "idle" });
  const parent = todo(1, { sessions: [orchestrator] });
  const failing = todo(2, { parent_id: 1, sessions: [session("s", { todo_id: 2 })], pr_url: "https://github.com/o/r/pull/2", pr_state: "changes_requested", ci_state: "failure" });
  assert.deepEqual(waitingOnYou({ todos: [parent, failing], inbox: [], reviews: [], now: NOW }), []);
  // With the orchestrator gone (or on Cloud, which cannot be told), it is yours.
  const gone = todo(1, { sessions: [session("o", { todo_id: 1, state: "ended" })] });
  assert.equal(waitingOnYou({ todos: [gone, failing], inbox: [], reviews: [], now: NOW }).length, 1);
});
