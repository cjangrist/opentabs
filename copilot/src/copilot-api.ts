import { ToolError, fetchFromPage, findLocalStorageEntry, sleep, waitUntil } from '@opentabs-dev/plugin-sdk';

export const ORIGIN = 'https://copilot.microsoft.com';
export const API_BASE = `${ORIGIN}/c/api`;
const CHAT_SOCKET_URL = `${ORIGIN.replace('https://', 'wss://')}/c/api/chat?api-version=2`;

const CHAT_SCOPE = '140e65af-45d1-4427-bf08-3e7295db6836/chatai.readwrite';
const ACCESS_TOKEN_MARKER = 'accesstoken';
const TOKEN_EXPIRY_SKEW_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 30_000;
const SOCKET_TIMEOUT_MS = 300_000;
const SOCKET_IDLE_TIMEOUT_MS = 120_000;
const TASK_SOCKET_MAX_LIFETIME_MS = 1_800_000;
export const COMPLETION_WAIT_MS = 18_000;

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

interface CachedToken {
  secret?: string;
  expiresOn?: string;
}

const readAccessToken = (): string | null => {
  const entry = findLocalStorageEntry(
    key => key.includes(ACCESS_TOKEN_MARKER) && key.toLowerCase().includes(CHAT_SCOPE),
  );
  if (!entry) return null;
  try {
    const cached = JSON.parse(entry.value) as CachedToken;
    if (!cached.secret) return null;
    const expiresOn = Number(cached.expiresOn);
    if (
      Number.isFinite(expiresOn) &&
      expiresOn > 0 &&
      Math.floor(Date.now() / 1000) >= expiresOn - TOKEN_EXPIRY_SKEW_SECONDS
    )
      return null;
    return cached.secret;
  } catch {
    return null;
  }
};

export const isAuthenticated = (): boolean => readAccessToken() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

const requireAccessToken = (): string => {
  const token = readAccessToken();
  if (!token)
    throw ToolError.auth(
      'Not signed in to Copilot with a Microsoft account, or the bearer has expired. Reload https://copilot.microsoft.com and sign in.',
      'AUTH_ERROR',
    );
  return token;
};

const normalizeFetchError = (error: unknown): never => {
  if (error instanceof ToolError) {
    if (error.code === 'RATE_LIMITED') throw ToolError.rateLimited(error.message, error.retryAfterMs, 'RATE_LIMIT');
    if (['AUTH_ERROR', 'NOT_FOUND', 'VALIDATION_ERROR', 'TIMEOUT'].includes(error.code)) throw error;
    throw new ToolError(error.message, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    });
  }
  throw new ToolError(
    `Copilot request failed: ${error instanceof Error ? error.message : String(error)}`,
    'UPSTREAM_ERROR',
    {
      category: 'internal',
      retryable: true,
    },
  );
};

