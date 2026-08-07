import { ToolError, fetchFromPage, fetchJSON } from '@opentabs-dev/plugin-sdk';

// --- Constants ---

const API_ORIGIN = 'https://www.perplexity.ai';
const REST_BASE = `${API_ORIGIN}/rest`;

/**
 * The Perplexity SPA stamps every REST call with its build version and an
 * entry-point tag. Older/absent values are served by the same gateway but the
 * schematized answer blocks (`use_schematized_api`) are only guaranteed for the
 * version the site itself is sending, so keep this in sync with the network tab.
 */
const CLIENT_VERSION = '2.18';
const CLIENT_SOURCE = 'default';
const VERSION_QUERY = `version=${CLIENT_VERSION}&source=${CLIENT_SOURCE}`;

const SESSION_URL = `${API_ORIGIN}/api/auth/session?${VERSION_QUERY}`;
const MODELS_URL = `${REST_BASE}/models/config/v2?${VERSION_QUERY}`;
const LIST_RECENT_URL = `${REST_BASE}/thread/list_recent?exclude_asi=false&${VERSION_QUERY}`;
const GRAPHQL_URL = `${REST_BASE}/perplexity_ask/graphql`;
const ASK_URL = `${REST_BASE}/sse/perplexity_ask`;

/**
 * Relay persisted-query hashes used by the Library page. The gateway rejects
 * ad-hoc GraphQL documents ("Access denied"), so the hashes are the only way in.
 * They travel with the frontend build; when Perplexity ships a new one these go
 * stale and the code falls back to the REST sidebar endpoint.
 */
const LIBRARY_ROOT_QUERY_HASH = '1c1f9e86416eddf3dfed6ede99575a5cc241b59cf079f2e9295ed927f2908006';
const LIBRARY_PAGE_QUERY_HASH = 'e207cce86b2c9b67fca3ea7d8450d675ec86c0c429b38e42e88f3b027e7c8729';

const ASK_TIMEOUT_MS = 600_000;
const GRAPHQL_PAGE_SIZE = 50;

/** Answer-mode block use cases the Perplexity web client advertises. */
const SUPPORTED_BLOCK_USE_CASES = [
  'answer_modes',
  'media_items',
  'knowledge_cards',
  'inline_entity_cards',
  'inline_images',
  'inline_assets',
  'preserve_latex',
  'answer_tabs',
];

/** `sources` values the site's own source picker sends. */
export const SOURCE_VALUES = ['web', 'scholar', 'social'] as const;

/**
 * `focus` is the plugin-facing name for the site's source picker plus its
 * no-search "writing" mode, which the gateway still spells `search_focus`.
 */
export const FOCUS_VALUES = ['internet', 'scholar', 'social', 'writing'] as const;
export type Focus = (typeof FOCUS_VALUES)[number];

// --- Types ---

export interface PerplexityUser {
  id: string;
  email: string;
  username: string;
  subscriptionStatus: string;
  subscriptionTier: string;
  orgRole: string;
}

export interface PerplexityModel {
  id: string;
  displayName: string;
  description: string;
  mode: string;
  provider: string;
  subscriptionTier: string;
  inModelPicker: boolean;
  isDefault: boolean;
}

export interface PerplexityConversation {
  id: string;
  title: string;
  url: string;
  updatedAt: string;
  status: string;
  mode: string;
  spaceName: string;
}

export interface PerplexitySource {
  title: string;
  url: string;
  snippet: string;
}

export interface PerplexityTurn {
  prompt: string;
  response: string;
  model: string;
  sources: PerplexitySource[];
}

export interface PerplexityAskResult {
  conversationId: string;
  entryId: string;
  contextUuid: string;
  readWriteToken: string;
  title: string;
  model: string;
  text: string;
  sources: PerplexitySource[];
  relatedQuestions: string[];
}

// --- Auth ---

interface SessionResponse {
  user?: {
    id?: string;
    email?: string;
    username?: string;
    org_role?: string;
    subscription_status?: string;
  };
}

/**
 * Perplexity keeps its session in an HttpOnly cookie, so there is nothing in
 * localStorage or `document.cookie` to inspect — the only honest readiness
 * check is asking the session endpoint who we are. Logged out it answers
 * `200 {}`, so the presence of `user.id` is the real signal.
 */
