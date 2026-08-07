import { ToolError, fetchFromPage, getCookie, sleep, waitUntil } from '@opentabs-dev/plugin-sdk';

// --- Constants ---

const ORIGIN = 'https://grok.com';
const REST_BASE = `${ORIGIN}/rest`;

/**
 * Cookie the Grok web app stores the signed-in account id in. The session
 * itself lives in the httpOnly `sso` / `sso-rw` cookies, which JavaScript
 * cannot read — this one is the readable marker that a session exists, and it
 * also supplies the `uid` the chat gateway's URL requires.
 */
const USER_ID_COOKIE = 'x-userid';

const REQUEST_TIMEOUT_MS = 30_000;
/** Hard ceiling on one completion. Expert/Heavy answers can run for minutes. */
const COMPLETION_TIMEOUT_MS = 600_000;
/**
 * A Cloudflare or anti-bot challenge on the gateway shows up as a socket that
 * opens and then goes silent rather than as a clean failure, so the stream is
 * abandoned when no event arrives for this long.
 */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Channel the answer text streams on. */
const CHANNEL_RESPONSE = 'CHANNEL_ASSISTANT_RESPONSE';
/**
 * Channel carrying Grok's reasoning trace. Each frame is a complete phrase
 * ("Searching for …"), not a token, so frames are joined with newlines.
 */
const CHANNEL_NOTETAKER_HEADER = 'CHANNEL_ASSISTANT_NOTETAKER_HEADER';

/** Mode ids the picker offers that map onto the `thinking` boolean. */
const MODE_REASONING = 'expert';
const MODE_NON_REASONING = 'fast';

/** How hard to chase a new conversation's server-generated title before giving up. */
const TITLE_POLL_ATTEMPTS = 3;
const TITLE_POLL_INTERVAL_MS = 800;

/** Grok caps the conversation list endpoint at 60 rows per request. */
const CONVERSATION_PAGE_SIZE = 60;
/** `load-responses` is a POST with an id list; keep batches modest. */
const LOAD_RESPONSES_BATCH = 25;

// --- Types ---

export interface GrokUser {
  id: string;
  email: string;
  name: string;
  username: string;
  subscriptionTier: string;
  createdAt: string;
}

export interface GrokModel {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  isAvailable: boolean;
  requiresSubscriptionTier: string;
  badge: string;
}

