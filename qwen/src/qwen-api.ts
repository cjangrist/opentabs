import { ToolError, fetchFromPage, getLocalStorage, waitUntil } from '@opentabs-dev/plugin-sdk';

// --- Constants ---

const API_ORIGIN = 'https://chat.qwen.ai';
const API_BASE = `${API_ORIGIN}/api`;

/** localStorage key holding the JWT the Qwen SPA authenticates with. */
const TOKEN_KEY = 'token';
/** Client version the Qwen web app stamps on every request. */
const CLIENT_VERSION = '0.2.82';
/** Version of the Alibaba risk-control SDK the web app reports. */
const BX_VERSION = '2.5.37';

const REQUEST_TIMEOUT_MS = 30_000;
const COMPLETION_TIMEOUT_MS = 600_000;

/** Chat types Qwen routes a message through. Plain chat vs. web-search-backed chat. */
const CHAT_TYPE_TEXT = 't2t';
const CHAT_TYPE_SEARCH = 'search';

/**
 * Qwen's three reasoning settings, taken from the site bundle's ThinkingMode enum.
 * "Auto" lets the model decide, "Thinking" forces reasoning, "Fast" disables it.
 * Any other value makes the completion endpoint hang instead of erroring.
 */
const THINKING_MODE_AUTO = 'Auto';
const THINKING_MODE_ON = 'Thinking';
const THINKING_MODE_OFF = 'Fast';

/** Phases the completion stream labels its content fragments with. */
const PHASE_ANSWER = 'answer';
const PHASE_THINK = 'think';
/** Reasoning phase used when `thinking_format` is "summary", which is Qwen's default. */
const PHASE_THINKING_SUMMARY = 'thinking_summary';
const PHASE_WEB_SEARCH = 'web_search';

// --- Types ---

export interface QwenUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tier: string;
}

export interface QwenModel {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportsThinking: boolean;
  supportsSearch: boolean;
  maxContextLength: number;
}

export interface QwenConversation {
  id: string;
  title: string;
  url: string;
  chatType: string;
  projectId: string;
  pinned: boolean;
  updatedAt: number;
}

export interface QwenSearchResult {
  title: string;
  url: string;
  snippet: string;
  hostname: string;
}

export interface QwenTurn {
  prompt: string;
  response: string;
  thinking: string;
  searchResults: QwenSearchResult[];
}

export interface QwenChatResult {
  conversationId: string;
  responseId: string;
  parentMessageId: string;
  text: string;
  thinking: string;
  searchResults: QwenSearchResult[];
  title: string;
  modelId: string;
}

// --- Auth ---

const readToken = (): string | null => {
  const token = getLocalStorage(TOKEN_KEY);
  return token && token.length > 0 ? token : null;
};

/** True when the page holds a Qwen JWT — i.e. the user is logged in. */
export const isAuthenticated = (): boolean => readToken() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

const requireToken = (): string => {
  const token = readToken();
  if (!token) {
    throw ToolError.auth('Not authenticated — please log in to Qwen at https://chat.qwen.ai.');
  }
  return token;
};

/**
 * Reproduces the header set the Qwen web app stamps on API requests. The SPA
 * relies on its session cookie, but the endpoints also accept the localStorage
 * JWT as a bearer token, which is what this plugin sends.
 */
const buildHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${requireToken()}`,
    accept: 'application/json, text/plain, */*',
    source: 'web',
    Version: CLIENT_VERSION,
    'bx-v': BX_VERSION,
    ...extra,
  };

  try {
    headers['x-request-id'] = crypto.randomUUID();
    headers.Timezone = new Date().toString();
  } catch {
    // Both headers are advisory — omit them when the environment lacks the APIs.
  }

  return headers;
};

// --- Envelope handling ---

/** The `/api/v2/*` endpoints wrap every payload in this envelope. */
interface ApiEnvelope<T> {
  success?: boolean;
  request_id?: string;
  data?: T;
  code?: string | number;
  msg?: string;
  detail?: string;
}

const describeApiError = (envelope: ApiEnvelope<unknown>): string =>
  envelope.msg ?? envelope.detail ?? (envelope.code !== undefined ? `code ${envelope.code}` : 'unknown error');

