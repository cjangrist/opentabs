# Kimi

OpenTabs plugin for [Kimi](https://www.kimi.com) — gives AI agents access to Kimi through your authenticated browser session.

Normalized to [`SPEC.md`](../SPEC.md): the same tool names, inputs and output shapes as every other provider in this repo.

## Setup

1. Open [kimi.com](https://www.kimi.com) in Chrome and log in
2. Open the OpenTabs side panel — the Kimi plugin should appear as **ready**

## Tools (20)

### Account (3)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the current Kimi user profile | Read |
| `list_models` | List available models, parsed live from the picker payload | Read |
| `list_capabilities` | Every model, toggle and feature, derived live | Read |

### Conversations (7)

| Tool | Description | Type |
|---|---|---|
| `list_conversations` | List conversations (paginated) | Read |
| `search_conversations` | Full-text search over conversations (paginated) | Read |
| `get_conversation` | Read a conversation as normalized SPEC §3 items | Read |
| `create_conversation` | Start a conversation, optionally inside a project | Write |
| `send_message` | Send a message in an existing conversation | Write |
| `rename_conversation` | Rename a conversation | Write |
| `delete_conversation` | Delete a conversation | Write |

### Projects (6)

| Tool | Description | Type |
|---|---|---|
| `list_projects` | List projects (paginated, real total) | Read |
| `get_project` | Get a project with a real conversation count | Read |
| `list_project_conversations` | List a project's conversations (paginated) | Read |
| `create_project` | Create a project | Write |
| `update_project` | Rename a project | Write |
| `delete_project` | Delete a project (and the conversations inside it) | Write |

### Research (4)

| Tool | Description | Type |
|---|---|---|
| `start_deep_research` | Start a Deep Research run; returns as soon as the id exists | Write |
| `get_deep_research` | Poll a research run | Read |
| `answer_deep_research` | Answer a clarifying question and resume | Write |
| `cancel_deep_research` | Stop a running research run | Write |

## Notes

- **Not supported: moving a conversation into a project after the fact.** Kimi files a chat
  into a project only at creation, via the Chat request's `project_id` — so use
  `create_conversation(project_id: …)`. There is no add/remove/move primitive:
  `ProjectService` exposes no membership method (every candidate answers HTTP 404),
  `ChatService/UpdateChat` accepts a `projectId` and silently ignores it (HTTP 200,
  membership unchanged), and the kimi.com UI offers no such affordance either.
  `list_capabilities().features.project_membership` says so with that reason.
- **Not supported: archiving.** Kimi has no archive concept for chats — the row menu offers
  Delete only, the chat payload carries no archived flag, and no Archive RPC exists.
  `is_archived` / `is_starred` are therefore always `false`.
- **Models.** `list_models` is parsed from `ConfigService/GetAvailableModels` on every call
  and matches the rendered picker exactly. `x-msh-version: 2.0.0` is **required**: without
  it the gateway serves a stale A/B bucket whose model list does not exist in the picker.
  K3 and K3 Swarm share both the scenario and the kimiPlus id and differ only in the
  request's `agent_mode`, which Kimi does not persist — so a K3 Swarm conversation reads
  back as `k3`.
- **Thinking.** `thinking` maps to `options.thinking`, `thinking_level` onto Kimi's native
  `reasoning_effort` ladder by name (`minimal/low→LOW, medium→MEDIUM, high→HIGH, max→MAX`),
  falling back to the nearest lower rung a model publishes — on Instant, whose ladder is
  `LOW` only, every level resolves to `LOW`. `REASONING_EFFORT_NONE` is Kimi's off switch
  rather than a level, so `thinking:false` sends it and is rejected for K3 / K3 Swarm, whose
  ladders have no "off" rung.
- **Search.** `search_conversations` drives `ChatService/ListChats` with a `query`.
  `FeedService/ListFeeds` also accepts a `query` and **silently ignores it** — it re-ranks
  but still returns every chat — so search is deliberately not routed through the feed.
  Kimi's search cursor blends two result sets and is not a stable prefix across page sizes;
  keep `limit` fixed while walking one query.
- **Long replies.** The OpenTabs adapter stops a tool at 25s, so `create_conversation` /
  `send_message` wait at most 18s and then return `status: "in_progress"` without cancelling
  the generation. The reply still lands — poll `get_conversation` for it.
- **Concurrency.** Kimi limits how many chats may generate at once. Exceeding it arrives as
  an in-stream `resource_exhausted` frame under HTTP 200 and is raised as `RATE_LIMIT`.
- **File upload / attachments** are deliberately out of scope. Existing attachments on a
  message are rendered as a labelled placeholder, never dropped.

## How It Works

This plugin runs inside your Kimi tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required.

Kimi's web app talks to a Connect-RPC gateway at `https://www.kimi.com/apiv2/...`, authenticated with the bearer token the app keeps in `localStorage.access_token`. The plugin calls those same endpoints:

| Purpose | Method |
|---|---|
| Current user | `kimi.gateway.account.v1.UserService/GetCurrentUser` |
| Models | `kimi.gateway.config.v1.ConfigService/GetAvailableModels` |
| Conversation list | `kimi.gateway.feed.v1.FeedService/ListFeeds` |
| Search / project members | `kimi.gateway.chat.v1.ChatService/ListChats` |
| Conversation metadata | `kimi.gateway.chat.v1.ChatService/GetChat` |
| Conversation messages | `kimi.gateway.chat.v1.ChatService/ListMessages` |
| Rename / delete a chat | `ChatService/UpdateChat`, `ChatService/DeleteChat` |
| Stop a generation | `kimi.gateway.chat.v1.ChatService/CancelChat` |
| Projects | `kimi.gateway.project.v1.ProjectService/{List,Get,Create,Update,Delete}Project` |
| Send / create chat | `kimi.gateway.chat.v1.ChatService/Chat` (streaming, `application/connect+json`) |

Every list endpoint pages with an opaque `pageToken`; the plugin's cursor additionally
carries the offset **within** a page so `max_items` is a hard ceiling that can resume
mid-page. `ListFeeds` and `ListProjects` reject a page size above 100, so a larger `limit`
is served by walking more than one upstream page.

Deep Research is the `deep-researcher` kimiPlus on the agentic scenario with the
`TOOL_TYPE_ASK_USER` tool declared. Its Chat stream is read **incrementally** rather than
buffered: a run stays open for minutes and parks — still open — when it asks a clarifying
question, so a buffered read would surface neither the chat id nor the question. Kimi
publishes the parked state as a first-class chat status (`STATUS_ASK_USER_QUESTION`), which
is the entire clarification detector — no text heuristics.

Expired access tokens are refreshed automatically via `GET /api/auth/token/refresh` using
`localStorage.refresh_token`.

## License

MIT
