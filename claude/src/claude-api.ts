import {
  type FetchFromPageOptions,
  ToolError,
  buildQueryString,
  fetchFromPage,
  getAuthCache,
  getCookie,
  getCurrentUrl,
  setAuthCache,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

// --- Auth ---
// claude.ai authenticates with HttpOnly session cookies, so `credentials: 'include'`
// is enough to be authorized. What the page does NOT expose anywhere else is the
// active organization id, and every chat endpoint is org-scoped — hence the
// `lastActiveOrg` cookie is the auth signal. It is readable (not HttpOnly) while
// `sessionKey` / `lastActiveOrg`'s siblings are not.

interface ClaudeAuth {
  orgId: string;
}

const getAuth = (): ClaudeAuth | null => {
  const orgId = getCookie('lastActiveOrg');
  if (!orgId) return null;

  // Re-validate the cache against the live cookie: switching organisation in the
  // UI rewrites the cookie, and a stale cache would keep hitting the old org.
  const cached = getAuthCache<ClaudeAuth>('claude');
  if (cached?.orgId === orgId) return cached;

  const auth: ClaudeAuth = { orgId };
  setAuthCache('claude', auth);
  return auth;
};

export const isAuthenticated = (): boolean => getAuth() !== null;

export const waitForAuth = async (): Promise<boolean> => {
  try {
    await waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

export const getOrgId = (): string => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth('Not authenticated — please log in to Claude.');
  return auth.orgId;
};

// --- API caller ---

const API_BASE = '/api';
const DEFAULT_TIMEOUT_MS = 30_000;
// Completions run well past the SDK's 30s default, especially on Opus at max effort.
const COMPLETION_TIMEOUT_MS = 300_000;

interface ApiOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeout?: number;
}

/**
 * claude.ai returns `{"type":"error","error":{"type":"…","message":"…"}}` bodies.
 * `fetchFromPage` already raises `httpStatusToToolError` on every non-2xx, but its
 * message is the raw body; re-classify so the caller sees Anthropic's own reason
 * and the SPEC §0 code.
 */
interface ClaudeErrorBody {
  type?: string;
  error?: { type?: string; message?: string };
}

/** Pulls Anthropic's own `error.message` out of an SDK error whose text embeds the body. */
const describeError = (raw: string): string => {
  const start = raw.indexOf('{');
  if (start < 0) return raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw.slice(start)) as ClaudeErrorBody;
    return parsed.error?.message ?? raw.slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
};

/**
 * `fetchFromPage` already throws `httpStatusToToolError` on every non-2xx, so a
 * `response.ok` branch here would be dead code. What it does NOT do is use the
 * SPEC §0 code names — it emits `RATE_LIMITED` and `http_error` — so re-map by
 * category and re-message with Anthropic's own reason instead of the raw body.
 */
const toSpecError = (error: ToolError, url: string): ToolError => {
  const reason = describeError(error.message);
  const where = `${url} — ${reason}`;
  switch (error.category) {
    case 'auth':
      return new ToolError(`Claude rejected the request: ${where}`, 'AUTH_ERROR', { category: 'auth' });
    case 'not_found':
      return new ToolError(`Not found: ${where}`, 'NOT_FOUND', { category: 'not_found' });
    case 'validation':
      return new ToolError(`Claude rejected the request: ${where}`, 'VALIDATION_ERROR', { category: 'validation' });
    case 'rate_limit':
      return new ToolError(`Claude rate limited the request: ${where}`, 'RATE_LIMIT', {
        category: 'rate_limit',
        retryable: true,
        retryAfterMs: error.retryAfterMs,
      });
    case 'timeout':
      return new ToolError(`Claude request timed out: ${where}`, 'TIMEOUT', { category: 'timeout', retryable: true });
    default:
      return new ToolError(`Claude request failed: ${where}`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: error.retryable,
      });
  }
};

