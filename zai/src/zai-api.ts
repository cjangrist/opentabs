import {
  type FetchFromPageOptions,
  ToolError,
  buildQueryString,
  fetchFromPage,
  getAuthCache,
  getCurrentUrl,
  setAuthCache,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

// --- Auth ---
// chat.z.ai is an Open WebUI derivative: it authenticates with a bearer JWT held in
// localStorage under `token`, not with cookies. Visiting the site anonymously still
// mints a token — a *guest* one, whose `email` claim is `guest-<epoch>@guest.com` and
// whose account has no chats. Treating that as "logged in" would make every list tool
// return a confident empty array, so the guest claim is checked here rather than only
// server-side.

const GUEST_EMAIL_PATTERN = /@guest\.com$/i;

interface ZaiAuth {
  token: string;
  userId: string;
}

interface TokenClaims {
  id?: string;
  email?: string;
}

const decodeTokenClaims = (token: string): TokenClaims | null => {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(normalized)) as TokenClaims;
  } catch {
    return null;
  }
};

const readStoredToken = (): string | null => {
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
};

const getAuth = (): ZaiAuth | null => {
  const token = readStoredToken();
  if (!token) return null;

  // Re-validate the cache against the live token: signing out and back in (or the
  // guest → user upgrade after SSO) rewrites localStorage, and a stale cache would
  // keep sending the previous bearer.
  const cached = getAuthCache<ZaiAuth>('zai');
  if (cached?.token === token) return cached;

  const claims = decodeTokenClaims(token);
  if (!claims?.id || !claims.email) return null;
  if (GUEST_EMAIL_PATTERN.test(claims.email)) return null;

  const auth: ZaiAuth = { token, userId: claims.id };
  setAuthCache('zai', auth);
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

const requireAuth = (): ZaiAuth => {
  const auth = getAuth();
  if (!auth)
    throw ToolError.auth(
      'Not authenticated — open https://chat.z.ai and sign in. A browsing session with no sign-in holds only a guest token, which has no conversations.',
    );
  return auth;
};

export const getUserId = (): string => requireAuth().userId;

/**
 * Bearer for requests that bypass `api()` — the completions stream, which is not
 * JSON and needs its own headers. z.ai's own client sends this on every call, so it
 * is sent here too rather than relying on the session cookie alone.
 */
export const getBearerToken = (): string => requireAuth().token;

// --- Client version ---
// /api/v2/chat/completions rejects any client that does not send an `x-fe-version`
// at or above its floor, and the rejection arrives as an SSE frame inside an HTTP
// 200 ("Your client version (unknown) is outdated"). The version is never hardcoded:
// it is the path segment of the frontend bundle the page itself loaded, so it tracks
// z.ai deployments automatically.

const FRONTEND_VERSION_PATTERN = /\/z-ai\/frontend\/(prod-fe-[\w.]+)\//;

const scanForFrontendVersion = (): string | null => {
  const assetUrls = [
    ...[...document.querySelectorAll<HTMLScriptElement>('script[src]')].map(element => element.src),
    ...[...document.querySelectorAll<HTMLLinkElement>('link[href]')].map(element => element.href),
    ...performance.getEntriesByType('resource').map(entry => entry.name),
  ];
  for (const url of assetUrls) {
    const match = FRONTEND_VERSION_PATTERN.exec(url);
    if (match?.[1]) return match[1];
  }
  const inline = FRONTEND_VERSION_PATTERN.exec(document.documentElement.outerHTML);
  return inline?.[1] ?? null;
};

export const getFrontendVersion = (): string => {
  const version = scanForFrontendVersion();
  if (!version)
    throw new ToolError(
      'Could not read the z.ai frontend version from the page. Reload https://chat.z.ai and try again — completions are rejected without an x-fe-version header.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  return version;
};

// --- API caller ---

const API_BASE = '/api';
const DEFAULT_TIMEOUT_MS = 30_000;
/** Completions stream for minutes on deep research; the wait budget is separate. */
export const COMPLETION_TIMEOUT_MS = 600_000;

interface ApiOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeout?: number;
}

/** z.ai errors are FastAPI-shaped: `{"detail": "…"}`, occasionally `{"detail": {"msg": "…"}}`. */
interface ZaiErrorBody {
  detail?: string | { msg?: string; message?: string };
  message?: string;
}

const describeError = (raw: string): string => {
  const start = raw.indexOf('{');
  if (start < 0) return raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw.slice(start)) as ZaiErrorBody;
    if (typeof parsed.detail === 'string') return parsed.detail;
    if (parsed.detail && typeof parsed.detail === 'object')
      return parsed.detail.msg ?? parsed.detail.message ?? raw.slice(0, 300);
    return parsed.message ?? raw.slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
};

