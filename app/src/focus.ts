// The keyboard moves only as the result of the user's own click or key. A tab
// opened by such an action may not be ready at once (its page is still being
// made), so the action leaves a wish that the tab takes the keyboard when it
// is ready; any key or press after it (or a page taking the keyboard) makes the
// wish stale, so a page that loads late never takes the keyboard back.

/// The user's keys and presses (and the window losing the keyboard) so far.
let userInputs = 0;
let wish: { tab: string; input: boolean; text?: string; at: number } | null = null;
/// Every time the keyboard was sent somewhere on purpose.
let requests = 0;

/// A key, a press, or the keyboard going to a page: wishes made before it are stale.
export function userActed() {
  userInputs++;
}

/// Tab `tab` takes the keyboard when it is ready; with `input`, its text box,
/// with `text` typed into it.
export function focusSoon(tab: string, input = false, text?: string) {
  wish = { tab, input, text, at: userInputs };
  requests++;
}

/// The wish for `tab`, taken (once), if it is still fresh.
export function takeFocusWish(tab: string): { input: boolean; text?: string } | null {
  if (!wish || wish.tab !== tab) return null;
  const w = wish;
  wish = null;
  return w.at === userInputs ? { input: w.input, text: w.text } : null;
}

/// The keyboard was sent somewhere now (not through a wish).
export function noteFocusRequest() {
  requests++;
}

export const focusRequestCount = () => requests;