const unwrap = <T>(envelope: ApiEnvelope<T>): T => {
  if (envelope.success === false) {
    throw ToolError.internal(`Qwen API error: ${describeApiError(envelope)}`);
  }
  if (envelope.data === undefined || envelope.data === null) {
    throw ToolError.internal('Qwen returned an empty response envelope.');
  }
  return envelope.data;
};

const callApi = async <T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> => {
  const response = await fetchFromPage(`${API_BASE}${path}`, {
    ...init,
    headers: buildHeaders((init?.headers as Record<string, string>) ?? {}),
    credentials: 'include',
    timeout: init?.timeout ?? REQUEST_TIMEOUT_MS,
  });
  // fetchFromPage already classifies every non-2xx status into a typed ToolError
  // (401/403 -> auth, 429 -> rate-limited with Retry-After, 5xx -> internal/retryable, …)
  // via httpStatusToToolError, so callApi only needs to guard what happens once the
  // response is already `ok`. Two things can still go wrong: reading the body can reject
  // mid-stream (a connection drop while a 2xx body is still arriving), or a fully-read body
  // can still not be valid JSON (a risk-control interstitial or maintenance page served at
  // HTTP 200). Both are caught below so no raw, unclassified error escapes this function —
  // a mid-stream read failure is retryable (transient), a non-JSON body is not (the
  // response is simply malformed).
  let rawBody = '';
  try {
    rawBody = await response.text();
    return JSON.parse(rawBody) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      const preview = rawBody.length > 200 ? `${rawBody.slice(0, 200)}…` : rawBody;
      throw ToolError.internal(`Qwen returned a non-JSON response from ${path}: ${preview || '(empty body)'}`);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw ToolError.timeout(`Qwen response body from ${path} could not be read: ${reason}`);
  }
};

const getWrapped = async <T>(path: string): Promise<T> =>
  unwrap<T>(await callApi<ApiEnvelope<T>>(path, { method: 'GET' }));