export const callApi = async <T>(
  path: string,
  init: RequestInit & { timeout?: number; allowEmpty?: boolean } = {},
): Promise<T> => {
  let response: Response | undefined;
  try {
    response = await fetchFromPage(`${API_BASE}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${requireAccessToken()}`,
        'x-search-uilang': 'en-us',
        ...((init.headers as Record<string, string>) ?? {}),
      },
      credentials: 'include',
      timeout: init.timeout ?? REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    normalizeFetchError(error);
  }

  if (!response)
    throw new ToolError('Copilot request failed before a response was available.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });

  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim().slice(0, 500);
    const suffix = detail ? `: ${detail}` : '';
    if (response.status === 401 || response.status === 403)
      throw ToolError.auth(`Copilot rejected the request for ${path}${suffix}`, 'AUTH_ERROR');
    if (response.status === 404) throw ToolError.notFound(`Copilot has no resource at ${path}${suffix}`, 'NOT_FOUND');
    if (response.status === 429)
      throw ToolError.rateLimited(`Copilot throttled the request for ${path}${suffix}`, undefined, 'RATE_LIMIT');
    if (response.status === 400 || response.status === 422)
      throw ToolError.validation(`Copilot rejected the request for ${path}${suffix}`, 'VALIDATION_ERROR');
    throw new ToolError(`Copilot returned HTTP ${response.status} for ${path}${suffix}`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: response.status >= 500,
    });
  }
  if (text.length === 0) {
    if (init.allowEmpty) return undefined as T;
    throw new ToolError(`Copilot returned an empty response for ${path}.`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolError(`Copilot returned non-JSON data for ${path}.`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  }
};

export const getApi = <T>(path: string): Promise<T> => callApi<T>(path, { method: 'GET' });

export const postApi = <T>(path: string, body?: unknown): Promise<T> =>
  callApi<T>(path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const patchApi = <T>(path: string, body: unknown, allowEmpty = true): Promise<T> =>
  callApi<T>(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    allowEmpty,
  });

export const deleteApi = <T>(path: string, allowEmpty = true): Promise<T> =>
  callApi<T>(path, { method: 'DELETE', allowEmpty });

export const toUnixSeconds = (value: string | null | undefined): number => {
  if (!value) return 0;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0;
};

export const conversationUrl = (conversationId: string, projectId?: string | null): string =>
  projectId ? `${ORIGIN}/projects/${projectId}/chats/${conversationId}` : `${ORIGIN}/chats/${conversationId}`;

export const projectUrl = (projectId: string): string => `${ORIGIN}/projects/${projectId}`;

export const getCurrentConversationId = (): string | null => {
  if (window.location.origin !== ORIGIN) return null;
  return window.location.pathname.match(/\/(?:projects\/[^/]+\/)?chats\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
};

export const getCurrentProjectId = (): string | null => {
  if (window.location.origin !== ORIGIN) return null;
  return window.location.pathname.match(/\/projects\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
};

export interface GatewayCitation {
  title: string;
  url: string;
  publisher: string | null;
  snippet: string | null;
  position: number | null;
}

export interface GatewayReasoning {
  id: string;
  text: string;
}

export interface GatewaySearch {
  id: string;
  type: string;
  query: string | null;
  url: string | null;
  completed: boolean;
  results: GatewayCitation[];
}

export interface GatewayRun {
  clientSessionId: string;
  conversationId: string;
  modelId: string;
  prompt: string;
  parentMessageId: string;
  messageId: string;
  title: string;
  text: string;
  citations: GatewayCitation[];
  reasoning: GatewayReasoning[];
  searches: GatewaySearch[];
  taskId: string | null;
  taskStatus: string | null;
  received: boolean;
  done: boolean;
  error: ToolError | null;
}

interface GatewayFrame {
  event?: string;
  conversationId?: string;
  messageId?: string;
  partId?: string;
  text?: string;
  title?: string;
  url?: string;
  publisher?: string | null;
  snippet?: string | null;
  position?: number;
  errorCode?: string;
  message?: string;
  tool?: { type?: string; query?: string; url?: string };
  task?: { id?: string; status?: string };
  taskId?: string;
  update?: Array<{ op?: string; path?: string; value?: unknown }>;
}

export interface GatewayTurnOptions {
  conversationId: string;
  modelId: string;
  prompt: string;
  content?: unknown[];
  stopBeforeSend?: boolean;
  clientSessionId?: string;
  cursor?: string;
  keepOpenAfterDone?: boolean;
}

const gatewaySockets = new WeakMap<GatewayRun, WebSocket>();
const gatewayClosers = new WeakMap<GatewayRun, () => void>();

export const sendGatewayTaskCancel = (run: GatewayRun, taskId: string): boolean => {
  const socket = gatewaySockets.get(run);
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ event: 'stop', conversationId: run.conversationId }));
  socket.send(
    JSON.stringify({
      event: 'send',
      conversationId: run.conversationId,
      content: [{ type: 'command', command: { type: 'cancelTask', taskId } }],
      mode: 'research',
    }),
  );
  return true;
};

export const closeGatewayRun = (run: GatewayRun): void => gatewayClosers.get(run)?.();

const gatewayError = (frame: GatewayFrame): ToolError => {
  const detail = frame.errorCode ?? frame.message ?? 'unknown gateway error';
  if (/quota|limit|throttl|over-research/i.test(detail))
    return ToolError.rateLimited(`Copilot gateway rejected the turn: ${detail}`, undefined, 'RATE_LIMIT');
  if (/auth|token|unauthor/i.test(detail))
    return ToolError.auth(`Copilot gateway rejected the session: ${detail}`, 'AUTH_ERROR');
  if (/invalid|bad.request/i.test(detail))
    return ToolError.validation(`Copilot gateway rejected the request: ${detail}`, 'VALIDATION_ERROR');
  return new ToolError(`Copilot gateway returned an error: ${detail}`, 'UPSTREAM_ERROR', {
    category: 'internal',
    retryable: false,
  });
};

/**
 * Starts one gateway turn and leaves the socket alive when the calling tool
 * returns early. This is what lets long Think Deeper and Deep Research work
 * survive OpenTabs' 25-second handler budget.
 */
