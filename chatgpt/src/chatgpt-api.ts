import {
  type FetchFromPageOptions,
  ToolError,
  buildQueryString,
  clearAuthCache,
  fetchFromPage,
  getAuthCache,
  getCookie,
  getCurrentUrl,
  setAuthCache,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

// --- Auth ---
// chatgpt.com authenticates every /backend-api call with a bearer access token
// minted at /api/auth/session. The session itself rides on HttpOnly cookies, so
// the readable `oai-client-auth-info` cookie is the synchronous presence signal
// and the token is fetched lazily on the first API call.

const API_BASE = 'https://chatgpt.com/backend-api';
/** The GPT store moved off /backend-api — /backend-api/gizmos/discovery now 200s with `cuts: []`. */
const PUBLIC_API_BASE = 'https://chatgpt.com/public-api';
const SESSION_URL = 'https://chatgpt.com/api/auth/session';
const DEFAULT_TIMEOUT_MS = 30_000;

interface ChatGPTAuth {
  accessToken: string;
}

const fetchAccessToken = async (): Promise<string | null> => {
  try {
    const response = await fetchFromPage(SESSION_URL, { timeout: DEFAULT_TIMEOUT_MS });
    const text = await response.text();
    if (!text) return null;
    const session = JSON.parse(text) as { accessToken?: string };
    return session.accessToken ?? null;
  } catch {
    return null;
  }
};

const ensureAuth = async (): Promise<ChatGPTAuth> => {
  const cached = getAuthCache<ChatGPTAuth>('chatgpt');
  if (cached) return cached;

  const accessToken = await fetchAccessToken();
  if (!accessToken)
    throw new ToolError('Not authenticated — please log in to ChatGPT at https://chatgpt.com.', 'AUTH_ERROR', {
      category: 'auth',
    });

  const auth: ChatGPTAuth = { accessToken };
  setAuthCache('chatgpt', auth);
  return auth;
};

export const isAuthenticated = (): boolean => {
  if (getAuthCache<ChatGPTAuth>('chatgpt')) return true;
  const authCookie = getCookie('oai-client-auth-info');
  return authCookie !== null && authCookie.length > 0;
};

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

// --- Error classification ---

/**
 * chatgpt.com answers with `{"detail": "…"}` (a string) or FastAPI's
 * `{"detail": [{loc, msg}]}` validation array. `fetchFromPage` already raises
 * `httpStatusToToolError` on every non-2xx, but its code names are not the SPEC
 * §0 set and its message is the raw body — so re-map by category and re-message
 * with OpenAI's own reason.
 */
interface ChatGPTErrorBody {
  detail?: string | { message?: string; code?: string } | { msg?: string; loc?: (string | number)[] }[];
  message?: string;
}

const describeError = (raw: string): string => {
  const start = raw.indexOf('{');
  if (start < 0) return raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw.slice(start)) as ChatGPTErrorBody;
    if (typeof parsed.detail === 'string') return parsed.detail;
    if (Array.isArray(parsed.detail))
      return parsed.detail.map(entry => `${(entry.loc ?? []).join('.')}: ${entry.msg ?? ''}`).join('; ');
    // Conversation endpoints answer `{"detail": {"message": "…", "code": "…"}}`.
    if (parsed.detail && typeof parsed.detail === 'object') {
      const nested = parsed.detail as { message?: string; code?: string };
      if (nested.message) return nested.code ? `${nested.message} (${nested.code})` : nested.message;
    }
    return parsed.message ?? raw.slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
};

export const toSpecError = (error: ToolError, url: string): ToolError => {
  const where = `${url} — ${describeError(error.message)}`;
  switch (error.category) {
    case 'auth':
      clearAuthCache('chatgpt');
      return new ToolError(`ChatGPT rejected the request: ${where}`, 'AUTH_ERROR', { category: 'auth' });
    case 'not_found':
      return new ToolError(`Not found: ${where}`, 'NOT_FOUND', { category: 'not_found' });
    case 'validation':
      return new ToolError(`ChatGPT rejected the request: ${where}`, 'VALIDATION_ERROR', { category: 'validation' });
    case 'rate_limit':
      return new ToolError(`ChatGPT rate limited the request: ${where}`, 'RATE_LIMIT', {
        category: 'rate_limit',
        retryable: true,
        retryAfterMs: error.retryAfterMs,
      });
    case 'timeout':
      return new ToolError(`ChatGPT request timed out: ${where}`, 'TIMEOUT', { category: 'timeout', retryable: true });
    default:
      return new ToolError(`ChatGPT request failed: ${where}`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: error.retryable,
      });
  }
};

// --- API caller ---

export interface ApiOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeout?: number;
  /** Target https://chatgpt.com/public-api instead of /backend-api. */
  base?: 'backend' | 'public';
}

/**
 * Every request goes through `fetchFromPage`, so it inherits the tab's cookies,
 * TLS fingerprint and Cloudflare clearance. Calling the API any other way is
 * rejected by chatgpt.com's bot protection.
 */
export const api = async <T>(endpoint: string, options: ApiOptions = {}): Promise<T> => {
  const auth = await ensureAuth();
  const base = options.base === 'public' ? PUBLIC_API_BASE : API_BASE;
  const queryString = options.query ? buildQueryString(options.query) : '';
  const url = queryString ? `${base}${endpoint}?${queryString}` : `${base}${endpoint}`;

  const headers: Record<string, string> = { Authorization: `Bearer ${auth.accessToken}`, accept: 'application/json' };
  const init: FetchFromPageOptions = {
    method: options.method ?? 'GET',
    headers,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetchFromPage(url, init);
  } catch (error) {
    if (error instanceof ToolError) throw toSpecError(error, url);
    throw new ToolError(`ChatGPT request failed: ${url} — ${String(error).slice(0, 200)}`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolError(
      `ChatGPT returned a non-JSON body for ${endpoint} (${text.length} bytes). The API shape may have changed.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  }
};

// --- Shared helpers ---

/**
 * ChatGPT mixes epoch seconds, epoch milliseconds, numeric strings and ISO
 * strings across endpoints. SPEC §0 wants unix seconds; unparseable input is 0
 * rather than a thrown "Invalid time value" (which once took down get_memories).
 */
export const toUnixSeconds = (value: unknown): number => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    return Math.floor(Math.abs(value) > 1e11 ? value / 1000 : value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return toUnixSeconds(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
  }
  return 0;
};

export const conversationUrl = (conversationId: string): string => `https://chatgpt.com/c/${conversationId}`;
export const projectUrl = (projectId: string): string => `https://chatgpt.com/g/${projectId}/project`;

/** Resolves the conversation id from the active chatgpt.com tab when the caller omits one. */
export const resolveConversationId = (explicit?: string): string => {
  if (explicit) return explicit;
  const match = /\/c\/([0-9a-fA-F-]{36})/.exec(getCurrentUrl() ?? '');
  if (!match?.[1])
    throw ToolError.validation(
      'No conversation_id given and the active tab is not on a ChatGPT conversation (https://chatgpt.com/c/<uuid>).',
    );
  return match[1];
};
