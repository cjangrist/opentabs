import {
  type FetchFromPageOptions,
  ToolError,
  buildQueryString,
  fetchFromPage,
  getAuthCache,
  getCurrentUrl,
  getLocalStorage,
  setAuthCache,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

// --- Auth ---
//
// chat.qwen.ai is an Open WebUI derivative: it authenticates with a bearer JWT held
// in localStorage under `token`, not with cookies.
//
// The JWT is deliberately thin — probed live, it carries exactly
// `{id, last_password_change, exp}` and NO role/email claim — so the token alone
// cannot tell a signed-in account from the anonymous one `/api/config` enables
// (`enable_anonymous: true`). What it can prove is that a token exists and has not
// expired, which is what `isAuthenticated` claims and no more. Whether the session is
// a real account is answered by `get_current_user`, which reads `/api/v1/auths/` and
// returns the server's own `role`/`tier`; every other tool surfaces the difference
// naturally, because an anonymous account's own chats and projects are genuinely
// empty rather than hidden.

const API_ORIGIN = 'https://chat.qwen.ai';
const API_BASE = '/api';

interface QwenAuth {
  token: string;
  userId: string;
}

interface TokenClaims {
  id?: string;
  /** Unix seconds. Present on every Qwen token observed. */
  exp?: number;
}

const decodeTokenClaims = (token: string): TokenClaims | null => {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as TokenClaims;
  } catch {
    return null;
  }
};

const getAuth = (): QwenAuth | null => {
  const token = getLocalStorage('token');
  if (!token) return null;

  // Re-validate the cache against the live token: signing out and back in (or the
  // anonymous → user upgrade after Google SSO) rewrites localStorage, and a stale
  // cache would keep sending the previous bearer.
  const cached = getAuthCache<QwenAuth>('qwen');
  if (cached?.token === token) return cached;

  const claims = decodeTokenClaims(token);
  if (!claims?.id) return null;
  // An expired bearer is worse than none: every call would come back 401 with a
  // message about the endpoint rather than about the session.
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) return null;

  const auth: QwenAuth = { token, userId: claims.id };
  setAuthCache('qwen', auth);
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

const requireAuth = (): QwenAuth => {
  const auth = getAuth();
  if (!auth)
    throw ToolError.auth(
      'Not authenticated — open https://chat.qwen.ai and sign in. The page holds no unexpired Qwen bearer token in localStorage["token"].',
    );
  return auth;
};

export const getUserId = (): string => requireAuth().userId;

/** Bearer for requests that bypass `api()` — the completion stream, which is SSE. */
export const getBearerToken = (): string => requireAuth().token;

// --- Client version ---
//
// Qwen stamps a `Version` header carrying the frontend build the page is running.
// It is never hardcoded: the version is the path segment of the bundle the page
// itself loaded, so it tracks Qwen deployments automatically (0.2.82 → 0.2.83 landed
// during this plugin's own development).

const BUNDLE_VERSION_PATTERN = /\/qwenweb\/qwen-chat-fe\/([\d.]+)\//;
/** Last-resort value when the bundle URL cannot be read; the header is advisory. */
const FALLBACK_CLIENT_VERSION = '0.2.83';

export const getClientVersion = (): string => {
  const assetUrls = [
    ...[...document.querySelectorAll<HTMLScriptElement>('script[src]')].map(element => element.src),
    ...[...document.querySelectorAll<HTMLLinkElement>('link[href]')].map(element => element.href),
  ];
  for (const url of assetUrls) {
    const match = BUNDLE_VERSION_PATTERN.exec(url);
    if (match?.[1]) return match[1];
  }
  return FALLBACK_CLIENT_VERSION;
};

/**
 * Header set the Qwen SPA stamps on API requests.
 *
 * `bx-ua` / `bx-umidtoken` are deliberately NOT set here. chat.qwen.ai sits behind
 * Alibaba's Baxia risk control, whose SDK patches `window.fetch` in the page and
 * adds those headers itself. This plugin runs in the MAIN world, so the patched
 * fetch is the one `fetchFromPage` reaches — signing them here would replace a valid
 * token with a stale one. A tripped WAF does not error: the POST simply hangs.
 */
const buildHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${requireAuth().token}`,
    accept: 'application/json, text/plain, */*',
    source: 'web',
    Version: getClientVersion(),
    ...extra,
  };
  try {
    headers['x-request-id'] = crypto.randomUUID();
  } catch {
    // Advisory header — omit it when the environment lacks crypto.randomUUID.
  }
  return headers;
};

// --- Envelope + error mapping ---

/** Every `/api/v2/*` endpoint wraps its payload in this envelope. */
interface ApiEnvelope<T> {
  success?: boolean;
  request_id?: string;
  data?: T;
  code?: string | number;
  msg?: string;
  detail?: string;
}

const describeEnvelope = (envelope: ApiEnvelope<unknown>): string => {
  const nested = envelope.data as { code?: string; details?: string } | undefined;
  return (
    nested?.details ??
    envelope.msg ??
    envelope.detail ??
    nested?.code ??
    (envelope.code !== undefined ? `code ${envelope.code}` : 'unknown error')
  );
};

const NOT_FOUND_PATTERN = /\bnot[_ ]?found\b|\bdoes not exist\b/i;

/**
 * Decides whether a `success: false` envelope means "gone" rather than "broken".
 *
 * The machine-readable signal is `data.code` — verified live, a missing chat answers
 * HTTP 200 with `{"success":false,"data":{"code":"Not_Found","details":"This
 * conversation has been deleted…"}}`. Matching only `details` would miss it, because
 * that sentence never contains the words "not found", and the caller would be told to
 * retry an id that can never come back.
 */
