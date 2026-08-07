# Triage — Kilo Code bot review of PR #1

**Date:** 2026-08-07
**PR:** [#1 — 🎉 chore(repo): initial import — spec, guidelines, and nine verified providers](https://github.com/cjangrist/opentabs/pull/1)
**Head SHA:** `c4c3e5493adc3b208240f8acefec7138b054417e`
**Reviewer:** `kilo-code-bot[bot]` ("Code Review Roast"), verdict *13 Issues Found | Address before merge*

This document records the triage of all thirteen inline review comments. Each finding was
re-derived from the source rather than taken from the bot's summary, and — where a read-only
check could settle it — verified against the live providers through the OpenTabs MCP server
(`127.0.0.1:9515`) and the authenticated Chromium on CDP `127.0.0.1:9222`.

No code was changed in this pass. Every `CONFIRMED` and `PARTIAL` finding has a self-contained
issue; the three `FALSE_POSITIVE`s are disproven below and no issue was filed for them.

Account data (conversation ids, thread slugs, titles, message ids) is redacted throughout.

---

## Summary

| # | Location | Bot severity | Verdict | Severity | Issue |
|---|---|---|---|---|---|
| 1 | `gemini/src/gemini-api.ts:345-369` — dead `.conversation-turn` branch | critical | **PARTIAL** | medium | [#6](https://github.com/cjangrist/opentabs/issues/6) |
| 2 | `grok/src/grok-api.ts:139-150` — `callRest` ignores HTTP status | warning | **CONFIRMED** | **high** | [#2](https://github.com/cjangrist/opentabs/issues/2) |
| 3 | `chatgpt/src/tools/schemas.ts:86-95` — raw `create_time`/`update_time` | warning | **FALSE_POSITIVE** | — | none |
| 4 | `chatgpt/src/tools/search-conversations.ts:22-36` — cursor out, none in | warning | **CONFIRMED** | **high** | [#3](https://github.com/cjangrist/opentabs/issues/3) |
| 5 | `perplexity/src/perplexity-api.ts:446-448` — `offset=0` hardcoded | suggestion | **CONFIRMED** | **high** | [#4](https://github.com/cjangrist/opentabs/issues/4) |
| 6 | `perplexity/src/perplexity-api.ts:432-435` — `blocks.find` for sources | suggestion | **FALSE_POSITIVE** | — | none |
| 7 | `deepseek/src/deepseek-api.ts:497-499` — `getLatestMessageId` cost | suggestion | **PARTIAL** | low | [#10](https://github.com/cjangrist/opentabs/issues/10) |
| 8 | `kimi/src/kimi-api.ts:577-611` — single `ListMessages`, no paging | suggestion | **CONFIRMED** | **high** | [#5](https://github.com/cjangrist/opentabs/issues/5) |
| 9 | `qwen/src/qwen-api.ts:739,742` — bare `crypto.randomUUID()` | suggestion | **FALSE_POSITIVE** | — | none |
| 10 | `claude/src/claude-api.ts:13-32` — comment promises `intercomSettings` | suggestion | **CONFIRMED** | low | [#11](https://github.com/cjangrist/opentabs/issues/11) |
| 11 | `gemini/src/gemini-api.ts:273-286` — hand-concatenated JSON header | suggestion | **CONFIRMED** | low | [#7](https://github.com/cjangrist/opentabs/issues/7) |
| 12 | `kimi/src/kimi-api.ts:88-105` — unguarded `response.json()` | nitpick | **CONFIRMED** | low | [#8](https://github.com/cjangrist/opentabs/issues/8) |
| 13 | `qwen/src/qwen-api.ts:250-259` — `getModels` reads `response.data` | suggestion | **PARTIAL** | low | [#9](https://github.com/cjangrist/opentabs/issues/9) |

**Totals:** 7 confirmed, 3 partial, 3 false positives. 10 issues filed.

### Where the bot's severities were wrong

The bot's ranking correlates poorly with real user impact. Three of its four **lowest**-rated
findings (5, 8, and — after re-derivation — 2) are the ones that lose user data silently, which
`SPEC.md` §1 calls out explicitly: *"Silent truncation is a bug."* Its single **critical** (1)
is a latent trap whose branch is currently unreachable.

| direction | findings |
|---|---|
| bot **understated** | 2 (warning → high), 5 (suggestion → high), 8 (suggestion → high), 4 (warning → high) |
| bot **overstated** | 1 (critical → medium), 10 (implied outage → low docs) |
| bot **wrong** | 3, 6, 9 |

### Cross-cutting themes

Three themes account for nine of the ten filed issues, and both map onto the two most
emphasized sections of `SPEC.md`:

1. **Pagination (§1)** — findings 4, 5, 8. In each case the *provider* offers a working cursor
   and the *plugin* discards it, then returns a shape with no `has_more` so the caller cannot
   even detect the loss. This is the single most repeated defect in the import.
2. **Error taxonomy (§0)** — findings 2, 12, 13. HTTP status and error envelopes are parsed as
   success. Grok's case is the severe one: a real `401` becomes an empty list.
3. **Comments describing code that was never written** — findings 1, 10. Both point a future
   maintainer at a mechanism that does not exist.

### Note on the pre-normalization baseline

PR #1 imports nine plugins that predate `SPEC.md` normalization: none of them yet expose the
§1 pagination envelope (`items` / `next_cursor` / `has_more` / `total` / `page_info`) or the §3
Responses-style `items` array. The findings below are scored on **user-visible defect**, not on
distance from the target contract — otherwise all nine providers would be one finding each. The
pagination findings are rated high because they cause *silent data loss today*, not merely
because the envelope is absent.

---

## 1 — `gemini/src/gemini-api.ts:345-369` — `getConversationMessages` dead branch

**Verdict: PARTIAL · Severity: medium · Issue [#6](https://github.com/cjangrist/opentabs/issues/6)**

### Context

Gemini has no thread API in this plugin, so `gemini__get_conversation` is entirely DOM-scraped.
`getConversationMessages` is the whole read path; it is called at
`gemini/src/tools/get-conversation.ts:40`.

### The finding

> `getConversationMessages` queries `.conversation-turn`, then only parses when
> `turns.length === 0`. So when the elements you searched for *are* present, you shrug and
> return `[]`. This is the live read path for `get_conversation` (called at
> `get-conversation.ts:40`) — any thread rendered with `.conversation-turn` comes back empty.
> Textbook content-dropped-at-HTTP-200, on the happy path.
> — severity: **critical**

### Evaluation

The structural claim is exactly right. `gemini/src/gemini-api.ts:345-369`:

```ts
export const getConversationMessages = (): { prompt: string; response: string }[] => {
  const container = document.querySelector('[data-test-id="chat-history-container"]');
  if (!container) return [];

  const messages: { prompt: string; response: string }[] = [];
  const turns = container.querySelectorAll('.conversation-turn');

  if (turns.length === 0) {
    // Alternative: parse from query/response containers
    const queryContainers = container.querySelectorAll('.query-text, .user-query, [data-test-id="user-message"]');
    const responseContainers = container.querySelectorAll(
      '.model-response-text, .response-container-content, [data-test-id="model-response"]',
    );

    const count = Math.max(queryContainers.length, responseContainers.length);
    for (let i = 0; i < count; i++) {
      messages.push({
        prompt: queryContainers[i]?.textContent?.trim() ?? '',
        response: responseContainers[i]?.textContent?.trim() ?? '',
      });
    }
  }

  return messages;
};
```

`turns` is computed and used only to *suppress* parsing. There is no `turns.length > 0` branch.
The call path the bot names is real — `get-conversation.ts:40`:

```ts
    const messages = getConversationMessages();
    return {
      conversation_id: currentId,
      turns: messages.map(m => ({ prompt: m.prompt, response: m.response })),
    };
```

Where the bot is wrong is the *severity* and the "live read path … comes back empty" framing.
`.conversation-turn` matches **nothing** in Gemini's current DOM, so the `=== 0` branch always
wins and the tool works. It is a latent trap, not a live outage — hence PARTIAL rather than
CONFIRMED-critical.

### Impact

Today: none. The day Google ships markup containing `.conversation-turn` — one front-end
release, no plugin change — every `gemini__get_conversation` call begins returning `turns: []`
at HTTP 200, with a valid `conversation_id` and no exception. Nothing distinguishes "empty
conversation" from "scraper broke". This is the first entry in `AGENTS.md`'s known-failure
table (*"Auth check keyed on markup the site no longer emits"*) and the exact shape of the
regression that, per `00-shared-context`, had the gemini plugin returning `[]` for a year.

The secondary harm is present now: the file documents `.conversation-turn` as the primary
shape when it is in fact the shape that yields nothing.

### Empirical check

Navigated the authenticated Gemini tab to a real thread (id redacted) and inspected the
rendered DOM over CDP:

```console
$ python3 cdp_eval.py --url-contains gemini.google.com --js-file gemini-probe2.js
{"url":"/app/<redacted>","textLen":1607,
 "counts":{".conversation-turn":0,".conversation-container":2,"user-query":2,
           ".query-text":2,".user-query":0,"[data-test-id=\"user-message\"]":0,
           ".model-response-text":2,".response-container-content":3,
           "[data-test-id=\"model-response\"]":0,".markdown":3}}
```

`.conversation-turn` → **0**. The fallback selectors `.query-text` (2) and
`.model-response-text` (2) are what actually match. Confirmed end-to-end through the tool:

```console
$ opentabs tool call gemini__get_conversation
{ "conversation_id": "<redacted>",
  "turns": [ { "prompt": "<redacted — 165 chars of real prompt text>",
               "response": "<redacted — 512 chars of real response text>" } ] }
```

Non-empty: one turn, both fields populated with the thread's actual text. The critical claim
does not hold against the live site.

### Recommended fix

Two independent changes:

1. Either implement the `turns.length > 0` branch or delete the `.conversation-turn` query
   outright. A query whose only effect is to suppress parsing must not survive review.
2. **Fail loudly when every selector misses.** If the container exists and has non-trivial
   `textContent` but nothing matched, raise `UPSTREAM_ERROR` rather than returning `[]`.

Satisfies `SPEC.md` §3 (*"Never drop content silently"*) and `AGENTS.md`'s testing bar
(*"An empty array is not success"*).

### Issue

<https://github.com/cjangrist/opentabs/issues/6>

---

## 2 — `grok/src/grok-api.ts:139-150` — `callRest` ignores HTTP status

**Verdict: CONFIRMED · Severity: high (bot said "warning") · Issue [#2](https://github.com/cjangrist/opentabs/issues/2)**

### Context

`callRest` is the single funnel for every Grok `/rest/*` request — `getCurrentUser`,
`getModels`, `listConversations`, `getConversation`, `sendMessage` all reach it through
`getRest` / `postRest`. Grok authenticates purely on httpOnly cookies, so an expired session is
the *normal* failure, not an exotic one.

### The finding

> `callRest` does `await response.json()` with all the defensive checking of a cat walking past
> a cucumber — no `response.ok`, no status check, no error-envelope lookup. So a 401, 429, or
> 502 gets silently re-cast as an empty list.
> — severity: **warning**

### Evaluation

Correct, and the consequence is worse than "warning". `grok/src/grok-api.ts:139-150`:

```ts
const callRest = async <T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> => {
  const response = await fetchFromPage(`${REST_BASE}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...((init?.headers as Record<string, string>) ?? {}),
    },
    credentials: 'include',
    timeout: init?.timeout ?? REQUEST_TIMEOUT_MS,
  });
  return (await response.json()) as T;
};
```

No status branch, no envelope check, and a blind cast to the success type `T`. The swallow
completes at `grok/src/grok-api.ts:304-306`:

```ts
    const page = await getRest<RawConversationList>(`/app-chat/conversations?${query.toString()}`);
    const rows = page.conversations ?? [];
    if (rows.length === 0) break;
```

An error body has no `conversations` key → `rows` is `[]` → the loop breaks → `[]` is returned
as a successful result.

One nuance on the bot's supporting claim, *"Every sibling provider guards this (kimi checks
`response.ok`; deepseek/qwen `unwrap` the envelope)"*: kimi does
(`kimi/src/kimi-api.ts:164-178`), but **qwen's `callApi` has the same missing check**
(`qwen/src/qwen-api.ts:167-175`) and is only partly saved by `unwrap`. That does not weaken the
finding against grok — see finding 13.

### Impact

A user whose Grok session has expired is told they have **zero conversations**. No error, no
retry hint, no `AUTH_ERROR`. Identically: a 429 is reported as "no data" rather than
`RATE_LIMIT, retryable: true`, and a 5xx as "no data". If the gateway returns HTML instead of
JSON, `response.json()` throws a raw `SyntaxError` that escapes unclassified.

This is two entries from `AGENTS.md`'s failure table at once — *"Write helper ignores an error
payload inside a 200"* and *"An empty array is **not** success"* — and a direct `SPEC.md` §0
violation.

### Empirical check

Read-only `fetch` calls issued from the authenticated grok.com page over CDP:

```console
$ python3 cdp_eval.py --url-contains grok.com --js-file grok-probe.js
{"authed":  {"status":200,"ok":true, "keys":["conversations","nextPageToken","textSearchMatches"]},
 "noCreds": {"status":401,"ok":false,"keys":["code","message","details"],
             "body":"{\"code\":16,\"message\":\"No credentials presented. [WKE=unauthenticated:no-credentials]\",\"details\":[]}"},
 "badPath": {"status":404,"ok":false,"keys":["code","message","details"],
             "body":"{\"code\":5,\"message\":\"Not Found\",\"details\":[]}"}}
```

Two things are proven. Grok returns a **well-formed `{code, message, details}` error envelope**
that `callRest` discards, and the error bodies parse cleanly as JSON — so they sail through
`response.json()` and become `[]` rather than throwing.

### Recommended fix

In `callRest`, before parsing: branch on `response.status` (401/403 → `AUTH_ERROR`, 404 →
`NOT_FOUND`, 429 → `RATE_LIMIT` with `retryable: true`, other `!ok` → `UPSTREAM_ERROR`),
quoting Grok's own `message`. Parse the body via `text()` + `try { JSON.parse }` so a non-JSON
gateway page yields a classified error. Even at 200, classify a `{code, message}` shape that
carries none of the expected success keys.

Satisfies `SPEC.md` §0 — *"HTTP 200 with an error payload … must be classified, never treated
as success."* Reference implementation: `kimi/src/kimi-api.ts:164-178`.

### Issue

<https://github.com/cjangrist/opentabs/issues/2>

---

## 3 — `chatgpt/src/tools/schemas.ts:86-95` — raw `create_time` / `update_time`

**Verdict: FALSE_POSITIVE · No issue filed**

### Context

`mapConversationListItem` maps ChatGPT's `/backend-api/conversations` rows into
`conversationListItemSchema`, whose `create_time` / `update_time` are declared
`z.string()` and described as ISO 8601.

### The finding

> `mapConversationListItem` passes `create_time`/`update_time` through raw (`c.create_time ?? ''`)
> while every sibling mapper in this file (`mapUser`, `mapMessage`, even `search-conversations`)
> runs them through `toIsoTimestamp`. **The list endpoint serves these as epoch floats**, so you
> emit numbers where the schema (lines 67-68) promises ISO 8601.
> — severity: **warning**

### Evaluation

The finding rests on a factual premise about the endpoint, and that premise is false.

The code is as described — `chatgpt/src/tools/schemas.ts:86-95`:

```ts
export const mapConversationListItem = (c: RawConversationListItem) => ({
  id: c.id ?? '',
  title: c.title ?? '',
  create_time: c.create_time ?? '',
  update_time: c.update_time ?? '',
  is_archived: c.is_archived ?? false,
  is_starred: c.is_starred ?? false,
  gizmo_id: c.gizmo_id ?? '',
  snippet: c.snippet ?? '',
});
```

and the asymmetry the bot notices is real: `mapUser` at `schemas.ts:59` uses
`toIsoTimestamp(u.created)`, and `search-conversations.ts:42` pre-converts with
`toIsoTimestamp(item.update_time) || undefined` — precisely because *that* endpoint returns
epoch floats (`RawSearchResult.update_time` is typed `number | string`).

But `/backend-api/conversations` does **not**. It returns ISO 8601 strings, so the pass-through
emits exactly what the schema promises. The two mappers differ because the two endpoints
differ, which is a defensible reading of the code rather than an oversight.

### Impact

None. The mapped output is schema-conformant ISO 8601 today.

The residual worth noting — and it is a robustness note, not a defect — is that
`RawConversationListItem` types both fields as `string`, so if OpenAI ever flips the list
endpoint to the float shape its detail endpoint already uses, a raw number would flow straight
into a `z.string()` field. Running the values through `toIsoTimestamp` would cost nothing and
close that. That is a hardening suggestion, not the bug that was reported, and does not meet
the bar for an issue in this pass.

### Empirical check — the disproof

```console
$ opentabs tool call chatgpt__list_conversations '{"limit":2}'
{'create_time': '2026-08-05T18:47:50.133826Z', 'update_time': '2026-08-05T19:08:01.734171Z', …}
{'create_time': '2026-04-19T10:59:41.992448Z', 'update_time': '2026-04-19T10:59:48.627071Z', …}
```

(ids, titles and snippets redacted.)

The mapper is a pure pass-through — `c.create_time ?? ''` — so ISO 8601 *out* proves ISO 8601
*in*. The endpoint does not serve epoch floats. The reported defect cannot occur.

### Note on an adjacent, unreported issue

The same call returned `total: 3` for `limit: 2, offset: 0` — i.e. `offset + items + 1`, which
`SPEC.md` §1 names explicitly:

> If the provider's `total` is not a true total (chatgpt returns `offset+items+1`), return
> `null` and explain in the description rather than passing a lie through.

`list-conversations.ts:39` does `total: data.total ?? 0`, passing the lie through. The bot did
not raise this, and it is out of scope for this triage pass, but it is recorded here so it is
not lost.

### Issue

None — false positive. Disproof recorded above and posted in-thread.

---

## 4 — `chatgpt/src/tools/search-conversations.ts:22-36` — cursor out, no cursor in

**Verdict: CONFIRMED · Severity: high (bot said "warning") · Issue [#3](https://github.com/cjangrist/opentabs/issues/3)**

### Context

`chatgpt__search_conversations` wraps `/backend-api/conversations/search`. `SPEC.md` §2 lists
`search_conversations` among the paginated tools.

### The finding

> The output advertises a `cursor` for pagination, but the input schema (lines 22-25) has no
> `cursor` param and the handler never sends one. You hand the caller a next-page token and then
> refuse to accept it back — like a bouncer who stamps your hand and won't let you re-enter. If
> the search endpoint caps results behind that cursor, you'll see page one forever.
> — severity: **warning**

### Evaluation

Confirmed exactly, and the conditional in the bot's last sentence ("*if* the search endpoint
caps results") resolves to yes. `chatgpt/src/tools/search-conversations.ts:22-36`:

```ts
  input: z.object({
    query: z.string().describe('Search query text'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum results to return (default 28)'),
  }),
  output: z.object({
    conversations: z.array(conversationListItemSchema).describe('Matching conversations'),
    cursor: z.string().describe('Cursor for next page, empty if no more'),
  }),
  handle: async params => {
    const data = await api<{ items?: RawSearchResult[]; cursor?: string }>('/conversations/search', {
      query: {
        query: params.query,
        limit: params.limit ?? 28,
      },
    });
```

Cursor in the output, absent from the input, never forwarded. Two further defects in the same
block that the bot did not name: `limit` is accepted but ignored by the endpoint, and there is
no `has_more`, `total`, `page_info`, `fetch_all` or `max_items`.

### Impact

A caller searching a large account receives the first 30 matches, is handed a token proving
more exist, and has no way to use it. For an LLM consumer the failure is worse than a hard
error: the result *looks* complete. "Find my conversation about X" returns "not found" when
the match is on page 2.

`SPEC.md` §1 is unambiguous — *"There is no unpaginated list tool in this repo"* and
*"Silent truncation is a bug."*

### Empirical check

Through the plugin:

```console
$ opentabs tool call chatgpt__search_conversations '{"query":"the","limit":2}'
n_conversations = 30       # asked for 2 — limit is ignored
cursor          = '30'     # a real next-page token

$ opentabs tool schema chatgpt__search_conversations
"properties": { "query": {…}, "limit": {…}, "tabId": {…} }     # no "cursor"
```

And the endpoint driven directly from the chatgpt.com page (read-only), which is the
`SPEC.md` §1 page-boundary proof:

| request | status | items | cursor |
|---|---|---|---|
| `/backend-api/conversations/search?query=the` | 200 | 30 | `"30"` |
| `/backend-api/conversations/search?query=the&cursor=30` | 200 | 30 | `"60"` |

```console
disjoint: true    overlapCount: 0
```

Thirty additional, entirely non-overlapping matches sit one query parameter away. The server
supports the cursor; the plugin's input schema makes it unreachable.

### Recommended fix

Add `cursor: z.string().optional()` and forward it. Implement `fetch_all` / `max_items` with
`page_info.truncated` set at the ceiling. Move the output to the `SPEC.md` §1 envelope
(`items` / `next_cursor` / `has_more` / `total` / `page_info`), with `next_cursor: null` — not
`""` — when exhausted, and `total: null` since the endpoint reports none. Document in the tool
description that `limit` is ignored, per §1's *"If the provider ignores `limit`/`offset` … document
it in the tool description and drive the real cursor."*

### Issue

<https://github.com/cjangrist/opentabs/issues/3>

---

## 5 — `perplexity/src/perplexity-api.ts:446-448` — `offset=0` hardcoded

**Verdict: CONFIRMED · Severity: high (bot said "suggestion") · Issue [#4](https://github.com/cjangrist/opentabs/issues/4)**

### Context

`perplexity__get_conversation` reads a thread via `/rest/thread/<slug>`. Its description
promises the opposite of what it does.

### The finding

> `offset=0` is baked into `threadUrl`, so `get_conversation` can only ever read the newest
> `limit` turns with no way to page further. The tool's own description (get-conversation.ts:10)
> promises the whole thread — but anything past the cap gets quietly guillotined.
> — severity: **suggestion**

### Evaluation

Confirmed. `perplexity/src/perplexity-api.ts:446-448`:

```ts
const threadUrl = (conversationId: string, limit: number): string =>
  `${REST_BASE}/thread/${encodeURIComponent(conversationId)}` +
  `?with_parent_info=true&with_schematized_response=true&${VERSION_QUERY}&limit=${limit}&offset=0`;
```

The function's own doc comment at `perplexity-api.ts:450-456` confirms the semantics:

> `limit` keeps the newest N entries and still returns them oldest-first, so the last element
> is always the tip of the thread

`limit` defaults to 50 at `get-conversation.ts:37`, and the description at
`get-conversation.ts:10` states:

> Turns come from the Perplexity API, so **the whole thread is returned** regardless of what is
> scrolled into view.

Decisively, the output schema at `get-conversation.ts:23-28` carries `conversation_id`, `title`,
`url`, `turns` — and nothing else. **No `has_more`, no `next_cursor`, no `page_info`.** The
caller has no channel through which truncation could be reported even in principle.

The bot rated this "suggestion". It is silent data loss against the most emphasized requirement
in the spec.

### Impact

A 120-turn research thread read at the default `limit: 50` returns the newest 50. The caller —
told by the tool description that it has the whole thread — summarizes a conversation whose
first 70 turns, including the original question and every intermediate conclusion, it never
saw. There is no parameter that will ever return them: with `offset` pinned at `0`, raising
`limit` is the only lever and it caps at 200.

### Empirical check

Same thread (slug redacted), two calls:

```console
$ opentabs tool call perplexity__get_conversation '{"conversation_id":"<slug>","limit":50}'
turns = 2   keys = ['conversation_id', 'title', 'turns', 'url']

$ opentabs tool call perplexity__get_conversation '{"conversation_id":"<slug>","limit":1}'
turns = 1   keys = ['conversation_id', 'title', 'turns', 'url']
has_more?    False
next_cursor? False
```

A turn was dropped and the response is byte-for-byte indistinguishable in *shape* from a thread
that genuinely has one turn. That is the definition of silent truncation.

### Recommended fix

Parameterize `offset` in `threadUrl`. Add `cursor` (opaque, encoding the offset), `fetch_all`
and `max_items` to the tool input. Return `next_cursor` / `has_more` / `page_info.truncated`;
`has_more` can be derived by requesting `limit + 1` and trimming, since the endpoint reports no
total. Correct the description so it stops claiming the whole thread is returned unless
`fetch_all` was used.

Satisfies `SPEC.md` §1 (*"`truncated: true` must be set if a ceiling stopped the walk. Silent
truncation is a bug."*) and §2's `get_conversation` signature
`{ conversation_id?, cursor?, limit?, fetch_all?, … }`.

### Issue

<https://github.com/cjangrist/opentabs/issues/4>

---

## 6 — `perplexity/src/perplexity-api.ts:432-435` — `extractSources` uses `blocks.find`

**Verdict: FALSE_POSITIVE · No issue filed**

### Context

A Perplexity thread entry carries an array of typed blocks. `extractSources` pulls the web
citations that the answer's `[n]` markers index into.

### The finding

> `extractSources` uses `blocks.find(...)` — first `web_result_block` wins, the rest are dead to
> you. Meanwhile `extractAnswerText` (line 424) handles *multiple* markdown blocks. The code
> knows answers carry several blocks; it just forgot that for citations. A multi-section answer
> keeps the first batch of sources and torches the rest.
> — severity: **suggestion**

### Evaluation

Two independent reasons this does not hold.

**First, the supporting argument is a misreading.** The bot claims `extractAnswerText` "handles
multiple markdown blocks" and infers an inconsistency. It does not.
`perplexity/src/perplexity-api.ts:424-429`:

```ts
export const extractAnswerText = (blocks: AnswerBlock[]): string => {
  const markdownBlocks = blocks.filter(block => block.markdown_block);
  const preferred =
    markdownBlocks.find(block => block.intended_usage === 'ask_text') ?? markdownBlocks[markdownBlocks.length - 1];
  return preferred?.markdown_block?.answer ?? '';
};
```

It filters to markdown blocks and then deliberately selects exactly **one** — `find` on
`intended_usage === 'ask_text'`, falling back to the last. The doc comment above it
(`:419-423`) explains why: `ask_text_0_markdown` and `ask_text` are *the same answer twice*,
schematized and rendered, and the rendered one is what the page shows. Both functions select a
single block. There is no asymmetry to correct — the premise is backwards.

**Second, the multi-block case does not occur.** `perplexity-api.ts:432-435`:

```ts
export const extractSources = (blocks: AnswerBlock[]): PerplexitySource[] => {
  const webBlock = blocks.find(block => block.web_result_block);
  return mapSources(webBlock?.web_result_block?.web_results ?? []);
};
```

The schematized response assigns one block per `intended_usage`, and `web_results` is one of
them.

### Impact

None observed. `find` is behaviourally identical to `flatMap` on every thread available.

The residual: `flatMap` + de-dupe by URL would be strictly more defensive and costs one line.
That is a hardening nicety, not a defect, and does not warrant an issue.

### Empirical check — the disproof

Twelve threads (all threads on the account), read-only, over CDP from the perplexity.ai page —
every entry's block list enumerated:

```console
$ python3 cdp_eval.py --url-contains perplexity.ai --js-file px-scan.js
scanned 12
0  entries=1  maxWebBlocks=1
1  entries=2  maxWebBlocks=1
2  entries=1  maxWebBlocks=1
3  entries=1  maxWebBlocks=1
4  entries=2  maxWebBlocks=1
5  entries=1  maxWebBlocks=0     <- plan_block | markdown_block | plan_block  (no web search)
6  entries=1  maxWebBlocks=1
7  entries=2  maxWebBlocks=1
8  entries=2  maxWebBlocks=1
9  entries=1  maxWebBlocks=1
10 entries=1  maxWebBlocks=1
11 entries=1  maxWebBlocks=1
```

**16 entries across 12 threads. Maximum `web_result_block` count per entry: 1.** Never 2.

A representative entry, including a 40-source Pro search:

```json
{"entries":1,"perEntry":[{"totalBlocks":4,
  "blockKinds":["plan_block","markdown_block","plan_block","web_result_block"],
  "intended":["plan","ask_text","pro_search_steps","web_results"],
  "webBlocks":1,"webResultsPerBlock":[40]}]}
```

One `web_result_block`, `intended_usage: "web_results"`, carrying all 40 sources. The sources
are aggregated by Perplexity into a single block by design — `find` loses nothing. Confirmed
through the tool: `perplexity__get_conversation` returned `sources = 40` for that turn.

### Issue

None — false positive. Disproof recorded above and posted in-thread.

---

## 7 — `deepseek/src/deepseek-api.ts:497-499` — `getLatestMessageId` cost

**Verdict: PARTIAL · Severity: low · Issue [#10](https://github.com/cjangrist/opentabs/issues/10)**

### Context

`getLatestMessageId` resolves the tip of a DeepSeek thread so a follow-up `send_message` can
thread onto it.

### The finding

> `getLatestMessageId` calls `getConversation(id, 1)` to grab the thread tip — but `limit` only
> slices the *local* array (`turns.slice(-limit)` at line 492); the server still ships the whole
> conversation first. So every follow-up `send_message` downloads the entire history just to read
> one id off the end.
>
> 🩹 Resolve the tip message id via a lighter call (a small page or a dedicated latest-message
> field) instead of reconstructing the full thread.
> — severity: **suggestion**

### Evaluation

The mechanism is exactly right. `deepseek/src/deepseek-api.ts:497-499`:

```ts
/** Returns the id of the newest message, which a follow-up must thread onto. */
export const getLatestMessageId = async (conversationId: string): Promise<number> =>
  (await getConversation(conversationId, 1)).lastMessageId;
```

`deepseek-api.ts:450-452` — the request carries no paging parameter at all:

```ts
  const history = await getApi<HistoryMessagesResponse>(
    `/chat/history_messages?chat_session_id=${encodeURIComponent(conversationId)}`,
  );
```

and `deepseek-api.ts:489-494` — `limit` is a purely local slice applied afterwards:

```ts
  return {
    title: history.chat_session?.title ?? '',
    modelId: history.chat_session?.model_type ?? '',
    turns: turns.slice(-limit),
    lastMessageId,
  };
```

Marked PARTIAL for two reasons.

**There is no correctness bug.** `lastMessageId` is accumulated over the *full* message loop at
`deepseek-api.ts:458`, before the slice — so the id returned is correct regardless of `limit`.
The defect is bandwidth and latency only.

**The suggested fix is not available.** The bot proposes "a small page or a dedicated
latest-message field". Probing showed the endpoint ignores every paging parameter tried, and no
lighter endpoint is exposed. A fix has to reduce *duplicate* work rather than shrink the
payload.

### Impact

Every `send_message` on an existing conversation re-downloads and re-parses the entire thread —
fragment collection, thinking blocks, search results — to obtain one integer. A caller that
does `get_conversation` then `send_message` pays for the identical full history twice in
immediate succession. On the small test threads this is ~350 ms and a few KB; the payload
scales linearly with thread length, so a long research thread makes it megabytes per turn.

### Empirical check

Read-only GETs from the chat.deepseek.com page (session ids redacted):

| session | HTTP | bytes | messages | ms |
|---|---|---|---|---|
| A | 200 | 2 175 | 4 | 345 |
| B | 200 | 2 094 | 4 | 349 |
| C | 200 | 1 704 | 2 | 400 |
| D | 200 | 7 722 | 2 | 350 |
| E | 200 | 9 533 | 2 | 351 |
| F | 200 | 1 388 | 2 | 349 |

And the decisive one — the endpoint ignores paging entirely:

| request | bytes | messages |
|---|---|---|
| `/chat/history_messages?chat_session_id=A` | 2 175 | 4 |
| `…&limit=1&count=1&page_size=1` | **2 175** | **4** |

Byte-identical. There is no server-side way to ask for just the tip, which is why the bot's
suggested fix cannot be implemented as written.

### Recommended fix

In preference order: (1) thread the id through the caller — accept an optional
`parent_message_id` on `send_message`, since callers usually already hold one from the previous
turn, and fall back to `getLatestMessageId` only when absent; (2) add a light internal helper
that reads `chat_messages.at(-1).message_id` without building the whole `turns` array,
eliminating the mapping cost even though the network payload is unavoidable; (3) a
request-scoped memo so one `send_message` never fetches history twice.

No `SPEC.md` clause is violated — the returned data is correct. `SPEC.md` §0's *"Nothing is
hardcoded that can be read at query time"* rules out caching the tip id across calls, since a
concurrent message from another client would invalidate it.

### Issue

<https://github.com/cjangrist/opentabs/issues/10>

---

## 8 — `kimi/src/kimi-api.ts:577-611` — single `ListMessages`, no paging

**Verdict: CONFIRMED · Severity: high (bot said "suggestion") · Issue [#5](https://github.com/cjangrist/opentabs/issues/5)**

### Context

`getConversationTurns` backs `kimi__get_conversation`. Its tool description
(`kimi/src/tools/get-conversation.ts:10`) states:

> Messages are fetched from the Kimi API, so **the whole history is available** regardless of
> what is scrolled into view.

### The finding

> `getConversationTurns` fires one `ListMessages` with `pageSize: limit` and calls it done — no
> `nextPageToken` loop, even though `listConversations` in this same file pages properly. If Kimi
> caps `pageSize` below your requested `limit` (a documented failure mode), you silently get fewer
> turns than asked: no error, no cursor.
> — severity: **suggestion**

### Evaluation

Confirmed, and the reality is worse than the bot's conditional. `kimi/src/kimi-api.ts:545-547`
— the response type does not even *declare* a continuation token:

```ts
interface ListMessagesResponse {
  messages?: ChatMessage[];
}
```

`kimi/src/kimi-api.ts:577-586`:

```ts
export const getConversationTurns = async (
  conversationId: string,
  limit: number,
): Promise<{ turns: KimiTurn[]; lastMessageId: string }> => {
  const data = await callRpc<ListMessagesResponse>('kimi.gateway.chat.v1.ChatService/ListMessages', {
    chatId: conversationId,
    pageSize: limit,
  });

  const messages = [...(data.messages ?? [])].reverse();
```

One request, no loop. The in-file inconsistency the bot points at is real —
`kimi/src/kimi-api.ts:522-523`, in `listConversations`:

```ts
    pageToken = data.nextPageToken;
    if (!pageToken || items.length === 0) break;
```

The bot framed the trigger as "*if* Kimi caps `pageSize`". The actual trigger is far more
common: any chat with more messages than `limit`, which at the default `limit: 50` is any
moderately long conversation.

### Impact

Because `ListMessages` returns **newest-first** and the code reverses a single page, the
messages dropped are always the **oldest** — the start of the conversation, including the
original question. A caller receives a transcript that begins mid-thread while the tool
description asserts the whole history was returned.

A second, subtler consequence: reversing a truncated newest-first page can leave an orphan
assistant message at position 0 when the page boundary falls between a user prompt and its
reply. The pairing loop at `kimi-api.ts:590-608` then emits a turn with an empty `prompt` and a
populated `response` — a malformed turn presented as valid.

`AGENTS.md` lists this class directly: *"Endpoint silently caps results and ignores
`limit`/`offset`."*

### Empirical check

Read-only `ListMessages` RPCs issued from the kimi.com page. On an 11-message chat
(id redacted):

| `pageSize` | messages returned | response keys | `nextPageToken` |
|---|---|---|---|
| 200 | 11 | `["messages"]` | absent (exhausted) |
| **2** | **2** | **`["messages","nextPageToken"]`** | **present** (opaque, redacted) |

**Kimi does return a continuation token, and `getConversationTurns` throws it away.** This is
not a hypothetical cap — the server is actively handing the plugin the means to fetch the rest.

Through the plugin, same chat:

```console
$ opentabs tool call kimi__get_conversation '{"conversation_id":"<id>","limit":200}'
turns = 5   keys = ['conversation_id', 'title', 'turns', 'url']

$ opentabs tool call kimi__get_conversation '{"conversation_id":"<id>","limit":2}'
turns = 1   keys = ['conversation_id', 'title', 'turns', 'url']
has_more?    False
next_cursor? False
```

Four of five turns silently gone, with no field in the output shape capable of saying so.

### Recommended fix

Add `nextPageToken?: string` to `ListMessagesResponse`. Loop in `getConversationTurns` exactly
as `listConversations` does, sending `pageToken` on each subsequent request until `limit` is
satisfied or the token is absent. Surface `next_cursor` / `has_more` / `page_info.truncated`
and accept `cursor` / `fetch_all` / `max_items`. Pair turns only after the full set is
assembled, so a page boundary cannot orphan an assistant message. Correct the tool description.

Satisfies `SPEC.md` §1 (*"Silent truncation is a bug"*), §2 (`get_conversation` signature) and
§3 (*"Never drop content silently"*).

### Issue

<https://github.com/cjangrist/opentabs/issues/5>

---

## 9 — `qwen/src/qwen-api.ts:739,742` — bare `crypto.randomUUID()`

**Verdict: FALSE_POSITIVE · No issue filed**

### The finding

> `chat()` calls `crypto.randomUUID()` bare (lines 739, 742), but `buildHeaders` (lines 132-137)
> wraps the *same* API in a try/catch because the author knows some page contexts lack it. You
> remembered the seatbelt in the front seat and forgot it in the back. If the runtime lacks
> `crypto.randomUUID`, `send_message` throws a raw `TypeError`.
>
> 🩹 Reuse a guarded uuid helper (the one `buildHeaders` clearly believes in) instead of calling
> `crypto.randomUUID()` directly.
> — severity: **suggestion**

### Evaluation

The finding is a conditional whose premise is unreachable, resting on an inference about author
intent that the code contradicts. Four independent disproofs.

**1 — The try/catch is not about `crypto`.** `qwen/src/qwen-api.ts:132-137`:

```ts
  try {
    headers['x-request-id'] = crypto.randomUUID();
    headers.Timezone = new Date().toString();
  } catch {
    // Both headers are advisory — omit them when the environment lacks the APIs.
  }
```

The comment states the reason: these two headers are **advisory** and are dropped rather than
failing the request. `new Date().toString()` cannot throw at all, so the block is not a
targeted `crypto` guard. The identical pattern appears in `kimi/src/kimi-api.ts:140-144`, where
the comment names the real subject:

```ts
  try {
    headers['r-timezone'] = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Timezone is advisory — omit it when the environment does not expose Intl.
  }
```

The pattern is "advisory header", not "crypto might be missing".

**2 — The premise is false in the deployment target.** `crypto.randomUUID` is available in every
secure context. This plugin executes inside the `https://chat.qwen.ai` page — it reads
`localStorage`, `window.location`, and issues same-origin `fetchFromPage` requests. It cannot
run anywhere else.

**3 — The repo-wide pattern contradicts the inference.** Bare `crypto.randomUUID()` appears at
seven call sites across five providers in this same PR:

```
gemini/src/gemini-api.ts:276
copilot/src/copilot-api.ts:631
claude/src/tools/create-conversation.ts:23
qwen/src/qwen-api.ts:133, 739, 742
grok/src/grok-api.ts:700, 737
perplexity/src/perplexity-api.ts:539   // const randomUuid = (): string => crypto.randomUUID();
```

If the premise held, the entire repo would be broken and the bot flagged one provider.
Note in particular `perplexity-api.ts:539`, which defines a `randomUuid` helper that is itself
an unguarded passthrough — the codebase's own considered position on this API.

**4 — The suggested fix references code that does not exist.** There is no guarded uuid helper
in `@opentabs-dev/plugin-sdk`; `grep -ri uuid` over the SDK's `dist/` returns nothing. The
remedy the bot proposes ("reuse the guarded uuid helper") cannot be applied.

### Impact

None. `send_message` cannot throw the described `TypeError` in any context the plugin runs in.

### Empirical check — the disproof

On the authenticated chat.qwen.ai page:

```console
$ python3 cdp_eval.py --url-contains chat.qwen.ai --js-file qwen-probe.js
{"hasCryptoRandomUUID": true, "isSecureContext": true, …}
```

`crypto.randomUUID` is a function and the context is secure — the branch the finding depends on
does not exist at runtime.

### Issue

None — false positive. Disproof recorded above and posted in-thread.

---

## 10 — `claude/src/claude-api.ts:13-32` — comment promises `intercomSettings`

**Verdict: CONFIRMED (severity framing overstated) · Severity: low · Issue [#11](https://github.com/cjangrist/opentabs/issues/11)**

### Context

`getAuth()` gates every Claude tool: `api()`, `apiStream()` and `orgApi()` all call it and raise
`AUTH_ERROR` on `null`, and `orgApi` needs its `orgId` to build `/api/organizations/<id>/…`.

### The finding

> The header comment (lines 14-16) brags that auth is detected via the intercomSettings global
> *or* the lastActiveOrg cookie — but `getAuth` only ever reads the cookie. So the whole plugin's
> auth rests on a single cookie, with the documented fallback nowhere in sight. That is exactly
> the auth-keyed-on-one-cookie → all-tools-dead-overnight failure your own AGENTS.md warns about.
> — severity: **suggestion**

### Evaluation

The core claim is straightforwardly true. `claude/src/claude-api.ts:13-32`:

```ts
// --- Auth ---
// Claude.ai uses HttpOnly session cookies — requests with credentials: 'include'
// are automatically authenticated. We detect auth via the intercomSettings global
// or the lastActiveOrg cookie.

interface ClaudeAuth {
  orgId: string;
}

const getAuth = (): ClaudeAuth | null => {
  const cached = getAuthCache<ClaudeAuth>('claude');
  if (cached) return cached;

  const orgId = getCookie('lastActiveOrg');
  if (!orgId) return null;

  const auth: ClaudeAuth = { orgId };
  setAuthCache('claude', auth);
  return auth;
};
```

Two signals documented, one implemented. `intercomSettings` appears nowhere else in the plugin.

The escalation to "all-tools-dead-overnight" is overstated. The reddit precedent
`AGENTS.md` cites is severe because it failed *silently*; here a missing cookie produces a clean,
actionable `AUTH_ERROR` from `claude/src/claude-api.ts:50`. That is a loud failure, which is why
this is scored low rather than the outage the comment implies. The finding is nonetheless
confirmed as a documentation defect with a real resilience tail.

The empirical check also invalidates the bot's own suggested fix — see below.

### Impact

Present harm: a maintainer debugging a Claude auth failure reads the header comment, goes
looking for the `intercomSettings` fallback, and finds neither the code nor — as it turns out —
the global. Time lost, confidence misplaced. `AGENTS.md` code style: *"write a comment only to
explain **why** something non-obvious is done"*; a comment describing behaviour the code does
not have is worse than none.

Tail risk: if Anthropic renames or drops `lastActiveOrg`, `getAuth()` returns `null` for a
fully logged-in user and every Claude tool tells them to log in when they already are.

A separate wrinkle noticed while reading: `getAuth` returns the `getAuthCache` value **before**
re-reading the cookie, so a user who switches organisation mid-session may keep hitting the
previous org's endpoints until the cache expires. Folded into the issue.

### Empirical check

On the authenticated claude.ai tab:

```console
$ python3 cdp_eval.py --url-contains claude.ai --js-file claude-probe.js
{"hasIntercomSettings": false,
 "cookieNames": ["_fbp","anthropic-device-id","activitySessionId","user-sidebar-visible-on-load",
                 "CH-prefers-color-scheme","__ssid","_gcl_au","ajs_anonymous_id","sessionKeyLC",
                 "lastActiveOrg","_dd_s_v2"],
 "hasLastActiveOrg": true,
 "otherGlobals": []}
```

(cookie **names** only; no values.)

`window.intercomSettings` is **undefined**. So the comment does not merely describe unwritten
code — it names a signal that is not there to implement, and the bot's suggested fix ("implement
the documented second signal") is impossible as written. `lastActiveOrg` is present and is
genuinely the only org-id-bearing signal among the enumerated cookies and globals.

### Recommended fix

Minimum: delete the `intercomSettings` clause and replace it with what is true and *why* — auth
is the `lastActiveOrg` cookie because claude.ai exposes the org id nowhere else in the page.
Better: add a real second signal and document it — `sessionKeyLC` as a login indicator, and
`GET /api/organizations` as an authoritative fallback when the cookie is missing (`waitForAuth`
already polls, so an async fallback fits). While editing, make the `getAuthCache`
short-circuit re-validate against the current cookie.

Satisfies `AGENTS.md` (*"Implement a REAL `isReady()` auth check"*) and its comment-style rule.

### Issue

<https://github.com/cjangrist/opentabs/issues/11>

---

## 11 — `gemini/src/gemini-api.ts:273-286` — hand-concatenated JSON header

**Verdict: CONFIRMED · Severity: low · Issue [#7](https://github.com/cjangrist/opentabs/issues/7)**

### Context

Gemini's `StreamGenerate` call selects a model through the `x-goog-ext-525001261-jspb` header,
a JSON-encoded jspb array with the model id at index 4.

### The finding

> `modelHeader` is hand-concatenated with `${resolvedModelId}` wedged between quotes into a JSON
> string. A `model_id` containing a double-quote (user-controllable, and Gemini doesn't validate
> it against the model list) produces a header that is neither valid JSON nor a valid jspb — the
> request leaves the station already derailed.
> — severity: **suggestion**

### Evaluation

Confirmed on both counts, and the second count — the missing validation, which the bot mentions
only parenthetically — is the more important defect.

`gemini/src/gemini-api.ts:273-286`:

```ts
  // Build model header — include model ID if specified
  const resolvedModelId = modelId ?? 'fbb127bbb056c959';
  const modelHeader = `[1,null,null,null,"${resolvedModelId}",null,null,0,[4],null,null,1]`;
  const sessionId = crypto.randomUUID();
  …
    headers: {
      ...STREAM_HEADERS,
      'x-goog-ext-525001261-jspb': modelHeader,
      'x-goog-ext-525005358-jspb': `["${sessionId}",1]`,
    },
```

`modelId` is fully caller-controlled and reaches this line unvalidated.
`gemini/src/tools/send-message.ts:32`:

```ts
    model_id: z.string().optional().describe('Model ID to use (from list_models). Defaults to the active model.'),
```

passed at `send-message.ts:38-44` straight into `apiSendMessage(..., params.model_id)`. Neither
`send-message.ts` nor `create-conversation.ts:16` checks membership against `getModels()` —
unlike qwen's `resolveModelId` (`qwen/src/qwen-api.ts:269-280`), which does exactly that.

Severity is low rather than higher because the practical outcome is a confusing failure, not a
security boundary crossing: a stray quote yields a malformed jspb that Gemini rejects, and
`\r`/`\n` makes `fetch()` throw on an illegal header value before the request leaves the
browser. There is no cross-origin or smuggling consequence.

### Impact

An agent that reads a display name (rather than an id) out of `gemini__list_models`, or a user
who pastes a quoted id, dispatches a request with a corrupt header. Gemini rejects it or
silently falls back to a different model, and the plugin surfaces this as an opaque
stream-parse failure rather than "invalid model id" — which, per `SPEC.md` §4, should have been
a `VALIDATION_ERROR` listing the valid ids **before any request was sent**.

Also noted: the hardcoded default `'fbb127bbb056c959'` at line 274 sits against `SPEC.md` §0
(*"Nothing is hardcoded that can be read at query time"*) and §4 (*"Never ship a hardcoded
array"*) — the default should come from `getModels()`.

### Empirical check

Reproduced with the exact template from line 275 (no network call — the defect is in string
construction):

```console
$ node -e '…'
concat  : [1,null,null,null,"x","evil":"y",null,null,0,[4],null,null,1]
JSON.parse: THROWS -> Expected ',' or ']' after array element in JSON at position 28
stringify: [1,null,null,null,"x\",\"evil\":\"y",null,null,0,[4],null,null,1]
stringify parses: true   elem[4] round-trips: true
```

A `model_id` of `x","evil":"y` produces a header that is not parseable JSON.
`JSON.stringify` on the same input escapes correctly and round-trips exactly.

The missing validation was verified by reading the full call path
(`send-message.ts` → `apiSendMessage` → line 274); `getModels()` is never consulted. Not
exercised end-to-end live, because sending a message is a mutation and this pass was read-only.

### Recommended fix

```ts
const resolvedModelId = await resolveModelId(modelId); // validates against getModels()
const modelHeader = JSON.stringify([1, null, null, null, resolvedModelId, null, null, 0, [4], null, null, 1]);
const sessionHeader = JSON.stringify([sessionId, 1]);
```

Satisfies `SPEC.md` §4 — *"`model_id` — validated against the live list; invalid ⇒
`VALIDATION_ERROR` **listing the valid ids**, before any request is sent."* Model the validator
on `qwen/src/qwen-api.ts:269-280`.

### Issue

<https://github.com/cjangrist/opentabs/issues/7>

---

## 12 — `kimi/src/kimi-api.ts:88-105` — unguarded `response.json()` in `refreshAccessToken`

**Verdict: CONFIRMED · Severity: low · Issue [#8](https://github.com/cjangrist/opentabs/issues/8)**

### Context

`refreshAccessToken` is the recovery path when Kimi's ~15-minute access token expires
mid-session. `callRpc` invokes it on any `401` and retries (`kimi/src/kimi-api.ts:164-170`), so
every Kimi tool can route through it.

### The finding

> `refreshAccessToken` does `await response.json()` with no try/catch — in the same file that
> wraps `JSON.parse` in try/catch twice (lines 111, 202). So a 2xx that isn't JSON (a gateway
> error page) detonates as a raw `SyntaxError` instead of failing cleanly as not-authenticated.
> — severity: **nitpick**

### Evaluation

Accurate in every particular, including both line references.
`kimi/src/kimi-api.ts:92-100`:

```ts
  const response = await fetch(REFRESH_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${refreshToken}` },
    credentials: 'include',
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as { access_token?: string; refresh_token?: string };
  if (!payload.access_token) return null;
```

The `!response.ok` guard covers non-2xx. It does not cover a **2xx with a non-JSON body**, where
`response.json()` throws.

The two cited precedents are exactly as described. `kimi-api.ts:111-115` (`readDeviceId`):

```ts
  try {
    return (JSON.parse(raw) as { webId?: string }).webId ?? '';
  } catch {
    return '';
  }
```

`kimi-api.ts:202-206` (`decodeConnectFrames`):

```ts
    try {
      events.push(JSON.parse(body) as Record<string, unknown>);
    } catch {
      // Trailer frames can be empty — skip anything that is not JSON.
    }
```

`refreshAccessToken` is the sole unguarded parse in the file.

### Impact

The function's contract is `Promise<string | null>`, `null` meaning "could not refresh", which
`callRpc` converts into an actionable message at `kimi-api.ts:168`:

```ts
    if (!refreshed) throw ToolError.auth('Kimi session expired — please reload https://www.kimi.com and log in.');
```

A `SyntaxError` breaks that contract: it propagates out of `callRpc` uncaught and
uncategorised, so at the exact moment the user's session lapses they see
`Unexpected token '<', "<!DOCTYPE "... is not valid JSON` instead of "log in again".

Realistic 2xx-non-JSON triggers: a Cloudflare or corporate-proxy interstitial in front of
`www.kimi.com/api/auth/token/refresh`, a captive-portal login page, an empty body, an HTML
maintenance page served at 200. Severity is low because it requires that specific coincidence,
and the outcome is a confusing error rather than wrong data.

### Empirical check

**Not verified live — reasoning and code precedent only.** Exercising `refreshAccessToken`
means calling Kimi's refresh endpoint, which rotates the stored refresh token and writes it back
to `localStorage`. That is a mutation of the user's live session, and this pass was read-only.
Forcing a non-JSON 2xx from that endpoint is not possible without a proxy.

The evidence is therefore the code path plus the two in-file precedents quoted above. The
issue specifies stubbed-`Response` unit tests as the verification bar.

### Recommended fix

Mirror the existing pattern:

```ts
  let payload: { access_token?: string; refresh_token?: string };
  try {
    payload = (await response.json()) as { access_token?: string; refresh_token?: string };
  } catch {
    return null;
  }
```

Satisfies `SPEC.md` §0 — a refresh that cannot be parsed is a refresh that failed, and must
surface as `AUTH_ERROR`, not an unclassified exception.

### Issue

<https://github.com/cjangrist/opentabs/issues/8>

---

## 13 — `qwen/src/qwen-api.ts:250-259` — `getModels` reads `response.data` directly

**Verdict: PARTIAL · Severity: low · Issue [#9](https://github.com/cjangrist/opentabs/issues/9)**

### Context

`getModels` backs `qwen__list_models` and is the validation source for `resolveModelId` /
`getDefaultModelId`, so every `qwen__send_message` and `qwen__create_conversation` passes
through it.

### The finding

> `getModels` calls `/models` via `callApi` and reads `response.data` directly — the one endpoint
> that skips `unwrap`, which every other call uses to check `success`/`code`/`msg`. Qwen answers
> HTTP 200 even on auth/rate-limit errors, so a failure here surfaces as the misleading
> `Qwen returned no models` instead of the actual reason.
>
> 🩹 Route `/models` through `getWrapped` (which unwraps and checks `success`), or run
> `describeApiError` on the raw response before reading `.data`.
> — severity: **suggestion**

### Evaluation

There is a real gap here, but not the one described — hence PARTIAL. The code is as quoted;
`qwen/src/qwen-api.ts:250-259`:

```ts
export const getModels = async (): Promise<QwenModel[]> => {
  const response = await callApi<{ data?: RawModel[] }>('/models', { method: 'GET' });
  const models = (response.data ?? [])
    .filter(model => typeof model.id === 'string' && model.info?.is_active !== false)
    .map(mapModel);
  if (models.length === 0) {
    throw ToolError.internal('Qwen returned no models — reload https://chat.qwen.ai and try again.');
  }
  return models;
};
```

Three corrections to the bot's characterization:

1. **`/models` is not "the one endpoint that skips `unwrap`".** `getCurrentUser` also uses raw
   `callApi` for `/v1/auths/` — with an explicit comment at `qwen-api.ts:199` saying so:
   *"`/api/v1/auths/` is unwrapped — it returns the profile object directly."* Two endpoints,
   deliberately.
2. **`/models` is not a v2-envelope endpoint.** It returns a bare `{data: [...]}` with no
   `success`, `code` or `msg`. So `unwrap` (`qwen-api.ts:157-165`), which only throws on
   `success === false`, would change nothing — the suggested fix is inert.
3. **`/models` is not auth-gated**, so the specific "auth error at HTTP 200" scenario cannot
   arise there.

What *is* real: `getModels` has **no error classification at all**, and neither does `callApi`
(`qwen-api.ts:167-175`), which returns `await response.json()` with no `response.ok` check —
the identical omission as grok's `callRest` (finding 2).

### Impact

Narrower than reported but genuine:

- **Rate limiting / risk control.** Qwen fronts these endpoints with Alibaba risk control
  (hence the `bx-v` header). A `429` or challenge response has no `data` → `response.data ?? []`
  → `[]` → the user is told to "reload the page" when the correct answer is `RATE_LIMIT,
  retryable: true` with a backoff.
- **Non-JSON body.** A challenge or maintenance page makes `await response.json()` throw a raw
  `SyntaxError` out of `callApi`, unclassified.
- **Non-2xx generally.** No `response.ok` check, so a `500` with a JSON error object is cast to
  `{data?: RawModel[]}` and reported as "no models".
- **Blast radius.** Because `resolveModelId` calls `getModels`, this misleading message also
  masks every `send_message` failure whose real cause was upstream.

### Empirical check

Read-only probes from the chat.qwen.ai page:

| request | HTTP | body keys | models |
|---|---|---|---|
| `/api/models` with the real bearer + cookies | 200 | `["data"]` | 18 |
| `/api/models` with `Bearer bogus.invalid.token`, `credentials: 'omit'` | **200** | `["data"]` | **18** |

Two results. The envelope keys are `["data"]` only — no `success`, no `code`, no `msg` — so
this is not a v2-envelope endpoint and `getWrapped` would be a no-op. And a bogus bearer with
credentials omitted still returns the full 18-model list, so the endpoint is effectively
unauthenticated and the reported auth-failure scenario is not reproducible.

The residual failure modes above were not reproduced live: forcing a 429 would mean
deliberately tripping Alibaba risk control on the user's real account, which is neither
read-only nor safe. They are argued from `callApi`'s missing `response.ok` check.

### Recommended fix

Fix it in `callApi`, which also covers `getCurrentUser`. Branch on status before parsing (401/403
→ `AUTH_ERROR`, 429 → `RATE_LIMIT` with `retryable: true`, other `!ok` → `UPSTREAM_ERROR`);
parse via `text()` + `try { JSON.parse }`. In `getModels`, before the `length === 0` throw, run
`describeApiError` on the parsed object and raise with Qwen's own reason when `msg` / `detail` /
`code` is present, reserving "Qwen returned no models" for a genuine `{data: []}`. Record in a
comment what the probe found, so the next reader does not "fix" it back to `getWrapped`.

Satisfies `SPEC.md` §0 — *"HTTP 200 with an error payload … must be classified, never treated as
success."* `SPEC.md` §4 also requires the model list be parsed live on every call, so a transient
upstream failure must be reported rather than degraded into an empty list.

### Issue

<https://github.com/cjangrist/opentabs/issues/9>

---

## Method

- **Source of truth:** every finding re-derived from the working tree at
  `c4c3e5493adc3b208240f8acefec7138b054417e`, with callers traced. The bot's characterization was
  treated as a hypothesis, not evidence — three of thirteen did not survive that.
- **Live verification:** OpenTabs MCP server in dev mode on `127.0.0.1:9515`, driven through
  `opentabs tool call`; the authenticated stealth Chromium on CDP `127.0.0.1:9222` for
  in-page DOM inspection and read-only `fetch` probes against each provider's own API.
- **Read-only discipline:** no message was sent, no conversation created, renamed, archived or
  deleted, no token rotated. The two findings needing a mutation to reproduce (12, and the
  rate-limit tail of 13) are marked "not verified live" with the reason.
- **Rate limiting:** MCP calls spaced; provider probes issued over CDP where possible to avoid
  the server's 429.
- **Redaction:** this repo is public. Conversation ids, thread slugs, titles, message ids and
  page tokens are redacted; cookie **names** appear where load-bearing, never values; no token,
  cookie value, HAR or account email appears anywhere in this document or in the filed issues.

## Scratch

Probe scripts and raw output live outside the repo at
`~/opentabs/trash/2026-08-07-kilo-triage/` (gitignored, not committed).
