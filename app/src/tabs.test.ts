import { test } from "node:test";
import assert from "node:assert/strict";
import { addressToUrl, findTabFor, insertAfter, nextAfterClose, sameObject } from "./tabs.ts";

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
