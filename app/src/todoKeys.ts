// Keyboard for the Todo kanban and list: a cursor over the cards (or rows),
// moved with j k / h l (or the arrows; the keys are keymap.ts's, which the
// user may change), and keys acting on the todo under it:
// Enter its sheet, s its status, ⇧h ⇧l (kanban) the column it is in, o and
// ⌥Enter its session (o and ⌘Enter, without one, the launch sheet), p its PR, u its parent; c adds a todo there, / searches,
// ? lists the keys. The browser's tab keys (⌘⇧[ ⌘⇧]) go to the lane (a
// repository's, a parent's) before or after.
// It reads the page's elements, so the pages only mark them:
//   data-row="todo:<id>" on a card or row, data-row="lane:<key>" on a list
//   lane's head, data-lane="<key>" on a lane, data-col="<status>" on a
//   kanban cell. The cursor is marked with data-cursor.
// To drop it, remove this file, its use in App.tsx and those attributes.
import { useEffect, useRef, useState, type RefObject } from "react";
import { matches } from "./keymap";

export interface TodoKeyActions {
  /// Enter: the todo's panel.
  open: (todoId: number) => void;
  /// The panel following the cursor, while it is open.
  select: (todoId: number) => void;
  /// s: the status menu.
  status: (todoId: number) => void;
  /// f: the focus mode with the todo's page.
  focus: (todoId: number) => void;
  /// The kanban's ⇧h ⇧l (⇧← ⇧→): to the column before (-1) or after (1).
  shift: (todoId: number, delta: -1 | 1) => void;
  /// u: the todo's parent's panel.
  parent: (todoId: number) => void;
  /// p: the todo's PR (or issue).
  link: (todoId: number) => void;
  /// ⌘Enter, and o without a session: the launch sheet.
  start: (todoId: number) => void;
  /// ?: the list of these keys.
  help: () => void;
  /// Esc: closes the panel.
  close: () => void;
  /// The list's h / l, and Enter on a lane's head.
  toggleLane: (lane: string) => void;
  isCollapsed: (lane: string) => boolean;
}

const ROW = "[data-row]";
const LANE_ROW = "lane:";
const TODO_ROW = "todo:";
/// Lanes of a parent todo when grouped by parent (App.tsx's buildLanes).
const PARENT_LANE = "parent:";
/// Keys typed here are text, not commands.
export const TYPING = "input, textarea, select, [contenteditable], [role=menu], [role=dialog], .xterm";

const todoId = (row: string) => (row.startsWith(TODO_ROW) ? Number(row.slice(TODO_ROW.length)) : null);
const laneOf = (el: Element) => el.closest<HTMLElement>("[data-lane]")?.dataset.lane ?? null;
const colOf = (el: Element) => el.closest<HTMLElement>("[data-col]") ?? null;

