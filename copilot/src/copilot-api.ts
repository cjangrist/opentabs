import { ToolError, fetchFromPage, findLocalStorageEntry, sleep, waitUntil } from '@opentabs-dev/plugin-sdk';

// --- Constants ---

const ORIGIN = 'https://copilot.microsoft.com';
const API_BASE = `${ORIGIN}/c/api`;
const CHAT_SOCKET_URL = `${ORIGIN.replace('https://', 'wss://')}/c/api/chat?api-version=2`;

/**
 * Copilot authenticates its own API with an MSAL bearer token rather than with
 * cookies. MSAL caches it in localStorage under a pipe-delimited key whose last
 * segment is the scope; this is the scope the chat API is issued for.
 */
const CHAT_SCOPE = '140e65af-45d1-4427-bf08-3e7295db6836/chatai.readwrite';
const ACCESS_TOKEN_MARKER = 'accesstoken';

/**
 * Treat a token that is about to expire as already expired, so a long request
 * does not start on a credential that dies mid-flight.
 */
const TOKEN_EXPIRY_SKEW_SECONDS = 60;

const REQUEST_TIMEOUT_MS = 30_000;
/** Hard ceiling on one completion. Think Deeper answers can run for minutes. */
const COMPLETION_TIMEOUT_MS = 600_000;
/**
 * The gateway accepts the socket before it validates anything, so a rejected
 * request can look like a socket that opens and then goes quiet. Abandon the
 * stream when nothing arrives for this long.
 */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Copilot serves both list endpoints 20 rows at a time. */
const PAGE_SIZE_HINT = 20;
/** Stops a cursor that never advances from looping forever. */
const MAX_PAGES = 25;

/** Conversation types the sidebar's history list is built from. */
const CONVERSATION_TYPES = 'chat,character,xbox,group';

/**
 * Copilot has no models endpoint — the composer's picker is client-side. These
 * are the four entries it renders, with the ids Copilot puts on the wire (the
 * `mode` field of the `send` frame, which is also stored on every message) and
 * the labels and descriptions the picker itself shows.
 */
const MODE_SMART = 'smart';
const MODE_REASONING = 'reasoning';
const MODE_SEARCH = 'search';

const MODES: CopilotModel[] = [
  {
    id: MODE_SMART,
    displayName: 'Smart',
    description: 'Thinks deeply or quickly based on the task',
    isDefault: true,
  },
  {
    id: MODE_REASONING,
    displayName: 'Think deeper',
    description: 'Better for more complex topics',
    isDefault: false,
  },
  {
    id: 'study',
    displayName: 'Study and learn',
    description: 'Quizzes, guided learning, and more',
    isDefault: false,
  },
  {
    id: MODE_SEARCH,
    displayName: 'Search',
    description: 'Answers with enhanced references',
    isDefault: false,
  },
];

/**
 * The capability handshake the Copilot web app opens every chat socket with.
 * It is replayed verbatim on purpose: the gateway tailors the response to the
 * declared capabilities, and a trimmed list makes it emit an answer with no
 * content at all rather than falling back to plain text.
 */
