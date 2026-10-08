// The app's shortcuts, each an action with one key the user can change
// (ShortcutsDialog in App.tsx). A key is written as modifiers and a key, like
// "cmd+shift+[" or "ctrl+h" or "j", with the key as a key event names it.
// The arrow keys, Enter, Esc and the editing keys stay as they are.
import { useSyncExternalStore } from "react";

export type Action =
  | "palette"
  | "sessions"
  | "newTodo"
  | "newTab"
  | "closeTab"
  | "prevTab"
  | "nextTab"
  | "reload"
  | "sideApp"
  | "sidePane"
  | "archive"
  | "toInput"
  | "focusUrl"
  | "terminalLinks"
  | "back"
  | "forward"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "down"
  | "up"
  | "left"
  | "right"
  | "moveLeft"
  | "moveRight"
  | "status"
  | "focusTodo"
  | "session"
  | "link"
  | "parent"
  | "add"
  | "editTitle"
  | "editMemo"
  | "addSubtask"
  | "start"
  | "search"
  | "help"
  | "paletteDown"
  | "paletteUp";

/// Grouped as the shortcuts dialog shows them, with what each does.
export const ACTIONS: { group: string; items: [Action, string][] }[] = [
  {
    group: "どこでも",
    items: [
      ["palette", "コマンド（⌘K のメニュー）"],
      ["sessions", "セッション一覧（⌘K の一番上）"],
      ["newTodo", "新しい todo（Input の画面では input）"],
      ["reload", "今の画面を取り直す（ページでは再読み込み）"],
      ["sideApp", "入力先を Todo 側へ（Input モードでは左へ）"],
      ["sidePane", "入力先を右のペインへ（Input モードでは右へ）"],
    ],
  },
  {
    group: "ブラウザ",
    items: [
      ["newTab", "新しいタブ"],
      ["closeTab", "タブを閉じる"],
      ["prevTab", "前のタブ（Input モードでは入力先の側のタブ、Todo では前のレーン）"],
      ["nextTab", "次のタブ（Input モードでは入力先の側のタブ、Todo では次のレーン）"],
      ["focusUrl", "アドレス欄へ"],
      ["terminalLinks", "ターミナルに出ているリンクを選んで開く（⌘ クリックで後ろのタブ、⌘⇧ クリックで前に開く）"],
      ["back", "戻る"],
      ["forward", "進む"],
      ["zoomIn", "拡大"],
      ["zoomOut", "縮小"],
      ["zoomReset", "実際のサイズ（ピンチの拡大も戻す）"],
      ["archive", "Cloud セッションのページをアーカイブ（セッション一覧では、行のセッションを片付ける）"],
      ["toInput", "表示中のページを input に追加"],
    ],
  },
  {
    group: "一覧（Todo・セッション・PR・メニュー）",
    items: [
      ["down", "下へ（ブラウザのページではスクロール）"],
      ["up", "上へ（ブラウザのページではスクロール）"],
      ["left", "左へ（リストはレーンを畳む）"],
      ["right", "右へ（リストはレーンを開く）"],
      ["moveLeft", "カンバン：カードを左の列へ"],
      ["moveRight", "カンバン：カードを右の列へ"],
      ["status", "ステータスを変える"],
      ["focusTodo", "Todo： Input モードで開く（添付の URL を左に）"],
      ["session", "セッションを開く"],
      ["link", "PR / issue を開く"],
      ["parent", "親の todo を開く"],
      ["add", "その場所に todo を追加"],
      ["search", "絞り込み欄へ"],
      ["help", "キーの一覧"],
    ],
  },
  {
    group: "todo のシート",
    items: [
      ["editTitle", "タイトルを編集"],
      ["editMemo", "メモを編集"],
      ["addSubtask", "サブタスクを追加"],
      ["start", "セッションを始める（起動シート。o もセッションがなければ同じ）"],
    ],
  },
  {
    group: "⌘K のメニュー",
    items: [
      ["paletteDown", "下へ"],
      ["paletteUp", "上へ"],
    ],
  },
];