export const fetchSessionUserId = async (): Promise<string | null> => {
  try {
    const data = await fetchJSON<SessionResponse>(SESSION_URL, { timeout: 15_000 });
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
};

export const isAuthenticated = async (): Promise<boolean> => (await fetchSessionUserId()) !== null;

const requireSession = async (): Promise<NonNullable<SessionResponse['user']>> => {
  const data = await fetchJSON<SessionResponse>(SESSION_URL, { timeout: 15_000 });
  if (!data?.user?.id) {
    throw ToolError.auth('Not signed in to Perplexity — please log in at https://www.perplexity.ai.');
  }
  return data.user;
};

// --- Account ---

interface UserSettingsResponse {
  subscription_status?: string;
  subscription_tier?: string | null;
  default_model?: string;
}

export const getUserSettings = async (): Promise<UserSettingsResponse> =>
  (await fetchJSON<UserSettingsResponse>(
    `${REST_BASE}/user/settings?skip_connector_picker_credentials=true&${VERSION_QUERY}`,
    { timeout: 20_000 },
  )) ?? {};

export const getCurrentUser = async (): Promise<PerplexityUser> => {
  const [user, settings] = await Promise.all([requireSession(), getUserSettings()]);
  return {
    id: user.id ?? '',
    email: user.email ?? '',
    username: user.username ?? '',
    subscriptionStatus: settings.subscription_status ?? user.subscription_status ?? 'none',
    subscriptionTier: settings.subscription_tier ?? '',
    orgRole: user.org_role ?? '',
  };
};

// --- Models ---

interface ModelEntry {
  label?: string;
  description?: string;
  mode?: string;
  provider?: string | null;
}

interface SearchConfigEntry {
  label?: string;
  subscription_tier?: string;
  non_reasoning_model?: string | null;
  reasoning_model?: string | null;
}

interface ModelsConfigResponse {
  models?: Record<string, ModelEntry>;
  search_config?: SearchConfigEntry[];
  default_models?: Record<string, string>;
}

/**
 * `models` is the full catalogue the gateway will accept as `model_preference`
 * (~114 ids across search/research/study/asi modes). `search_config` is the
 * much shorter list the on-page model picker renders, and it is the only place
 * the Pro/Max gating tier is stated — so both are merged rather than filtering
 * down to the picker, which would hide ids that genuinely work.
 */
export const getModels = async (): Promise<PerplexityModel[]> => {
  const [config, settings] = await Promise.all([
    fetchJSON<ModelsConfigResponse>(MODELS_URL, { timeout: 20_000 }),
    getUserSettings(),
  ]);

  const models = config?.models ?? {};
  const defaultModelId = settings.default_model ?? config?.default_models?.search ?? '';

  const pickerTierById = new Map<string, string>();
  for (const entry of config?.search_config ?? []) {
    for (const id of [entry.non_reasoning_model, entry.reasoning_model]) {
      if (id) pickerTierById.set(id, entry.subscription_tier ?? '');
    }
  }

  return Object.entries(models).map(([id, model]) => ({
    id,
    displayName: model.label ?? '',
    description: model.description ?? '',
    mode: model.mode ?? '',
    provider: model.provider ?? '',
    subscriptionTier: pickerTierById.get(id) ?? '',
    inModelPicker: pickerTierById.has(id),
    isDefault: id === defaultModelId,
  }));
};

export const assertKnownModel = async (modelId: string): Promise<void> => {
  const models = await getModels();
  if (models.some(model => model.id === modelId)) return;
  const pickerIds = models
    .filter(model => model.inModelPicker)
    .map(model => model.id)
    .join(', ');
  throw ToolError.validation(
    `Unknown Perplexity model "${modelId}". Call list_models for valid ids (model-picker ids: ${pickerIds}).`,
  );
};

// --- Conversations (threads) ---

export const conversationUrl = (conversationId: string): string => `${API_ORIGIN}/search/${conversationId}`;

interface RecentThread {
  uuid?: string;
  title?: string;
  link?: string;
  updated_at?: string;
  status?: string;
  context_uuid?: string;
}

interface GraphqlThreadNode {
  slug?: string;
  entryId?: string;
  contextUUID?: string;
  name?: string;
  status?: string;
  mode?: string;
  updatedAt?: string;
  isArchived?: boolean;
  space?: { title?: string; name?: string } | null;
}

interface GraphqlThreadsPage {
  edges?: { node?: GraphqlThreadNode }[];
  pageInfo?: { endCursor?: string; hasNextPage?: boolean };
}

interface GraphqlResponse {
  data?: { viewer?: { recentGroup?: { threads?: GraphqlThreadsPage } } };
  errors?: { message?: string }[];
}

const GRAPHQL_BASE_VARIABLES = {
  includeSearchPreview: false,
  searchTerm: null,
  sortOrder: 'NEWEST',
  statuses: null,
  threadTypes: null,
  sources: null,
  includeTemporary: null,
};

const callLibraryGraphql = async (
  operationName: string,
  hash: string,
  variables: Record<string, unknown>,
): Promise<GraphqlThreadsPage> => {
  const response = await fetchFromPage(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationName,
      variables: { ...GRAPHQL_BASE_VARIABLES, ...variables },
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    }),
    timeout: 30_000,
  });

  const payload = (await response.json()) as GraphqlResponse;
  // The GraphQL gateway answers 200 even for FORBIDDEN / PersistedQueryNotFound.
  if (payload.errors?.length) {
    throw ToolError.internal(`Perplexity library GraphQL rejected ${operationName}: ${payload.errors[0]?.message}`);
  }
  const threads = payload.data?.viewer?.recentGroup?.threads;
  if (!threads) throw ToolError.internal(`Perplexity library GraphQL returned no threads for ${operationName}.`);
  return threads;
};

