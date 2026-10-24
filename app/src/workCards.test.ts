import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLabel, sizeLabel, subtaskSummary } from "./workCards.ts";

const sub = (status: string, ...states: string[]) => ({ status, sessions: states.map((state) => ({ state })) });

test("a parent's subtasks count as done, asking, running and the rest, each once", () => {
  const s = subtaskSummary([sub("done", "ended"), sub("doing", "needs_input", "running"), sub("doing", "running"), sub("todo"), sub("review", "idle")]);
  assert.deepEqual(s, { total: 5, done: 1, asking: 1, running: 1, other: 2 });
});

test("a model shows by its family, a context by its size in k", () => {
  assert.equal(modelLabel("claude-opus-5-5"), "opus");
  assert.equal(modelLabel("claude-sonnet-5-5-20260101"), "sonnet");
  assert.equal(modelLabel("gpt-5-codex"), "gpt-5-codex");
  assert.equal(sizeLabel(82_110), "82k");
  assert.equal(sizeLabel(900), "1k");
  assert.equal(sizeLabel(1_234_567), "1.2M");
});
