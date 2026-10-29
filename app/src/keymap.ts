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
  | "closeRow"
  | "prevTab"
  | "nextTab"
  | "reload"
  | "sideApp"
  | "sidePane"
  | "archive"
  | "bookmark"
  | "studyThis"
  | "askChatGpt"
  | "scrollDown"
  | "scrollUp"
  | "spaceManage"
  | "spaceWork"
  | "spaceStudy"
  | "spaceBrowser"
  | "spaceSlack"
  | "spaceArtifacts"
  | "focusUrl"
  | "terminalLinks"
  | "workRight"
  | "workArtifacts"
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
  | "prFilter"
  | "showTodo"
  | "workFix"
  | "workHandled"
  | "workEnded"
  | "workLink"
  | "workSort"
  | "workMoveDown"
  | "workMoveUp"
  | "slackFilter"
  | "slackCompose"
  | "slackDone"
  | "slackForget"
  | "slackMute"
  | "slackMuteChannel"
  | "slackBookmark"
  | "slackReact"
  | "slackReply"
  | "slackTodo"
  | "slackOpen"
  | "slackScrollDown"
  | "slackScrollUp"
  | "slackNarrower"
  | "slackWider"
  | "studyPick"
  | "studyRead"
  | "studyBrowser"
  | "studyForget"
  | "studyTags"
  | "studyKind"
  | "studyCopy"
  | "studyDigest"
  | "studyPodcast"
  | "studyChapter"
  | "studyKeep"
  | "studyList"
  | "artifactForget"
  | "search"
  | "todoView"
  | "help"
  | "paletteDown"
  | "paletteUp";