export const startGatewayTurn = (options: GatewayTurnOptions): GatewayRun => {
  const token = requireAccessToken();
  const clientSessionId = options.clientSessionId ?? crypto.randomUUID();
  const run: GatewayRun = {
    clientSessionId,
    conversationId: options.conversationId,
    modelId: options.modelId,
    prompt: options.prompt,
    parentMessageId: '',
    messageId: '',
    title: '',
    text: '',
    citations: [],
    reasoning: [],
    searches: [],
    taskId: null,
    taskStatus: null,
    received: false,
    done: false,
    error: null,
  };

  let socket: WebSocket;
  try {
    const query = new URLSearchParams({ clientSessionId, accessToken: token });
    if (options.cursor) query.set('cursor', options.cursor);
    socket = new WebSocket(`${CHAT_SOCKET_URL}&${query.toString()}`);
    gatewaySockets.set(run, socket);
  } catch (error) {
    run.error = new ToolError(`Could not open Copilot's gateway: ${String(error)}`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
    return run;
  }

  let idleTimer: ReturnType<typeof setTimeout>;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  let closedByUs = false;
  const close = () => {
    closedByUs = true;
    clearTimeout(overallTimer);
    clearTimeout(idleTimer);
    clearTimeout(lifetimeTimer);
    try {
      socket.close();
    } catch {
      // Closing an already-closed socket is harmless.
    }
    gatewaySockets.delete(run);
    gatewayClosers.delete(run);
  };
  gatewayClosers.set(run, close);
  const fail = (error: ToolError) => {
    if (run.done || run.error) return;
    run.error = error;
    close();
  };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => fail(ToolError.timeout('Copilot stopped sending gateway events before the turn finished.', 'TIMEOUT')),
      SOCKET_IDLE_TIMEOUT_MS,
    );
  };
  const overallTimer = setTimeout(
    () => fail(ToolError.timeout(`Copilot did not finish within ${SOCKET_TIMEOUT_MS / 1000}s.`, 'TIMEOUT')),
    SOCKET_TIMEOUT_MS,
  );
  resetIdle();

  socket.onopen = () => {
    socket.send(JSON.stringify(SET_OPTIONS_FRAME));
    socket.send(JSON.stringify({ event: 'reportLocalConsents', grantedConsents: [] }));
    if (options.stopBeforeSend) socket.send(JSON.stringify({ event: 'stop', conversationId: options.conversationId }));
    socket.send(
      JSON.stringify({
        event: 'send',
        conversationId: options.conversationId,
        content: options.content ?? [{ type: 'text', text: options.prompt }],
        mode: options.modelId,
        context: {},
      }),
    );
  };

  socket.onerror = () =>
    fail(
      ToolError.auth(
        "Copilot's gateway rejected the connection. Reload https://copilot.microsoft.com and retry.",
        'AUTH_ERROR',
      ),
    );

  socket.onclose = event => {
    gatewaySockets.delete(run);
    gatewayClosers.delete(run);
    if (closedByUs || run.done || run.error) return;
    fail(
      new ToolError(
        `Copilot's gateway closed before the turn finished (code ${event.code}${event.reason ? `: ${event.reason}` : ''}).`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
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
        run.received = true;
        run.conversationId = frame.conversationId ?? run.conversationId;
        run.parentMessageId = frame.messageId ?? run.parentMessageId;
        return;
      case 'startMessage':
        run.messageId = frame.messageId ?? run.messageId;
        return;
      case 'appendText':
        run.text += frame.text ?? '';
        return;
      case 'chainOfThought': {
        const id = frame.partId ?? `${run.messageId || run.conversationId}:reasoning:${run.reasoning.length}`;
        const existing = run.reasoning.find(item => item.id === id);
        if (existing) existing.text += frame.text ?? '';
        else run.reasoning.push({ id, text: frame.text ?? '' });
        return;
      }
      case 'toolExecuting': {
        const tool = frame.tool;
        if (!tool?.type) return;
        run.searches.push({
          id: frame.partId ?? `${run.messageId || run.conversationId}:tool:${run.searches.length}`,
          type: tool.type,
          query: tool.query ?? null,
          url: tool.url ?? null,
          completed: false,
          results: [],
        });
        return;
      }
      case 'citation':
        if (frame.url) {
          const citation = {
            title: frame.title ?? '',
            url: frame.url,
            publisher: frame.publisher ?? null,
            snippet: frame.snippet ?? null,
            position: Number.isInteger(frame.position) ? (frame.position as number) : null,
          };
          run.citations.push(citation);
          run.searches.at(-1)?.results.push(citation);
        }
        return;
      case 'partCompleted': {
        const search = frame.partId ? run.searches.find(item => item.id === frame.partId) : run.searches.at(-1);
        if (search) search.completed = true;
        return;
      }
      case 'taskStart':
        run.taskId = frame.task?.id ?? run.taskId;
        run.taskStatus = frame.task?.status ?? run.taskStatus;
        return;
      case 'taskUpdate':
        if (frame.taskId && (!run.taskId || frame.taskId === run.taskId)) run.taskId = frame.taskId;
        for (const patch of frame.update ?? []) {
          if (patch.path === '/status' && typeof patch.value === 'string') run.taskStatus = patch.value;
        }
        if (options.keepOpenAfterDone && ['completed', 'failed', 'cancelled'].includes(run.taskStatus ?? '')) close();
        return;
      case 'titleUpdate':
        run.title = frame.title ?? run.title;
        return;
      case 'done':
        run.done = true;
        for (const search of run.searches) search.completed = true;
        clearTimeout(idleTimer);
        if (options.keepOpenAfterDone) {
          clearTimeout(overallTimer);
          lifetimeTimer = setTimeout(close, TASK_SOCKET_MAX_LIFETIME_MS);
        } else {
          close();
        }
        return;
      case 'error':
      case 'chatMessageError':
        fail(gatewayError(frame));
        return;
      default:
        return;
    }
  };

  return run;
};

export const waitForGatewayRun = async (
  run: GatewayRun,
  predicate: (current: GatewayRun) => boolean,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.error) throw run.error;
    if (predicate(run)) return true;
    await sleep(100);
  }
  if (run.error) throw run.error;
  return predicate(run);
};
