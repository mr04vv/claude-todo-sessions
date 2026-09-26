import { invoke } from "@tauri-apps/api/core";

export type Status = "todo" | "doing" | "done";
export type SessionState = "running" | "needs_input" | "idle" | "ended";

export interface Session {
  session_id: string;
  title: string | null;
  todo_id: number | null;
  cwd: string;
  state: SessionState;
  state_at: number;
  /** `owner/repo`, present on inbox sessions. */
  repo?: string | null;
}

export interface Todo {
  id: number;
  title: string;
  status: Status;
  issue_url: string | null;
  cwd: string | null;
  memo: string | null;
  updated_at: number;
  sessions: Session[];
  /** `owner/repo` derived from the issue URL or the working folder. */
  repo: string | null;
}

export interface Board {
  todos: Todo[];
  inbox: Session[];
  sync_status: string;
}

export interface TodoInput {
  title: string;
  issue_url?: string;
  cwd?: string;
  memo?: string;
}

export interface TodoUpdate {
  title?: string;
  status?: Status;
  memo?: string;
  cwd?: string;
  issue_url?: string;
}

export interface Issue {
  number: number;
  title: string;
  url: string;
  repo: string;
  updated_at: string;
  cwd: string | null;
}

export interface IssueImport {
  title: string;
  url: string;
  cwd?: string;
}

export const api = {
  ghIssues: () => invoke<Issue[]>("gh_issues"),
  importIssues: (issues: IssueImport[]) => invoke<number>("import_issues", { issues }),
  board: () => invoke<Board>("board"),
  createTodo: (input: TodoInput) => invoke<Todo>("create_todo", { input }),
  updateTodo: (id: number, update: TodoUpdate) => invoke<Todo>("update_todo", { id, update }),
  deleteTodo: (id: number) => invoke<void>("delete_todo", { id }),
  linkSession: (sessionId: string, todoId: number) => invoke<void>("link_session", { sessionId, todoId }),
  unlinkSession: (sessionId: string) => invoke<void>("unlink_session", { sessionId }),
  openSession: (sessionId: string) => invoke<void>("open_session", { sessionId }),
  startDesktop: (todoId: number) => invoke<void>("start_desktop", { todoId }),
  startTerminal: (todoId: number) => invoke<void>("start_terminal", { todoId }),
  startCloud: (todoId: number) => invoke<void>("start_cloud", { todoId }),
};

export const isCloud = (s: Session) => s.session_id.startsWith("cse_");

/** `owner/repo#123` from a GitHub issue or PR URL, or null. */
export function issueRef(url: string | null): string | null {
  const m = url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : null;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Relative time like "3分前" for a unix timestamp in seconds. */
export function ago(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < MINUTE) return "たった今";
  if (s < HOUR) return `${Math.floor(s / MINUTE)}分前`;
  if (s < DAY) return `${Math.floor(s / HOUR)}時間前`;
  return `${Math.floor(s / DAY)}日前`;
}
