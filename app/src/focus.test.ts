import { test } from "node:test";
import assert from "node:assert/strict";
import { focusRequestCount, focusSoon, noteFocusRequest, takeFocusWish, userActed } from "./focus.ts";

test("a tab asked for takes the keyboard when it is ready", () => {
  focusSoon("t1");
  assert.deepEqual(takeFocusWish("t1"), { input: false, text: undefined });
  // Once only.
  assert.equal(takeFocusWish("t1"), null);
});

test("another tab does not take the wish", () => {
  focusSoon("t1", true, "hello");
  assert.equal(takeFocusWish("t2"), null);
  assert.deepEqual(takeFocusWish("t1"), { input: true, text: "hello" });
});

test("the user acting again before the tab is ready drops the wish", () => {
  focusSoon("t1");
  userActed();
  assert.equal(takeFocusWish("t1"), null);
});

test("a newer wish replaces an older one", () => {
  focusSoon("t1");
  focusSoon("t2");
  assert.equal(takeFocusWish("t1"), null);
  assert.ok(takeFocusWish("t2"));
});

test("every request is counted, so a dialog closing knows the keyboard was sent elsewhere", () => {
  const before = focusRequestCount();
  focusSoon("t1");
  noteFocusRequest();
  assert.equal(focusRequestCount(), before + 2);
});
