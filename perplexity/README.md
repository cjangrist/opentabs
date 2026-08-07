# Perplexity

OpenTabs plugin for [Perplexity](https://www.perplexity.ai) — gives AI agents access to Perplexity's answer engine through your authenticated browser session.

## Setup

1. Open [perplexity.ai](https://www.perplexity.ai) in Chrome and log in
2. Open the OpenTabs side panel — the Perplexity plugin should appear as **ready**

## Tools (7)

### Account (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the signed-in Perplexity account | Read |

### Models (1)

| Tool | Description | Type |
|---|---|---|
| `list_models` | List available Perplexity models | Read |

### Conversations (3)

| Tool | Description | Type |
|---|---|---|
| `list_conversations` | List recent Perplexity threads | Read |
| `get_conversation` | Get a thread's turns with their citations | Read |
| `create_conversation` | Start a new thread and get the cited answer | Write |

### Chat (1)

| Tool | Description | Type |
|---|---|---|
| `send_message` | Ask a follow-up in a thread and get the cited answer | Write |

### Search (1)

| Tool | Description | Type |
|---|---|---|
| `search` | One-shot search returning the answer plus its sources | Write |

## Concept mapping

Perplexity is an answer engine rather than a chat app, so the standard contract maps like this:

| Contract | Perplexity |
|---|---|
| conversation | **thread** — identified by the slug in `/search/<slug>`, which is the first entry's backend UUID |
| turn | **entry** — one `query_str` plus the answer blocks it produced |
| citations | `web_result_block.web_results` on each entry; the `[n]` markers in the answer index into that list (`[1]` is `sources[0]`) |

Every answer-producing tool (`search`, `create_conversation`, `send_message`) returns `sources`, and `get_conversation` returns `sources` per turn.

## How It Works

This plugin runs inside your Perplexity tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — Perplexity's session lives in an HttpOnly cookie, so requests simply go out with `credentials: 'include'`. No API tokens or OAuth apps required.

| Purpose | Endpoint |
|---|---|
| Session / readiness | `GET /api/auth/session` |
| Plan + default model | `GET /rest/user/settings` |
| Models | `GET /rest/models/config/v2` |
| Thread list (full Library, paged) | `POST /rest/perplexity_ask/graphql` — persisted queries `LibraryThreadsRelayQuery` / `LibraryRecentThreadsPaginationQuery` |
| Thread list (fallback, 20 newest) | `GET /rest/thread/list_recent` |
| Thread detail | `GET /rest/thread/{slug}?with_schematized_response=true` |
| Ask / follow-up | `POST /rest/sse/perplexity_ask` (SSE, `text/event-stream`) |

Two gotchas the code handles:

- **`/rest/sse/perplexity_ask` always returns HTTP 200.** Failures (invalid model, rate limit, expired session) arrive inside the stream as a normal `event: message` frame carrying `status: "failed"` and an `error_code`, so the plugin parses the stream instead of trusting the status code.
- **`/rest/thread/list_recent` hard-caps at 20 and ignores `limit`/`offset`.** The full Library is only reachable through the Relay persisted queries, so those are the primary path and the REST endpoint is the fallback.

## License

MIT
