import { test } from "node:test";
import assert from "node:assert/strict";
import { osc52Text, paneGeometry, unwrapCopied } from "./osc52.ts";

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

// A partial selection: what the copy holds does not show the pane's width or how much of the first line was left out.
test("a pane's width stands in for the widest line, so a short copy is joined too", () => {
  const first = "あ".repeat(29); // 58 columns, ends at the edge of a 60-column pane
  assert.equal(unwrapCopied(`${first}\n続き`, { width: 60 }), `${first}続き`);
  assert.equal(unwrapCopied(`${first}\n続き`), `${first}\n続き`);
});

test("lines short of the pane's width are not joined, even when the copy's widest is near it", () => {
  const line = `  ${"あ".repeat(50)}`; // 102 columns in a 120-column pane
  assert.equal(unwrapCopied(`${line}\n  次の行`, { width: 120 }), `${line}\n  次の行`);
});

test("the first line of a selection started mid-line counts the columns left out", () => {
  const first = "あ".repeat(20); // 40 columns, from column 78 to the edge of a 120-column pane
  const copy = `${first}\n    続きの行です。`;
  assert.equal(unwrapCopied(copy, { width: 120, startCol: 78 }), `${first}続きの行です。`);
  assert.equal(unwrapCopied(copy, { width: 120 }), copy);
});

// A herdr client: a sidebar of 4 columns to the left of the panes, a tab bar of 1 row above them.
const single = { area: { x: 0, y: 0, width: 145, height: 94 }, panes: [{ rect: { x: 0, y: 0, width: 145, height: 94 } }] };
const split = {
  area: { x: 0, y: 0, width: 145, height: 94 },
  panes: [{ rect: { x: 0, y: 0, width: 72, height: 94 } }, { rect: { x: 73, y: 0, width: 72, height: 94 } }],
};
const CLIENT = { cols: 149, rows: 95 };

test("a selection's start becomes the pane's width and the column it began at in the pane", () => {
  const press = { col: 4 + 78, row: 10 };
  assert.deepEqual(paneGeometry(single, CLIENT, press, { col: 60, row: 12 }), { width: 145, startCol: 78 });
});

test("the start is the earlier end, whichever way the drag went", () => {
  const press = { col: 4 + 20, row: 12 };
  assert.deepEqual(paneGeometry(single, CLIENT, press, { col: 4 + 90, row: 10 }), { width: 145, startCol: 90 });
  assert.deepEqual(paneGeometry(single, CLIENT, { col: 4 + 90, row: 10 }, press), { width: 145, startCol: 90 });
});

test("in a split, the pane the selection started in gives the width and the origin", () => {
  assert.deepEqual(paneGeometry(split, CLIENT, { col: 4 + 73 + 5, row: 10 }, { col: 4 + 73 + 20, row: 10 }), { width: 72, startCol: 5 });
});

test("a start outside the panes (the sidebar) tells nothing", () => {
  assert.equal(paneGeometry(single, CLIENT, { col: 2, row: 10 }, { col: 40, row: 10 }), undefined);
});

// Claude Code leaves the pane's last column empty and wraps at spaces, so a long Japanese
// run with none moves to the next line whole and the line before it ends short of the edge.
const PANE = { width: 145, startCol: 0 };

test("a line breaks before a word that would not fit, so a line well short of the edge is wrapped too", () => {
  // 127 columns, and "のセル位置、herdr" (17) does not fit in the 144 left.
  const first = `${" ".repeat(111)}press と release`;
  assert.equal(unwrapCopied(`${first}\n  のセル位置、herdr のセッション名`, PANE), `${first} のセル位置、herdr のセッション名`);
});

test("the space the break took is put back between Japanese and ASCII", () => {
  const first = `${"あ".repeat(55)} 左に 4`; // 119 columns; the next word (48) does not fit
  const next = "列の折りたたみサイドバーがあるのを確認しました。";
  assert.equal(unwrapCopied(`${first}\n    ${next}`, PANE), `${first} ${next}`);
});

test("a line that fills the pane to its last column joins on, with no space between Japanese", () => {
  const full = "あ".repeat(72); // 144 columns
  assert.equal(unwrapCopied(`${full}\nました。`, PANE), `${full}ました。`);
});

test("a line whose next word fits is a line of its own", () => {
  const line = `${"あ".repeat(50)}`; // 100 columns
  assert.equal(unwrapCopied(`${line}\n  次の行`, PANE), `${line}\n  次の行`);
});

// A selection that ends mid-row holds only the start of the last row's first word.
test("the last line's word is measured on the row it was cut from", () => {
  const first = "。左に 4 列 の 4 と 列"; // 22 columns, from column 115
  const copy = `${first}\n    の間も`; // "の間も" (6) fits in the 7 left, but the row goes on: の間も、スペースが戻ります。
  const row = "  の間も、スペースが戻ります。";
  assert.equal(unwrapCopied(copy, { width: 145, startCol: 115 }), copy, "alone it looks like a line of its own");
  assert.equal(unwrapCopied(copy, { width: 145, startCol: 115, endRowText: row }), `${first}の間も`);
});

test("a row that is not the one the copy ends on is not trusted", () => {
  const first = "。左に 4 列 の 4 と 列";
  const copy = `${first}\n    の間も`;
  assert.equal(unwrapCopied(copy, { width: 145, startCol: 115, endRowText: "  別の行です、長い長い長い長い" }), copy);
});
