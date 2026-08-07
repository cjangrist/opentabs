import { ToolError, fetchFromPage, getLocalStorage, waitUntil } from '@opentabs-dev/plugin-sdk';
import { type PowChallenge, encodePowHeader, solvePowChallenge } from './pow.js';

// --- Constants ---

const API_ORIGIN = 'https://chat.deepseek.com';
const API_BASE = `${API_ORIGIN}/api/v0`;
const COMPLETION_PATH = '/api/v0/chat/completion';

/** localStorage key holding the bearer token the DeepSeek SPA signs requests with. */
const USER_TOKEN_KEY = 'userToken';
const DEVICE_ID_KEY = '__ds_remote_feature_did';
/** Cache the SPA keeps of GET /client/settings?scope=model, used as a fallback. */
const MODEL_CACHE_KEY = '__ds_remote_feature_store_model';

const CLIENT_VERSION = '2.3.0';
const REQUEST_TIMEOUT_MS = 30_000;
const COMPLETION_TIMEOUT_MS = 300_000;

const DEFAULT_MODEL_TYPE = 'default';

// DeepSeek business error codes (mirrors the enum in the site bundle).
const BIZ_MISSING_TOKEN = 40002;
const BIZ_INVALID_TOKEN = 40003;
const BIZ_USER_IS_BANNED = 40012;
const BIZ_IP_ACCESS_RESTRICTED = 40029;
const BIZ_POW_HEADER_ERROR = 40300;
const BIZ_INVALID_POW_RESPONSE = 40301;
const BIZ_MUTED = 50006;

// --- Types ---

export interface DeepSeekUser {
  id: string;
  email: string;
  name: string;
  provider: string;
  mobileNumber: string;
  avatar: string;
}

export interface DeepSeekModel {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportsThinking: boolean;
  supportsSearch: boolean;
}

export interface DeepSeekConversation {
  id: string;
  title: string;
  url: string;
  modelId: string;
  pinned: boolean;
  updatedAt: number;
}

/**
 * A web page DeepSeek cited. `citeIndex` is the number that appears inline in the
 * answer text as `[citation:N]`, so callers can resolve those markers to sources.
 */
export interface DeepSeekSearchResult {
  title: string;
  url: string;
  snippet: string;
  siteName: string;
  citeIndex: number;
}

export interface DeepSeekTurn {
  prompt: string;
  response: string;
  thinking: string;
  searchQueries: string[];
  searchResults: DeepSeekSearchResult[];
}

export interface DeepSeekChatResult {
  conversationId: string;
  messageId: number;
  parentMessageId: number;
  text: string;
  thinking: string;
  searchQueries: string[];
  searchResults: DeepSeekSearchResult[];
  title: string;
}

// --- Auth ---

/**
 * The SPA wraps its localStorage values as `{"value": ..., "__version": "0"}`.
 * Reads the inner value, tolerating a bare string for robustness.
 */
const readWrappedValue = (key: string): string | null => {
  const raw = getLocalStorage(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { value?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.value === 'string') return parsed.value;
  } catch {
    // Not JSON — fall through and treat the raw string as the value.
  }
  return raw.length > 0 ? raw : null;
};

const readUserToken = (): string | null => {
  const token = readWrappedValue(USER_TOKEN_KEY);
  return token && token.length > 0 ? token : null;
};

/** True when the page holds a DeepSeek bearer token — i.e. the user is logged in. */
export const isAuthenticated = (): boolean => readUserToken() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

const requireUserToken = (): string => {
  const token = readUserToken();
  if (!token) {
    throw ToolError.auth('Not authenticated — please log in to DeepSeek at https://chat.deepseek.com.');
  }
  return token;
};

const readDeviceId = (): string => getLocalStorage(DEVICE_ID_KEY) ?? '';

