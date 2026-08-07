# SPEC.md — normalized LLM-provider contract

Every chat provider in this repo exposes **the same tool names, the same inputs, and the
same output shapes**. Provider quirks live behind this surface, never in new tool names.

Providers: `gemini` `claude` `chatgpt` `kimi` `perplexity` `deepseek` `qwen` `grok`
`copilot` `zai`.

**If a provider genuinely lacks a capability, omit the tool** and declare it as `false` in
`list_capabilities().features` with a `reason`. Never ship a stub that returns empty.

> **The shapes below are implemented once, in
> [`docs/reference/normalized-schemas.ts`](docs/reference/normalized-schemas.ts).** Copy that
> file verbatim into `<provider>/src/tools/normalized-schemas.ts` rather than re-deriving the
> zod. If a shape there is wrong, fix it there *and* here in the same PR.

---

## 0. Conventions

- Tool names are snake_case and unprefixed in source; the platform namespaces them as
  `<provider>__<tool>`.
- Timestamps are **unix seconds** (integer), named `created_at` / `updated_at`.
- IDs are strings, always the provider's native id, never a synthesized index. This applies
  to §3 items too: use the provider's own message/tool-call id verbatim (the `type` field
  already disambiguates, so the illustrative `msg_…` / `tc_…` prefixes below are not
  required). Synthesize an id **only** where the provider has none — e.g. reasoning blocks
  that carry no id — and say so in the tool description.
- "Absent" is `null`. Never `""`, and never an omitted key: a field in these shapes is
  always present.
- Nothing is hardcoded that can be read at query time — model lists, toggle values and
  limits are parsed from the live site/API on every call.

### Error taxonomy

Every tool raises one of: `AUTH_ERROR`, `NOT_FOUND`, `VALIDATION_ERROR`, `RATE_LIMIT`,
`UNSUPPORTED`, `UPSTREAM_ERROR`, `TIMEOUT`, each with `retryable: boolean`.
HTTP 200 with an error payload (SSE/Connect/WebSocket frames, `{"json":{"errors":[…]}}`,
`{"name":"…Error"}`) **must** be classified, never treated as success.

---

## 1. Pagination — mandatory, explicit, on every list tool

There is no unpaginated list tool in this repo.

**Input** (every `list_*` tool):

| field | type | default | notes |
|---|---|---|---|
| `cursor` | `string?` | — | opaque; pass back `next_cursor` verbatim |
| `limit` | `int?` | `50` | 1–200; page size requested from the provider |
| `fetch_all` | `bool?` | `false` | follow cursors until exhausted or `max_items` |
| `max_items` | `int?` | `1000` | hard ceiling when `fetch_all` is true |

**Output** (every `list_*` tool):

```jsonc
{
  "items": [ /* … */ ],
  "next_cursor": "…" | null,     // null iff there is definitively no more data
  "has_more": true | false,
  "total": 1004 | null,          // null when the provider does not report a true total
  "page_info": { "returned": 50, "pages_fetched": 1, "truncated": false }
}
```

Rules:

- `truncated: true` **must** be set if a ceiling stopped the walk. Silent truncation is a bug.
- If the provider ignores `limit`/`offset` or hard-caps a page (perplexity capped at 20,
  gmail at ~101, grok at 60), document it in the tool description and drive the real cursor.
- If the provider's `total` is not a true total (chatgpt returns `offset+items+1`), return
  `null` and explain in the description rather than passing a lie through.
- **Verification bar:** pagination is only "done" when proven **across a page boundary** —
  page 1 + page 2 with `limit` small, ids disjoint, and the union matching a `fetch_all` run.

---

## 2. Conversations — basics

- `list_conversations` — paginated. Item shape:
  ```jsonc
  { "id": "…", "title": "…", "url": "…", "created_at": 0, "updated_at": 0,
    "project_id": "…" | null, "model_id": "…" | null, "is_archived": false,
    "is_starred": false }
  ```
