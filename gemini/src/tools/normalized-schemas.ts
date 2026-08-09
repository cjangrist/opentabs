// ---------------------------------------------------------------------------
// normalized-schemas.ts — the canonical zod definition of every shape in SPEC.md
// ---------------------------------------------------------------------------
//
// This file is the authority for cross-provider consistency. Copy it VERBATIM
// into your provider (`<provider>/src/tools/normalized-schemas.ts`) rather than
// re-deriving the shapes — the whole point of SPEC.md is that a single consumer
// can drive all ten providers with one set of parsers.
//
// If a shape here is wrong or missing, change it HERE and in SPEC.md in the same
// PR, then re-copy. Never fork it privately inside one provider.
//
// Conventions (SPEC.md §0):
//   - timestamps are unix SECONDS (integer), named created_at / updated_at
//   - ids are strings, always the provider's native id
//   - "absent" is `null`, never `""` and never an omitted key
//
// Requires zod ^4.
// ---------------------------------------------------------------------------

import { z } from 'zod';

// ---------------------------------------------------------------------------
// §0 — Error taxonomy
// ---------------------------------------------------------------------------

/**
 * The seven codes every tool is allowed to raise. Pass one as the second
 * argument to `new ToolError(message, code, { retryable })`, or use the
 * `ToolError.*` helpers whose default codes already match this list
 * (`ToolError.auth` → AUTH_ERROR, `.notFound` → NOT_FOUND, `.validation` →
 * VALIDATION_ERROR, `.timeout` → TIMEOUT). `RATE_LIMIT` and `UPSTREAM_ERROR`
 * have no helper — construct them explicitly so the code string stays exact.
 */
export const NORMALIZED_ERROR_CODES = [
  'AUTH_ERROR',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'RATE_LIMIT',
  'UNSUPPORTED',
  'UPSTREAM_ERROR',
  'TIMEOUT',
] as const;

export type NormalizedErrorCode = (typeof NORMALIZED_ERROR_CODES)[number];

/** Which codes are retryable. Mirror this in the `retryable` option. */
export const RETRYABLE_ERROR_CODES: readonly NormalizedErrorCode[] = ['RATE_LIMIT', 'TIMEOUT', 'UPSTREAM_ERROR'];

// ---------------------------------------------------------------------------
// §1 — Pagination
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_MAX_ITEMS = 1000;

/**
 * Spread into the `input` object of every `list_*` tool (and `get_conversation`,
 * which is paginated over items).
 */