/** Reproduces the header set the DeepSeek web app stamps on every API request. */
const buildHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${requireUserToken()}`,
    accept: '*/*',
    'x-client-platform': 'web',
    'x-client-version': CLIENT_VERSION,
    'x-client-locale': 'en_US',
    'x-client-bundle-id': 'com.deepseek.chat',
    ...extra,
  };

  try {
    headers['x-client-timezone-offset'] = String(-new Date().getTimezoneOffset() * 60);
  } catch {
    // Timezone is advisory — omit it when the environment does not expose it.
  }

  return headers;
};

// --- Envelope handling ---

interface ApiEnvelope<T> {
  code?: number;
  msg?: string;
  data?: { biz_code?: number; biz_msg?: string; biz_data?: T };
}

const bizErrorToToolError = (code: number, message: string): ToolError => {
  const detail = message || `code ${code}`;
  switch (code) {
    case BIZ_MISSING_TOKEN:
    case BIZ_INVALID_TOKEN:
      return ToolError.auth(
        `DeepSeek rejected the session (${detail}) — please reload https://chat.deepseek.com and log in.`,
      );
    case BIZ_USER_IS_BANNED:
    case BIZ_IP_ACCESS_RESTRICTED:
      return ToolError.auth(`DeepSeek denied access: ${detail}`);
    case BIZ_MUTED:
      return ToolError.rateLimited(`DeepSeek has temporarily muted this account: ${detail}`);
    case BIZ_POW_HEADER_ERROR:
    case BIZ_INVALID_POW_RESPONSE:
      return ToolError.internal(`DeepSeek rejected the proof-of-work header: ${detail}`);
    default:
      return ToolError.internal(`DeepSeek API error: ${detail}`);
  }
};

/** Unwraps DeepSeek's `{code, data: {biz_code, biz_data}}` envelope. */
const unwrap = <T>(envelope: ApiEnvelope<T>): T => {
  if (envelope.code !== undefined && envelope.code !== 0) {
    throw bizErrorToToolError(envelope.code, envelope.msg ?? '');
  }
  const data = envelope.data;
  if (!data) throw ToolError.internal('DeepSeek returned an empty response envelope.');
  if (data.biz_code !== undefined && data.biz_code !== 0) {
    throw bizErrorToToolError(data.biz_code, data.biz_msg ?? '');
  }
  if (data.biz_data === undefined || data.biz_data === null) {
    throw ToolError.internal('DeepSeek returned no data for this request.');
  }
  return data.biz_data;
};

const callApi = async <T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> => {
  const response = await fetchFromPage(`${API_BASE}${path}`, {
    ...init,
    headers: buildHeaders((init?.headers as Record<string, string>) ?? {}),
    credentials: 'include',
    timeout: init?.timeout ?? REQUEST_TIMEOUT_MS,
  });
  return unwrap<T>((await response.json()) as ApiEnvelope<T>);
};

const getApi = <T>(path: string): Promise<T> => callApi<T>(path, { method: 'GET' });

const postApi = <T>(path: string, body: unknown, timeout?: number): Promise<T> =>
  callApi<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeout,
  });

// --- Account ---

interface CurrentUserResponse {
  id?: string;
  email?: string;
  mobile_number?: string;
  id_profile?: { provider?: string; name?: string; picture?: string; email?: string };
}

export const getCurrentUser = async (): Promise<DeepSeekUser> => {
  const user = await getApi<CurrentUserResponse>('/users/current');
  if (!user.id) throw ToolError.auth('DeepSeek did not return a user — please log in at https://chat.deepseek.com.');

  return {
    id: user.id,
    email: user.email ?? user.id_profile?.email ?? '',
    name: user.id_profile?.name ?? '',
    provider: user.id_profile?.provider ?? '',
    mobileNumber: user.mobile_number ?? '',
    avatar: user.id_profile?.picture ?? '',
  };
};

// --- Models ---

interface RawModelConfig {
  model_type?: string;
  name?: string;
  description?: string;
  is_default?: boolean;
  enabled?: boolean;
  /** `{}` when the model supports the toggle, `null` when it does not. */
  think_feature?: unknown;
  search_feature?: unknown;
}

interface ModelSettingsResponse {
  settings?: { model_configs?: { value?: RawModelConfig[] } };
}