- `get_conversation` — `{ conversation_id?, cursor?, limit?, fetch_all?, include_reasoning?, include_tool_calls? }`.
  `conversation_id` omitted ⇒ resolve from the active tab. Returns the paginated **item list**
  defined in §3.
- `create_conversation` — `{ text, model_id?, project_id?, thinking?, thinking_level?, search?, tools? }`
  → `{ conversation_id, message_id, items: [...] }`
- `send_message` — same options plus `conversation_id?` (omitted ⇒ active tab).
- `search_conversations` — paginated, where the provider supports it.
- `rename_conversation`, `delete_conversation`, `archive_conversation` — where supported.

### The 25-second tool budget

The OpenTabs adapter aborts a tool handler after **25 s of script execution**, which is
shorter than a long completion on every provider here. A tool that simply `await`s the
stream therefore dies mid-flight and reports a platform timeout with no result.

`create_conversation` / `send_message` must instead stop *waiting* before that budget
(~18 s is a safe ceiling), **without cancelling the in-flight request**, and return

```jsonc
{ "conversation_id": "…", "message_id": "…", "status": "in_progress", "items": [ … ] }
```

The generation continues in the page and lands normally — verified on claude.ai, where a
141 s completion still persisted in full after the handler returned — so the caller polls
`get_conversation` for the finished reply. `status` is `"completed"` when the stream
finished inside the budget.

---

## 3. Message format — OpenAI Responses item schema

`get_conversation`, `create_conversation` and `send_message` all return `items`: a flat,
ordered array of **Responses-style output items**. This is the single most important
consistency requirement in this repo.

```jsonc
// user / assistant message
{
  "id": "msg_…",
  "type": "message",
  "role": "user" | "assistant" | "system",
  "status": "completed" | "in_progress" | "incomplete",
  "created_at": 1712345678,
  "model": "claude-sonnet-5" | null,          // assistant only
  "content": [
    { "type": "input_text",  "text": "…" },   // role=user
    { "type": "output_text", "text": "…",     // role=assistant
      "annotations": [
        { "type": "url_citation", "url": "…", "title": "…",
          "start_index": 0, "end_index": 12 }
      ] }
  ]
}

// reasoning / extended thinking
{ "id": "rs_…", "type": "reasoning",
  "summary": [ { "type": "summary_text", "text": "…" } ],
  "effort": "max" | null }            // the PROVIDER'S native level id, or null

// web search performed by the model
{ "id": "ws_…", "type": "web_search_call", "status": "completed",
  "action": { "type": "search", "query": "…", "url": null },
  "results": [ { "title": "…", "url": "…", "snippet": "…", "site_name": "…" } ] }

// any other provider tool invocation
{ "id": "tc_…", "type": "tool_call", "name": "code_interpreter",
  "status": "completed", "arguments": {…}, "output": "…" | null }
```

Field notes:

- `status` on every item is `completed` | `in_progress` | `incomplete`. A tool call whose
  result has not arrived is `in_progress`; one the provider flagged as an error is
  `incomplete`.
- `reasoning.effort` carries the **provider's own** level id (`"xhigh"`, `"max"`, …) or
  `null`. It is deliberately not an enum: provider effort ladders differ in both length and
  naming. The *request* ladder is the normalized `thinking_level` in §4.
- `web_search_call.action` is `{ type, query, url }`; `query` is null for non-search actions
  and `url` is null for plain searches. `type` is the provider's action kind, `"search"` in
  the common case.
- `tool_call.arguments` is an object (the tool input as the provider recorded it) and
  `output` is the result rendered as text, or `null` when there is no result yet. If the
  output is truncated for size, mark the truncation in the text — never silently.

Rules:

- **Concatenate every text block.** Never return only the first (this dropped 673 of 946
  chatgpt messages). Join multiple text parts with `\n\n`.
- Never drop content silently. Reasoning and tool items are excluded by default via
  `include_reasoning` / `include_tool_calls` (both default `false`), and whatever was left
  out **must** be counted in `omitted`:
  ```jsonc
  "omitted": { "reasoning": 3, "tool_calls": 5, "hidden": 0, "empty": 0 }
  ```
  `omitted` covers the **whole** conversation, not just the returned page, so a caller can
  tell at a glance how much was filtered without walking every page. Say so in the tool
  description.
