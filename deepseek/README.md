# OpenTabs plugin — DeepSeek

Drives [chat.deepseek.com](https://chat.deepseek.com) through its own JSON API,
normalized to [`SPEC.md`](../SPEC.md).

## Tools

| tool | endpoint | notes |
|---|---|---|
| `get_current_user` | `GET /users/current` | |
| `list_models` | `GET /client/settings?did=…&scope=model` | Instant / Expert / Vision. Requires the `did` device id — without it the call answers `INVALID_PARAM`. |
| `list_capabilities` | (derived) | SPEC §6, built live from the model payload. |
| `list_conversations` | `GET /chat_session/fetch_page` | Keyset cursor over `(pinned, updated_at)`. |
| `search_conversations` | `POST /index/query` | The site's own full-text index, SSE, `before_seq_id` cursor. |
| `get_conversation` | `GET /chat/history_messages` | Whole tree; the live thread is walked from `current_message_id`. |
| `create_conversation` | `POST /chat_session/create` + completion | |
| `send_message` | `POST /chat/completion` (SSE) | Threads onto the live leaf. |
| `rename_conversation` | `POST /chat_session/update_title` | |
| `delete_conversation` | `POST /chat_session/delete` | |
| `star_conversation` | `POST /chat_session/update_pinned` | Surfaces as `is_starred`. |

No projects and no deep-research tools: DeepSeek has neither. Both are declared
`false` with a reason in `list_capabilities().features` rather than shipped as
empty stubs.

## Auth

Bearer token read from the `userToken` localStorage entry (JSON-wrapped as
`{"value": …}`), plus the `x-client-*` headers the SPA sends. No cookie required.

Every response is HTTP 200 with the real outcome in `data.biz_code`, so the
status line never reveals a rejected request. `biz_code: 1` is a catch-all
illegal-argument code carrying `ILLEGAL_COUNT`, `ILLEGAL_CHAT_SESSION_ID` and
`invalid chat session id` alike, so it is split on the message into `NOT_FOUND`
vs `VALIDATION_ERROR`.

## Pagination

`fetch_page` rejects `count` outside **2..100** (`ILLEGAL_COUNT`), and its
`lte_cursor` is **inclusive** — the boundary row comes back a second time on the
next page. The normalized cursor therefore carries the last id actually
returned (`<pinned>|<updated_at>|<id>`) so the repeat is dropped and a mid-page
`max_items` resume is expressible. `total` is always `null`: the endpoint
reports no count of any kind, only `has_more`.

`/index/query` takes no page-size parameter at all — the server streams whatever
batch it likes — so `limit` is applied by slicing and the search cursor carries
an intra-batch offset alongside the real `before_seq_id`.

## Modes, DeepThink and Search

The picker offers **modes**, not named checkpoints, and the API field is
`model_type`: `default` (Instant), `expert`, `vision`.

A conversation's mode is **fixed when it is created** — DeepSeek's own tooltip is
"To switch modes, please start a new chat" — so `send_message` rejects a
`model_id` that differs from the conversation's.

DeepThink and Search are per-message booleans on the completion request
(`thinking_enabled`, `search_enabled`), exposed as `thinking` and `search`.
DeepThink has **no effort ladder**, so `capabilities.thinking.levels` is `null`
and `thinking_level` raises `VALIDATION_ERROR` rather than being silently
ignored. Only `default` offers Search; Expert and Vision hide the button and
answer with a `TIP` fragment saying so.

## Message fragments

An assistant turn is a list of fragments, all of which are mapped:

| fragment | maps to |
|---|---|
| `REQUEST` / `RESPONSE` | `message.content[]` text, all parts joined |
| `THINK` | `reasoning` (`effort: null` — there is no ladder) |
| `SEARCH`, `TOOL_SEARCH` | `web_search_call` with `action.type: "search"` |
| `TOOL_OPEN` | `web_search_call` with `action.type: "open_page"` and a `url` |
| `TOOL_FIND` | `tool_call` named `find_in_page` |
| `FILE` | labelled placeholder in the message text |
| `TIP` | labelled placeholder in the message text |

`[citation:N]` markers resolve against the turn's own results, so `url_citation`
annotations carry real offsets into the `output_text`.

## Proof of work

`POST /chat/completion` is gated behind a challenge from
`POST /chat/create_pow_challenge`. The answer is the smallest integer `n` where
`hash("<salt>_<expire_at>_<n>")` equals the server's target digest, sent back as
a base64 `X-DS-PoW-Response` header. A solve costs roughly two seconds, which is
budgeted for inside the 25-second tool ceiling.

The hash (`DeepSeekHashV1`) is SHA3-256 with one deviation: its Keccak-f
permutation runs rounds 1..23 instead of 0..23, so a stock SHA3 implementation
produces different digests. See `src/pow.ts`.
