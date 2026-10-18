import { test } from "node:test";
import assert from "node:assert/strict";
import { arrange, latestFirst, moveTo } from "./order.ts";

const id = (s: string) => s;

test("what was never moved comes first as it comes, then the rest as moved", () => {
  assert.deepEqual(arrange(["a", "b", "c", "d"], id, ["c", "a"]), ["b", "d", "c", "a"]);
  assert.deepEqual(arrange(["a", "b"], id, []), ["a", "b"]);
});

test("moving one onto another puts it there, and keeps the section's whole order", () => {
  assert.deepEqual(moveTo([], ["a", "b", "c"], "a", "b"), ["b", "a", "c"], "down one");
  assert.deepEqual(moveTo([], ["a", "b", "c"], "c", "b"), ["a", "c", "b"], "up one");
  assert.deepEqual(moveTo([], ["a", "b", "c"], "c", "a"), ["c", "a", "b"], "to the top");
  // Another section's order stays, ahead of this one's.
  assert.deepEqual(moveTo(["x", "a", "y"], ["a", "b"], "b", "a"), ["x", "y", "b", "a"]);
});

test("by time, the latest first, and as they come on a tie", () => {
  const items = [{ k: "a", t: 1 }, { k: "b", t: 3 }, { k: "c", t: 1 }, { k: "d", t: 2 }];
  assert.deepEqual(latestFirst(items, (i) => i.t).map((i) => i.k), ["b", "d", "a", "c"]);
});
