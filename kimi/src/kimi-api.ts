import { ToolError, fetchFromPage, getLocalStorage, setLocalStorage, waitUntil } from '@opentabs-dev/plugin-sdk';

// --- Constants ---

const API_ORIGIN = 'https://www.kimi.com';
const RPC_BASE = `${API_ORIGIN}/apiv2`;
const REFRESH_URL = `${API_ORIGIN}/api/auth/token/refresh`;

const ACCESS_TOKEN_KEY = 'access_token';
const REFRESH_TOKEN_KEY = 'refresh_token';

const CHAT_TIMEOUT_MS = 300_000;
const DEFAULT_SCENARIO = 'SCENARIO_K2D5';

// --- Types ---

export interface KimiUser {
  id: string;
  nickname: string;
  avatar: string;
  phone: string;
  region: string;
}

export interface KimiModel {
  id: string;
  displayName: string;
  description: string;
  scenario: string;
  kimiPlusId: string;
  isDefault: boolean;
}

export interface KimiConversation {
  id: string;
  title: string;
  url: string;
  projectId: string;
}

export interface KimiTurn {
  prompt: string;
  response: string;
  thinking: string;
}

export interface KimiChatResult {
  conversationId: string;
  messageId: string;
  parentMessageId: string;
  text: string;
  thinking: string;
}

// --- Auth ---

const readAccessToken = (): string | null => {
  const token = getLocalStorage(ACCESS_TOKEN_KEY);
  return token && token.length > 0 ? token : null;
};

const readRefreshToken = (): string | null => {
  const token = getLocalStorage(REFRESH_TOKEN_KEY);
  return token && token.length > 0 ? token : null;
};

/** True when the page holds a Kimi access token — i.e. the user is logged in. */
export const isAuthenticated = (): boolean => readAccessToken() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

const requireAccessToken = (): string => {
  const token = readAccessToken();
  if (!token) throw ToolError.auth('Not authenticated — please log in to Kimi at https://www.kimi.com.');
  return token;
};

/**
 * Kimi access tokens live ~15 minutes. When one expires mid-session the SPA
 * silently refreshes it; a plugin call can land in that gap, so exchange the
 * long-lived refresh token for a fresh access token and persist it the same
 * way the app does.
 */
