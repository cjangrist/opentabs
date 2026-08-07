# Claude

OpenTabs plugin for Claude — gives AI agents access to Claude through your authenticated browser session.

## Install

```bash
opentabs plugin install claude
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-claude
```

## Setup

1. Open [claude.ai](https://claude.ai) in Chrome and log in
2. Open the OpenTabs side panel — the Claude plugin should appear as **ready**

## Tools (24)

Every tool follows the repo-wide [`SPEC.md`](../SPEC.md) contract: `list_*` tools take
`cursor` / `limit` / `fetch_all` / `max_items` and return
`items` / `next_cursor` / `has_more` / `total` / `page_info`, and conversation reads return
an ordered array of OpenAI-Responses-style items.

### Account (4)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the current user profile and active organization | Read |
| `list_organizations` | List organizations (paginated) | Read |
| `list_models` | List models, parsed live from the org's model picker config | Read |
| `list_capabilities` | Every model, toggle and feature this provider supports | Read |

### Conversations (7)

| Tool | Description | Type |
|---|---|---|
| `list_conversations` | List conversations (paginated) | Read |
| `search_conversations` | Full-text search — one relevance page, no cursor | Read |
| `get_conversation` | Read a conversation as normalized items | Read |
| `create_conversation` | Create a conversation and send its first message | Write |
| `send_message` | Send a message and get the reply | Write |
| `rename_conversation` | Rename a conversation | Write |
| `delete_conversation` | Delete a conversation | Write |

### Projects (9)

| Tool | Description | Type |
|---|---|---|
| `list_projects` | List projects (paginated, real total) | Read |
| `get_project` | Get a project with its conversation count | Read |
| `list_project_conversations` | List a project's conversations (paginated) | Read |
| `create_project` | Create a project | Write |
| `update_project` | Rename a project or change its description | Write |
| `delete_project` | Delete a project (and the conversations inside it) | Write |
| `add_conversation_to_project` | Put a conversation into a project | Write |
| `remove_conversation_from_project` | Take a conversation out of its project | Write |
| `move_conversation_to_project` | Move a conversation between projects | Write |

### Research (4)

| Tool | Description | Type |
|---|---|---|
| `start_deep_research` | Start Claude's Research feature; returns immediately | Write |
| `get_deep_research` | Poll a research run | Read |
| `answer_deep_research` | Answer a clarifying question and resume | Write |
| `cancel_deep_research` | Stop a running research task | Write |

## Notes

- **Not supported:** archiving a conversation — claude.ai's row menu offers Pin, Mark as
  unread, Rename, Add to project and Delete only. `list_capabilities().features` says so
  with a reason.
- **Thinking:** `thinking` maps to Claude's `thinking_mode`, `thinking_level` to its
  reasoning effort (`minimal→low, low→low, medium→medium, high→high, max→max`, falling back
  to the nearest lower step a model publishes). Claude's native `xhigh` is reported in
  `capabilities.thinking.levels` but is not reachable through the normalized ladder.
- **Long replies:** the OpenTabs adapter stops a tool at 25s, so `create_conversation` /
  `send_message` wait at most 18s and then return `status: "in_progress"` without
  cancelling the stream. The reply still lands — poll `get_conversation` for it.
- **File upload / attachments** are deliberately out of scope. Existing attachments on a
  message are rendered as a labelled placeholder, never dropped.

## How It Works

This plugin runs inside your Claude tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
