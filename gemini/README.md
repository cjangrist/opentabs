# Gemini

OpenTabs plugin for Google Gemini — gives AI agents access to Gemini through your authenticated browser session.

## Install

```bash
opentabs plugin install gemini
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-gemini
```

## Setup

1. Open [gemini.google.com](https://gemini.google.com) in Chrome and log in
2. Open the OpenTabs side panel — the Gemini plugin should appear as **ready**

## Tools (24)

All tools follow [`SPEC.md`](../SPEC.md) — the same names, inputs and output shapes as
every other chat provider in this repo.

### Account (3)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | The signed-in Google account | Read |
| `list_models` | Gemini modes, parsed live from the mode picker's bootstrap payload | Read |
| `list_capabilities` | Every model, toggle and feature, derived live | Read |

### Conversations (8)

| Tool | Description | Type |
|---|---|---|
| `list_conversations` | Paginated chat list, cursor-driven | Read |
| `search_conversations` | Paginated full-text search | Read |
| `get_conversation` | Transcript as normalized Responses items | Read |
| `create_conversation` | Start a chat | Write |
| `send_message` | Reply in a chat | Write |
| `rename_conversation` | Retitle a chat | Write |
| `star_conversation` | Pin or unpin a chat | Write |
| `delete_conversation` | Permanently delete a chat | Write |

### Projects (9)

Gemini calls projects **Notebooks**. Project ids are native `notebooks/<uuid>` resource
names; every tool also accepts the bare UUID.

| Tool | Description | Type |
|---|---|---|
| `list_projects` | Paginated Notebook catalogue | Read |
| `get_project` | Notebook settings and real chat count | Read |
| `list_project_conversations` | Cursor-paginated Notebook chats | Read |
| `create_project` | Create a Notebook | Write |
| `update_project` | Rename or change Notebook Instructions | Write |
| `delete_project` | Safely delete a Notebook, optionally detaching chats first | Write |
| `add_conversation_to_project` | File a chat in a Notebook | Write |
| `remove_conversation_from_project` | Detach a chat from its Notebook | Write |
| `move_conversation_to_project` | Move and verify a chat between Notebooks | Write |

### Deep Research (4)

| Tool | Description | Type |
|---|---|---|
| `start_deep_research` | Create and confirm a native research plan, then return promptly | Write |
| `get_deep_research` | Poll structural status, progress, report items and sources | Read |
| `answer_deep_research` | Confirm a native plan parked with automatic confirmation disabled | Write |
| `cancel_deep_research` | Stop a running task with Gemini's own cancel RPC | Write |

## Provider notes

- **Pagination** uses Gemini's own opaque cursors (`MaZiqc` for chats, `unqWSc` for
  search). Neither reports a total, so `total` is always `null`. `MaZiqc` caps a page at
  100 rows; `unqWSc` takes no page-size argument at all, so `limit` / `max_items` are
  enforced as hard ceilings on the result.
- **Thinking** is Gemini's "Extended thinking" picker entry — a per-message toggle on the
  most capable mode, not a separate model. The normalized `thinking_level` ladder
  collapses onto on/off (`minimal|low` → standard, `medium|high|max` → Extended).
- **Web search** is not controllable: Gemini browses autonomously and the composer has no
  switch, so passing `search` raises `VALIDATION_ERROR` instead of faking a control.
- **Deep Research** drives Gemini's two native control turns (plan, then Start research)
  and returns the conversation id as `research_id`; Gemini's persisted native task id is
  only a placeholder. Polling reads progress from the task extension, final Markdown from
  candidate slot 30, and curated citations from the completed report. Gemini publishes no
  stable task-failure marker, so `failed`/`error` are not guessed from elapsed time; a task
  with no report continues to report its last structural state.
- **Notebooks** are Gemini's project surface. `description` maps to Notebook
  **Instructions**. `create_conversation` and `start_deep_research` accept `project_id`.
  Native Notebook deletion would also delete its chats, so `delete_project` refuses a
  non-empty Notebook unless `detach_conversations: true` preserves and verifies them first.
- **Timing:** Gemini persists a turn only when generation finishes. A send waits ~18s and
  polls the transcript; `status: "in_progress"` means the answer had not landed yet.

## How It Works

This plugin runs inside your Gemini tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