const mapModelConfigs = (configs: RawModelConfig[]): DeepSeekModel[] =>
  configs
    .filter(config => config.enabled !== false && typeof config.model_type === 'string')
    .map(config => ({
      id: config.model_type ?? '',
      displayName: config.name ?? '',
      description: config.description ?? '',
      isDefault: config.is_default === true,
      supportsThinking: config.think_feature !== null && config.think_feature !== undefined,
      supportsSearch: config.search_feature !== null && config.search_feature !== undefined,
    }));

/**
 * Falls back to the model list the SPA caches in localStorage. Used only when the
 * settings endpoint is unreachable, so `list_models` still reflects the picker.
 */
const readCachedModels = (): DeepSeekModel[] => {
  const raw = getLocalStorage(MODEL_CACHE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { entries?: { model_configs?: { value?: RawModelConfig[] } } };
    return mapModelConfigs(parsed.entries?.model_configs?.value ?? []);
  } catch {
    return [];
  }
};

/**
 * Lists the models the DeepSeek picker offers. These are "model types" rather than
 * named checkpoints — DeepThink and Search are per-message toggles, not separate
 * models, so they are exposed as booleans on the chat tools instead of invented ids.
 */
export const getModels = async (): Promise<DeepSeekModel[]> => {
  try {
    const settings = await getApi<ModelSettingsResponse>(
      `/client/settings?did=${encodeURIComponent(readDeviceId())}&scope=model`,
    );
    const models = mapModelConfigs(settings.settings?.model_configs?.value ?? []);
    if (models.length > 0) return models;
  } catch (error) {
    if (error instanceof ToolError && error.category === 'auth') throw error;
  }

  const cached = readCachedModels();
  if (cached.length > 0) return cached;
  throw ToolError.internal('DeepSeek returned no models — reload https://chat.deepseek.com and try again.');
};

/** Validates a model id against the live picker and returns the API `model_type`. */
export const resolveModelType = async (modelId: string | undefined): Promise<string> => {
  if (!modelId) return DEFAULT_MODEL_TYPE;
  const models = await getModels();
  const match = models.find(model => model.id === modelId);
  if (!match) {
    throw ToolError.validation(
      `Unknown DeepSeek model "${modelId}". Call list_models for valid ids (${models.map(m => m.id).join(', ')}).`,
    );
  }
  return match.id;
};

// --- Conversations ---

export const conversationUrl = (conversationId: string): string => `${API_ORIGIN}/a/chat/s/${conversationId}`;

interface RawChatSession {
  id?: string;
  title?: string | null;
  model_type?: string;
  pinned?: boolean;
  updated_at?: number;
}

interface FetchPageResponse {
  chat_sessions?: RawChatSession[];
  has_more?: boolean;
}

const mapSession = (session: RawChatSession): DeepSeekConversation => ({
  id: session.id ?? '',
  title: session.title ?? '',
  url: conversationUrl(session.id ?? ''),
  modelId: session.model_type ?? '',
  pinned: session.pinned === true,
  updatedAt: session.updated_at ?? 0,
});

/**
 * Lists chat sessions newest-first — the same source the DeepSeek sidebar renders.
 * Pages with the `lte_cursor` the SPA uses: each page continues from the oldest
 * session seen so far.
 */
export const listConversations = async (limit: number): Promise<DeepSeekConversation[]> => {
  const conversations: DeepSeekConversation[] = [];
  const seen = new Set<string>();
  let cursor: RawChatSession | undefined;

  while (conversations.length < limit) {
    const pageSize = Math.min(100, limit - conversations.length);
    const query =
      cursor === undefined
        ? `count=${pageSize}`
        : `count=${pageSize}&lte_cursor.pinned=${cursor.pinned === true}&lte_cursor.updated_at=${cursor.updated_at}`;

    const page = await getApi<FetchPageResponse>(`/chat_session/fetch_page?${query}`);
    const sessions = page.chat_sessions ?? [];
    if (sessions.length === 0) break;

    let added = 0;
    for (const session of sessions) {
      if (!session.id || seen.has(session.id)) continue;
      seen.add(session.id);
      conversations.push(mapSession(session));
      added++;
    }

    cursor = sessions[sessions.length - 1];
    if (page.has_more !== true || added === 0) break;
  }

  return conversations.slice(0, limit);
};

// --- Conversation detail ---

interface RawSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  site_name?: string;
  cite_index?: number;
}