/// `enabled` while the Todo page is shown and nothing covers it; `panelOpen`
/// makes the panel follow the cursor.
export function useTodoKeys(root: RefObject<HTMLElement | null>, layout: "board" | "list", enabled: boolean, panelOpen: boolean, actions: TodoKeyActions) {
  const [cursor, setCursor] = useState<string | null>(null);
  const state = useRef({ cursor, layout, enabled, panelOpen, actions });
  state.current = { cursor, layout, enabled, panelOpen, actions };

  // The mark follows every render, since the cards come and go with the board.
  useEffect(() => {
    root.current?.querySelectorAll("[data-cursor]").forEach((el) => el.removeAttribute("data-cursor"));
    if (cursor) root.current?.querySelector(`[data-row="${CSS.escape(cursor)}"]`)?.setAttribute("data-cursor", "");
  });

  useEffect(() => {
    const move = (el: HTMLElement | undefined) => {
      if (!el?.dataset.row) return;
      state.current.cursor = el.dataset.row;
      setCursor(el.dataset.row);
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const id = todoId(el.dataset.row);
      if (state.current.panelOpen && id !== null) state.current.actions.select(id);
    };
    const onKey = (e: KeyboardEvent) => {
      const { cursor, layout, enabled, actions } = state.current;
      if (!enabled || (e.target as HTMLElement).closest(TYPING)) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      const arrow = (name: string, shift = false) => plain && e.shiftKey === shift && e.key === name;
      // Page-wide: the search box, and the list of keys.
      if (matches(e, "search") || matches(e, "help")) {
        e.preventDefault();
        if (matches(e, "help")) actions.help();
        else document.querySelector<HTMLInputElement>(".filter-search")?.focus();
        return;
      }
      const rows = [...(root.current?.querySelectorAll<HTMLElement>(ROW) ?? [])];
      const at = rows.find((el) => el.dataset.row === cursor);
      const id = at ? todoId(at.dataset.row!) : null;
      // Adds a todo where the cursor is (its column on the kanban), else in the first lane.
      if (matches(e, "add")) {
        const place = at ? (colOf(at) ?? at.closest("[data-lane]")) : root.current;
        const add = place?.querySelector<HTMLButtonElement>(".add-inline") ?? at?.closest("[data-lane]")?.querySelector<HTMLButtonElement>(".add-inline");
        if (add) {
          e.preventDefault();
          add.click();
        }
        return;
      }
      if (rows.length === 0) return;
      // The lane before or after with a card (or a list lane's head), in the
      // kanban's column the cursor is in when that has one.
      // (While the pane has the typing, as App.tsx marks it, they are its tabs'.)
      if ((matches(e, "prevTab") || matches(e, "nextTab")) && !document.querySelector(".app.typing-pane")) {
        e.preventDefault();
        const dir = matches(e, "nextTab") ? 1 : -1;
        const lanes = [...(root.current?.querySelectorAll<HTMLElement>("[data-lane]") ?? [])];
        const col = at && colOf(at)?.dataset.col;
        const from = at ? lanes.findIndex((l) => l.contains(at)) : dir > 0 ? -1 : lanes.length;
        for (let i = from + dir; i >= 0 && i < lanes.length; i += dir) {
          const first = (col && lanes[i].querySelector<HTMLElement>(`[data-col="${col}"] ${ROW}`)) || lanes[i].querySelector<HTMLElement>(ROW);
          if (first) return move(first);
        }
        return;
      }
      // The session opens as its "開く" does (⌥Enter: its menu); the PR, the parent.
      const onTodo: [boolean, () => void][] = [
        [matches(e, "session"), () => (at!.querySelector<HTMLButtonElement>(".open-main") ?? { click: () => actions.start(id!) }).click()],
        [matches(e, "start"), () => actions.start(id!)],
        [e.key === "Enter" && e.altKey && !e.metaKey && !e.ctrlKey, () => at!.querySelector<HTMLButtonElement>(".open-caret")?.click()],
        [matches(e, "link"), () => actions.link(id!)],
        [matches(e, "parent"), () => actions.parent(id!)],
        [matches(e, "status"), () => actions.status(id!)],
        [matches(e, "focusTodo"), () => actions.focus(id!)],
        // Moves the card as dragging it to the next column does.
        [layout === "board" && (matches(e, "moveLeft") || arrow("ArrowLeft", true)), () => actions.shift(id!, -1)],
        [layout === "board" && (matches(e, "moveRight") || arrow("ArrowRight", true)), () => actions.shift(id!, 1)],
      ];
      const hit = onTodo.find(([yes]) => yes);
      if (hit) {
        if (id !== null) {
          e.preventDefault();
          hit[1]();
        }
        return;
      }
      if (e.key === "Escape" && plain) {
        actions.close();
        return;
      }
      const down = matches(e, "down") || arrow("ArrowDown");
      const up = matches(e, "up") || arrow("ArrowUp");
      const left = matches(e, "left") || arrow("ArrowLeft");
      const right = matches(e, "right") || arrow("ArrowRight");
      const enter = e.key === "Enter" && plain && !e.shiftKey;
      if (!(down || up || left || right || enter)) return;
      e.preventDefault();
      // The first key only puts the cursor on the first card.
      if (!at) return move(rows[0]);
      const row = at.dataset.row!;
      if (enter) {
        if (id !== null) actions.open(id);
        else {
          // A parent's lane opens the parent; other lanes fold and open.
          const lane = row.slice(LANE_ROW.length);
          if (lane.startsWith(PARENT_LANE)) actions.open(Number(lane.slice(PARENT_LANE.length)));
          else actions.toggleLane(lane);
        }
        return;
      }
      if (layout === "list") {
        const lane = row.startsWith(LANE_ROW) ? row.slice(LANE_ROW.length) : laneOf(at);
        if (down || up) return move(rows[rows.indexOf(at) + (down ? 1 : -1)]);
        if (!lane) return;
        // h folds the lane (the cursor goes to its head), l opens it.
        if (left && !actions.isCollapsed(lane)) {
          actions.toggleLane(lane);
          state.current.cursor = LANE_ROW + lane;
          setCursor(LANE_ROW + lane);
        } else if (right && actions.isCollapsed(lane)) actions.toggleLane(lane);
        return;
      }
      // Kanban: j k go through the column, from lane to lane; h l to the
      // nearest card in the next column of the lane that has one.
      const cell = colOf(at);
      if (!cell) return;
      if (down || up) {
        const inCol = rows.filter((el) => colOf(el)?.dataset.col === cell.dataset.col);
        return move(inCol[inCol.indexOf(at) + (down ? 1 : -1)]);
      }
      const cells = [...(cell.closest("[data-lane]")?.querySelectorAll<HTMLElement>("[data-col]") ?? [])];
      const index = [...cell.querySelectorAll<HTMLElement>(ROW)].indexOf(at);
      for (let i = cells.indexOf(cell) + (right ? 1 : -1); i >= 0 && i < cells.length; i += right ? 1 : -1) {
        const cards = [...cells[i].querySelectorAll<HTMLElement>(ROW)];
        if (cards.length > 0) return move(cards[Math.min(index, cards.length - 1)]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [root]);

  return { cursor, setCursor };
}
