import { test } from "node:test";
import assert from "node:assert/strict";
import { ageGroup, arrange, latestFirst, moveTo } from "./order.ts";

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

test("a time falls in today, yesterday, the week, the month or before", () => {
  const now = new Date(2026, 9, 18, 9, 0);
  const at = (...d: [number, number, number, number?]) => new Date(...(d as [number, number, number, number])).getTime() / 1000;
  assert.equal(ageGroup(at(2026, 9, 18, 0), now), "今日");
  assert.equal(ageGroup(at(2026, 9, 17, 23), now), "昨日");
  assert.equal(ageGroup(at(2026, 9, 11, 10), now), "この1週間");
  assert.equal(ageGroup(at(2026, 8, 19, 10), now), "この1ヶ月");
  assert.equal(ageGroup(at(2026, 8, 17, 10), now), "1ヶ月以上前");
  assert.equal(ageGroup(0, now), "1ヶ月以上前", "never: the oldest");
});
