// Events for this window: the ones sent to it (emit_to) and to every window
// (emit), not the ones another window's tabs send to theirs.
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export const listenHere = <T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> => getCurrentWebviewWindow().listen<T>(event, handler);

/// Whether this page is the browser's own window's.
export const isBrowserWindow = () => getCurrentWebviewWindow().label === "browser";