- Non-text parts render as a labelled placeholder, e.g. `[image 800x600 <ref>]` — never `""`.
- Citations map to `url_citation` annotations with indices into the `output_text` when the
  provider gives positions; otherwise `start_index`/`end_index` are `null`.

---

## 4. Models — always dynamic

`list_models` (paginated only if the provider paginates; otherwise `items` + `has_more:false`):

```jsonc
{
  "id": "…", "display_name": "…", "description": "…",
  "is_default": false, "is_available": true,
  "requires_subscription": "TIER_PRO" | null,
  "context_window": 200000 | null,
  "capabilities": {
    "thinking":       { "supported": true,
                        // the PROVIDER'S native level ids, coarsest first,
                        // or null when thinking is a plain on/off toggle
                        "levels": ["low","medium","high","xhigh","max"] | null,
                        "per_message": true },
    "web_search":     { "supported": true, "per_message": true },
    "deep_research":  { "supported": true },
    "vision":         { "supported": false },
    "code_interpreter": { "supported": false }
  }
}
```

- **Parse from the live picker/API at query time.** Never ship a hardcoded array; never
  invent an id the site's own picker does not show (the kimi `x-msh-version` A/B trap).
- Cross-check the parsed list against the rendered model picker before declaring it correct.
- Selection params on `create_conversation` / `send_message`:
  - `model_id` — validated against the live list; invalid ⇒ `VALIDATION_ERROR` **listing the
    valid ids**, before any request is sent.
  - `thinking?: boolean` and `thinking_level?: "minimal"|"low"|"medium"|"high"|"max"`.
    Map onto whatever the provider actually calls it (effort, reasoning mode, DeepThink,
    Expert model). If thinking is a *model* rather than a toggle, `thinking: true` selects
    that model and this mapping is documented in the tool description.
    `capabilities.thinking.levels` reports the provider's **native** ids, which will not
    line up one-to-one with the five normalized ones; **document the mapping in the tool
    description**, and raise `VALIDATION_ERROR` rather than silently ignoring a level or
    toggle a model does not have. (claude.ai: `minimal→low, low→low, medium→medium,
    high→high, max→max`, falling back to the nearest lower step a model publishes; `xhigh`
    exists natively and is not reachable through the normalized ladder.)
  - `search?: boolean`. If the provider ignores it and searches autonomously, say so in the
    description — do not pretend it is a control.

---

## 5. Projects / folders

Where supported (`claude` projects, `chatgpt` folders, `perplexity` spaces, `kimi`/`qwen`
projects, `gemini` gems, …):

- `list_projects` — paginated
- `get_project` — `{ project_id }`
- `list_project_conversations` — `{ project_id, …pagination }`, where the provider can list
  a project's members. This is how a move is proven from both sides.
- `create_project` — `{ name, description? }`
- `update_project` — `{ project_id, name?, description? }`
- `delete_project` — `{ project_id }`
- `add_conversation_to_project` — `{ conversation_id, project_id }`
- `remove_conversation_from_project` — `{ conversation_id, project_id? }`
- `move_conversation_to_project` — `{ conversation_id, to_project_id, from_project_id? }`
  (must be atomic-ish: verify the source membership is gone and the target has it)

Project item shape:
```jsonc
{ "id": "…", "name": "…", "description": "…" | null,
  "created_at": 0, "updated_at": 0, "conversation_count": 0 | null, "url": "…" }
```

**Verification bar:** create → add an existing conversation → move it to a second project →
confirm via `list_conversations` that `project_id` changed and via `get_project` that
membership moved. Clean up afterwards.

---

## 6. Capabilities & toggles

`list_capabilities` — one tool per provider, no input:

```jsonc
{
  "provider": "claude",
  "models": [ /* §4 items */ ],
  "toggles": [
    { "id": "thinking", "display_name": "Extended thinking", "type": "enum",
      "values": ["off","low","medium","high"], "default": "off",
      "scope": "per_message", "applies_to_models": ["claude-opus-5"] },
    { "id": "web_search", "display_name": "Web search", "type": "boolean",
      "default": true, "scope": "per_message", "controllable": false,
      "note": "provider searches autonomously; flag is a hint" }
  ],
  "features": {
    "projects":        { "supported": true,  "reason": null },
    "deep_research":   { "supported": true,  "reason": null },
    "search_conversations": { "supported": false, "reason": "no search endpoint" },
    "archive_conversation": { "supported": true, "reason": null }
  }
}
```

`scope` is `per_message` or `account`. `controllable: false` marks a toggle the provider
exposes but ignores. This tool is how a caller discovers what a provider can actually do —
it must be **derived live**, not a static literal.

Normative details, so all ten providers answer the same question the same way:

- `features` contains **exactly** the keys in `NORMALIZED_FEATURE_KEYS`
  (`docs/reference/normalized-schemas.ts`) — every provider reports every key, so a consumer
  branches on a fixed set instead of probing:
  `list_conversations`, `get_conversation`, `create_conversation`, `send_message`,
  `search_conversations`, `rename_conversation`, `delete_conversation`,
  `archive_conversation`, `projects`, `project_membership`, `models`, `thinking`,
  `web_search`, `deep_research`, `vision`, `code_interpreter`.
- `reason` is always present: a string when `supported` is false, `null` when it is true.
- A toggle's `default` is a **boolean** when `type` is `"boolean"` and a **string** when
  `type` is `"enum"`. `values` is `null` for boolean toggles.
- `applies_to_models` lists the model ids the toggle affects, or `null` when it applies to
  all of them.

---

## 7. Deep research — multi-step with clarification handling

Modelled as a job, because every provider runs it asynchronously over minutes.

- `start_deep_research`
  `{ text, model_id?, project_id?, auto_answer_clarifications?: bool = true,
     clarification_answer?: string = "Include everything." }`
  → `{ research_id, conversation_id, status }`

  `research_id` is the provider's own job id where one exists; where the run has no
  identity of its own (claude.ai), use the conversation id and say so in the description.

- `get_deep_research` `{ research_id }` →
  ```jsonc
  {
    "research_id": "…", "conversation_id": "…",
    "status": "queued" | "clarifying" | "running" | "completed" | "failed" | "cancelled",
    "clarifying_question": "…" | null,
    "auto_answered": true | false,
    "progress": { "steps_completed": 7, "current_step": "Reading sources", "sources_found": 42 },
    "items": [ /* §3 items, when completed */ ],
    "sources": [ { "title": "…", "url": "…", "snippet": "…" } ],
    "error": null
  }
  ```

- `answer_deep_research` `{ research_id, text }` — supplies the clarification and resumes.
- `cancel_deep_research` `{ research_id }` — where supported.

Behaviour:

- **Default (`auto_answer_clarifications: true`)**: when the model asks a follow-up, the
  plugin replies `"Include everything."` automatically and continues. `get_deep_research`
  must still report `auto_answered: true` and echo the `clarifying_question` so the caller
  can see what was asked. Qwen asks essentially always; Claude sometimes.
- **`auto_answer_clarifications: false`**: the job parks in `status: "clarifying"` with
  `clarifying_question` set, and waits for `answer_deep_research`. **Raise this to the user.**
- `start_deep_research` must return promptly — it must not block for the whole run.
- Detecting "is this a clarifying question?" is provider-specific; state in the tool
  description exactly how it is detected, and make it conservative (a false "clarifying"
  that parks a completed run is worse than a passthrough).

**Verification bar:** run one real research job end-to-end per provider, poll to
`completed`, and confirm sources are non-empty. Exercise the clarification path explicitly
on at least Qwen (which reliably asks).

---

## 8. Out of scope (deliberately, for now)

File upload and attachment handling. Do not implement it; do not add tool params for it.