/// Grouped as the shortcuts dialog shows them, with what each does.
export const ACTIONS: { group: string; items: [Action, string][] }[] = [
  {
    group: "どこでも",
    items: [
      ["spaceManage", "管理へ（Todo・PR・DB）"],
      ["spaceWork", "作業へ（セッション）"],
      ["spaceStudy", "学習へ（読みもの）"],
      ["spaceBrowser", "ブラウザのウインドウを前に出す（⌘T で新しいタブ、⌘W でタブを閉じる）"],
      ["spaceSlack", "Slack へ"],
      ["spaceArtifacts", "成果物へ（セッションが作った Doc・Artifact・ファイル）"],
      ["palette", "コマンド（⌘K のメニュー）"],
      ["sessions", "セッション一覧（⌘K の一番上）"],
      ["newTodo", "新しい todo"],
      ["reload", "今の画面を取り直す（ページでは再読み込み）"],
      ["sideApp", "入力先を左へ（ページから一覧、一覧から管理のサイドバー・学習の絞り込み、いちばん左は場のアイコン）"],
      ["sidePane", "入力先を右へ（ページ、作業・学習では右のページ）"],
      ["workRight", "作業の右側（サブタスクと、横に開いたページ）を隠す・出す"],
      ["workArtifacts", "作業の右側に、このセッション（サブタスクも）の成果物を出す・戻す（j k で選んで Enter で横に、⌘Enter でブラウザに）"],
    ],
  },
  {
    group: "ブラウザ",
    items: [
      ["newTab", "新しいタブ"],
      ["closeTab", "タブを閉じる"],
      ["closeRow", "タブの一覧で、カーソルのあるタブを閉じる（開いていなくても）"],
      ["prevTab", "前のタブ（作業・学習では入力先の側のタブ、Todo では前のレーン）"],
      ["nextTab", "次のタブ（作業・学習では入力先の側のタブ、Todo では次のレーン）"],
      ["focusUrl", "アドレス欄へ"],
      ["terminalLinks", "ターミナルやページに出ているリンクを選んで開く（ターミナルでは Enter で横に、⌘Enter でブラウザに。⌘ クリックと ⌘⇧ クリックも同じ。ページでは新しいタブに）"],
      ["back", "戻る"],
      ["forward", "進む"],
      ["zoomIn", "拡大"],
      ["zoomOut", "縮小"],
      ["zoomReset", "実際のサイズ（ピンチの拡大も戻す）"],
      ["archive", "Cloud セッションのページをアーカイブ（作業の一覧では、行のセッションを片付ける）"],
      ["bookmark", "表示中のページを読みものに入れる（O'Reilly の本のページなら本として目次ごと）"],
      ["studyThis", "表示中のページを読みものに入れて、すぐ学習で読む（右に NotebookLM など）"],
      ["scrollDown", "ページを下へスクロール"],
      ["scrollUp", "ページを上へスクロール"],
      ["askChatGpt", "ブラウザのウインドウで、表示中のページ（選んだ文があればその文）を右の ChatGPT に解説してもらう"],
    ],
  },
  {
    group: "一覧（Todo・PR・作業・学習・ブラウザのタブ・メニュー）",
    items: [
      ["down", "下へ（ブラウザのページでは、Google の検索結果なら結果を選ぶ）"],
      ["up", "上へ（ブラウザのページでは、Google の検索結果なら結果を選ぶ）"],
      ["left", "左へ（リストはレーンを畳む）"],
      ["right", "右へ（リストはレーンを開く）"],
      ["moveLeft", "カンバン：カードを左の列へ"],
      ["moveRight", "カンバン：カードを右の列へ"],
      ["status", "ステータスを変える"],
      ["session", "作業で開く（終わったセッションは再開、セッションがなければ起動シート）"],
      ["showTodo", "その todo を管理で開く（PR・作業の一覧）"],
      ["link", "PR / issue を開く"],
      ["parent", "親の todo を開く"],
      ["add", "その場所に todo を追加"],
      ["search", "絞り込み欄へ"],
      ["todoView", "Todo：カンバン・リスト・Doing を切り替える"],
      ["help", "キーの一覧"],
    ],
  },
  {
    group: "todo のシート",
    items: [
      ["editTitle", "タイトルを編集"],
      ["editMemo", "メモを編集"],
      ["addSubtask", "サブタスクを追加"],
      ["start", "セッションを始める（起動シート。o もセッションがなければ同じ。PR の画面では GitHub で見る。作業では空いている側のボタン：始める・再開・開く）"],
    ],
  },
  {
    group: "PR の画面（J K で選ぶ、Enter でレビューを始める・元のセッションに直させる、o で作業で開く）",
    items: [
      ["prFilter", "すべて・レビュー依頼・自分の PR を切り替える"],
      ["reviewAgent", "レビューのエージェントを切り替える（Claude / Codex）"],
      ["reviewSubmit", "レビューの提出を切り替える（提出前に確認する / 自動で提出する）"],
      ["reviewRunner", "レビューが動く場所を切り替える（Cloud / herdr）"],
    ],
  },
  {
    group: "作業の一覧（J K で選ぶ、Enter で開く）",
    items: [
      ["workFix", "あなた待ちの CI の失敗・修正の依頼を、元のセッションに直させる"],
      ["workHandled", "指揮役から回されたものに対応した（あなた待ちから外す）"],
      ["workEnded", "終了したセッションを出す・隠す"],
      ["workLink", "選んでいるセッションを todo に紐づける（紐づいていれば外す）"],
      ["workSort", "並べ方を切り替える（手で並べた順・動きがあった順・始めた順）"],
      ["workMoveDown", "選んでいる行を下へ（並べ替え。ドラッグでも。手で並べた順になる）"],
      ["workMoveUp", "選んでいる行を上へ（並べ替え。ドラッグでも。手で並べた順になる）"],
    ],
  },
  {
    group: "Slack の画面（Enter でスレッドを開く）",
    items: [
      ["slackFilter", "未読・メンション・スレッド・既読・ブックマークを切り替える"],
      ["slackDone", "Done（そのスレッドのメンションと返信を既読にして一覧から消し、次へ進む）"],
      ["slackForget", "消す（もう一度押すと、そのスレッドのメンションをこの Mac からも消し、スレッドを追うのもやめる。Esc でやめる）"],
      ["slackCompose", "新しいメッセージ（入っているチャンネルへ）"],
      ["slackMute", "このスレッドの返信を数えない／また数える"],
      ["slackBookmark", "選んでいるメッセージをブックマークする／外す（スレッドの先頭ならスレッド。f の「ブックマーク」で一覧）"],
      ["slackReact", "選んでいるメッセージにリアクションを付ける（絵文字の名前を入れて Enter、Esc でやめる）"],
      ["slackMuteChannel", "このチャンネルを Shosai でミュート（メンションも返信も届かない。解除は設定の Slack）"],
      ["slackReply", "返信欄へ（⌘Enter で送る、Esc で一覧へ戻る）"],
      ["slackTodo", "Todo にする"],
      ["slackOpen", "Slack で開く"],
      ["slackScrollDown", "スレッドの次のメッセージへ（Todo にするのは選んでいるメッセージ）"],
      ["slackScrollUp", "スレッドの前のメッセージへ"],
      ["slackNarrower", "一覧を狭める"],
      ["slackWider", "一覧を広げる"],
    ],
  },
  {
    group: "学習の一覧（J K で選ぶ、Enter で読む）",
    items: [
      ["studyPick", "選ぶ・外す（選んだものはまとめて読む）"],
      ["studyRead", "選んだものをまとめて読む"],
      ["studyBrowser", "ブラウザで開く"],
      ["studyForget", "消す（もう一度押すと消す、Esc でやめる）"],
      ["studyTags", "タグを直す"],
      ["studyKind", "種類を切り替える（すべて・記事・X の投稿・本）"],
      ["studyCopy", "選んだもの（なければカーソルの行、読んでいるときは開いているもの）の URL をコピー（NotebookLM 用）"],
      ["studyDigest", "選んだもの（なければカーソルの行）で日報を作る"],
      ["studyPodcast", "選んだもの（なければカーソルの行）で音声つきの日報を作る（Gemini の API キーが要る）"],
      ["studyChapter", "目次：章を読んだ・まだにする（Enter でその章へ）"],
      ["studyKeep", "読んで良かったものを残す（もう一度で「これから読む」に戻す。読んでいる画面でも）"],
      ["studyList", "読んでいるところと一覧を行き来する（一覧では、消すのや選ぶのをやめるのが先）"],
    ],
  },
  {
    group: "成果物の画面（J K で選ぶ、Enter で開く）",
    items: [["artifactForget", "一覧から消す"]],
  },
  {
    group: "⌘K のメニュー",
    items: [
      ["paletteDown", "下へ（一覧・メニューでも）"],
      ["paletteUp", "上へ（一覧・メニューでも）"],
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
  bookmark: "cmd+shift+d",
  studyThis: "cmd+shift+s",
  askChatGpt: "cmd+shift+g",
  scrollDown: "shift+j",
  scrollUp: "shift+k",
  spaceManage: "cmd+1",
  spaceWork: "cmd+2",
  spaceStudy: "cmd+3",
  spaceBrowser: "cmd+4",
  spaceSlack: "cmd+5",
  spaceArtifacts: "cmd+6",
  focusUrl: "cmd+l",
  terminalLinks: "cmd+shift+l",
  workRight: "cmd+shift+e",
  workArtifacts: "cmd+shift+o",
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
  prFilter: "f",
  showTodo: "t",
  workFix: "f",
  workHandled: "d",
  closeRow: "d",
  workEnded: "e",
  workLink: "l",
  workSort: "s",
  workMoveDown: "shift+j",
  workMoveUp: "shift+k",
  slackFilter: "f",
  slackDone: "e",
  slackForget: "d",
  slackCompose: "c",
  slackMute: "m",
  slackMuteChannel: "shift+m",
  slackBookmark: "b",
  slackReact: ":",
  slackReply: "r",
  slackTodo: "t",
  slackOpen: "o",
  slackScrollDown: "shift+j",
  slackScrollUp: "shift+k",
  slackNarrower: "[",
  slackWider: "]",
  studyPick: " ",
  studyRead: "cmd+Enter",
  studyBrowser: "o",
  studyForget: "d",
  studyTags: "t",
  studyKind: "f",
  studyCopy: "c",
  studyDigest: "n",
  studyPodcast: "p",
  studyChapter: "m",
  studyKeep: "s",
  studyList: "Escape",
  artifactForget: "d",
  search: "/",
  todoView: "f",
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

/// The keys that open something (a session, a page), besides Enter.
const OPENING: Action[] = ["session", "link", "slackOpen", "studyBrowser"];

/// Whether a key with ctrl is one that opens, ctrl asking for the default
/// browser: Enter (⌘Enter too), or an opening key, ctrl being none of its own.
export function opensWithCtrl(e: KeyboardEvent): boolean {
  if (!e.ctrlKey) return false;
  if (e.key === "Enter") return true;
  const plain = { key: e.key, ctrlKey: false, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey } as KeyboardEvent;
  return OPENING.some((a) => matches(plain, a));
}

const GLYPHS: Record<string, string> = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const KEY_NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "Enter", Escape: "Esc", " ": "Space", Backspace: "⌫", Tab: "Tab" };

/// "cmd+shift+[" as ⌘⇧[.
export function keyLabel(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  return parts.map((m) => GLYPHS[m] ?? m).join("") + (KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key));
}
