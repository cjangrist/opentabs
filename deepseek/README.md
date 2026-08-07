# OpenTabs plugin — DeepSeek

Drives [chat.deepseek.com](https://chat.deepseek.com) through its own JSON API.

## Tools

| tool | notes |
|---|---|
| `get_current_user` | `GET /api/v0/users/current` |
| `list_models` | `GET /api/v0/client/settings?scope=model` — Instant / Expert / Vision |
| `list_conversations` | `GET /api/v0/chat_session/fetch_page` (cursor paged) |
| `get_conversation` | `GET /api/v0/chat/history_messages` |
| `create_conversation` | `POST /api/v0/chat_session/create` then the completion stream |
| `send_message` | `POST /api/v0/chat/completion` (SSE), threaded by `parent_message_id` |

## Auth

Bearer token read from the `userToken` localStorage entry, plus the `x-client-*`
headers the SPA sends. No cookie is required.

## DeepThink and Search

Neither is a model. Both are per-message booleans on the completion request
(`thinking_enabled`, `search_enabled`), exposed as the `thinking` and `search`
parameters on `create_conversation` / `send_message`. Reasoning text arrives as
`THINK` fragments and is returned in the `thinking` field. `list_models` reports
`supports_thinking` / `supports_search` per model — only Instant supports search.

## Proof of work

`POST /api/v0/chat/completion` is gated behind a challenge from
`POST /api/v0/chat/create_pow_challenge`. The answer is the smallest integer `n`
where `hash("<salt>_<expire_at>_<n>")` equals the server's target digest, sent
back as a base64 `X-DS-PoW-Response` header.

The hash (`DeepSeekHashV1`) is SHA3-256 with one deviation: its Keccak-f
permutation runs rounds 1..23 instead of 0..23, so a stock SHA3 implementation
produces different digests. See `src/pow.ts`.