const postWrapped = async <T>(path: string, body: unknown): Promise<T> =>
  unwrap<T>(
    await callApi<ApiEnvelope<T>>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

// --- Account ---

interface RawUser {
  id?: string;
  email?: string;
  name?: string;
  role?: string;
  tier?: string;
}

/** `/api/v1/auths/` is unwrapped — it returns the profile object directly. */
export const getCurrentUser = async (): Promise<QwenUser> => {
  const user = await callApi<RawUser>('/v1/auths/', { method: 'GET' });
  if (!user.id) {
    throw ToolError.auth('Qwen did not return a user — please log in at https://chat.qwen.ai.');
  }
  return {
    id: user.id,
    email: user.email ?? '',
    name: user.name ?? '',
    role: user.role ?? '',
    tier: user.tier ?? '',
  };
};

// --- Models ---

interface RawModel {
  id?: string;
  name?: string;
  info?: {
    is_active?: boolean;
    meta?: {
      description?: string;
      short_description?: string;
      max_context_length?: number;
      chat_type?: string[];
      capabilities?: { thinking?: boolean; search?: boolean };
    };
  };
}

const mapModel = (model: RawModel, index: number): QwenModel => {
  const meta = model.info?.meta;
  return {
    id: model.id ?? '',
    displayName: model.name ?? '',
    description: meta?.short_description ?? meta?.description ?? '',
    // Qwen has no per-account default flag; the picker preselects the first entry.
    isDefault: index === 0,
    supportsThinking: meta?.capabilities?.thinking === true,
    supportsSearch: (meta?.chat_type ?? []).includes(CHAT_TYPE_SEARCH),
    maxContextLength: meta?.max_context_length ?? 0,
  };
};

/**
 * Lists the models Qwen's own picker offers. Reasoning and web search are
 * per-message toggles rather than separate models, so they are exposed as the
 * `thinking` / `search` booleans on the chat tools instead of invented ids.
 */
export const getModels = async (): Promise<QwenModel[]> => {
  // Probed live: `/models` returns a bare `{ data: [...] }` with no `success`/`code`/`msg`
  // envelope, and it is not auth-gated (a bogus bearer token still returns the full list).
  // Routing this through getWrapped/unwrap would therefore be a no-op — do not "fix" it
  // back to that without re-probing first.
  const response = await callApi<{ data?: RawModel[] }>('/models', { method: 'GET' });
  const models = (response.data ?? [])
    .filter(model => typeof model.id === 'string' && model.info?.is_active !== false)
    .map(mapModel);
  if (models.length === 0) {
    throw ToolError.internal('Qwen returned no models — reload https://chat.qwen.ai and try again.');
  }
  return models;
};

/** Resolves the id the picker's first entry uses, which the SPA preselects. */
const getDefaultModelId = async (): Promise<string> => {
  const models = await getModels();
  const first = models[0];
  if (!first) throw ToolError.internal('Qwen returned no models.');
  return first.id;
};

/** Validates a model id against the live picker so a typo never hangs the stream. */
export const resolveModelId = async (modelId: string | undefined): Promise<string> => {
  const models = await getModels();
  if (!modelId) {
    const first = models[0];
    if (!first) throw ToolError.internal('Qwen returned no models.');
    return first.id;
  }
  const match = models.find(model => model.id === modelId);
  if (!match) {
    throw ToolError.validation(
      `Unknown Qwen model "${modelId}". Call list_models for valid ids (${models.map(model => model.id).join(', ')}).`,
    );
  }
  return match.id;
};

// --- Conversations ---

export const conversationUrl = (conversationId: string): string => `${API_ORIGIN}/c/${conversationId}`;

interface RawChatSummary {
  id?: string;
  title?: string | null;
  chat_type?: string;
  project_id?: string | null;
  pinned?: boolean;
  updated_at?: number;
  created_at?: number;
}

const mapConversation = (chat: RawChatSummary): QwenConversation => ({
  id: chat.id ?? '',
  title: chat.title ?? '',
  url: conversationUrl(chat.id ?? ''),
  chatType: chat.chat_type ?? '',
  projectId: chat.project_id ?? '',
  pinned: chat.pinned === true,
  updatedAt: chat.updated_at ?? 0,
});

/**
 * Lists chat sessions newest-first. Pinned chats live behind a separate endpoint
 * and are prepended, mirroring how the Qwen sidebar renders them. Chats that
 * belong to a project are included with their `project_id` exposed rather than
 * filtered out, so nothing silently goes missing.
 */
export const listConversations = async (limit: number): Promise<QwenConversation[]> => {
  const conversations: QwenConversation[] = [];
  const seen = new Set<string>();

  const add = (chats: RawChatSummary[]): number => {
    let added = 0;
    for (const chat of chats) {
      if (!chat.id || seen.has(chat.id)) continue;
      seen.add(chat.id);
      conversations.push(mapConversation(chat));
      added++;
    }
    return added;
  };

  const pinned = await getWrapped<RawChatSummary[]>('/v2/chats/pinned').catch(() => [] as RawChatSummary[]);
  add(pinned.map(chat => ({ ...chat, pinned: true })));

  for (let page = 1; conversations.length < limit; page++) {
    const chats = await getWrapped<RawChatSummary[]>(`/v2/chats/?page=${page}`);
    if (chats.length === 0) break;
    if (add(chats) === 0) break;
  }

  return conversations.slice(0, limit);
};

// --- Conversation detail ---

/** Cumulative list Qwen streams for the reasoning summary — each frame resends the whole array. */
interface RawSummaryField {
  content?: string[];
}

interface RawPartExtra {
  web_search_info?: RawSearchResult[];
  summary_title?: RawSummaryField;
  summary_thought?: RawSummaryField;
}

interface RawContentPart {
  content?: unknown;
  phase?: string;
  status?: string;
  extra?: RawPartExtra;
}

interface RawSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  hostname?: string;
  website?: string;
}

interface RawMessage {
  id?: string;
  role?: string;
  content?: string;
  parentId?: string | null;
  childrenIds?: string[];
  model?: string;
  content_list?: RawContentPart[];
}

interface RawChatDetail {
  id?: string;
  title?: string;
  chat_type?: string;
  models?: string[] | null;
  currentId?: string;
  chat?: {
    models?: string[];
    messages?: RawMessage[];
    history?: { messages?: Record<string, RawMessage>; currentId?: string };
  };
}

const mapSearchResult = (result: RawSearchResult): QwenSearchResult => ({
  title: result.title ?? '',
  url: result.url ?? '',
  snippet: result.snippet ?? '',
  hostname: result.hostname ?? result.website ?? '',
});

/** Concatenates the string content of every part belonging to one phase. */
const collectPhase = (parts: RawContentPart[], phase: string): string =>
  parts
    .filter(part => part.phase === phase && typeof part.content === 'string')
    .map(part => part.content as string)
    .join('');