const SET_OPTIONS_FRAME = {
  event: 'setOptions',
  supportedFeatures: [
    'partial-generated-images',
    'composer-prefill-conversation-action',
    'composer-send-conversation-action-v2',
    'side-by-side-comparison',
    'session-duration-nudge',
    'compose-email-html',
  ],
  supportedCards: [
    'weather',
    'local',
    'image',
    'sports',
    'video',
    'healthcareEntity',
    'healthcareInfo',
    'healthRecordsConnectNewProvider',
    'healthRecordsUpdate',
    'suggestHealth',
    'chart',
    'safetyHelpline',
    'quiz',
    'finance',
    'recipe',
    'personalArtifacts',
    'flashcard',
    'navigation',
    'person',
    'powerPointCreator',
    'consentV2',
    'composeEmail',
    'createCalendarEvent',
    'modifyCalendarEvent',
    'deleteCalendarEvent',
    'practiceTest',
    'tapToReveal',
    'elicitation',
  ],
  supportedUIComponents: {
    Badge: '1.2',
    Basic: '1.2',
    Box: '1.2',
    Button: '1.2',
    Card: '1.2',
    Caption: '1.2',
    Chart: '1.2',
    Checkbox: '1.2',
    Col: '1.2',
    DatePicker: '1.3',
    Divider: '1.2',
    Form: '1.2',
    Icon: '1.2',
    Image: '1.2',
    Label: '1.2',
    ListView: '1.2',
    ListViewItem: '1.2',
    Map: '1.3',
    Markdown: '1.2',
    Pressable: '1.3',
    RadioGroup: '1.3',
    Row: '1.2',
    Select: '1.3',
    Spacer: '1.2',
    Table: '1.3',
    'Table.Cell': '1.3',
    'Table.Row': '1.3',
    Text: '1.2',
    Textarea: '1.3',
    Title: '1.2',
    Transition: '1.2',
  },
  ads: null,
  supportedActions: [],
};

// --- Types ---

export interface CopilotUser {
  id: string;
  firstName: string;
  preferredName: string;
  accountTier: string;
  isPro: boolean;
  regionCode: string;
  subscriptions: string[];
}

export interface CopilotModel {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export interface CopilotConversation {
  id: string;
  title: string;
  url: string;
  type: string;
  pinned: boolean;
  updatedAt: string;
}

export interface CopilotSearchResult {
  title: string;
  url: string;
  snippet: string;
  siteName: string;
  citeIndex: number;
}

export interface CopilotTurn {
  prompt: string;
  response: string;
  thinking: string;
  searchResults: CopilotSearchResult[];
  messageId: string;
  modelId: string;
  createdAt: string;
}

export interface CopilotChatResult {
  conversationId: string;
  messageId: string;
  parentMessageId: string;
  text: string;
  thinking: string;
  searchResults: CopilotSearchResult[];
  title: string;
  modelId: string;
}

// --- Auth ---

interface CachedToken {
  secret?: string;
  expiresOn?: string;
}

/**
 * Reads the bearer token the Copilot web app holds for its own API.
 *
 * This is the whole authentication mechanism: cookies alone are *not* enough.
 * An unauthenticated request to `/c/api/user` still answers 200, but with an
 * anonymous profile and an empty history — so a missing token looks like an
 * empty account rather than like a failure. Refreshing the token is MSAL's job
 * and happens while the tab is open; the plugin only reads the cache.
 */
const readAccessToken = (): string | null => {
  const entry = findLocalStorageEntry(
    key => key.includes(ACCESS_TOKEN_MARKER) && key.toLowerCase().includes(CHAT_SCOPE),
  );
  if (!entry) return null;

  let cached: CachedToken;
  try {
    cached = JSON.parse(entry.value) as CachedToken;
  } catch {
    return null;
  }
  if (!cached.secret) return null;

  const expiresOn = Number(cached.expiresOn);
  if (Number.isFinite(expiresOn) && expiresOn > 0) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds >= expiresOn - TOKEN_EXPIRY_SKEW_SECONDS) return null;
  }
  return cached.secret;
};

/** True when the tab holds a live Microsoft account token for Copilot. */
export const isAuthenticated = (): boolean => readAccessToken() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

const requireAccessToken = (): string => {
  const token = readAccessToken();
  if (!token) {
    throw ToolError.auth(
      'Not signed in to Copilot with a Microsoft account (or the session token has expired). Open https://copilot.microsoft.com, sign in, and reload the tab.',
    );
  }
  return token;
};

// --- REST plumbing ---

/**
 * Calls one of Copilot's `/c/api/*` endpoints. The request is issued by the
 * page so it stays same-origin, and the MSAL bearer is attached explicitly —
 * without it the API answers as an anonymous visitor instead of failing.
 */