export const DEFAULT_KEYS: Record<Action, string> = {
  palette: "cmd+k",
  sessions: "cmd+shift+k",
  newTodo: "cmd+n",
  newTab: "cmd+t",
  closeTab: "cmd+w",
  prevTab: "cmd+shift+[",
  nextTab: "cmd+shift+]",
  reload: "cmd+r",
  sideApp: "ctrl+h",
  sidePane: "ctrl+l",
  archive: "cmd+shift+a",
  // As Safari's "Add to Reading List".
  toInput: "cmd+shift+d",
  focusUrl: "cmd+l",
  terminalLinks: "cmd+shift+l",
  back: "cmd+[",
  forward: "cmd+]",
  zoomIn: "cmd+=",
  zoomOut: "cmd+-",
  zoomReset: "cmd+0",
  down: "j",
  up: "k",
  left: "h",
  right: "l",
  moveLeft: "shift+h",
  moveRight: "shift+l",
  status: "s",
  focusTodo: "f",
  session: "o",
  link: "p",
  parent: "u",
  add: "c",
  editTitle: "e",
  editMemo: "m",
  addSubtask: "a",
  start: "cmd+Enter",
  search: "/",
  help: "?",
  paletteDown: "ctrl+j",
  paletteUp: "ctrl+k",
};

const KEYS_KEY = "shortcuts";
const MODIFIERS = ["cmd", "ctrl", "alt", "shift"] as const;
/// A shifted key names its own character on some keyboards: ⇧[ is "{".
const SHIFTED: Record<string, string> = { "{": "[", "}": "]" };

function loadKeys(): Record<Action, string> {
  try {
    return { ...DEFAULT_KEYS, ...JSON.parse(localStorage.getItem(KEYS_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_KEYS };
  }
}

let keys = loadKeys();
const listeners = new Set<() => void>();

export const keyOf = (action: Action) => keys[action];
export const allKeys = () => keys;

export function setKeys(next: Partial<Record<Action, string>>) {
  keys = { ...keys, ...next };
  try {
    localStorage.setItem(KEYS_KEY, JSON.stringify(keys));
  } catch {
    // The keys still apply until the app closes.
  }
  listeners.forEach((f) => f());
}

export const resetKeys = () => setKeys({ ...DEFAULT_KEYS });

/// Re-renders when a key changes.
export function useKeymap() {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => keys,
  );
}

const normal = (key: string) => {
  const k = key.length === 1 ? key.toLowerCase() : key;
  return SHIFTED[k] ?? k;
};

/// The key as written here, from a key event; null for a lone modifier.
export function comboOf(e: KeyboardEvent): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  const mods = [e.metaKey && "cmd", e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean);
  return [...mods, normal(e.key)].join("+");
}

/// Whether the event is `action`'s key. A symbol typed with ⇧ (? on most
/// keyboards) matches a key written without it, unless another key matches
/// the ⇧ too: ⌘⇧[ (which macOS reports as "[" with ⇧, ⌘ keeping the key
/// unshifted) is the previous tab, never ⌘[.
export function matches(e: KeyboardEvent, action: Action): boolean {
  const combo = keys[action];
  if (matchesCombo(e, combo, true)) return true;
  return matchesCombo(e, combo) && !Object.values(keys).some((c) => matchesCombo(e, c, true));
}

/// `exact` leaves out the ⇧ a symbol may come with.
export function matchesCombo(e: KeyboardEvent, combo: string, exact = false): boolean {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const has = (m: (typeof MODIFIERS)[number]) => parts.includes(m);
  const symbol = !exact && key.length === 1 && !/[a-z0-9]/.test(key) && e.key === key;
  return (
    normal(e.key) === key &&
    e.metaKey === has("cmd") &&
    e.ctrlKey === has("ctrl") &&
    e.altKey === has("alt") &&
    (e.shiftKey === has("shift") || (symbol && !has("shift")))
  );
}

const GLYPHS: Record<string, string> = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const KEY_NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "Enter", Escape: "Esc", " ": "Space", Backspace: "⌫", Tab: "Tab" };

/// "cmd+shift+[" as ⌘⇧[.
export function keyLabel(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  return parts.map((m) => GLYPHS[m] ?? m).join("") + (KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key));
}
