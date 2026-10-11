import { test } from "node:test";
import assert from "node:assert/strict";
import type { Category, Theme } from "./api.ts";
import { categoryAt, themeGroups, themeLabel, themeRows } from "./themes.ts";

const theme = (id: number, name: string, category_id: number | null): Theme => ({ id, name, goal: null, doc_url: null, updated_at: 0, category_id });
const categories: Category[] = [
  { id: 1, name: "セキュリティ" },
  { id: 2, name: "パフォーマンス" },
];
const themes = [theme(10, "OIDC", 1), theme(11, "Rust", null), theme(12, "CSP", 1), theme(13, "Core Web Vitals", 2)];

test("themes go by category, in the categories' order, those in none last", () => {
  assert.deepEqual(
    themeGroups(themes, categories).map(({ category, themes }) => [category?.name ?? null, themes.map((t) => t.name)]),
    [
      ["セキュリティ", ["OIDC", "CSP"]],
      ["パフォーマンス", ["Core Web Vitals"]],
      [null, ["Rust"]],
    ],
  );
});

test("a theme is labelled with its category", () => {
  assert.equal(themeLabel(themes[0], categories), "セキュリティ › OIDC");
  assert.equal(themeLabel(themes[1], categories), "Rust");
});

test("the list's rows are the unsorted, each category and its themes unless folded, then the themes in none", () => {
  assert.deepEqual(themeRows(themes, categories, new Set([2])), ["unsorted", "c:1", "t:10", "t:12", "c:2", "t:11"]);
  const uncategorized = themes.map((t) => ({ ...t, category_id: null }));
  assert.deepEqual(themeRows(uncategorized, [], new Set()), ["unsorted", "t:10", "t:11", "t:12", "t:13"], "with no categories, the themes alone");
});

test("a new theme goes in the category the cursor is on, or the one of the theme it is on", () => {
  assert.equal(categoryAt("c:2", themes), 2);
  assert.equal(categoryAt("t:12", themes), 1);
  assert.equal(categoryAt("t:11", themes), null);
  assert.equal(categoryAt("unsorted", themes), null);
});