const isNotFoundEnvelope = (envelope: ApiEnvelope<unknown>): boolean => {
  const nested = envelope.data as { code?: string; details?: string } | undefined;
  return [nested?.code, nested?.details, envelope.msg, envelope.detail, String(envelope.code ?? '')].some(
    value => typeof value === 'string' && NOT_FOUND_PATTERN.test(value),
  );
};

/**
 * `fetchFromPage` already throws `httpStatusToToolError` on every non-2xx, so an
 * `response.ok` branch would be dead code. What it does not do is use the SPEC §0
 * code names — it emits `RATE_LIMITED` / `http_error` — so the category is re-mapped
 * and re-messaged with Qwen's own `msg`/`details` instead of the raw body.
 */
const toSpecError = (error: ToolError, url: string): ToolError => {
  const reason = error.message.slice(0, 300);
  const where = `${url} — ${reason}`;
  if (NOT_FOUND_PATTERN.test(reason))
    return new ToolError(`Not found: ${where}`, 'NOT_FOUND', { category: 'not_found' });
  switch (error.category) {
    case 'auth':
      return new ToolError(`Qwen rejected the request: ${where}`, 'AUTH_ERROR', { category: 'auth' });
    case 'not_found':
      return new ToolError(`Not found: ${where}`, 'NOT_FOUND', { category: 'not_found' });
    case 'validation':
      return new ToolError(`Qwen rejected the request: ${where}`, 'VALIDATION_ERROR', { category: 'validation' });
    case 'rate_limit':
      return new ToolError(`Qwen rate limited the request: ${where}`, 'RATE_LIMIT', {
        category: 'rate_limit',
        retryable: true,
        retryAfterMs: error.retryAfterMs,
      });
    case 'timeout':
      return new ToolError(`Qwen request timed out: ${where}`, 'TIMEOUT', { category: 'timeout', retryable: true });
    default:
      return new ToolError(`Qwen request failed: ${where}`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: error.retryable,
      });
  }
};

const DEFAULT_TIMEOUT_MS = 30_000;
/** A deep-research completion holds its stream open for many minutes. */
export const COMPLETION_TIMEOUT_MS = 600_000;

interface ApiOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeout?: number;
}

const request = async (endpoint: string, options: ApiOptions = {}): Promise<Response> => {
  const queryString = options.query ? buildQueryString(options.query) : '';
  const url = queryString ? `${API_BASE}${endpoint}?${queryString}` : `${API_BASE}${endpoint}`;
  const headers = buildHeaders(options.body !== undefined ? { 'content-type': 'application/json' } : {});
  const init: FetchFromPageOptions = {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  try {
    return await fetchFromPage(url, init);
  } catch (error) {
    if (error instanceof ToolError) throw toSpecError(error, url);
    throw new ToolError(`Qwen request failed: ${url} — ${String(error).slice(0, 200)}`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  }
};

/**
 * Reads a JSON body. Two things can still go wrong once the response is `ok`:
 * reading the body can reject mid-stream, or a fully-read body can not be JSON at
 * all — Baxia serves a risk-control interstitial at HTTP 200. Both are classified so
 * nothing raw escapes: a mid-stream read failure is retryable, a non-JSON body is
 * not.
 */
const readJson = async <T>(response: Response, endpoint: string): Promise<T> => {
  let raw = '';
  try {
    raw = await response.text();
  } catch (error) {
    throw new ToolError(
      `Qwen response body from ${endpoint} could not be read: ${String(error).slice(0, 160)}`,
      'TIMEOUT',
      { category: 'timeout', retryable: true },
    );
  }
  if (!raw) return undefined as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ToolError(
      `Qwen returned a non-JSON body for ${endpoint} (${raw.length} bytes): ${raw.slice(0, 160)}`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  }
};

/** Calls an endpoint that returns a bare payload (the `/api/v1/*` and `/api/models` family). */
export const apiRaw = async <T>(endpoint: string, options: ApiOptions = {}): Promise<T> =>
  readJson<T>(await request(endpoint, options), endpoint);

/**
 * Calls a `/api/v2/*` endpoint and unwraps its envelope.
 *
 * `success: false` arrives at HTTP 200 — a missing chat answers 200 with
 * `{"success":false,"data":{"code":"Not_Found"}}` — so the envelope decides the
 * error, not the status.
 */
export const api = async <T>(endpoint: string, options: ApiOptions = {}): Promise<T> => {
  const envelope = await readJson<ApiEnvelope<T>>(await request(endpoint, options), endpoint);
  if (envelope === undefined) return undefined as T;
  if (envelope.success === false) {
    const reason = describeEnvelope(envelope);
    if (isNotFoundEnvelope(envelope))
      throw new ToolError(`Not found: ${endpoint} — ${reason}`, 'NOT_FOUND', { category: 'not_found' });
    throw new ToolError(`Qwen API error on ${endpoint}: ${reason}`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: false,
    });
  }
  return envelope.data as T;
};

// --- Shared helpers ---

export const conversationUrl = (conversationId: string): string => `${API_ORIGIN}/c/${conversationId}`;
export const projectUrl = (projectId: string): string => `${API_ORIGIN}/p/${projectId}`;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Resolves the conversation id from the active Qwen tab when the caller omits one. */
export const resolveConversationId = (explicit?: string): string => {
  if (explicit) return explicit;
  const match = /\/c\/([0-9a-fA-F-]{36})/.exec(getCurrentUrl() ?? '');
  if (!match?.[1])
    throw ToolError.validation(
      'No conversation_id given and the active tab is not on a Qwen conversation (https://chat.qwen.ai/c/<uuid>).',
    );
  return match[1];
};
