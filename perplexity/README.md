# Perplexity

OpenTabs plugin for [Perplexity](https://www.perplexity.ai) — gives AI agents access to Perplexity's answer engine through your authenticated browser session.

Normalized to [`SPEC.md`](../SPEC.md): the same tool names, inputs and output shapes as every other provider in this repo.

## Setup

1. Open [perplexity.ai](https://www.perplexity.ai) in Chrome and log in
2. Open the OpenTabs side panel — the Perplexity plugin should appear as **ready**

## Tools (24)

### Account (3)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Signed-in account, plan and default model | Read |
| `list_models` | Live model list with per-model capabilities | Read |
| `list_capabilities` | Every model, toggle and feature, derived live | Read |

### Conversations (8)

| Tool | Description | Type |
|---|---|---|
| `list_conversations` | Paged Library listing | Read |
| `search_conversations` | Paged, server-side free-text search | Read |
| `get_conversation` | Thread as normalized Responses items | Read |
| `create_conversation` | Start a thread | Write |
| `send_message` | Follow up in a thread | Write |
| `rename_conversation` | Set a thread title | Write |
| `delete_conversation` | Permanently delete a thread | Write |
| `archive_conversation` | Archive / unarchive a thread | Write |

### Projects — Perplexity Spaces (9)

`list_projects`, `get_project`, `list_project_conversations`, `create_project`,
`update_project`, `delete_project`, `add_conversation_to_project`,
`remove_conversation_from_project`, `move_conversation_to_project`.

### Deep research (4)

`start_deep_research`, `get_deep_research`, `answer_deep_research`, `cancel_deep_research`.

## Concept mapping

Perplexity is an answer engine rather than a chat app, so the normalized contract maps like this:

| Contract | Perplexity |
|---|---|
| conversation | **thread** — identified by the slug in `/search/<slug>` |
| turn | **entry** — one `query_str` plus the answer blocks it produced |
| message items | one entry becomes a `user` message, its recorded steps, and an `assistant` message |
| reasoning | `THOUGHT` steps inside the entry's `pro_search_steps` block |
| web_search_call | `SEARCH_WEB` joined to its `SEARCH_RESULTS` by `goal_id`; `GET_URL_CONTENT` becomes an `open_page` action |
| tool_call | `CODE`, `RESEARCH_ANSWER`, `RESEARCH_CLARIFYING_QUESTIONS` steps |
| citations | the `[n]` markers in the answer index into `web_result_block.web_results` (`[1]` is `sources[0]`), and are mapped to `url_citation` annotations with real offsets |
| project | **Space** (product) / **project** (URL) / **collection** (API) |
| thinking | a separate MODEL, not a flag — each picker row pairs a non-thinking id with a "…thinking" id |
| deep research | the `pplx_alpha` "Deep research" model on an ordinary thread |

## How It Works

This plugin runs inside your Perplexity tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — Perplexity's session lives in an HttpOnly cookie, so requests simply go out with `credentials: 'include'`. No API tokens or OAuth apps required.

| Purpose | Endpoint |
|---|---|
| Session / readiness | `GET /api/auth/session` |
| Plan + default model | `GET /rest/user/settings` |
| Models | `GET /rest/models/config/v2` |
| Live mode quotas | `GET /rest/rate-limit/status` |
| Thread list (paged Library) | `POST /rest/perplexity_ask/graphql` — persisted `LibraryRecentThreadsPaginationQuery` |
| Thread list (fallback) | `POST /rest/thread/list_ask_threads` |
| Thread detail | `GET /rest/thread/{slug}?with_schematized_response=true` |
| Ask / follow-up | `POST /rest/sse/perplexity_ask` (SSE) |
| Spaces | `/rest/collections/*` |
| Research clarification | `POST /rest/sse/handle_perplexity_research_clarifying_answers` |
| Stop a run | `POST /rest/sse/perplexity_terminate` |

Gotchas the code handles, each found live rather than assumed:

- **`/rest/sse/perplexity_ask` always returns HTTP 200.** Failures (invalid model, rate limit, expired session) arrive inside the stream as a normal `event: message` frame carrying `status: "failed"` and an `error_code`, so the plugin parses the stream instead of trusting the status code.
- **`offset` on the thread-detail endpoint is silently ignored** at every value. The real primitive is the undocumented `has_next_page` / `next_cursor` pair in the response body.
- **The Library's root Relay query ignores `count`** and always returns 25 rows; only the pagination query honours it, so that one is used even for the first page.
- **`/rest/thread/list_ask_threads` ignores `archived_only`**, and there is no way to list archived threads back — archiving is observable as the thread leaving the Library.
- **`thread_count` on a Space stays 0** even when the Space holds threads, so `conversation_count` is reported as `null`.
- **`batch_archive_threads` reports `succeeded` for a context uuid that does not exist**, so the thread is resolved first and `failed` is still inspected.
- **Mid-run, the thread endpoint serves a placeholder entry** (`status: PENDING`, `model: turbo`, no blocks) until the answer lands. A research run's clarifying question therefore usually only becomes visible after the run has finished — and Perplexity skips an unanswered question itself after ~60 s.
- **Deleted or inaccessible threads answer 400/403 with an `error_code`**, which is re-classified as `NOT_FOUND`.

## License

MIT
