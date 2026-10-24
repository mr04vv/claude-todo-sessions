import { test } from "node:test";
import assert from "node:assert/strict";
import { addressToUrl, findTabFor, insertAfter, isSplitRight, isWorkPage, nextAfterClose, rightChildren, sameObject } from "./tabs.ts";

const tabs = (...ids: string[]) => ids.map((id) => ({ id }));

test("closing a tab shows its right neighbour", () => {
  assert.equal(nextAfterClose(tabs("a", "b", "c"), "b")?.id, "c");
});

test("closing the last tab shows its left neighbour", () => {
  assert.equal(nextAfterClose(tabs("a", "b", "c"), "c")?.id, "b");
});

test("closing the only tab leaves none", () => {
  assert.equal(nextAfterClose(tabs("a"), "a"), null);
});

test("closing a tab not in the list leaves none", () => {
  assert.equal(nextAfterClose(tabs("a", "b"), "x"), null);
});

test("a new tab goes right after the one it was opened from", () => {
  assert.deepEqual(insertAfter(tabs("a", "b", "c"), { id: "n" }, "a").map((t) => t.id), ["a", "n", "b", "c"]);
});

test("a new tab opened from nothing goes last", () => {
  assert.deepEqual(insertAfter(tabs("a", "b"), { id: "n" }, null).map((t) => t.id), ["a", "b", "n"]);
  assert.deepEqual(insertAfter(tabs("a", "b"), { id: "n" }, "gone").map((t) => t.id), ["a", "b", "n"]);
});

test("the same object ignores the fragment and a trailing slash", () => {
  assert.ok(sameObject("https://github.com/acme/web/pull/57#discussion", "https://github.com/acme/web/pull/57/"));
  assert.ok(!sameObject("https://github.com/acme/web/pull/57", "https://github.com/acme/web/pull/58"));
  assert.ok(!sameObject("https://github.com/acme/web/pull/57?tab=files", "https://github.com/acme/web/pull/57"));
});

test("a tab is found by what it was opened for, even after it moved on", () => {
  const list = [
    { id: "a", url: "https://github.com/acme/web/pull/57/files", openedFor: "https://github.com/acme/web/pull/57" },
    { id: "b", url: "https://example.com/" },
  ];
  assert.equal(findTabFor(list, "https://github.com/acme/web/pull/57")?.id, "a");
  assert.equal(findTabFor(list, "https://example.com")?.id, "b");
  assert.equal(findTabFor(list, "https://example.com/other"), undefined);
});

test("the address bar opens URLs, bare hosts and searches", () => {
  assert.equal(addressToUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(addressToUrl("example.com"), "https://example.com");
  assert.equal(addressToUrl("rust ownership"), "https://www.google.com/search?q=rust%20ownership");
  assert.equal(addressToUrl("  "), null);
});

test("a host with a port, or localhost, opens as a URL", () => {
  assert.equal(addressToUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(addressToUrl("localhost:3000/login"), "http://localhost:3000/login");
  assert.equal(addressToUrl("localhost"), "http://localhost");
  assert.equal(addressToUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(addressToUrl("example.com:8443/x"), "https://example.com:8443/x");
});

test("a split view's right is a pinned page to ask, or the page of the session on its right", () => {
  const split = [{ id: "r1" }, { id: "pinchatgpt" }, { id: "wa", session: "a" }, { id: "wb", session: "b" }];
  assert.equal(isSplitRight(split, "pinchatgpt", ["pinchatgpt"], undefined), true);
  assert.equal(isSplitRight(split, "wb", ["pinchatgpt"], "b"), true);
  assert.equal(isSplitRight(split, "wa", ["pinchatgpt"], "b"), false);
  // With no session on the right, a reading's page (which has none) is still the left.
  assert.equal(isSplitRight(split, "r1", ["pinchatgpt"], undefined), false);
});

test("a page opened beside a session in 作業 is the right, a session's page or terminal is not", () => {
  const page = { id: "p1", area: "work" as const };
  const cloud = { id: "wa", area: "work" as const, session: "a" };
  const herdr = { id: "wh1", area: "work" as const, term: {} };
  const reading = { id: "r1", area: "study" as const };
  assert.equal(isWorkPage(page), true);
  assert.equal(isWorkPage(cloud), false);
  assert.equal(isWorkPage(herdr), false);
  assert.equal(isWorkPage(reading), false);
  assert.equal(isSplitRight([page, cloud], "p1", [], undefined), true);
});

test("作業's right shows the subtasks not closed there, and the one asked for among them, else one asking, else one at work, else the first", () => {
  const kids = [{ id: 1, state: "idle" }, { id: 2, state: "needs_input" }, { id: 3, state: "running" }];
  const asks = (c: { state: string }) => c.state === "needs_input";
  const runs = (c: { state: string }) => c.state === "running";
  const shown = rightChildren(kids, [2], 3, asks, runs);
  assert.deepEqual(shown.children.map((c) => c.id), [1, 3]);
  assert.equal(shown.child?.id, 3);
  assert.equal(rightChildren(kids, [], null, asks, runs).child?.id, 2);
  assert.equal(rightChildren(kids, [2], 2, asks, runs).child?.id, 3);
  assert.equal(rightChildren(kids, [2, 3], null, asks, runs).child?.id, 1);
  assert.equal(rightChildren(kids, [1, 2, 3], 1, asks, runs).child, undefined);
});