interface RawFragment {
  /** REQUEST (user text), RESPONSE (answer), THINK (reasoning), SEARCH (web lookup). */
  type?: string;
  content?: string;
  /** SEARCH fragments carry these instead of `content`, which is always null. */
  queries?: { query?: string }[];
  results?: RawSearchResult[];
}

const collectFragments = (fragments: RawFragment[], type: string): string =>
  fragments
    .filter(fragment => fragment.type === type)
    .map(fragment => fragment.content ?? '')
    .filter(content => content.length > 0)
    .join('');

/** Pulls the queries DeepSeek ran out of the SEARCH fragments of one message. */
const collectSearchQueries = (fragments: RawFragment[]): string[] =>
  fragments
    .filter(fragment => fragment.type === 'SEARCH')
    .flatMap(fragment => fragment.queries ?? [])
    .map(entry => entry.query ?? '')
    .filter(query => query.length > 0);

/** Pulls the cited sources out of the SEARCH fragments of one message. */
const collectSearchResults = (fragments: RawFragment[]): DeepSeekSearchResult[] =>
  fragments
    .filter(fragment => fragment.type === 'SEARCH')
    .flatMap(fragment => fragment.results ?? [])
    .map(result => ({
      title: result.title ?? '',
      url: result.url ?? '',
      snippet: result.snippet ?? '',
      siteName: result.site_name ?? '',
      citeIndex: result.cite_index ?? 0,
    }));

interface RawChatMessage {
  message_id?: number;
  parent_id?: number | null;
  role?: string;
  status?: string;
  fragments?: RawFragment[];
}

interface HistoryMessagesResponse {
  chat_session?: RawChatSession;
  chat_messages?: RawChatMessage[];
}

/**
 * Reads a conversation's turns. `history_messages` returns the full thread in
 * chronological order, so user prompts pair with the assistant reply that follows.
 */
export const getConversation = async (
  conversationId: string,
  limit: number,
): Promise<{ title: string; modelId: string; turns: DeepSeekTurn[]; lastMessageId: number }> => {
  const history = await getApi<HistoryMessagesResponse>(
    `/chat/history_messages?chat_session_id=${encodeURIComponent(conversationId)}`,
  );

  const turns: DeepSeekTurn[] = [];
  let lastMessageId = 0;

  for (const message of history.chat_messages ?? []) {
    if (typeof message.message_id === 'number') lastMessageId = message.message_id;
    const fragments = message.fragments ?? [];

    if (message.role === 'USER') {
      turns.push({
        prompt: collectFragments(fragments, 'REQUEST'),
        response: '',
        thinking: '',
        searchQueries: [],
        searchResults: [],
      });
      continue;
    }
    if (message.role !== 'ASSISTANT') continue;

    const response = collectFragments(fragments, 'RESPONSE');
    const thinking = collectFragments(fragments, 'THINK');
    const searchQueries = collectSearchQueries(fragments);
    const searchResults = collectSearchResults(fragments);
    const previous = turns[turns.length - 1];

    if (previous && previous.response === '') {
      previous.response = response;
      previous.thinking = thinking;
      previous.searchQueries = searchQueries;
      previous.searchResults = searchResults;
    } else {
      turns.push({ prompt: '', response, thinking, searchQueries, searchResults });
    }
  }

  return {
    title: history.chat_session?.title ?? '',
    modelId: history.chat_session?.model_type ?? '',
    turns: turns.slice(-limit),
    lastMessageId,
  };
};

/** Returns the id of the newest message, which a follow-up must thread onto. */
export const getLatestMessageId = async (conversationId: string): Promise<number> =>
  (await getConversation(conversationId, 1)).lastMessageId;

// --- Proof of work ---

interface PowChallengeResponse {
  challenge?: PowChallenge;
}

/**
 * DeepSeek gates the completion endpoint behind a proof of work: fetch a challenge,
 * solve it locally, and present the answer as `X-DS-PoW-Response`.
 */