export interface GrokConversation {
  id: string;
  title: string;
  url: string;
  starred: boolean;
  temporary: boolean;
  workspaceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GrokSearchResult {
  title: string;
  url: string;
  snippet: string;
  siteName: string;
  citeIndex: number;
}

export interface GrokTurn {
  prompt: string;
  response: string;
  thinking: string;
  searchResults: GrokSearchResult[];
  responseId: string;
  modelId: string;
}

export interface GrokChatResult {
  conversationId: string;
  responseId: string;
  parentResponseId: string;
  text: string;
  thinking: string;
  searchResults: GrokSearchResult[];
  title: string;
  modelId: string;
}

// --- Auth ---

const readUserId = (): string | null => {
  const value = getCookie(USER_ID_COOKIE);
  return value && value.length > 0 ? value : null;
};

/** True when the browser holds a Grok session cookie — i.e. the user is logged in. */
export const isAuthenticated = (): boolean => readUserId() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

const requireUserId = (): string => {
  const userId = readUserId();
  if (!userId) {
    throw ToolError.auth('Not authenticated — please log in to Grok at https://grok.com.');
  }
  return userId;
};

// --- REST plumbing ---

/**
 * Calls one of Grok's `/rest/*` endpoints. Authentication rides entirely on the
 * httpOnly session cookies, so `credentials: 'include'` is the whole mechanism;
 * no bearer token is involved. The request is issued by the page itself, which
 * keeps it same-origin and lets Cloudflare's `cf_clearance` cookie apply.
 */
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

const getRest = <T>(path: string): Promise<T> => callRest<T>(path, { method: 'GET' });

const postRest = <T>(path: string, body: unknown): Promise<T> =>
  callRest<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// --- Account ---

interface RawUser {
  userId?: string;
  email?: string;
  givenName?: string;
  familyName?: string;
  xUsername?: string;
  xSubscriptionType?: string;
  createTime?: string;
}

export const getCurrentUser = async (): Promise<GrokUser> => {
  const user = await getRest<RawUser>('/auth/get-user');
  if (!user.userId) {
    throw ToolError.auth('Grok did not return an account — please log in at https://grok.com.');
  }
  return {
    id: user.userId,
    email: user.email ?? '',
    name: [user.givenName, user.familyName].filter(Boolean).join(' '),
    username: user.xUsername ?? '',
    subscriptionTier: user.xSubscriptionType ?? '',
    createdAt: user.createTime ?? '',
  };
};

// --- Models (Grok calls them "modes") ---

interface RawMode {
  id?: string;
  title?: string;
  description?: string;
  badgeText?: string;
  availability?: {
    available?: Record<string, never>;
    requiresUpgrade?: { message?: string; minimumSubscriptionTier?: string };
  };
}

interface RawModes {
  modes?: RawMode[];
  defaultModeId?: string;
}

const mapMode = (mode: RawMode, defaultModeId: string): GrokModel => ({
  id: mode.id ?? '',
  displayName: mode.title ?? '',
  description: mode.description ?? '',
  isDefault: mode.id === defaultModeId,
  isAvailable: mode.availability?.available !== undefined,
  requiresSubscriptionTier: mode.availability?.requiresUpgrade?.minimumSubscriptionTier ?? '',
  badge: (mode.badgeText ?? '').trim(),
});

/**
 * Lists the entries Grok's own model picker shows. Grok models the picker as
 * "modes" (Fast / Expert / Heavy / …) rather than model ids, and reasoning is
 * a property of the mode rather than a per-message flag, so `list_models`
 * returns the modes verbatim instead of inventing ids.
 */
export const getModels = async (): Promise<GrokModel[]> => {
  const payload = await postRest<RawModes>('/modes', { locale: 'en' });
  const models = (payload.modes ?? [])
    .filter(mode => typeof mode.id === 'string' && mode.id.length > 0)
    .map(mode => mapMode(mode, payload.defaultModeId ?? ''));
  if (models.length === 0) {
    throw ToolError.internal('Grok returned no models — reload https://grok.com and try again.');
  }
  return models;
};

/**
 * Picks the mode a message runs under. An explicit id always wins. Otherwise
 * `thinking` chooses between Grok's reasoning mode (Expert) and its fast one,
 * and omitting it leaves the account's default mode in place.
 */
export const resolveModelId = async (modelId: string | undefined, thinking: boolean | undefined): Promise<string> => {
  const models = await getModels();
  const fallback = models.find(model => model.isDefault) ?? models[0];
  if (!fallback) throw ToolError.internal('Grok returned no models.');

  if (modelId) {
    const match = models.find(model => model.id === modelId);
    if (!match) {
      throw ToolError.validation(
        `Unknown Grok model "${modelId}". Call list_models for valid ids (${models.map(m => m.id).join(', ')}).`,
      );
    }
    return match.id;
  }

  if (thinking === true) return models.find(m => m.id === MODE_REASONING)?.id ?? fallback.id;
  if (thinking === false) return models.find(m => m.id === MODE_NON_REASONING)?.id ?? fallback.id;
  return fallback.id;
};

// --- Conversations ---

export const conversationUrl = (conversationId: string): string => `${ORIGIN}/c/${conversationId}`;

interface RawConversation {
  conversationId?: string;
  title?: string;
  starred?: boolean;
  temporary?: boolean;
  createTime?: string;
  modifyTime?: string;
  workspaces?: { workspaceId?: string }[] | string[];
}

interface RawConversationList {
  conversations?: RawConversation[];
  nextPageToken?: string;
}

const mapConversation = (conversation: RawConversation): GrokConversation => ({
  id: conversation.conversationId ?? '',
  title: conversation.title ?? '',
  url: conversationUrl(conversation.conversationId ?? ''),
  starred: conversation.starred === true,
  temporary: conversation.temporary === true,
  workspaceIds: (conversation.workspaces ?? []).map(workspace =>
    typeof workspace === 'string' ? workspace : (workspace.workspaceId ?? ''),
  ),
  createdAt: conversation.createTime ?? '',
  updatedAt: conversation.modifyTime ?? '',
});

/**
 * Lists chats newest-first, matching the sidebar's History order. Chats filed
 * under a project are deliberately kept (the sidebar hides them behind
 * Projects) with their `workspaces` exposed, so nothing silently disappears.
 */
export const listConversations = async (limit: number): Promise<GrokConversation[]> => {
  const conversations: GrokConversation[] = [];
  const seen = new Set<string>();
  let pageToken = '';

  while (conversations.length < limit) {
    const query = new URLSearchParams({ pageSize: String(Math.min(limit, CONVERSATION_PAGE_SIZE)) });
    if (pageToken) query.set('pageToken', pageToken);

    const page = await getRest<RawConversationList>(`/app-chat/conversations?${query.toString()}`);
    const rows = page.conversations ?? [];
    if (rows.length === 0) break;

    let added = 0;
    for (const row of rows) {
      if (!row.conversationId || seen.has(row.conversationId)) continue;
      seen.add(row.conversationId);
      conversations.push(mapConversation(row));
      added++;
    }
    // The cursor is the id of the last row, so a page that adds nothing new
    // means the list has been walked to the end.
    if (added === 0 || !page.nextPageToken || page.nextPageToken === pageToken) break;
    pageToken = page.nextPageToken;
  }

  return conversations.slice(0, limit);
};

// --- Conversation detail ---

interface RawResponseNode {
  responseId?: string;
  sender?: string;
  parentResponseId?: string;
}

interface RawWebSearchResult {
  url?: string;
  title?: string;
  preview?: string;
  snippet?: string;
  siteName?: string;
  citeIndex?: number;
}

interface RawStep {
  text?: string[];
  tags?: string[];
  webSearchResults?: RawWebSearchResult[];
}

interface RawResponse {
  responseId?: string;
  message?: string;
  sender?: string;
  parentResponseId?: string;
  createTime?: string;
  webSearchResults?: RawWebSearchResult[];
  citedWebSearchResults?: RawWebSearchResult[];
  steps?: RawStep[];
  model?: string;
  requestMetadata?: { model?: string; effort?: string };
}

const mapSearchResult = (result: RawWebSearchResult, index: number): GrokSearchResult => {
  let siteName = result.siteName ?? '';
  if (!siteName && result.url) {
    try {
      siteName = new URL(result.url).hostname;
    } catch {
      // A malformed URL just leaves the site name empty.
    }
  }
  return {
    title: result.title ?? '',
    url: result.url ?? '',
    snippet: result.snippet ?? result.preview ?? '',
    siteName,
    citeIndex: result.citeIndex ?? index,
  };
};

const dedupeSearchResults = (results: RawWebSearchResult[]): GrokSearchResult[] => {
  const seen = new Set<string>();
  return results
    .filter(result => {
      const url = result?.url;
      if (typeof url !== 'string' || url.length === 0 || seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .map(mapSearchResult);
};

/**
 * Reads the reasoning trace off a stored response. Grok records it as `steps`,
 * where the entries tagged "header" are the phrases the UI shows while it
 * thinks; other steps carry tool chatter that is not useful as prose.
 */
const readStoredThinking = (response: RawResponse): string =>
  (response.steps ?? [])
    .filter(step => (step.tags ?? []).includes('header'))
    .flatMap(step => step.text ?? [])
    .filter(text => text.length > 0)
    .join('\n');

const readStoredSearchResults = (response: RawResponse): GrokSearchResult[] =>
  dedupeSearchResults([
    ...(response.citedWebSearchResults ?? []),
    ...(response.webSearchResults ?? []),
    ...(response.steps ?? []).flatMap(step => step.webSearchResults ?? []),
  ]);

const getResponseNodes = (conversationId: string): Promise<{ responseNodes?: RawResponseNode[] }> =>
  getRest(`/app-chat/conversations/${encodeURIComponent(conversationId)}/response-node`);

const loadResponses = async (conversationId: string, responseIds: string[]): Promise<RawResponse[]> => {
  const responses: RawResponse[] = [];
  for (let offset = 0; offset < responseIds.length; offset += LOAD_RESPONSES_BATCH) {
    const batch = responseIds.slice(offset, offset + LOAD_RESPONSES_BATCH);
    const payload = await postRest<{ responses?: RawResponse[] }>(
      `/app-chat/conversations/${encodeURIComponent(conversationId)}/load-responses`,
      { responseIds: batch },
    );
    responses.push(...(payload.responses ?? []));
  }
  return responses;
};

/**
 * Walks back from the newest node through `parentResponseId`. Grok stores
 * messages as a tree — regenerating an answer forks it — so following the
 * parent chain yields exactly the branch the site renders and leaves abandoned
 * forks out.
 */
const currentBranch = (nodes: RawResponseNode[]): RawResponseNode[] => {
  const byId = new Map(nodes.filter(node => node.responseId).map(node => [node.responseId as string, node]));
  const tip = nodes[nodes.length - 1];
  if (!tip?.responseId) return nodes;

  const branch: RawResponseNode[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined = tip.responseId;

  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    branch.unshift(node);
    cursor = node.parentResponseId;
  }

  return branch.length > 0 ? branch : nodes;
};

/** Returns the id a follow-up message must thread onto, or null for an empty chat. */
export const getTipResponseId = async (conversationId: string): Promise<string | null> => {
  const { responseNodes } = await getResponseNodes(conversationId);
  const branch = currentBranch(responseNodes ?? []);
  return branch[branch.length - 1]?.responseId ?? null;
};

export const getConversationTitle = async (conversationId: string): Promise<string> => {
  const payload = await getRest<{ conversation?: RawConversation }>(
    `/app-chat/conversations_v2/${encodeURIComponent(conversationId)}?includeWorkspaces=true&includeTaskResult=true`,
  );
  return payload.conversation?.title ?? '';
};

export const getConversation = async (
  conversationId: string,
  limit: number,
): Promise<{ title: string; turns: GrokTurn[] }> => {
  const { responseNodes } = await getResponseNodes(conversationId);
  const branch = currentBranch(responseNodes ?? []);
  const ids = branch.map(node => node.responseId).filter((id): id is string => typeof id === 'string');

  const [title, responses] = await Promise.all([
    getConversationTitle(conversationId),
    ids.length > 0 ? loadResponses(conversationId, ids) : Promise.resolve([]),
  ]);

  // `load-responses` does not guarantee the request order back, so the branch
  // order from the node tree is what the turns are rebuilt from.
  const byId = new Map(responses.filter(r => r.responseId).map(r => [r.responseId as string, r]));
  const turns: GrokTurn[] = [];

  for (const id of ids) {
    const response = byId.get(id);
    if (!response) continue;

    if (response.sender === 'human') {
      turns.push({
        prompt: response.message ?? '',
        response: '',
        thinking: '',
        searchResults: [],
        responseId: id,
        modelId: '',
      });
      continue;
    }

    const previous = turns[turns.length - 1];
    const filled = {
      response: response.message ?? '',
      thinking: readStoredThinking(response),
      searchResults: readStoredSearchResults(response),
      responseId: id,
      modelId: response.requestMetadata?.model ?? response.model ?? '',
    };

    if (previous && previous.response === '') {
      Object.assign(previous, filled);
    } else {
      turns.push({ prompt: '', ...filled });
    }
  }

  return { title, turns: turns.slice(-limit) };
};

// --- Chat gateway (WebSocket) ---

interface GatewayTextChunk {
  text?: string;
  channel?: string;
}

interface GatewayToolResult {
  web_search?: { webpages?: RawWebSearchResult[] };
}

interface GatewayChunk {
  text?: GatewayTextChunk;
  tool_result?: GatewayToolResult;
}

interface GatewayStreamError {
  kind?: string;
  message?: string;
  severity?: string;
  details?: { reason?: string };
}

interface GatewayEvent {
  type?: string;
  event_id?: string;
  conversation?: { id?: string };
  mode?: string;
  response?: { id?: string; status?: string; status_details?: { reason?: string } };
  item?: { id?: string };
  chunk?: GatewayChunk;
  output?: { stream_error?: GatewayStreamError };
  title?: string;
  error?: unknown;
  message?: string;
}

interface GatewayFrame {
  session_id?: string;
  event?: GatewayEvent;
}

export interface ChatOptions {
  text: string;
  conversationId?: string;
  parentResponseId?: string | null;
  modelId: string;
  search?: boolean;
}

/**
 * Describes an in-stream failure. Grok's gateway acknowledges a request and
 * only then reports rejections — an entitlement problem or an anti-bot block
 * arrives as a `stream_error` frame on an otherwise healthy socket, so the
 * absence of a transport error means nothing on its own.
 */
const describeStreamError = (error: GatewayStreamError): string => {
  const reason = error.details?.reason;
  const base = error.message ?? error.kind ?? 'unknown error';
  return reason ? `${base} (${error.kind ?? 'error'}: ${reason})` : base;
};

/** Tool overrides Grok accepts on the session; used to ask it not to search. */
const buildToolOverrides = (search: boolean | undefined): Record<string, boolean> | undefined => {
  if (search === undefined) return undefined;
  return { web_search: search, browse_page: search, x_search: search, x_semantic_search: search };
};

/**
 * Sends one message and resolves once Grok has finished and persisted the
 * reply. The gateway is a same-origin WebSocket, so the browser attaches the
 * session cookies during the handshake and no extra credential is needed.
 *
 * The protocol is `session.create` → `conversation.attached` →
 * `conversation.item.create` → `response.create`, then a run of
 * `response.chunk` frames, ending at `response.persisted`.
 */
export const chat = (options: ChatOptions): Promise<GrokChatResult> => {
  const userId = requireUserId();
  const toolOverrides = buildToolOverrides(options.search);

  return new Promise<GrokChatResult>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${ORIGIN.replace('https://', 'wss://')}/ws/mgw/?uid=${encodeURIComponent(userId)}`);
    } catch (error) {
      reject(ToolError.internal(`Could not open Grok's chat gateway: ${String(error)}`));
      return;
    }

    let sessionId = options.conversationId ?? '';
    let conversationId = options.conversationId ?? '';
    let responseId = '';
    let parentResponseId = options.parentResponseId ?? '';
    let title = '';
    let answer = '';
    const thinkingLines: string[] = [];
    const otherChannels: string[] = [];
    const searchResults: RawWebSearchResult[] = [];
    let settled = false;

    const close = () => {
      try {
        socket.close();
      } catch {
        // The socket may already be closing; nothing to recover from.
      }
    };

    const fail = (error: ToolError) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      clearTimeout(idleTimer);
      close();
      reject(error);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      clearTimeout(idleTimer);
      close();
      resolve({
        conversationId,
        responseId,
        parentResponseId,
        text: answer,
        thinking: [...thinkingLines, ...otherChannels].join('\n').trim(),
        searchResults: dedupeSearchResults(searchResults),
        title,
        modelId: options.modelId,
      });
    };

    const overallTimer = setTimeout(
      () => fail(ToolError.timeout(`Grok did not finish within ${COMPLETION_TIMEOUT_MS / 1000}s.`)),
      COMPLETION_TIMEOUT_MS,
    );

    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () =>
          fail(
            ToolError.timeout(
              'Grok stopped sending events — the request was most likely blocked by an anti-bot challenge. Open https://grok.com in the browser and retry.',
            ),
          ),
        STREAM_IDLE_TIMEOUT_MS,
      );
    };
    resetIdle();