/**
 * Pulls the cited pages out of a message. Qwen carries them on the web_search
 * part — either as `extra.web_search_info` or, on older messages, as the part's
 * own array-valued `content`.
 */
const collectSearchResults = (parts: RawContentPart[]): QwenSearchResult[] => {
  const seen = new Set<string>();
  return parts
    .filter(part => part.phase === PHASE_WEB_SEARCH)
    .flatMap(part => {
      const fromExtra = part.extra?.web_search_info;
      if (Array.isArray(fromExtra)) return fromExtra;
      return Array.isArray(part.content) ? (part.content as RawSearchResult[]) : [];
    })
    .filter(result => {
      if (typeof result?.url !== 'string' || seen.has(result.url)) return false;
      seen.add(result.url);
      return true;
    })
    .map(mapSearchResult);
};

/**
 * Reads the reasoning text. Qwen's default `thinking_format` is "summary": the
 * part's own `content` is empty and the text lives in `extra.summary_thought`
 * as a growing list of steps, each with a matching title in `summary_title`.
 * Models on the raw format put the text in `content` instead, so both are read.
 */
const collectThinking = (parts: RawContentPart[]): string =>
  parts
    .filter(part => part.phase === PHASE_THINK || part.phase === PHASE_THINKING_SUMMARY)
    .flatMap(part => {
      if (typeof part.content === 'string' && part.content.length > 0) return [part.content];
      const titles = part.extra?.summary_title?.content ?? [];
      const thoughts = part.extra?.summary_thought?.content ?? [];
      return thoughts.map((thought, index) => {
        const title = titles[index];
        return title ? `${title}\n${thought}` : thought;
      });
    })
    .join('\n\n');

interface MessageContent {
  response: string;
  thinking: string;
  searchResults: QwenSearchResult[];
}

/** Reduces one assistant message to the three fields the tools expose. */
const readAssistantMessage = (message: RawMessage): MessageContent => {
  const parts = message.content_list ?? [];
  return {
    // Assistant messages keep their text in content_list; `content` is a
    // pre-rendered fallback that is empty on anything recent.
    response: collectPhase(parts, PHASE_ANSWER) || (message.content ?? ''),
    thinking: collectThinking(parts),
    searchResults: collectSearchResults(parts),
  };
};

/**
 * Walks the branch that is currently displayed. Qwen stores messages as a tree
 * keyed by id, so following `parentId` back from `currentId` yields exactly the
 * thread the site shows — regenerated branches stay out of the result.
 */
const currentBranch = (detail: RawChatDetail): RawMessage[] => {
  const byId = detail.chat?.history?.messages;
  const currentId = detail.chat?.history?.currentId ?? detail.currentId;
  if (!byId || !currentId) return detail.chat?.messages ?? [];

  const branch: RawMessage[] = [];
  const visited = new Set<string>();
  let cursor: string | null | undefined = currentId;

  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const message: RawMessage | undefined = byId[cursor];
    if (!message) break;
    branch.unshift(message);
    cursor = message.parentId;
  }

  return branch.length > 0 ? branch : (detail.chat?.messages ?? []);
};

const readChatDetail = (conversationId: string): Promise<RawChatDetail> =>
  getWrapped<RawChatDetail>(`/v2/chats/${encodeURIComponent(conversationId)}`);

export const getConversation = async (
  conversationId: string,
  limit: number,
): Promise<{ title: string; modelId: string; chatType: string; turns: QwenTurn[]; currentId: string }> => {
  const detail = await readChatDetail(conversationId);
  const turns: QwenTurn[] = [];

  for (const message of currentBranch(detail)) {
    if (message.role === 'user') {
      turns.push({ prompt: message.content ?? '', response: '', thinking: '', searchResults: [] });
      continue;
    }
    if (message.role !== 'assistant') continue;

    const { response, thinking, searchResults } = readAssistantMessage(message);
    const previous = turns[turns.length - 1];

    if (previous && previous.response === '') {
      previous.response = response;
      previous.thinking = thinking;
      previous.searchResults = searchResults;
    } else {
      turns.push({ prompt: '', response, thinking, searchResults });
    }
  }

  return {
    title: detail.title ?? '',
    modelId: detail.chat?.models?.[0] ?? detail.models?.[0] ?? '',
    chatType: detail.chat_type ?? '',
    turns: turns.slice(-limit),
    currentId: detail.chat?.history?.currentId ?? detail.currentId ?? '',
  };
};