const callApi = async <T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> => {
  const response = await fetchFromPage(`${API_BASE}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${requireAccessToken()}`,
      'x-search-uilang': 'en-us',
      ...((init?.headers as Record<string, string>) ?? {}),
    },
    credentials: 'include',
    timeout: init?.timeout ?? REQUEST_TIMEOUT_MS,
  });
  return (await response.json()) as T;
};

const getApi = <T>(path: string): Promise<T> => callApi<T>(path, { method: 'GET' });

const postApi = <T>(path: string, body: unknown): Promise<T> =>
  callApi<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// --- Account ---

interface RawUser {
  id?: string;
  anid?: string | null;
  firstName?: string | null;
  preferredName?: string | null;
  accountTier?: string;
  isPro?: boolean;
  regionCode?: string;
  subscriptions?: { tier?: string }[];
}

/**
 * The tier Copilot reports for a visitor it does not recognise. The endpoint
 * answers 200 with a freshly minted id in that case, so the tier — not the
 * status code — is what distinguishes "signed out" from "signed in".
 */
const ANONYMOUS_ACCOUNT_TIER = 'guest';

/**
 * Reads the signed-in profile. Copilot's `/user` endpoint answers 200 for
 * anonymous visitors too, handing back a throwaway id, `accountTier: "guest"`
 * and null everywhere else — so a rejected bearer looks like a brand-new
 * account rather than like a failure unless it is checked for explicitly.
 */
export const getCurrentUser = async (): Promise<CopilotUser> => {
  const user = await getApi<RawUser>('/user?api-version=4');
  const isAnonymous = user.accountTier === ANONYMOUS_ACCOUNT_TIER || (!user.firstName && !user.anid);
  if (!user.id || isAnonymous) {
    throw ToolError.auth(
      'Copilot returned an anonymous profile — the Microsoft account session is not active. Sign in at https://copilot.microsoft.com and reload the tab.',
    );
  }
  return {
    id: user.id,
    firstName: user.firstName ?? '',
    preferredName: user.preferredName ?? '',
    accountTier: user.accountTier ?? '',
    isPro: user.isPro === true,
    regionCode: user.regionCode ?? '',
    subscriptions: (user.subscriptions ?? []).map(subscription => subscription.tier ?? '').filter(Boolean),
  };
};

// --- Models (Copilot calls them "modes") ---

/**
 * Lists the entries Copilot's composer picker offers. Copilot has no model
 * endpoint and no model ids — the picker selects a *mode* that is sent with
 * each message and stored on it — so these mirror the picker rather than
 * inventing ids.
 */
export const getModels = (): CopilotModel[] => MODES;

/**
 * Picks the mode a message runs under. An explicit id always wins; otherwise
 * `thinking` and `search` map onto the picker entries that mean the same
 * thing, and omitting both leaves Copilot's default ("Smart") in place.
 */
export const resolveModelId = (
  modelId: string | undefined,
  thinking: boolean | undefined,
  search: boolean | undefined,
): string => {
  if (modelId) {
    const match = MODES.find(mode => mode.id === modelId);
    if (!match) {
      throw ToolError.validation(
        `Unknown Copilot mode "${modelId}". Call list_models for valid ids (${MODES.map(m => m.id).join(', ')}).`,
      );
    }
    return match.id;
  }
  if (thinking === true) return MODE_REASONING;
  if (search === true) return MODE_SEARCH;
  return MODE_SMART;
};

// --- Conversations ---

export const conversationUrl = (conversationId: string): string => `${ORIGIN}/chats/${conversationId}`;

interface RawConversation {
  id?: string;
  title?: string | null;
  type?: string;
  isPinned?: boolean;
  updatedAt?: string;
}

interface RawPage<T> {
  results?: T[];
  next?: string | null;
}