/** Raw request that classifies claude.ai's error envelope instead of leaking the body. */
const request = async (endpoint: string, options: ApiOptions = {}): Promise<Response> => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth('Not authenticated — please log in to Claude.');

  const qs = options.query ? buildQueryString(options.query) : '';
  const url = qs ? `${API_BASE}${endpoint}?${qs}` : `${API_BASE}${endpoint}`;

  const headers: Record<string, string> = { accept: 'application/json' };
  const init: FetchFromPageOptions = {
    method: options.method ?? 'GET',
    headers,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  try {
    return await fetchFromPage(url, init);
  } catch (error) {
    if (error instanceof ToolError) throw toSpecError(error, url);
    throw new ToolError(`Claude request failed: ${url} — ${String(error).slice(0, 200)}`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  }
};

export const api = async <T>(endpoint: string, options: ApiOptions = {}): Promise<T> => {
  const response = await request(endpoint, options);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolError(
      `Claude returned a non-JSON body for ${endpoint} (${text.length} bytes). The API shape may have changed.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  }
};

/** Org-scoped shorthand: `/chat_conversations` → `/organizations/<org>/chat_conversations`. */
export const orgApi = async <T>(path: string, options: ApiOptions = {}): Promise<T> =>
  api<T>(`/organizations/${getOrgId()}${path}`, options);

// --- Streaming completions ---

interface SseFrame {
  type?: string;
  // Legacy `rendering_mode: 'text'` frames.
  completion?: string;
  // Modern `rendering_mode: 'messages'` frames.
  delta?: { type?: string; text?: string };
  content_block?: { type?: string; text?: string };
  error?: { type?: string; message?: string };
  message?: { error?: { message?: string } };
}

export interface CompletionResult {
  text: string;
  streamBytes: number;
}

/**
 * claude.ai emits two SSE dialects from the same endpoint depending on
 * `rendering_mode`:
 *   'text'     → {type:'completion', completion:'…'}                       (legacy)
 *   'messages' → {type:'content_block_delta', delta:{type:'text_delta', …}} (modern)
 * Handle both so a server-side default flip cannot silently produce "".
 */
const parseCompletionStream = (raw: string): { text: string; streamError: string | undefined } => {
  let text = '';
  let streamError: string | undefined;

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;

    let frame: SseFrame;
    try {
      frame = JSON.parse(payload) as SseFrame;
    } catch {
      continue;
    }

    if (frame.type === 'error' || frame.error || frame.message?.error) {
      streamError = frame.error?.message ?? frame.message?.error?.message ?? 'Unknown streaming error';
      continue;
    }
    if (frame.type === 'completion' && frame.completion) {
      text += frame.completion;
      continue;
    }
    if (frame.type === 'content_block_start' && frame.content_block?.type === 'text' && frame.content_block.text) {
      text += frame.content_block.text;
      continue;
    }
    if (frame.type === 'content_block_delta' && frame.delta?.type === 'text_delta' && frame.delta.text) {
      text += frame.delta.text;
    }
  }

  return { text, streamError };
};

const completionUrl = (conversationId: string): string =>
  `${API_BASE}/organizations/${getOrgId()}/chat_conversations/${conversationId}/completion`;

/**
 * The OpenTabs adapter aborts a tool handler after 25s of script execution, which
 * is well short of a long Opus answer. Tools therefore stop *waiting* at this
 * budget and return what exists, leaving the completion promise running in the
 * page so the answer still lands server-side.
 */
export const COMPLETION_WAIT_MS = 18_000;

/** Runs a completion to the end and returns the assembled assistant text. */
export const runCompletion = async (conversationId: string, body: unknown): Promise<CompletionResult> => {
  const url = completionUrl(conversationId);
  const response = await fetchFromPage(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    timeout: COMPLETION_TIMEOUT_MS,
  });

  const raw = await response.text();
  const { text, streamError } = parseCompletionStream(raw);

  // HTTP 200 on an SSE endpoint does not mean the completion succeeded — the
  // failure arrives as an in-stream frame. Never hand back a silent empty string.
  if (streamError)
    throw new ToolError(`Claude completion failed: ${streamError}`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  if (!text)
    throw new ToolError(
      `Claude completion returned no text (${raw.length} bytes of stream). The completion SSE format may have changed.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );

  return { text, streamBytes: raw.length };
};

/**
 * Starts a completion and returns as soon as the request is accepted, without
 * draining the stream. Used by deep research, where the same SSE connection stays
 * open for the whole multi-minute run but the work is persisted server-side and
 * can be read back from the conversation. SPEC §7 requires start to return promptly.
 */
export const startCompletion = (conversationId: string, body: unknown): void => {
  void fetchFromPage(completionUrl(conversationId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    timeout: COMPLETION_TIMEOUT_MS,
  }).catch(() => {
    // The run continues server-side; get_deep_research reports the real outcome.
  });
};

// --- Shared helpers ---

export const toUnixSeconds = (iso: string | undefined | null): number =>
  iso ? Math.floor(new Date(iso).getTime() / 1000) || 0 : 0;

export const conversationUrl = (conversationId: string): string => `https://claude.ai/chat/${conversationId}`;
export const projectUrl = (projectId: string): string => `https://claude.ai/project/${projectId}`;

/** Resolves the conversation id from the active claude.ai tab when the caller omits one. */
export const resolveConversationId = (explicit?: string): string => {
  if (explicit) return explicit;
  const match = /\/chat\/([0-9a-fA-F-]{36})/.exec(getCurrentUrl() ?? '');
  if (!match?.[1])
    throw ToolError.validation(
      'No conversation_id given and the active tab is not on a Claude conversation (https://claude.ai/chat/<uuid>).',
    );
  return match[1];
};