    const send = (event: Record<string, unknown>) => {
      const frame: Record<string, unknown> = { event };
      if (sessionId) frame.session_id = sessionId;
      socket.send(JSON.stringify(frame));
    };

    socket.onopen = () => {
      const xGrok: Record<string, unknown> = {
        protocol_capabilities: ['conversation_attached', 'custom_methods_v1'],
        use_chunk: true,
        enable_side_by_side: false,
        force_side_by_side: false,
        enable_image_generation: false,
        image_generation_count: 1,
        disable_text_follow_ups: true,
        disable_artifact: true,
        force_concise: false,
      };
      if (options.conversationId) {
        xGrok.conversation_id = options.conversationId;
        xGrok.load_existing = true;
      }
      if (toolOverrides) xGrok.tool_overrides = toolOverrides;

      send({
        type: 'session.create',
        event_id: `evt_init_${crypto.randomUUID()}`,
        session: { model: options.modelId, x_grok: xGrok },
      });
    };

    socket.onerror = () => fail(ToolError.internal("Grok's chat gateway reported a socket error."));

    socket.onclose = event => {
      if (settled) return;
      // Reaching here means the socket ended before `response.persisted`.
      fail(
        ToolError.internal(
          `Grok's chat gateway closed before the reply finished (code ${event.code}${event.reason ? `: ${event.reason}` : ''}).`,
        ),
      );
    };

