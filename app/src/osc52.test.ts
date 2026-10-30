import { test } from "node:test";
import assert from "node:assert/strict";
import { osc52Text, unwrapCopied } from "./osc52.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

test("an OSC 52 write gives its text, multibyte included", () => {
  assert.equal(osc52Text(`c;${b64("こんにちは herdr")}`), "こんにちは herdr");
  assert.equal(osc52Text(`;${b64("x")}`), "x");
});

test("a query, a malformed write or no target gives nothing", () => {
  assert.equal(osc52Text("c;?"), null);
  assert.equal(osc52Text("c;not base64!"), null);
  assert.equal(osc52Text("nosemicolon"), null);
});

// Claude Code wraps its text itself, at the pane's width, with a newline and the indent.
const wide = "あ".repeat(60); // 120 columns

test("lines Claude Code wrapped at the width are joined, Japanese without a space", () => {
  assert.equal(unwrapCopied(`  - ${wide}\n    続きです。\n  - 次の項目`), `  - ${wide}続きです。\n  - 次の項目`);
});

test("English wrapped at a space gets the space back", () => {
  const line = "word ".repeat(24).trim(); // 119 columns
  assert.equal(unwrapCopied(`  ${line}\n  and the rest.`), `  ${line} and the rest.`);
});

test("short lines, blank lines, list items, tables and fences stay as they are", () => {
  for (const next of ["", "  - item", "  1. item", "  | a | b |", "  ```"]) {
    assert.equal(unwrapCopied(`  ${wide}\n${next}`), `  ${wide}\n${next}`);
  }
  assert.equal(unwrapCopied(`  ${wide}\n  短い\n  次の行`), `  ${wide}短い\n  次の行`);
});

test("a copy narrower than a wrapped pane is left alone", () => {
  assert.equal(unwrapCopied("短い行\n次の行"), "短い行\n次の行");
});

test("a box-drawn table's rows stay apart", () => {
  const border = `  ┌${"─".repeat(118)}┐`;
  const row = `  │${"あ".repeat(59)}│`;
  assert.equal(unwrapCopied(`${border}\n${row}\n${row}`), `${border}\n${row}\n${row}`);
});