export const paginationInputShape = {
  cursor: z
    .string()
    .optional()
    .describe('Opaque cursor from a previous call’s next_cursor. Pass it back verbatim. Omit for the first page.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .optional()
    .describe(`Page size requested from the provider (default ${DEFAULT_PAGE_LIMIT}, max ${MAX_PAGE_LIMIT}).`),
  fetch_all: z
    .boolean()
    .optional()
    .describe('Follow cursors until the provider is exhausted or max_items is reached (default false).'),
  max_items: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Hard ceiling on items returned when fetch_all is true (default ${DEFAULT_MAX_ITEMS}). ` +
        'Never exceeded — the upstream request is bounded to the remaining budget.',
    ),
};

export const pageInfoSchema = z.object({
  returned: z.number().int().describe('Number of items in this response.'),
  pages_fetched: z.number().int().describe('Upstream requests made to build this response.'),
  truncated: z.boolean().describe('True when a ceiling (max_items) stopped the walk before the data ran out.'),
});

/** Wraps an item schema in the SPEC §1 envelope. */
export const paginatedOutput = <TItem extends z.ZodType>(item: TItem) =>
  z.object({
    items: z.array(item).describe('The page of results.'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Cursor for the next page, or null when there is definitively no more data. Never "".'),
    has_more: z.boolean().describe('True when more data exists upstream.'),
    total: z
      .number()
      .int()
      .nullable()
      .describe('True total across all pages, or null when the provider does not report a real total.'),
    page_info: pageInfoSchema,
  });

export type PageInfo = z.infer<typeof pageInfoSchema>;

/** Normalized, already-defaulted pagination request. */
export interface PaginationRequest {
  cursor: string | undefined;
  limit: number;
  fetchAll: boolean;
  maxItems: number;
}

/**
 * Applies SPEC §1 defaults and clamps. Use this instead of inlining `?? 50`.
 *
 * `maxItems` stays the caller's raw ceiling — the page walker is responsible for
 * bounding each upstream request to `min(limit, maxItems - collected)` so that
 * `limit:50, max_items:2` physically cannot over-collect.
 */
export const resolvePagination = (params: {
  cursor?: string;
  limit?: number;
  fetch_all?: boolean;
  max_items?: number;
}): PaginationRequest => ({
  cursor: params.cursor,
  limit: Math.min(Math.max(params.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT),
  fetchAll: params.fetch_all ?? false,
  maxItems: params.max_items ?? DEFAULT_MAX_ITEMS,
});

// ---------------------------------------------------------------------------
// §2 — Conversations
// ---------------------------------------------------------------------------

export const conversationListItemSchema = z.object({
  id: z.string().describe('Provider-native conversation id.'),
  title: z.string().describe('Conversation title. Empty string when the provider has not titled it yet.'),
  url: z.string().describe('Absolute URL of the conversation in the web app.'),
  created_at: z.number().int().describe('Unix seconds.'),
  updated_at: z.number().int().describe('Unix seconds.'),
  project_id: z.string().nullable().describe('Owning project/folder/space id, or null.'),
  model_id: z.string().nullable().describe('Model the conversation last used, or null when unknown.'),
  is_archived: z.boolean().describe('False when the provider has no archive concept.'),
  is_starred: z.boolean().describe('False when the provider has no star concept.'),
});

export type ConversationListItem = z.infer<typeof conversationListItemSchema>;

// ---------------------------------------------------------------------------
// §3 — Message format (OpenAI Responses item schema)
// ---------------------------------------------------------------------------

export const urlCitationSchema = z.object({
  type: z.literal('url_citation'),
  url: z.string(),
  title: z.string(),
  start_index: z
    .number()
    .int()
    .nullable()
    .describe('Index into the output_text where the citation starts, or null when the provider gives no position.'),
  end_index: z.number().int().nullable().describe('Index into the output_text where the citation ends, or null.'),
});

export const inputTextContentSchema = z.object({
  type: z.literal('input_text'),
  text: z.string(),
});

export const outputTextContentSchema = z.object({
  type: z.literal('output_text'),
  text: z.string(),
  annotations: z.array(urlCitationSchema).describe('Citations resolved against this text part. Empty when none.'),
});

export const messageContentSchema = z.discriminatedUnion('type', [inputTextContentSchema, outputTextContentSchema]);

export const itemStatusSchema = z.enum(['completed', 'in_progress', 'incomplete']);

export const messageItemSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  role: z.enum(['user', 'assistant', 'system']),
  status: itemStatusSchema,
  created_at: z.number().int().describe('Unix seconds.'),
  model: z.string().nullable().describe('Assistant messages only; null for user/system and when unknown.'),
  content: z
    .array(messageContentSchema)
    .describe(
      'ALL text parts of the turn, in order, concatenated per part. Non-text parts appear as a labelled ' +
        'placeholder such as "[image 800x600 <ref>]" — never as an empty string.',
    ),
});

/**
 * Provider-native effort/level id (e.g. "high", "xhigh", "max") when the
 * provider reports one, else null. Kept as a free string rather than an enum
 * because provider effort ladders differ in both length and naming; the
 * normalized *request* ladder is `thinkingLevelSchema` below.
 */
export const effortSchema = z.string().nullable();

export const reasoningItemSchema = z.object({
  id: z.string(),
  type: z.literal('reasoning'),
  summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() })),
  effort: effortSchema,
});

export const webSearchActionSchema = z.object({
  type: z.string().describe("Action kind — 'search' when the model issued a query; provider-specific otherwise."),
  query: z.string().nullable(),
  url: z.string().nullable().describe('Set for open_page/fetch style actions, else null.'),
});

export const webSearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string().nullable(),
  site_name: z.string().nullable(),
});

export const webSearchCallItemSchema = z.object({
  id: z.string(),
  type: z.literal('web_search_call'),
  status: itemStatusSchema,
  action: webSearchActionSchema,
  results: z.array(webSearchResultSchema),
});

export const toolCallItemSchema = z.object({
  id: z.string(),
  type: z.literal('tool_call'),
  name: z.string().describe('Provider-native tool name, e.g. "code_interpreter".'),
  status: itemStatusSchema,
  arguments: z.record(z.string(), z.unknown()).describe('Tool input as the provider recorded it.'),
  output: z
    .string()
    .nullable()
    .describe('Tool output rendered as text, or null when the call has no recorded result yet.'),
});

export const responseItemSchema = z.discriminatedUnion('type', [
  messageItemSchema,
  reasoningItemSchema,
  webSearchCallItemSchema,
  toolCallItemSchema,
]);

export type ResponseItem = z.infer<typeof responseItemSchema>;

/**
 * Everything that was produced upstream but is not in `items`. Nothing may
 * disappear silently: if you filtered it, count it here.
 */
export const omittedSchema = z.object({
  reasoning: z.number().int().describe('Reasoning items dropped because include_reasoning was false.'),
  tool_calls: z
    .number()
    .int()
    .describe('tool_call/web_search_call items dropped because include_tool_calls was false.'),
  hidden: z.number().int().describe('Parts the provider itself marks as hidden/redacted.'),
  empty: z.number().int().describe('Parts that carried no renderable content at all.'),
});

/** Spread into the `input` of get_conversation / create_conversation / send_message. */
export const itemVisibilityInputShape = {
  include_reasoning: z
    .boolean()
    .optional()
    .describe('Include reasoning items in items[] (default false). Excluded ones are counted in omitted.reasoning.'),
  include_tool_calls: z
    .boolean()
    .optional()
    .describe(
      'Include tool_call/web_search_call items (default false). Excluded ones are counted in omitted.tool_calls.',
    ),
};

/** The paginated §1 envelope plus the §3 `omitted` ledger. */
export const itemPageOutput = paginatedOutput(responseItemSchema).extend({
  omitted: omittedSchema,
});

// ---------------------------------------------------------------------------
// §4 — Models
// ---------------------------------------------------------------------------

/**
 * The normalized effort ladder callers request. Providers map it onto their own
 * ladder and MUST document the mapping in the tool description when the two do
 * not line up one-to-one.
 */
export const thinkingLevelSchema = z.enum(['minimal', 'low', 'medium', 'high', 'max']);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const modelCapabilitiesSchema = z.object({
  thinking: z.object({
    supported: z.boolean(),
    levels: z
      .array(z.string())
      .nullable()
      .describe('Provider-native level ids, coarsest first, or null when thinking is an on/off toggle.'),
    per_message: z.boolean().describe('False when the setting is account-wide rather than per request.'),
  }),
  web_search: z.object({ supported: z.boolean(), per_message: z.boolean() }),
  deep_research: z.object({ supported: z.boolean() }),
  vision: z.object({ supported: z.boolean() }),
  code_interpreter: z.object({ supported: z.boolean() }),
});

export const modelSchema = z.object({
  id: z.string().describe('Exact id to pass as model_id.'),
  display_name: z.string(),
  description: z.string().describe('Empty string when the provider ships none.'),
  is_default: z.boolean().describe('True for the model the provider would use when model_id is omitted.'),
  is_available: z.boolean().describe('False for models the picker lists but the account cannot select.'),
  requires_subscription: z.string().nullable().describe('Provider tier id (e.g. "TIER_PRO"), or null when free.'),
  context_window: z.number().int().nullable(),
  capabilities: modelCapabilitiesSchema,
});

export type NormalizedModel = z.infer<typeof modelSchema>;

/**
 * Spread into create_conversation / send_message inputs. `model_id` MUST be
 * validated against the live model list before any upstream request is sent,
 * raising VALIDATION_ERROR that lists the valid ids.
 */
export const messageOptionsInputShape = {
  model_id: z
    .string()
    .optional()
    .describe('Model id from list_models. Validated against the live list before any request is sent.'),
  thinking: z.boolean().optional().describe('Enable the provider’s extended-thinking / reasoning mode.'),
  thinking_level: thinkingLevelSchema
    .optional()
    .describe('Reasoning effort. Mapped onto the provider’s native ladder — see the tool description.'),
  search: z.boolean().optional().describe('Enable web search for this message.'),
  tools: z
    .array(z.string())
    .optional()
    .describe('Provider tool names to enable for this message. Unsupported providers reject a non-empty value.'),
};

// ---------------------------------------------------------------------------
// §5 — Projects / folders / spaces / gems
// ---------------------------------------------------------------------------

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.number().int().describe('Unix seconds.'),
  updated_at: z.number().int().describe('Unix seconds.'),
  conversation_count: z.number().int().nullable().describe('Null when the provider does not report it.'),
  url: z.string(),
});

export type NormalizedProject = z.infer<typeof projectSchema>;

// ---------------------------------------------------------------------------
// §6 — Capabilities & toggles
// ---------------------------------------------------------------------------

export const toggleSchema = z.object({
  id: z.string().describe('Stable toggle id, e.g. "thinking" or "web_search".'),
  display_name: z.string(),
  type: z.enum(['boolean', 'enum']),
  values: z.array(z.string()).nullable().describe('Allowed values for type=enum, else null.'),
  default: z.union([z.boolean(), z.string()]).describe('Boolean for type=boolean, string for type=enum.'),
  scope: z.enum(['per_message', 'account']),
  controllable: z.boolean().describe('False when the provider exposes the toggle but ignores what you set.'),
  applies_to_models: z.array(z.string()).nullable().describe('Model ids the toggle applies to, or null for all.'),
  note: z.string().nullable(),
});

export const featureSupportSchema = z.object({
  supported: z.boolean(),
  reason: z.string().nullable().describe('Why it is unsupported. Null when supported is true.'),
});

/**
 * Every provider reports EXACTLY these keys in `features`, so a consumer can
 * branch on a fixed set instead of probing. Add a key here (and in SPEC.md §6)
 * rather than inventing a provider-local one.
 */
export const NORMALIZED_FEATURE_KEYS = [
  'list_conversations',
  'get_conversation',
  'create_conversation',
  'send_message',
  'search_conversations',
  'rename_conversation',
  'delete_conversation',
  'archive_conversation',
  'projects',
  'project_membership',
  'models',
  'thinking',
  'web_search',
  'deep_research',
  'vision',
  'code_interpreter',
] as const;

export type NormalizedFeatureKey = (typeof NORMALIZED_FEATURE_KEYS)[number];

export const capabilitiesSchema = z.object({
  provider: z.string(),
  models: z.array(modelSchema),
  toggles: z.array(toggleSchema),
  features: z
    .record(z.string(), featureSupportSchema)
    .describe('Keyed by NORMALIZED_FEATURE_KEYS — every key present on every provider.'),
});

// ---------------------------------------------------------------------------
// §7 — Deep research
// ---------------------------------------------------------------------------

export const researchStatusSchema = z.enum(['queued', 'clarifying', 'running', 'completed', 'failed', 'cancelled']);

export type ResearchStatus = z.infer<typeof researchStatusSchema>;

export const researchProgressSchema = z.object({
  steps_completed: z.number().int(),
  current_step: z.string().nullable(),
  sources_found: z.number().int(),
});

export const researchSourceSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string().nullable(),
});

export const DEFAULT_CLARIFICATION_ANSWER = 'Include everything.';

export const startDeepResearchInputShape = {
  text: z.string().describe('The research question.'),
  auto_answer_clarifications: z
    .boolean()
    .optional()
    .describe(
      `When the model asks a follow-up, answer it automatically with clarification_answer and continue ` +
        '(default true). get_deep_research still reports auto_answered:true and echoes the question.',
    ),
  clarification_answer: z
    .string()
    .optional()
    .describe(`Reply used when auto_answer_clarifications is true (default "${DEFAULT_CLARIFICATION_ANSWER}").`),
};

export const deepResearchSchema = z.object({
  research_id: z.string(),
  conversation_id: z.string(),
  status: researchStatusSchema,
  clarifying_question: z
    .string()
    .nullable()
    .describe('The follow-up the model asked, whether or not it was auto-answered. Null when it asked none.'),
  auto_answered: z.boolean(),
  progress: researchProgressSchema,
  items: z.array(responseItemSchema).describe('SPEC §3 items for the research turn. Empty until there is output.'),
  sources: z.array(researchSourceSchema),
  error: z.string().nullable(),
});

export const startDeepResearchOutputSchema = z.object({
  research_id: z.string(),
  conversation_id: z.string(),
  status: researchStatusSchema,
});