const mapConversation = (conversation: RawConversation): CopilotConversation => ({
  id: conversation.id ?? '',
  title: conversation.title ?? '',
  url: conversationUrl(conversation.id ?? ''),
  type: conversation.type ?? '',
  pinned: conversation.isPinned === true,
  updatedAt: conversation.updatedAt ?? '',
});

/**
 * Lists chats newest-first, matching the sidebar's history order. Copilot
 * leaves a chat's title empty until it generates one and the sidebar prints
 * "New conversation" in its place; the empty string is passed through as-is
 * rather than being invented over.
 */
export const listConversations = async (limit: number): Promise<CopilotConversation[]> => {
  const conversations: CopilotConversation[] = [];
  const seen = new Set<string>();
  let cursor = '';

  for (let page = 0; page < MAX_PAGES && conversations.length < limit; page++) {
    const query = new URLSearchParams({ types: CONVERSATION_TYPES });
    if (cursor) query.set('cursor', cursor);

    const payload = await getApi<RawPage<RawConversation>>(`/conversations?${query.toString()}`);
    const rows = payload.results ?? [];
    if (rows.length === 0) break;

    let added = 0;
    for (const row of rows) {
      if (!row.id || seen.has(row.id)) continue;
      seen.add(row.id);
      conversations.push(mapConversation(row));
      added++;
    }

    if (added === 0 || !payload.next || payload.next === cursor) break;
    cursor = payload.next;
  }

  return conversations.slice(0, limit);
};

export const createEmptyConversation = async (): Promise<string> => {
  const conversation = await postApi<RawConversation>('/conversations', {});
  if (!conversation.id) {
    throw ToolError.internal('Copilot did not return an id for the new conversation.');
  }
  return conversation.id;
};

// --- Conversation detail ---

interface RawContentPart {
  type?: string;
  text?: string;
  title?: string;
  url?: string;
  publisher?: string;
  position?: number;
}

interface RawMessage {
  id?: string;
  author?: { type?: string };
  createdAt?: string;
  mode?: string | null;
  content?: RawContentPart[];
}

const mapCitation = (part: RawContentPart, index: number): CopilotSearchResult => {
  let siteName = part.publisher ?? '';
  if (!siteName && part.url) {
    try {
      siteName = new URL(part.url).hostname;
    } catch {
      // A malformed URL just leaves the site name empty.
    }
  }
  return {
    title: part.title ?? '',
    url: part.url ?? '',
    // Copilot cites by character offset into the answer rather than by
    // extract, so there is no snippet to report.
    snippet: '',
    siteName,
    citeIndex: index,
  };
};

const dedupeSearchResults = (results: CopilotSearchResult[]): CopilotSearchResult[] => {
  const seen = new Set<string>();
  return results
    .filter(result => {
      if (!result.url || seen.has(result.url)) return false;
      seen.add(result.url);
      return true;
    })
    .map((result, index) => ({ ...result, citeIndex: index }));
};

const readMessageText = (message: RawMessage): string =>
  (message.content ?? [])
    .filter(part => part.type === 'text')
    .map(part => part.text ?? '')
    .join('');

const readMessageCitations = (message: RawMessage): CopilotSearchResult[] =>
  dedupeSearchResults((message.content ?? []).filter(part => part.type === 'citation').map(mapCitation));

/**
 * Walks the history endpoint, which pages backwards from the newest message.
 * The pages are concatenated and then reversed once, so the caller always sees
 * the conversation in chronological order.
 */
const listMessages = async (conversationId: string, wanted: number): Promise<RawMessage[]> => {
  const messages: RawMessage[] = [];
  let cursor = '';

  for (let page = 0; page < MAX_PAGES && messages.length < wanted; page++) {
    const query = new URLSearchParams({ 'api-version': '2' });
    if (cursor) query.set('cursor', cursor);

    const payload = await getApi<RawPage<RawMessage>>(
      `/conversations/${encodeURIComponent(conversationId)}/history?${query.toString()}`,
    );
    const rows = payload.results ?? [];
    if (rows.length === 0) break;
    messages.push(...rows);

    if (!payload.next || payload.next === cursor) break;
    cursor = payload.next;
  }

  return messages.reverse();
};

