// The links of the user's open PRs waiting on each reviewer, one a line,
// to paste into Slack.

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

/// One list per reviewer, the one with the most PRs first.
export function reviewMessages(prs: ReviewRequest[]): ReviewMessage[] {
  const by = new Map<string, ReviewRequest[]>();
  for (const p of prs) for (const r of p.reviewers) by.set(r, [...(by.get(r) ?? []), p]);
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length).map(([reviewer, list]) => ({ reviewer, prs: list, text: list.map((p) => p.url).join("\n") }));
}