const mapGraphqlNode = (node: GraphqlThreadNode): PerplexityConversation => {
  const id = node.slug ?? node.entryId ?? '';
  return {
    id,
    title: node.name ?? '',
    url: conversationUrl(id),
    updatedAt: node.updatedAt ?? '',
    status: (node.status ?? '').toLowerCase(),
    mode: (node.mode ?? '').toLowerCase(),
    spaceName: node.space?.title ?? node.space?.name ?? '',
  };
};

/**
 * The sidebar REST endpoint (`list_recent`) hard-caps at 20 rows and ignores
 * limit/offset, so it can only ever show the top of the Library. The Library
 * page itself pages through Relay, which is what this uses; the REST list is
 * kept as a fallback for when a persisted-query hash goes stale.
 */
const listConversationsViaGraphql = async (limit: number): Promise<PerplexityConversation[]> => {
  const conversations: PerplexityConversation[] = [];

  let page = await callLibraryGraphql('LibraryThreadsRelayQuery', LIBRARY_ROOT_QUERY_HASH, {});
  const collect = (current: GraphqlThreadsPage): void => {
    for (const edge of current.edges ?? []) {
      if (edge.node) conversations.push(mapGraphqlNode(edge.node));
    }
  };
  collect(page);

  while (conversations.length < limit && page.pageInfo?.hasNextPage && page.pageInfo.endCursor) {
    page = await callLibraryGraphql('LibraryRecentThreadsPaginationQuery', LIBRARY_PAGE_QUERY_HASH, {
      count: GRAPHQL_PAGE_SIZE,
      cursor: page.pageInfo.endCursor,
    });
    collect(page);
  }

  return conversations.slice(0, limit);
};

const listConversationsViaRest = async (limit: number): Promise<PerplexityConversation[]> => {
  const threads = (await fetchJSON<RecentThread[]>(LIST_RECENT_URL, { timeout: 20_000 })) ?? [];
  return threads.slice(0, limit).map(thread => ({
    id: thread.uuid ?? '',
    title: thread.title ?? '',
    url: thread.uuid ? conversationUrl(thread.uuid) : `${API_ORIGIN}${thread.link ?? ''}`,
    updatedAt: thread.updated_at ?? '',
    status: thread.status ?? '',
    mode: '',
    spaceName: '',
  }));
};

export const listConversations = async (limit: number): Promise<PerplexityConversation[]> => {
  try {
    return await listConversationsViaGraphql(limit);
  } catch {
    return listConversationsViaRest(limit);
  }
};

// --- Conversation detail ---

interface WebResult {
  name?: string;
  url?: string;
  snippet?: string;
}

interface AnswerBlock {
  intended_usage?: string;
  markdown_block?: { answer?: string };
  web_result_block?: { web_results?: WebResult[] };
}

interface ThreadEntry {
  backend_uuid?: string;
  context_uuid?: string;
  read_write_token?: string;
  thread_url_slug?: string;
  query_str?: string;
  display_model?: string;
  thread_title?: string;
  blocks?: AnswerBlock[];
  related_query_items?: { text?: string }[];
  status?: string;
}

interface ThreadResponse {
  entries?: ThreadEntry[];
  thread_metadata?: { title?: string; mode?: string; thread_status?: string };
}

const mapSources = (results: WebResult[]): PerplexitySource[] =>
  results.map(result => ({
    title: result.name ?? '',
    url: result.url ?? '',
    snippet: result.snippet ?? '',
  }));

/**
 * An entry may carry the same answer twice: `ask_text_0_markdown` is the
 * schematized structured block and `ask_text` is the rendered one. `ask_text`
 * is what the page shows, so prefer it and fall back to the last markdown block.
 */