export const getConversationTitle = async (conversationId: string): Promise<string> => {
  const conversation = await getApi<RawConversation>(`/conversations/${encodeURIComponent(conversationId)}`);
  return conversation.title ?? '';
};

/**
 * Rebuilds a conversation as prompt/response turns. Copilot stores a flat list
 * of messages rather than a tree, so consecutive human and AI messages simply
 * pair up; a turn whose reply is missing is kept with an empty response rather
 * than dropped.
 */
export const getConversation = async (
  conversationId: string,
  limit: number,
): Promise<{ title: string; turns: CopilotTurn[] }> => {
  const [title, messages] = await Promise.all([
    getConversationTitle(conversationId).catch(() => ''),
    // Two messages per turn, plus slack for turns that only have one side.
    listMessages(conversationId, limit * 2 + PAGE_SIZE_HINT),
  ]);

  const turns: CopilotTurn[] = [];
  for (const message of messages) {
    if (message.author?.type === 'human') {
      turns.push({
        prompt: readMessageText(message),
        response: '',
        thinking: '',
        searchResults: [],
        messageId: message.id ?? '',
        modelId: message.mode ?? '',
        createdAt: message.createdAt ?? '',
      });
      continue;
    }

    const filled = {
      response: readMessageText(message),
      searchResults: readMessageCitations(message),
      messageId: message.id ?? '',
      createdAt: message.createdAt ?? '',
    };
    const previous = turns[turns.length - 1];
    if (previous && previous.response === '') {
      Object.assign(previous, filled);
    } else {
      turns.push({ prompt: '', thinking: '', modelId: '', ...filled });
    }
  }

  return { title, turns: turns.slice(-limit) };
};

// --- Chat gateway (WebSocket) ---

interface GatewayFrame {
  event?: string;
  conversationId?: string;
  messageId?: string;
  partId?: string;
  text?: string;
  title?: string;
  url?: string;
  publisher?: string;
  errorCode?: string;
  message?: string;
  tool?: { type?: string; query?: string };
}

export interface ChatOptions {
  text: string;
  conversationId: string;
  modelId: string;
}

/**
 * Sends one message and resolves once Copilot has finished the reply.
 *
 * The gateway is a same-origin WebSocket at `/c/api/chat`, but unlike the REST
 * endpoints it takes the bearer in the query string — a browser cannot set a
 * header on a WebSocket handshake. The protocol is `setOptions` →
 * `reportLocalConsents` → `send`, answered by `connected`, `received`,
 * `startMessage`, a run of `appendText` interleaved with `citation` and
 * `toolExecuting`, then `partCompleted`, `done` and `titleUpdate`.
 *
 * Failures arrive as an `error` frame on an otherwise healthy socket, so the
 * absence of a transport error means nothing on its own.
 */
