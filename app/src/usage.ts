// How the rail shows Claude's limits, kept apart from the components so it
// can be tested.

/// Whole units from this much up, in the rail.
const WHOLE_FROM = 100;

/// Money short enough for the rail: whole dollars from a hundred, cents below.
export const shortMoney = (n: number, currency: string) =>
  n.toLocaleString("ja-JP", { style: "currency", currency, minimumFractionDigits: n >= WHOLE_FROM ? 0 : 2, maximumFractionDigits: n >= WHOLE_FROM ? 0 : 2 });
