// The app's shortcuts, each an action with one key (listed in ShortcutsDialog
// in App.tsx). A key is written as modifiers and a key, like "cmd+shift+[" or
// "ctrl+h" or "j", with the key as a key event names it. The arrow keys,
// Enter, Esc and the editing keys stay as they are.

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
  | "session"
  | "link"
  | "parent"
  | "add"
  | "editTitle"
  | "editMemo"
  | "addSubtask"
  | "start"
  | "reviewAgent"
  | "reviewSubmit"
  | "reviewRunner"
  | "slackFilter"
  | "slackReply"
  | "slackTodo"
  | "slackOpen"
  | "slackScrollDown"
  | "slackScrollUp"
  | "slackNarrower"
  | "slackWider"
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
      ["sideApp", "入力先を Todo 側へ（学ぶ時間では左へ）"],
      ["sidePane", "入力先を右のペインへ（学ぶ時間では右へ）"],
    ],
  },
  {
    group: "ブラウザ",
    items: [
      ["newTab", "新しいタブ"],
      ["closeTab", "タブを閉じる"],
      ["prevTab", "前のタブ（学ぶ時間では入力先の側のタブ、Todo では前のレーン）"],
      ["nextTab", "次のタブ（学ぶ時間では入力先の側のタブ、Todo では次のレーン）"],
      ["focusUrl", "アドレス欄へ"],
      ["terminalLinks", "ターミナルに出ているリンクを選んで開く（⌘ クリックで後ろのタブ、⌘⇧ クリックで前に開く）"],
      ["back", "戻る"],
      ["forward", "進む"],
      ["zoomIn", "拡大"],
      ["zoomOut", "縮小"],
      ["zoomReset", "実際のサイズ（ピンチの拡大も戻す）"],
      ["archive", "Cloud セッションのページをアーカイブ（セッション一覧では、行のセッションを片付ける）"],
      ["toInput", "表示中のページを学びに入れる"],
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
      ["start", "セッションを始める（起動シート。o もセッションがなければ同じ。PR の画面では PR を開く）"],
    ],
  },
  {
    group: "PR の画面（Enter でレビューを始める）",
    items: [
      ["reviewAgent", "レビューのエージェントを切り替える（Claude / Codex）"],
      ["reviewSubmit", "レビューの提出を切り替える（提出前に確認する / 自動で提出する）"],
      ["reviewRunner", "レビューが動く場所を切り替える（Cloud / herdr）"],
    ],
  },
  {
    group: "Slack の画面（Enter でスレッドを開く）",
    items: [
      ["slackFilter", "未読・メンション・既読を切り替える"],
      ["slackReply", "返信欄へ（⌘Enter で送る、Esc で一覧へ戻る）"],
      ["slackTodo", "Todo にする"],
      ["slackOpen", "Slack で開く"],
      ["slackScrollDown", "スレッドを下へ"],
      ["slackScrollUp", "スレッドを上へ"],
      ["slackNarrower", "一覧を狭める"],
      ["slackWider", "一覧を広げる"],
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

const KEYS: Record<Action, string> = {
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
  session: "o",
  link: "p",
  parent: "u",
  add: "c",
  editTitle: "e",
  editMemo: "m",
  addSubtask: "a",
  start: "cmd+Enter",
  reviewAgent: "a",
  reviewSubmit: "s",
  reviewRunner: "r",
  slackFilter: "f",
  slackReply: "r",
  slackTodo: "t",
  slackOpen: "o",
  slackScrollDown: "shift+j",
  slackScrollUp: "shift+k",
  slackNarrower: "[",
  slackWider: "]",
  search: "/",
  help: "?",
  paletteDown: "ctrl+j",
  paletteUp: "ctrl+k",
};

const MODIFIERS = ["cmd", "ctrl", "alt", "shift"] as const;
/// A shifted key names its own character on some keyboards: ⇧[ is "{".
const SHIFTED: Record<string, string> = { "{": "[", "}": "]" };

export const keyOf = (action: Action) => KEYS[action];
export const allKeys = () => KEYS;

const normal = (key: string) => {
  const k = key.length === 1 ? key.toLowerCase() : key;
  return SHIFTED[k] ?? k;
};

/// Whether the event is `action`'s key. A symbol typed with ⇧ (? on most
/// keyboards) matches a key written without it, unless another key matches
/// the ⇧ too: ⌘⇧[ (which macOS reports as "[" with ⇧, ⌘ keeping the key
/// unshifted) is the previous tab, never ⌘[.
export function matches(e: KeyboardEvent, action: Action): boolean {
  const combo = KEYS[action];
  if (matchesCombo(e, combo, true)) return true;
  return matchesCombo(e, combo) && !Object.values(KEYS).some((c) => matchesCombo(e, c, true));
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