export const extractAnswerText = (blocks: AnswerBlock[]): string => {
  const markdownBlocks = blocks.filter(block => block.markdown_block);
  const preferred =
    markdownBlocks.find(block => block.intended_usage === 'ask_text') ?? markdownBlocks[markdownBlocks.length - 1];
  return preferred?.markdown_block?.answer ?? '';
};

/** Citations: the numbered `[n]` markers in the answer index into this list. */
export const extractSources = (blocks: AnswerBlock[]): PerplexitySource[] => {
  const webBlock = blocks.find(block => block.web_result_block);
  return mapSources(webBlock?.web_result_block?.web_results ?? []);
};

export interface ConversationDetail {
  conversationId: string;
  title: string;
  turns: PerplexityTurn[];
  lastEntryId: string;
  readWriteToken: string;
  contextUuid: string;
}

const threadUrl = (conversationId: string, limit: number): string =>
  `${REST_BASE}/thread/${encodeURIComponent(conversationId)}` +
  `?with_parent_info=true&with_schematized_response=true&${VERSION_QUERY}&limit=${limit}&offset=0`;

/**
 * Reads a thread. Any entry's backend uuid resolves the whole thread, but the
 * canonical id (what the URL and the Library show) is `thread_url_slug`, which
 * every entry carries. `limit` keeps the newest N entries and still returns
 * them oldest-first, so the last element is always the tip of the thread —
 * the response's own `latest_entry` field is served as `null` and is not used.
 */
export const getConversation = async (conversationId: string, limit: number): Promise<ConversationDetail> => {
  const data = await fetchJSON<ThreadResponse>(threadUrl(conversationId, limit), { timeout: 45_000 });
  const entries = data?.entries ?? [];
  if (entries.length === 0) {
    throw ToolError.notFound(`Perplexity thread "${conversationId}" has no entries or does not exist.`);
  }

  const first = entries[0];
  const last = entries[entries.length - 1];

  return {
    conversationId: first?.thread_url_slug ?? first?.backend_uuid ?? conversationId,
    title: data?.thread_metadata?.title ?? first?.thread_title ?? '',
    turns: entries.map(entry => ({
      prompt: entry.query_str ?? '',
      response: extractAnswerText(entry.blocks ?? []),
      model: entry.display_model ?? '',
      sources: extractSources(entry.blocks ?? []),
    })),
    lastEntryId: last?.backend_uuid ?? '',
    readWriteToken: last?.read_write_token ?? first?.read_write_token ?? '',
    contextUuid: first?.context_uuid ?? '',
  };
};