const buildPowHeader = async (targetPath: string): Promise<string> => {
  const response = await postApi<PowChallengeResponse>('/chat/create_pow_challenge', { target_path: targetPath });
  const challenge = response.challenge;
  if (!challenge) throw ToolError.internal('DeepSeek did not return a proof-of-work challenge.');

  const answer = solvePowChallenge(challenge);
  if (answer === null) {
    throw ToolError.internal(
      `Could not solve DeepSeek's proof-of-work challenge below difficulty ${challenge.difficulty}.`,
    );
  }
  return encodePowHeader(challenge, answer);
};

// --- Chat streaming ---

interface SseEvent {
  event: string;
  data: string;
}

/** Splits an SSE body into its `event:`/`data:` records. */
const parseSseEvents = (body: string): SseEvent[] => {
  const events: SseEvent[] = [];

  for (const block of body.split(/\r?\n\r?\n/)) {
    if (block.trim().length === 0) continue;
    let name = '';
    const dataLines: string[] = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }

    if (dataLines.length > 0 || name.length > 0) events.push({ event: name, data: dataLines.join('\n') });
  }

  return events;
};

interface DeltaFrame {
  p?: string;
  o?: string;
  v?: unknown;
}

interface FlatOperation {
  path: string;
  op: string;
  value: unknown;
}

/**
 * Flattens one delta frame into concrete operations.
 *
 * `p` and `o` are *sticky*: a frame that omits either reuses the value from the
 * previous frame on the same stream, which is how DeepSeek streams long runs of
 * text as bare `{"v":"..."}` records. BATCH frames carry nested operations whose
 * paths are relative to the outer path, and which keep their own sticky state.
 */
const flattenDelta = (frame: DeltaFrame, sticky: { path: string; op: string }): FlatOperation[] => {
  const op = frame.o ?? sticky.op;
  const path = frame.p ?? sticky.path;
  sticky.op = op;
  sticky.path = path;

  if (op !== 'BATCH') return [{ path, op, value: frame.v }];
  if (!Array.isArray(frame.v)) return [];

  const nested = { path: '', op: 'SET' };
  return (frame.v as DeltaFrame[]).flatMap(child =>
    flattenDelta(child, nested).map(operation => ({
      ...operation,
      path: (path ? `${path}/` : '') + operation.path,
    })),
  );
};

const resolveContainer = (root: Record<string, unknown>, segments: string[]): unknown => {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = current[index < 0 ? current.length + index : index];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
};

/** Applies one flattened operation to the accumulating response document. */
const applyOperation = (root: Record<string, unknown>, operation: FlatOperation): void => {
  const segments = operation.path.split('/').filter(segment => segment.length > 0);

  if (segments.length === 0) {
    if (operation.value && typeof operation.value === 'object') {
      Object.assign(root, operation.value as Record<string, unknown>);
    }
    return;
  }

  const key = segments[segments.length - 1];
  if (key === undefined) return;

  const container = resolveContainer(root, segments.slice(0, -1));
  if (container === null || typeof container !== 'object') return;

  if (Array.isArray(container)) {
    const parsed = Number(key);
    const index = parsed < 0 ? container.length + parsed : parsed;
    if (operation.op === 'APPEND') {
      // Appending an array at an index position inserts its members there.
      if (Array.isArray(operation.value)) {
        container.splice(index, 0, ...(operation.value as unknown[]));
        return;
      }
      if (typeof container[index] === 'string') {
        container[index] = (container[index] as string) + String(operation.value);
        return;
      }
    }
    container[index] = operation.value;
    return;
  }

  const record = container as Record<string, unknown>;
  const existing = record[key];

  if (operation.op === 'APPEND') {
    // An array value is spread into the target array — DeepSeek starts each new
    // fragment (e.g. the RESPONSE that follows a THINK block) with
    // `{"p":"response/fragments","o":"APPEND","v":[{...}]}`. Pushing the array
    // itself instead of its members would bury the fragment one level too deep
    // and silently drop the answer text.
    if (Array.isArray(existing) && Array.isArray(operation.value)) {
      existing.push(...(operation.value as unknown[]));
      return;
    }
    if (typeof existing === 'string') {
      record[key] = existing + String(operation.value);
      return;
    }
  }

  record[key] = operation.value;
};

interface StreamedResponse {
  message_id?: number;
  parent_id?: number;
  status?: string;
  fragments?: RawFragment[];
}