    socket.onmessage = message => {
      resetIdle();

      let frame: GatewayFrame;
      try {
        frame = JSON.parse(String(message.data)) as GatewayFrame;
      } catch {
        return;
      }
      const event = frame.event;
      if (!event) return;
      if (frame.session_id && !sessionId) sessionId = frame.session_id;

      switch (event.type) {
        case 'conversation.attached': {
          conversationId = event.conversation?.id ?? conversationId ?? sessionId;
          const item: Record<string, unknown> = {
            type: 'message',
            role: 'user',
            x_grok: {
              client_message_id: crypto.randomUUID(),
              input_chunks: [{ text: { text: options.text } }],
              ...(toolOverrides ? { tool_overrides: toolOverrides } : {}),
            },
          };
          const itemEvent: Record<string, unknown> = {
            type: 'conversation.item.create',
            event_id: `evt_msg_${Date.now()}`,
            item,
          };
          if (parentResponseId) itemEvent.parent_response_id = parentResponseId;
          send(itemEvent);
          send({ type: 'response.create', event_id: `evt_resp_${Date.now()}` });
          return;
        }

        case 'conversation.item.added':
          // The gateway files the outgoing message under a fresh id and hangs
          // the assistant reply off it. That id — not the branch tip the
          // request was threaded onto — is the reply's actual parent.
          parentResponseId = event.item?.id ?? parentResponseId;
          return;

        case 'response.created':
          responseId = event.response?.id ?? responseId;
          return;

        case 'response.chunk': {
          const chunk = event.chunk ?? {};
          const textChunk = chunk.text;
          if (textChunk?.text) {
            if (textChunk.channel === CHANNEL_RESPONSE) answer += textChunk.text;
            else if (textChunk.channel === CHANNEL_NOTETAKER_HEADER) thinkingLines.push(textChunk.text);
            else otherChannels.push(textChunk.text);
          }
          const webpages = chunk.tool_result?.web_search?.webpages;
          if (Array.isArray(webpages)) searchResults.push(...webpages);
          return;
        }

        case 'conversation.title.updated':
          title = event.title ?? title;
          return;

        case 'response.grok.output': {
          const streamError = event.output?.stream_error;
          if (streamError) {
            fail(ToolError.internal(`Grok refused the request: ${describeStreamError(streamError)}`));
          }
          return;
        }

        case 'response.done':
          if (event.response?.status === 'failed') {
            fail(ToolError.internal(`Grok's reply failed: ${event.response.status_details?.reason ?? 'unknown'}`));
          }
          return;

        case 'response.persisted':
          succeed();
          return;

        case 'error':
          fail(ToolError.internal(`Grok's chat gateway returned an error: ${event.message ?? JSON.stringify(event)}`));
          return;

        default:
          return;
      }
    };
  });
};