/** Reads the thread slug out of a /search/<slug> URL, or null when none is open. */
export const getCurrentConversationId = (): string | null => {
  const match = window.location.pathname.match(/^\/search\/([^/?#]+)/);
  return match?.[1] ?? null;
};

// --- Ask (SSE) ---

interface SseMessage {
  backend_uuid?: string;
  context_uuid?: string;
  read_write_token?: string;
  thread_url_slug?: string;
  thread_title?: string;
  query_str?: string;
  display_model?: string;
  status?: string;
  error_code?: string;
  text?: string;
  final?: boolean;
  final_sse_message?: boolean;
  blocks?: AnswerBlock[];
  related_query_items?: { text?: string }[];
}

/** Splits an `event:`/`data:` SSE body into its decoded JSON payloads. */
const parseSseMessages = (body: string): SseMessage[] =>
  body
    .split(/\r?\n\r?\n/)
    .map(chunk =>
      chunk
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n'),
    )
    .filter(payload => payload.length > 0)
    .flatMap(payload => {
      try {
        return [JSON.parse(payload) as SseMessage];
      } catch {
        return [];
      }
    });

export interface AskOptions {
  text: string;
  modelId?: string;
  focus?: Focus;
  sources?: string[];
  incognito?: boolean;
  /** Backend uuid of the newest entry in the thread being continued. */
  lastEntryId?: string;
  /** Per-thread write token; required alongside lastEntryId for follow-ups. */
  readWriteToken?: string;
}

const randomUuid = (): string => crypto.randomUUID();

const resolveSources = (options: AskOptions): { searchFocus: string; sources: string[] } => {
  if (options.sources && options.sources.length > 0) {
    return { searchFocus: options.focus === 'writing' ? 'writing' : 'internet', sources: options.sources };
  }
  switch (options.focus) {
    case 'writing':
      return { searchFocus: 'writing', sources: [] };
    case 'scholar':
      return { searchFocus: 'internet', sources: ['scholar'] };
    case 'social':
      return { searchFocus: 'internet', sources: ['social'] };
    default:
      return { searchFocus: 'internet', sources: ['web'] };
  }
};

const buildAskBody = (options: AskOptions): Record<string, unknown> => {
  const { searchFocus, sources } = resolveSources(options);
  const isFollowUp = Boolean(options.lastEntryId && options.readWriteToken);

  const params: Record<string, unknown> = {
    attachments: [],
    language: 'en-US',
    timezone: 'UTC',
    search_focus: searchFocus,
    sources,
    frontend_uuid: randomUuid(),
    mode: 'copilot',
    model_preference: options.modelId ?? 'turbo',
    is_related_query: false,
    is_sponsored: false,
    prompt_source: 'user',
    query_source: isFollowUp ? 'followup' : 'home',
    is_incognito: options.incognito ?? false,
    local_search_enabled: false,
    use_schematized_api: true,
    send_back_text_in_streaming_api: false,
    supported_block_use_cases: SUPPORTED_BLOCK_USE_CASES,
    client_coordinates: null,
    mentions: [],
    skip_search_enabled: true,
    is_nav_suggestions_disabled: false,
    source: CLIENT_SOURCE,
    always_search_override: false,
    override_no_search: false,
    version: CLIENT_VERSION,
  };

  if (isFollowUp) {
    params.last_backend_uuid = options.lastEntryId;
    params.read_write_token = options.readWriteToken;
    params.followup_source = 'link';
  } else {
    params.frontend_context_uuid = randomUuid();
  }

  try {
    params.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Timezone is advisory — the gateway accepts the UTC default.
  }

  return { params, query_str: options.text };
};

/**
 * Perplexity spells its stream-level failures as `error_code` strings. The rate
 * limit ones are plan-specific (`FREE_TIER_RATE_LIMITED`, `PRO_TIER_...`), so
 * match on the family rather than enumerating every variant.
 */
const errorCodeToToolError = (code: string, message: string): ToolError => {
  if (code === 'INVALID_MODEL_SELECTION') {
    return ToolError.validation(`Perplexity rejected the model selection: ${message}`);
  }
  if (code.includes('RATE_LIMIT') || code === 'TOO_MANY_REQUESTS' || code.includes('QUOTA')) {
    return ToolError.rateLimited(
      `Perplexity rate limited this account (${code}). Free accounts get a limited number of searches per rolling window — wait and retry, or upgrade the plan.`,
    );
  }
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'NOT_AUTHENTICATED') {
    return ToolError.auth(`Perplexity rejected the session (${code}) — reload https://www.perplexity.ai and log in.`);
  }
  return ToolError.internal(`Perplexity ask failed (${code}): ${message}`);
};

/**
 * Sends a query to the answer engine and folds the SSE stream into a result.
 *
 * The endpoint always replies HTTP 200: an invalid model, a rate limit or an
 * expired session all arrive as a normal `event: message` frame carrying
 * `status: "failed"` and an `error_code`, so the status code is never the
 * success signal — the final frame is.
 */
export const ask = async (options: AskOptions): Promise<PerplexityAskResult> => {
  const response = await fetchFromPage(ASK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(buildAskBody(options)),
    timeout: ASK_TIMEOUT_MS,
  });

  const messages = parseSseMessages(await response.text());
  if (messages.length === 0) {
    throw ToolError.internal('Perplexity returned an empty answer stream.');
  }

  const failed = messages.find(message => message.error_code || message.status === 'failed');
  if (failed) {
    throw errorCodeToToolError(failed.error_code ?? 'UNKNOWN', failed.text ?? failed.status ?? 'unknown error');
  }

  const final =
    messages.filter(message => message.final_sse_message || message.final).pop() ?? messages[messages.length - 1];
  if (!final) throw ToolError.internal('Perplexity answer stream had no final message.');

  const blocks = final.blocks ?? [];
  const text = extractAnswerText(blocks);
  if (!text && !final.backend_uuid) {
    throw ToolError.internal('Perplexity answer stream ended without an answer — it may have been interrupted.');
  }

  return {
    conversationId: final.thread_url_slug ?? final.backend_uuid ?? '',
    entryId: final.backend_uuid ?? '',
    contextUuid: final.context_uuid ?? '',
    readWriteToken: final.read_write_token ?? '',
    title: final.thread_title ?? final.query_str ?? '',
    model: final.display_model ?? '',
    text,
    sources: extractSources(blocks),
    relatedQuestions: (final.related_query_items ?? [])
      .map(item => item.text ?? '')
      .filter(question => question.length > 0),
  };
};
