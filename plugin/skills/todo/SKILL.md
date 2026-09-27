---
name: todo
description: Link this Claude Code session to a todo, or list, create and update todos. Use when the user mentions a todo, a GitHub issue to track, or asks to link this session.
---

Use the `todo-sessions` MCP tools.

- The current session_id is in the context injected at session start ("this session's session_id is ...").
- To link this session: find the todo with `list_todos` (or `create_todo` if it does not exist), then call `link_session` with that session_id and the todo id.
- A todo can list repositories as `owner/repo` in `repos` (the first is the main one); set it when the work spans more than one repo. An entry without a slash is a free group name (e.g. `調査`) for work that belongs to no repository.
- Each todo ships as one pull request: after opening a PR for the todo, call `update_todo` with its `pr_url`.
- Do not mark a todo `done` unless the user asks.