/**
 * Runs a chat turn and backfills the pieces the stream does not carry: a new
 * conversation's title only exists after Grok generates it, and cited sources
 * are attached to the stored response rather than to the streamed chunks.
 */
export const chatAndEnrich = async (options: ChatOptions): Promise<GrokChatResult> => {
  const result = await chat(options);

  if (!result.text && !result.thinking) {
    throw ToolError.internal('Grok returned no content — the stream may have been interrupted.');
  }

  // Grok names a new conversation asynchronously, and the `title.updated`
  // event often lands after the reply is already persisted. Poll briefly so
  // the caller usually gets the real title rather than an empty string.
  for (let attempt = 0; attempt < TITLE_POLL_ATTEMPTS && !result.title && result.conversationId; attempt++) {
    if (attempt > 0) await sleep(TITLE_POLL_INTERVAL_MS);
    result.title = await getConversationTitle(result.conversationId).catch(() => '');
  }

  if (result.searchResults.length === 0 && result.conversationId && result.responseId) {
    const stored = await loadResponses(result.conversationId, [result.responseId]).catch(() => []);
    const response = stored[0];
    if (response) {
      result.searchResults = readStoredSearchResults(response);
      if (!result.thinking) result.thinking = readStoredThinking(response);
    }
  }

  return result;
};

// --- Page state ---

/** Reads the chat id out of a /c/<uuid> URL, or null when none is open. */
export const getCurrentConversationId = (): string | null => {
  const match = window.location.pathname.match(/\/c\/([0-9a-fA-F-]{36})/);
  return match?.[1] ?? null;
};