const refreshAccessToken = async (): Promise<string | null> => {
  const refreshToken = readRefreshToken();
  if (!refreshToken) return null;

  const response = await fetch(REFRESH_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${refreshToken}` },
    credentials: 'include',
  });
  if (!response.ok) return null;

  let payload: { access_token?: string; refresh_token?: string };
  try {
    payload = (await response.json()) as { access_token?: string; refresh_token?: string };
  } catch {
    // A 2xx whose body is not JSON (gateway interstitial, captive portal, empty body) means
    // the refresh did not actually happen — treat it as not-authenticated rather than letting
    // a raw SyntaxError escape callRpc uncategorised.
    return null;
  }
  if (!payload.access_token) return null;

  setLocalStorage(ACCESS_TOKEN_KEY, payload.access_token);
  if (payload.refresh_token) setLocalStorage(REFRESH_TOKEN_KEY, payload.refresh_token);
  return payload.access_token;
};

/** Device id the Kimi web app stamps on every gateway request. */
const readDeviceId = (): string => {
  const raw = getLocalStorage('volcano-token-info');
  if (!raw) return '';
  try {
    return (JSON.parse(raw) as { webId?: string }).webId ?? '';
  } catch {
    return '';
  }
};

/**
 * Reproduces the header set the Kimi web app sends. `x-msh-version` is not
 * cosmetic: without it the gateway serves an older experiment bucket whose
 * model list ("K2.6 Instant/Thinking/Agent") does not match what the site's own
 * model picker shows ("Instant/K3/K3 Swarm").
 */
const buildHeaders = (token: string, contentType: string): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    Authorization: `Bearer ${token}`,
    'x-msh-platform': 'web',
    'x-msh-version': '2.0.0',
    'x-language': 'en-US',
    'connect-protocol-version': '1',
  };

  const deviceId = readDeviceId();
  if (deviceId) headers['x-msh-device-id'] = deviceId;

  const trafficId = getLocalStorage('msh_user_id');
  if (trafficId) headers['x-traffic-id'] = trafficId;

  try {
    headers['r-timezone'] = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Timezone is advisory — omit it when the environment does not expose Intl.
  }

  return headers;
};

// --- Connect-RPC unary calls (application/json) ---

/**
 * Calls a Connect-RPC unary method. Retries once with a refreshed access token
 * when the gateway rejects the current one.
 */
export const callRpc = async <T>(method: string, body: Record<string, unknown>): Promise<T> => {
  const send = async (token: string): Promise<Response> =>
    fetch(`${RPC_BASE}/${method}`, {
      method: 'POST',
      headers: buildHeaders(token, 'application/json'),
      credentials: 'include',
      body: JSON.stringify(body),
    });

  let response = await send(requireAccessToken());

  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw ToolError.auth('Kimi session expired — please reload https://www.kimi.com and log in.');
    response = await send(refreshed);
  }

  if (response.status === 429) throw ToolError.rateLimited('Kimi rate limited — please wait and retry.');
  if (!response.ok) {
    const detail = await response.text();
    throw ToolError.internal(`Kimi RPC ${method} failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  return (await response.json()) as T;
};

// --- Connect streaming protocol (application/connect+json) ---

/** Wraps a JSON payload in a Connect envelope: 1 flag byte + 4-byte big-endian length + body. */
const encodeConnectFrame = (payload: unknown): Uint8Array => {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const frame = new Uint8Array(5 + json.length);
  new DataView(frame.buffer).setUint32(1, json.length);
  frame.set(json, 5);
  return frame;
};

/** Splits a Connect stream body back into its individual JSON events. */
const decodeConnectFrames = (buffer: Uint8Array): Record<string, unknown>[] => {
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let offset = 0;

  while (offset + 5 <= buffer.length) {
    const length = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 4).getUint32(0);
    const body = decoder.decode(buffer.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
    try {
      events.push(JSON.parse(body) as Record<string, unknown>);
    } catch {
      // Trailer frames can be empty — skip anything that is not JSON.
    }
  }

  return events;
};

interface StreamBlock {
  id?: string;
  text?: { content?: string };
  think?: { content?: string };
}

interface StreamEvent {
  op?: string;
  mask?: string;
  chat?: { id?: string; name?: string };
  message?: { id?: string; parentId?: string; role?: string; status?: string };
  block?: StreamBlock;
}

const accumulateBlock = (
  store: Map<string, string>,
  order: string[],
  blockId: string,
  content: string,
  isSet: boolean,
): void => {
  if (!store.has(blockId)) {
    order.push(blockId);
    store.set(blockId, content);
    return;
  }
  // `set` on a known block replaces its content; `append` extends it.
  store.set(blockId, isSet ? content : `${store.get(blockId) ?? ''}${content}`);
};

/**
 * Folds the Connect event stream into a final result. Kimi emits `set` to seed
 * a block and `append` to extend it, keyed by block id — concatenating in that
 * order reproduces exactly what the Kimi web UI renders.
 */
const foldChatStream = (events: Record<string, unknown>[]): KimiChatResult => {
  const textByBlock = new Map<string, string>();
  const thinkByBlock = new Map<string, string>();
  const textOrder: string[] = [];
  const thinkOrder: string[] = [];

  let conversationId = '';
  let assistantMessageId = '';
  let assistantParentId = '';

  for (const raw of events) {
    const event = raw as StreamEvent;

    if (event.chat?.id) conversationId = event.chat.id;

    if (event.message?.role === 'assistant' && event.message.id) {
      assistantMessageId = event.message.id;
      if (event.message.parentId) assistantParentId = event.message.parentId;
    }

    const mask = event.mask ?? '';
    const block = event.block;
    if (!block?.id) continue;

    if (mask.startsWith('block.text')) {
      const content = block.text?.content;
      if (typeof content === 'string') {
        accumulateBlock(textByBlock, textOrder, block.id, content, mask === 'block.text');
      }
    } else if (mask.startsWith('block.think')) {
      const content = block.think?.content;
      if (typeof content === 'string') {
        accumulateBlock(thinkByBlock, thinkOrder, block.id, content, mask === 'block.think');
      }
    }
  }

  return {
    conversationId,
    messageId: assistantMessageId,
    parentMessageId: assistantParentId,
    text: textOrder.map(id => textByBlock.get(id) ?? '').join(''),
    thinking: thinkOrder.map(id => thinkByBlock.get(id) ?? '').join(''),
  };
};

// --- Chat (send message / create conversation) ---

export interface ChatOptions {
  text: string;
  conversationId?: string;
  parentMessageId?: string;
  scenario?: string;
  kimiPlusId?: string;
  useSearch?: boolean;
  thinking?: boolean;
  reasoningEffort?: string;
}

const buildChatPayload = (options: ChatOptions): Record<string, unknown> => {
  const scenario = options.scenario ?? DEFAULT_SCENARIO;
  const tools = options.useSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [];

  return {
    chat_id: options.conversationId ?? '',
    scenario,
    kimiplus_id: options.kimiPlusId ?? '',
    tools,
    message: {
      parent_id: options.parentMessageId ?? '',
      role: 'user',
      blocks: [{ message_id: '', text: { content: options.text } }],
      scenario,
      is_goal: false,
    },
    options: {
      thinking: options.thinking ?? false,
      enable_plugin: false,
      reasoning_effort: options.reasoningEffort ?? 'REASONING_EFFORT_NONE',
    },
    project_id: '',
  };
};

interface ConnectStreamError {
  code?: string;
  message?: string;
}

/**
 * Connect streaming replies always carry HTTP 200 — failures arrive as an
 * end-of-stream frame holding an `error` object, so the status code alone
 * never reveals an expired token.
 */
const findStreamError = (events: Record<string, unknown>[]): ConnectStreamError | null => {
  for (const event of events) {
    const error = (event as { error?: ConnectStreamError }).error;
    if (error?.code) return error;
  }
  return null;
};

const streamErrorToToolError = (error: ConnectStreamError): ToolError => {
  const message = error.message ?? error.code ?? 'unknown error';
  if (error.code === 'unauthenticated' || error.code === 'permission_denied') {
    return ToolError.auth(`Kimi rejected the session (${message}) — please reload https://www.kimi.com and log in.`);
  }
  if (error.code === 'resource_exhausted') {
    return ToolError.rateLimited(`Kimi rate limited: ${message}`);
  }
  if (error.code === 'invalid_argument') {
    return ToolError.validation(`Kimi rejected the request: ${message}`);
  }
  return ToolError.internal(`Kimi chat failed (${error.code}): ${message}`);
};

/**
 * Sends a message through Kimi's streaming Chat RPC. Passing no conversationId
 * makes the gateway mint a new chat and return its id in the stream.
 */
export const chat = async (options: ChatOptions): Promise<KimiChatResult> => {
  const frame = encodeConnectFrame(buildChatPayload(options));

  const send = async (token: string): Promise<Record<string, unknown>[]> => {
    const response = await fetchFromPage(`${RPC_BASE}/kimi.gateway.chat.v1.ChatService/Chat`, {
      method: 'POST',
      headers: buildHeaders(token, 'application/connect+json'),
      body: frame as unknown as BodyInit,
      timeout: CHAT_TIMEOUT_MS,
    });
    return decodeConnectFrames(new Uint8Array(await response.arrayBuffer()));
  };

  let events = await send(requireAccessToken());
  let streamError = findStreamError(events);

  if (streamError?.code === 'unauthenticated') {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw streamErrorToToolError(streamError);
    events = await send(refreshed);
    streamError = findStreamError(events);
  }

  if (streamError) throw streamErrorToToolError(streamError);

  const result = foldChatStream(events);

  if (!result.conversationId && !result.text) {
    throw ToolError.internal('Kimi returned no chat content — the stream may have been interrupted.');
  }
  if (!result.conversationId && options.conversationId) {
    result.conversationId = options.conversationId;
  }

  return result;
};

// --- Account ---

interface GetCurrentUserResponse {
  user?: {
    id?: string;
    nickname?: string;
    avatar?: string;
    region?: string;
    phone?: { countryCode?: string; number?: string };
  };
}

export const getCurrentUser = async (): Promise<KimiUser> => {
  const data = await callRpc<GetCurrentUserResponse>('kimi.gateway.account.v1.UserService/GetCurrentUser', {});
  const user = data.user;
  if (!user?.id) throw ToolError.auth('Kimi did not return a user — please log in at https://www.kimi.com.');

  const phone = user.phone?.number ? `+${user.phone.countryCode ?? ''} ${user.phone.number}`.trim() : '';

  return {
    id: user.id,
    nickname: user.nickname ?? '',
    avatar: user.avatar ?? '',
    phone,
    region: user.region ?? '',
  };
};

// --- Models ---

interface AvailableModel {
  scenario?: string;
  key?: string;
  displayName?: string;
  description?: string;
  kimiPlusId?: string;
}

interface GetAvailableModelsResponse {
  availableModels?: AvailableModel[];
  /** Wrapped in an object by the gateway, e.g. `{ "scenario": "SCENARIO_K2D5" }`. */
  defaultScenario?: { scenario?: string };
}

export const getModels = async (): Promise<KimiModel[]> => {
  const data = await callRpc<GetAvailableModelsResponse>('kimi.gateway.config.v1.ConfigService/GetAvailableModels', {});
  const defaultScenario = data.defaultScenario?.scenario ?? '';
  let defaultAssigned = false;

  return (data.availableModels ?? []).map(model => {
    const isDefault = !defaultAssigned && model.scenario === defaultScenario;
    if (isDefault) defaultAssigned = true;
    return {
      id: model.key ?? '',
      displayName: model.displayName ?? '',
      description: model.description ?? '',
      scenario: model.scenario ?? '',
      kimiPlusId: model.kimiPlusId ?? '',
      isDefault,
    };
  });
};

/** Resolves a model id (e.g. "k3") to the scenario/kimiPlus pair the Chat RPC expects. */
export const resolveModel = async (
  modelId: string | undefined,
): Promise<{ scenario?: string; kimiPlusId?: string }> => {
  if (!modelId) return {};
  const models = await getModels();
  const match = models.find(model => model.id === modelId) ?? models.find(model => model.scenario === modelId);
  if (!match) {
    throw ToolError.validation(
      `Unknown Kimi model "${modelId}". Call list_models for valid ids (${models.map(m => m.id).join(', ')}).`,
    );
  }
  return { scenario: match.scenario, kimiPlusId: match.kimiPlusId };
};

// --- Conversations ---

interface FeedItem {
  type?: string;
  chat?: { id?: string; name?: string; projectId?: string };
}

interface ListFeedsResponse {
  items?: FeedItem[];
  nextPageToken?: string;
}

export const conversationUrl = (conversationId: string): string => `${API_ORIGIN}/chat/${conversationId}`;

/**
 * Lists chats from the feed service — the same source the Kimi sidebar renders,
 * paging until `limit` is satisfied or the server runs out of items.
 */
export const listConversations = async (limit: number): Promise<KimiConversation[]> => {
  const conversations: KimiConversation[] = [];
  let pageToken: string | undefined;

  while (conversations.length < limit) {
    const pageSize = Math.min(100, limit - conversations.length);
    const body: Record<string, unknown> = { pageSize };
    if (pageToken) body.pageToken = pageToken;

    const data = await callRpc<ListFeedsResponse>('kimi.gateway.feed.v1.FeedService/ListFeeds', body);
    const items = data.items ?? [];

    for (const item of items) {
      if (item.type !== 'FEED_TYPE_CHAT' || !item.chat?.id) continue;
      conversations.push({
        id: item.chat.id,
        title: item.chat.name ?? '',
        url: conversationUrl(item.chat.id),
        projectId: item.chat.projectId ?? '',
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken || items.length === 0) break;
  }

  return conversations.slice(0, limit);
};

// --- Conversation detail ---

interface MessageBlock {
  id?: string;
  text?: { content?: string };
  think?: { content?: string };
}

interface ChatMessage {
  id?: string;
  parentId?: string;
  role?: string;
  status?: string;
  blocks?: MessageBlock[];
}

interface ListMessagesResponse {
  messages?: ChatMessage[];
  nextPageToken?: string;
}

interface GetChatResponse {
  chat?: { id?: string; name?: string };
}

export const getConversationTitle = async (conversationId: string): Promise<string> => {
  const data = await callRpc<GetChatResponse>('kimi.gateway.chat.v1.ChatService/GetChat', {
    chatId: conversationId,
  });
  return data.chat?.name ?? '';
};

const blockText = (message: ChatMessage): string =>
  (message.blocks ?? [])
    .map(block => block.text?.content ?? '')
    .filter(content => content.length > 0)
    .join('');

const blockThinking = (message: ChatMessage): string =>
  (message.blocks ?? [])
    .map(block => block.think?.content ?? '')
    .filter(content => content.length > 0)
    .join('');

export interface KimiConversationPage {
  turns: KimiTurn[];
  lastMessageId: string;
  nextCursor: string | null;
  pagesFetched: number;
  truncated: boolean;
}

const pairMessagesIntoTurns = (messages: ChatMessage[]): { turns: KimiTurn[]; lastMessageId: string } => {
  const turns: KimiTurn[] = [];
  let lastMessageId = '';

  for (const message of messages) {
    if (message.id) lastMessageId = message.id;

    if (message.role === 'user') {
      turns.push({ prompt: blockText(message), response: '', thinking: '' });
      continue;
    }
    if (message.role !== 'assistant') continue;

    const previous = turns[turns.length - 1];
    const text = blockText(message);
    const thinking = blockThinking(message);
    if (previous && previous.response === '') {
      previous.response = text;
      previous.thinking = thinking;
    } else {
      turns.push({ prompt: '', response: text, thinking });
    }
  }

  return { turns, lastMessageId };
};

/**
 * Reads a conversation's turns, walking `pageToken` across as many
 * `ListMessages` calls as `fetchAll` requires. `ListMessages` returns
 * newest-first, both within a page and across pages — a page's `nextPageToken`
 * points strictly further back in time — so raw messages are concatenated in
 * fetch order (still newest-first) and reversed exactly once at the end,
 * never per page, before prompts are paired with the reply that follows them.
 * Pairing only after the full requested set is assembled means a page
 * boundary can never split a user prompt from its reply into two turns.
 */
export const getConversationTurns = async (
  conversationId: string,
  limit: number,
  cursor: string | undefined,
  fetchAll: boolean,
  maxItems: number,
): Promise<KimiConversationPage> => {
  const newestFirst: ChatMessage[] = [];
  let pageToken = cursor;
  let pagesFetched = 0;
  let truncated = false;

  for (;;) {
    const body: Record<string, unknown> = { chatId: conversationId, pageSize: limit };
    if (pageToken) body.pageToken = pageToken;

    const data = await callRpc<ListMessagesResponse>('kimi.gateway.chat.v1.ChatService/ListMessages', body);
    pagesFetched += 1;
    newestFirst.push(...(data.messages ?? []));
    pageToken = data.nextPageToken;

    if (!fetchAll || !pageToken) break;
    if (newestFirst.length >= maxItems) {
      truncated = true;
      break;
    }
  }

  const { turns, lastMessageId } = pairMessagesIntoTurns(newestFirst.slice().reverse());

  return { turns, lastMessageId, nextCursor: pageToken ?? null, pagesFetched, truncated };
};

/**
 * Returns the id of the newest message in a chat. The Chat RPC threads replies
 * by parent id, so a follow-up must point at the current tip of the thread.
 */
export const getLatestMessageId = async (conversationId: string): Promise<string> => {
  const data = await callRpc<ListMessagesResponse>('kimi.gateway.chat.v1.ChatService/ListMessages', {
    chatId: conversationId,
    pageSize: 1,
  });
  return data.messages?.[0]?.id ?? '';
};

/** Reads the chat id out of a /chat/<id> URL, or null when no chat is open. */
export const getCurrentConversationId = (): string | null => {
  const match = window.location.pathname.match(/^\/chat\/([0-9a-fA-F-]+)/);
  return match?.[1] ?? null;
};

export const navigateToConversation = (conversationId: string): void => {
  window.location.href = conversationUrl(conversationId);
};