/** Returns the id of the newest message, which a follow-up threads onto. */
export const getCurrentMessageId = async (conversationId: string): Promise<string | null> => {
  const detail = await readChatDetail(conversationId);
  return detail.chat?.history?.currentId ?? detail.currentId ?? null;
};

// --- Chat streaming ---

/** Splits an SSE body into the JSON payload of each `data:` record. */
const parseSseData = (body: string): unknown[] => {
  const payloads: unknown[] = [];

  for (const block of body.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim());
    if (dataLines.length === 0) continue;

    const joined = dataLines.join('\n');
    if (joined === '[DONE]') continue;
    try {
      payloads.push(JSON.parse(joined));
    } catch {
      // Qwen occasionally emits keep-alive comments; skip anything unparseable.
    }
  }

  return payloads;
};

interface StreamDelta {
  role?: string;
  content?: unknown;
  phase?: string;
  status?: string;
  extra?: RawPartExtra;
}

interface StreamFrame {
  'response.created'?: { chat_id?: string; parent_id?: string; response_id?: string };
  choices?: { delta?: StreamDelta }[];
  error?: unknown;
  code?: string | number;
  msg?: string;
  detail?: string;
  success?: boolean;
}

const describeStreamError = (frame: StreamFrame): string | null => {
  if (frame.success === false) return describeApiError(frame);
  if (frame.error !== undefined && frame.error !== null) {
    if (typeof frame.error === 'string') return frame.error;
    const nested = frame.error as { message?: string; detail?: string; code?: string | number };
    return nested.message ?? nested.detail ?? `code ${nested.code ?? 'unknown'}`;
  }
  // A bare `code`/`detail` frame with no choices is Qwen's inline rejection shape.
  if (frame.choices === undefined && (frame.msg !== undefined || frame.detail !== undefined)) {
    return describeApiError(frame);
  }
  return null;
};

interface FoldedStream {
  responseId: string;
  parentMessageId: string;
  text: string;
  thinking: string;
  searchResults: QwenSearchResult[];
}

/**
 * Folds the completion stream. `incremental_output: true` makes every `answer`
 * delta a suffix, so the reply is a plain concatenation. The reasoning and
 * web-search phases instead resend a cumulative snapshot in `delta.extra` on
 * every frame, so the last frame of each phase wins.
 *
 * The endpoint answers HTTP 200 even when it rejects the request — failures
 * arrive as a frame inside the stream, so every frame is checked.
 */
