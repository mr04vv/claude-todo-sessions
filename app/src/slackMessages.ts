// Slack messages asking for the reviews the user's open PRs wait on: one per
// reviewer (their PRs together), or one for all of them. Text only, to paste.

export interface ReviewRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  /// A user's GitHub login, or a team's slug.
  reviewers: string[];
}

export interface ReviewMessage {
  reviewer: string;
  prs: ReviewRequest[];
  text: string;
}

const ASK = "レビューをお願いします";
const prLines = (p: ReviewRequest, after = "") => `• ${p.repo}#${p.number} ${p.title}${after}\n  ${p.url}`;
const count = (n: number) => (n > 1 ? `（${n}件）` : "");

/// One message per reviewer, the one with the most PRs first. `mention`
/// writes a reviewer as Slack is to see them (@name).
export function reviewMessages(prs: ReviewRequest[], mention: (reviewer: string) => string): ReviewMessage[] {
  const by = new Map<string, ReviewRequest[]>();
  for (const p of prs) for (const r of p.reviewers) by.set(r, [...(by.get(r) ?? []), p]);
  return [...by.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([reviewer, list]) => ({ reviewer, prs: list, text: `${mention(reviewer)}\n${ASK}${count(list.length)}\n${list.map((p) => prLines(p)).join("\n")}` }));
}

/// Every PR in one message, each with whom it asks.
export function allInOneMessage(prs: ReviewRequest[], mention: (reviewer: string) => string): string {
  return `${ASK}${count(prs.length)}\n${prs.map((p) => prLines(p, ` → ${p.reviewers.map(mention).join(" ")}`)).join("\n")}`;
}
