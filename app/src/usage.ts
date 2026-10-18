// What the rail and the usage dialog show of Claude's limits and Jev's
// spend, kept apart from the components so it can be tested.

/// Jev's credit as read off TypeSafe's console (its billing page has no
/// API): the credit bought or given, and what its usage page said was spent,
/// at `at`; `base_usd` is what this app had spent by then (SpendView.all_usd),
/// so that only what it spends after counts against what was left.
export interface JevCredit {
  credit: number;
  spent: number;
  base_usd: number;
  at: number;
}

/// Jev's credit left: what the console left, less what this app spent since
/// (other users of the key, such as the X extension, are not counted).
export const jevBalance = (c: JevCredit, allUsd: number) => c.credit - c.spent - Math.max(0, allUsd - c.base_usd);

/// Whole units from this much up, in the rail.
const WHOLE_FROM = 100;

/// Money short enough for the rail: whole dollars from a hundred, cents below.
export const shortMoney = (n: number, currency: string) =>
  n.toLocaleString("ja-JP", { style: "currency", currency, minimumFractionDigits: n >= WHOLE_FROM ? 0 : 2, maximumFractionDigits: n >= WHOLE_FROM ? 0 : 2 });