const foldStream = (payloads: unknown[]): FoldedStream => {
  const folded: FoldedStream = { responseId: '', parentMessageId: '', text: '', thinking: '', searchResults: [] };
  // Snapshot phases are keyed by phase so a reasoning block that resumes after a
  // web search does not overwrite the one that came before it.
  const latestByPhase = new Map<number, RawContentPart>();
  let phaseIndex = -1;
  let previousPhase = '';

  for (const payload of payloads) {
    const frame = payload as StreamFrame;

    const error = describeStreamError(frame);
    if (error) throw ToolError.internal(`Qwen chat failed: ${error}`);

    const created = frame['response.created'];
    if (created) {
      folded.responseId = created.response_id ?? folded.responseId;
      folded.parentMessageId = created.parent_id ?? folded.parentMessageId;
      continue;
    }

    for (const choice of frame.choices ?? []) {
      const delta = choice.delta;
      if (!delta) continue;

      const phase = delta.phase ?? PHASE_ANSWER;
      if (phase !== previousPhase) {
        phaseIndex++;
        previousPhase = phase;
      }

      if (phase === PHASE_ANSWER) {
        if (typeof delta.content === 'string') folded.text += delta.content;
        continue;
      }

      latestByPhase.set(phaseIndex, { phase, content: delta.content, extra: delta.extra });
    }
  }

  const snapshots = [...latestByPhase.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
  folded.thinking = collectThinking(snapshots);
  folded.searchResults = collectSearchResults(snapshots);

  return folded;
};

interface NewChatResponse {
  id?: string;
}

/** Creates an empty chat session, the same call the SPA makes before the first message. */
export const createChatSession = async (modelId: string, chatType: string): Promise<string> => {
  const created = await postWrapped<NewChatResponse>('/v2/chats/new', {
    chatId: '',
    models: [modelId],
    project_id: '',
    timestamp: Date.now(),
    chat_type: chatType,
    chat_mode: 'normal',
  });
  if (!created.id) throw ToolError.internal('Qwen did not return a new chat id.');
  return created.id;
};

export interface ChatOptions {
  text: string;
  conversationId?: string;
  parentMessageId?: string | null;
  modelId?: string;
  thinking?: boolean;
  search?: boolean;
}

/**
 * Builds the `feature_config` the SPA sends. Reasoning is a tri-state on Qwen:
 * omitting `thinking` leaves it on "Auto" (the site default, where the model
 * decides), `true` forces it on and `false` turns it off.
 */
const buildFeatureConfig = (thinking: boolean | undefined): Record<string, unknown> => {
  const mode = thinking === undefined ? THINKING_MODE_AUTO : thinking ? THINKING_MODE_ON : THINKING_MODE_OFF;
  return {
    thinking_enabled: mode !== THINKING_MODE_OFF,
    output_schema: 'phase',
    research_mode: 'normal',
    auto_thinking: mode === THINKING_MODE_AUTO,
    thinking_mode: mode,
    thinking_format: 'summary',
  };
};

/**
 * Sends a message and waits for the complete streamed reply, creating a chat
 * session first when none is given. Qwen keeps conversation history server
 * side: only the new message is uploaded, and `parentId` selects the branch it
 * continues.
 */
export const chat = async (options: ChatOptions): Promise<QwenChatResult> => {
  const modelId = options.modelId ?? (await getDefaultModelId());
  const chatType = options.search === true ? CHAT_TYPE_SEARCH : CHAT_TYPE_TEXT;
  const conversationId = options.conversationId ?? (await createChatSession(modelId, chatType));
  const parentId = options.parentMessageId ?? null;
  const featureConfig = buildFeatureConfig(options.thinking);

  const response = await fetchFromPage(
    `${API_BASE}/v2/chat/completions?chat_id=${encodeURIComponent(conversationId)}`,
    {
      method: 'POST',
      headers: buildHeaders({
        'content-type': 'application/json',
        accept: 'application/json',
        'x-accel-buffering': 'no',
      }),
      credentials: 'include',
      timeout: COMPLETION_TIMEOUT_MS,
      body: JSON.stringify({
        stream: true,
        version: '2.1',
        incremental_output: true,
        chatId: conversationId,
        chat_id: conversationId,
        parentId: parentId ?? '',
        parent_id: parentId,
        chat_mode: 'normal',
        model: modelId,
        messages: [
          {
            id: null,
            fid: crypto.randomUUID(),
            parentId,
            parent_id: parentId,
            childrenIds: [crypto.randomUUID()],
            role: 'user',
            content: options.text,
            user_action: 'chat',
            files: [],
            timestamp: Math.floor(Date.now() / 1000),
            models: [modelId],
            model: '',
            chat_type: chatType,
            sub_chat_type: chatType,
            feature_config: featureConfig,
            extra: { meta: { subChatType: chatType } },
          },
        ],
        timestamp: Date.now(),
      }),
    },
  );

  const folded = foldStream(parseSseData(await response.text()));
  if (!folded.text && !folded.thinking) {
    throw ToolError.internal('Qwen returned no content — the stream may have been interrupted.');
  }

  // The chat record is read back for two reasons: titles are generated server
  // side after the first exchange, and the cited sources of a web search are
  // only attached to the stored message — the stream's web_search frames carry
  // no `web_search_info`.
  const detail = await readChatDetail(conversationId).catch(() => null);
  const stored = detail?.chat?.history?.messages?.[folded.responseId];
  const persisted = stored ? readAssistantMessage(stored) : null;

  return {
    conversationId,
    responseId: folded.responseId,
    parentMessageId: folded.parentMessageId,
    text: folded.text || (persisted?.response ?? ''),
    thinking: folded.thinking || (persisted?.thinking ?? ''),
    searchResults: folded.searchResults.length > 0 ? folded.searchResults : (persisted?.searchResults ?? []),
    title: detail?.title ?? '',
    modelId,
  };
};

// --- Page state ---

/** Reads the chat id out of a /c/<uuid> URL, or null when none is open. */
export const getCurrentConversationId = (): string | null => {
  const match = window.location.pathname.match(/\/c\/([0-9a-fA-F-]{36})/);
  return match?.[1] ?? null;
};
