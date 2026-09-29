// Keyboard for the Todo kanban and list: a cursor over the cards (or rows),
// moved with j k / h l (or the arrows), and keys acting on the todo under it.
// It reads the page's elements, so the pages only mark them:
//   data-row="todo:<id>" on a card or row, data-row="lane:<key>" on a list
//   lane's head, data-lane="<key>" on a lane, data-col="<status>" on a
//   kanban cell. The cursor is marked with data-cursor.
// To drop it, remove this file, its use in App.tsx and those attributes.
import { useEffect, useRef, useState, type RefObject } from "react";

export interface TodoKeyActions {
  /// Enter: the todo's panel.
  open: (todoId: number) => void;
  /// Esc: closes the panel.
  close: () => void;
  /// The list's h / l, and Enter on a lane's head.
  toggleLane: (lane: string) => void;
  isCollapsed: (lane: string) => boolean;
}

const ROW = "[data-row]";
const LANE_ROW = "lane:";
const TODO_ROW = "todo:";
/// Keys typed here are text, not commands.
const TYPING = "input, textarea, select, [contenteditable], [role=menu], [role=dialog], .xterm";

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
      if (state.current.panelOpen && id !== null) state.current.actions.open(id);
    };
    const onKey = (e: KeyboardEvent) => {
      const { cursor, layout, enabled, actions } = state.current;
      if (!enabled || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest(TYPING)) return;
      const rows = [...(root.current?.querySelectorAll<HTMLElement>(ROW) ?? [])];
      if (rows.length === 0) return;
      const at = rows.find((el) => el.dataset.row === cursor);
      const key = e.key;
      const down = key === "j" || key === "ArrowDown";
      const up = key === "k" || key === "ArrowUp";
      const left = key === "h" || key === "ArrowLeft";
      const right = key === "l" || key === "ArrowRight";
      if (key === "Escape") {
        actions.close();
        return;
      }
      if (!(down || up || left || right || key === "Enter")) return;
      e.preventDefault();
      // The first key only puts the cursor on the first card.
      if (!at) return move(rows[0]);
      const row = at.dataset.row!;
      if (key === "Enter") {
        const id = todoId(row);
        if (id !== null) actions.open(id);
        else actions.toggleLane(row.slice(LANE_ROW.length));
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
