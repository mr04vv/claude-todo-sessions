import { test } from "node:test";
import assert from "node:assert/strict";
import { opensWithCtrl } from "./keymap.ts";
import { fileUrl, pathOfFileUrl } from "./tabs.ts";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey", boolean>> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent;

test("a file opens in the pane as a file URL, and outside as its path again", () => {
  const path = "/tmp/学び/20261012-oidc #1.html";
  const url = fileUrl(path);
  assert.equal(url, "file:///tmp/%E5%AD%A6%E3%81%B3/20261012-oidc%20%231.html");
  assert.equal(pathOfFileUrl(url), path);
  assert.equal(pathOfFileUrl("https://claude.ai/artifact/a"), null);
});

test("ctrl with Enter or a key that opens something opens outside", () => {
  assert.ok(opensWithCtrl(key("Enter", { ctrlKey: true })));
  assert.ok(opensWithCtrl(key("Enter", { ctrlKey: true, metaKey: true })), "⌃⌘Enter too");
  assert.ok(opensWithCtrl(key("o", { ctrlKey: true })), "o opens a session or a page");
  assert.ok(opensWithCtrl(key("p", { ctrlKey: true })), "p opens a PR");
  assert.ok(opensWithCtrl(key("O", { ctrlKey: true, shiftKey: true })), "⇧O opens a theme's note");
});

test("ctrl keeps its own keys, and nothing without ctrl changes", () => {
  assert.ok(!opensWithCtrl(key("Enter")));
  assert.ok(!opensWithCtrl(key("h", { ctrlKey: true })), "⌃h moves the typing");
  assert.ok(!opensWithCtrl(key("d", { ctrlKey: true })), "d forgets: never by ctrl");
  assert.ok(!opensWithCtrl(key("Control", { ctrlKey: true })));
});