export interface ChatOptions {
  text: string;
  conversationId?: string;
  parentMessageId?: number | null;
  modelType?: string;
  thinking?: boolean;
  search?: boolean;
}

/**
 * Streaming replies always carry HTTP 200 — DeepSeek reports failures as a
 * `toast`/`hint` frame with `type: "error"` inside the stream, so the status code
 * alone never reveals a rejected request.
 */
const findStreamError = (events: SseEvent[]): string | null => {
  for (const event of events) {
    if (event.event !== 'toast' && event.event !== 'hint') continue;
    try {
      const payload = JSON.parse(event.data) as { type?: string; content?: string };
      if (payload.type === 'error') return payload.content ?? 'unknown error';
    } catch {
      // Ignore frames that are not JSON.
    }
  }
  return null;
};

const foldChatStream = (events: SseEvent[]): DeepSeekChatResult => {
  const document: Record<string, unknown> = {};
  const sticky = { path: '', op: 'SET' };
  let title = '';

  for (const event of events) {
    if (event.event === 'title') {
      try {
        title = (JSON.parse(event.data) as { content?: string }).content ?? title;
      } catch {
        // Ignore malformed title frames.
      }
      continue;
    }
    // Anything without an event name is a delta frame.
    if (event.event !== '') continue;

    let frame: DeltaFrame;
    try {
      frame = JSON.parse(event.data) as DeltaFrame;
    } catch {
      continue;
    }
    for (const operation of flattenDelta(frame, sticky)) applyOperation(document, operation);
  }

  const response = (document.response ?? {}) as StreamedResponse;
  const fragments = response.fragments ?? [];

  return {
    conversationId: '',
    messageId: response.message_id ?? 0,
    parentMessageId: response.parent_id ?? 0,
    text: collectFragments(fragments, 'RESPONSE'),
    thinking: collectFragments(fragments, 'THINK'),
    searchQueries: collectSearchQueries(fragments),
    searchResults: collectSearchResults(fragments),
    title,
  };
};

interface CreateSessionResponse {
  chat_session?: { id?: string };
}

export const createConversation = async (): Promise<string> => {
  const created = await postApi<CreateSessionResponse>('/chat_session/create', {});
  const id = created.chat_session?.id;
  if (!id) throw ToolError.internal('DeepSeek did not return a new chat session id.');
  return id;
};

/**
 * Sends a message and waits for the complete streamed reply. Creates a chat
 * session first when none is given, mirroring what the web app does.
 */
export const chat = async (options: ChatOptions): Promise<DeepSeekChatResult> => {
  const conversationId = options.conversationId ?? (await createConversation());
  const powHeader = await buildPowHeader(COMPLETION_PATH);

  const response = await fetchFromPage(`${API_BASE}/chat/completion`, {
    method: 'POST',
    headers: buildHeaders({ 'content-type': 'application/json', 'x-ds-pow-response': powHeader }),
    credentials: 'include',
    timeout: COMPLETION_TIMEOUT_MS,
    body: JSON.stringify({
      chat_session_id: conversationId,
      parent_message_id: options.parentMessageId ?? null,
      model_type: options.modelType ?? DEFAULT_MODEL_TYPE,
      prompt: options.text,
      ref_file_ids: [],
      thinking_enabled: options.thinking ?? false,
      search_enabled: options.search ?? false,
      action: null,
      preempt: false,
    }),
  });

  const events = parseSseEvents(await response.text());

  const streamError = findStreamError(events);
  if (streamError) throw ToolError.internal(`DeepSeek chat failed: ${streamError}`);

  const result = foldChatStream(events);
  result.conversationId = conversationId;

  if (!result.text && !result.thinking) {
    throw ToolError.internal('DeepSeek returned no content — the stream may have been interrupted.');
  }

  return result;
};

// --- Page state ---

/** Reads the chat session id out of an /a/chat/s/<id> URL, or null when none is open. */
export const getCurrentConversationId = (): string | null => {
  const match = window.location.pathname.match(/\/chat\/s\/([0-9a-fA-F-]{36})/);
  return match?.[1] ?? null;
};