export const chat = (options: ChatOptions): Promise<CopilotChatResult> => {
  const token = requireAccessToken();

  return new Promise<CopilotChatResult>((resolve, reject) => {
    const url = `${CHAT_SOCKET_URL}&clientSessionId=${crypto.randomUUID()}&accessToken=${encodeURIComponent(token)}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      reject(ToolError.internal(`Could not open Copilot's chat gateway: ${String(error)}`));
      return;
    }

    let conversationId = options.conversationId;
    let messageId = '';
    let parentMessageId = '';
    let title = '';
    let answer = '';
    const toolNotes: string[] = [];
    const citations: CopilotSearchResult[] = [];
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
        messageId,
        parentMessageId,
        text: answer,
        thinking: toolNotes.join('\n'),
        searchResults: dedupeSearchResults(citations),
        title,
        modelId: options.modelId,
      });
    };

    const overallTimer = setTimeout(
      () => fail(ToolError.timeout(`Copilot did not finish within ${COMPLETION_TIMEOUT_MS / 1000}s.`)),
      COMPLETION_TIMEOUT_MS,
    );

    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () =>
          fail(
            ToolError.timeout(
              'Copilot stopped sending events before the reply finished. Open https://copilot.microsoft.com in the browser and retry.',
            ),
          ),
        STREAM_IDLE_TIMEOUT_MS,
      );
    };
    resetIdle();

    const send = (frame: unknown) => socket.send(JSON.stringify(frame));

    socket.onopen = () => {
      send(SET_OPTIONS_FRAME);
      send({ event: 'reportLocalConsents', grantedConsents: [] });
      send({
        event: 'send',
        conversationId: options.conversationId,
        content: [{ type: 'text', text: options.text }],
        mode: options.modelId,
        context: {},
      });
    };

    socket.onerror = () =>
      fail(
        ToolError.auth(
          "Copilot's chat gateway rejected the connection — the Microsoft account token is stale. Reload https://copilot.microsoft.com and retry.",
        ),
      );

    socket.onclose = event => {
      if (settled) return;
      // Reaching here means the socket ended before `done`.
      fail(
        ToolError.internal(
          `Copilot's chat gateway closed before the reply finished (code ${event.code}${event.reason ? `: ${event.reason}` : ''}).`,
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

      switch (frame.event) {
        case 'received':
          // The echo of the outgoing message; its id is the reply's parent.
          conversationId = frame.conversationId ?? conversationId;
          parentMessageId = frame.messageId ?? parentMessageId;
          return;

        case 'startMessage':
          messageId = frame.messageId ?? messageId;
          return;

        case 'appendText':
          answer += frame.text ?? '';
          return;

        case 'toolExecuting': {
          // The only progress narration Copilot streams. It is the closest
          // thing the site has to a reasoning trace, so it is surfaced as one.
          const tool = frame.tool;
          if (tool?.type) toolNotes.push(tool.query ? `${tool.type}: ${tool.query}` : tool.type);
          return;
        }

        case 'citation':
          citations.push(
            mapCitation({ title: frame.title, url: frame.url, publisher: frame.publisher }, citations.length),
          );
          return;

        case 'titleUpdate':
          title = frame.title ?? title;
          return;

        case 'done':
          succeed();
          return;

        case 'error':
          fail(
            ToolError.internal(
              `Copilot's chat gateway returned an error: ${frame.errorCode ?? frame.message ?? JSON.stringify(frame)}`,
            ),
          );
          return;

        default:
          return;
      }
    };
  });
};

/** How hard to chase a new conversation's server-generated title. */
const TITLE_POLL_ATTEMPTS = 3;
const TITLE_POLL_INTERVAL_MS = 800;

/**
 * Runs a chat turn and backfills what the stream does not carry. Copilot can
 * finish a turn having produced no content at all — Think Deeper does this
 * when a request trips its tool or safety path — and reports it as a perfectly
 * normal `done`, so that case is turned into an error rather than an empty
 * answer.
 */
export const chatAndEnrich = async (options: ChatOptions): Promise<CopilotChatResult> => {
  const result = await chat(options);

  if (!result.text) {
    throw ToolError.internal(
      'Copilot finished the turn without producing any text. This happens when a request trips its content or tool path — rephrase, or retry with model_id "smart".',
    );
  }

  // The title event usually lands with the reply, but on a brand-new chat it
  // can arrive after `done`; poll briefly so the caller gets the real title.
  for (let attempt = 0; attempt < TITLE_POLL_ATTEMPTS && !result.title && result.conversationId; attempt++) {
    if (attempt > 0) await sleep(TITLE_POLL_INTERVAL_MS);
    result.title = await getConversationTitle(result.conversationId).catch(() => '');
  }

  return result;
};

// --- Page state ---

/** Reads the chat id out of a /chats/<id> URL, or null when none is open. */
export const getCurrentConversationId = (): string | null => {
  const match = window.location.pathname.match(/\/chats\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
};
