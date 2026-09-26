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

export const api = {
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