/**
 * `fetchFromPage` already throws `httpStatusToToolError` on every non-2xx, so a
 * `response.ok` branch here would be dead code. What it does not do is use the
 * SPEC §0 code names — it emits `RATE_LIMITED` / `http_error` — so re-map by
 * category and re-message with z.ai's own `detail` instead of the raw body.
 *
 * The status is not the whole story either: z.ai answers a missing chat or folder
 * with **HTTP 500** and `{"detail":"failed to get chat: chat not found: <id>"}` —
 * verified live. Mapping that by status alone yields `UPSTREAM_ERROR,
 * retryable: true`, so a caller that asked for an id that does not exist would back
 * off and retry forever. The reason string is the only signal z.ai gives, so it
 * decides.
 */
const NOT_FOUND_PATTERN = /\bnot found\b|\bdoes not exist\b/i;

const toSpecError = (error: ToolError, url: string): ToolError => {
  const reason = describeError(error.message);
  const where = `${url} — ${reason}`;
  if (NOT_FOUND_PATTERN.test(reason))
    return new ToolError(`Not found: ${where}`, 'NOT_FOUND', { category: 'not_found' });
  switch (error.category) {
    case 'auth':
      return new ToolError(`z.ai rejected the request: ${where}`, 'AUTH_ERROR', { category: 'auth' });
    case 'not_found':
      return new ToolError(`Not found: ${where}`, 'NOT_FOUND', { category: 'not_found' });
    case 'validation':
      return new ToolError(`z.ai rejected the request: ${where}`, 'VALIDATION_ERROR', { category: 'validation' });
    case 'rate_limit':
      return new ToolError(`z.ai rate limited the request: ${where}`, 'RATE_LIMIT', {
        category: 'rate_limit',
        retryable: true,
        retryAfterMs: error.retryAfterMs,
      });
    case 'timeout':
      return new ToolError(`z.ai request timed out: ${where}`, 'TIMEOUT', { category: 'timeout', retryable: true });
    default:
      return new ToolError(`z.ai request failed: ${where}`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: error.retryable,
      });
  }
};

const request = async (endpoint: string, options: ApiOptions = {}): Promise<Response> => {
  const auth = requireAuth();

  const queryString = options.query ? buildQueryString(options.query) : '';
  const url = queryString ? `${API_BASE}${endpoint}?${queryString}` : `${API_BASE}${endpoint}`;

  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${auth.token}`,
  };
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
    throw new ToolError(`z.ai request failed: ${url} — ${String(error).slice(0, 200)}`, 'UPSTREAM_ERROR', {
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
      `z.ai returned a non-JSON body for ${endpoint} (${text.length} bytes). The API shape may have changed, or an interstitial was served at HTTP 200.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  }
};

// --- Shared helpers ---

export const conversationUrl = (conversationId: string): string => `https://chat.z.ai/c/${conversationId}`;
/** Folders have no dedicated route; z.ai filters the sidebar in place. */
export const projectUrl = (projectId: string): string => `https://chat.z.ai/?folder=${projectId}`;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Resolves the conversation id from the active z.ai tab when the caller omits one. */
export const resolveConversationId = (explicit?: string): string => {
  if (explicit) return explicit;
  const match = /\/c\/([0-9a-fA-F-]{36})/.exec(getCurrentUrl() ?? '');
  if (!match?.[1])
    throw ToolError.validation(
      'No conversation_id given and the active tab is not on a z.ai conversation (https://chat.z.ai/c/<uuid>).',
    );
  return match[1];
};
