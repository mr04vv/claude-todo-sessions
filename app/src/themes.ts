// The learning page's themes by category (one level: a category gathers
// themes, a theme keeps its note and reviews), and the rows its list's
// cursor goes over.
import type { Category, Theme } from "./api";

/// The themes by category, in the categories' order, those in none last.
export function themeGroups(themes: Theme[], categories: Category[]): { category: Category | null; themes: Theme[] }[] {
  return [...categories.map((c) => ({ category: c, themes: themes.filter((t) => t.category_id === c.id) })), { category: null, themes: themes.filter((t) => t.category_id === null) }];
}

/// 「セキュリティ › OIDC」, or the theme's name alone when it is in no category.
export function themeLabel(t: Theme, categories: Category[]): string {
  const c = categories.find((c) => c.id === t.category_id);
  return c ? `${c.name} › ${t.name}` : t.name;
}

/// The list's rows, as the cursor goes: "unsorted" (まだテーマにないもの),
/// each category ("c:<id>") with its themes ("t:<id>") unless `folded`, then
/// the themes in none.
export function themeRows(themes: Theme[], categories: Category[], folded: Set<number>): string[] {
  return [
    "unsorted",
    ...themeGroups(themes, categories).flatMap(({ category, themes }) => [
      ...(category ? [`c:${category.id}`] : []),
      ...(category && folded.has(category.id) ? [] : themes.map((t) => `t:${t.id}`)),
    ]),
  ];
}

/// The category a new theme goes in: the one the cursor (a row) is on, or the
/// one of the theme it is on.
export function categoryAt(row: string | null, themes: Theme[]): number | null {
  if (row?.startsWith("c:")) return Number(row.slice(2));
  return (row?.startsWith("t:") && themes.find((t) => t.id === Number(row.slice(2)))?.category_id) || null;
}
