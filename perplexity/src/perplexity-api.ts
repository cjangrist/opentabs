import {
  type FetchFromPageOptions,
  ToolError,
  fetchFromPage,
  getCurrentUrl,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

// --- Constants ---

export const API_ORIGIN = 'https://www.perplexity.ai';
const REST_BASE = `${API_ORIGIN}/rest`;

/**
 * The Perplexity SPA stamps every REST call with its build version and an
 * entry-point tag. The gateway serves older/absent values from the same
 * handlers, but the schematized answer blocks (`use_schematized_api`) are only
 * guaranteed for the version the site itself sends, so keep this in sync with
 * what the network tab shows.
 */
const CLIENT_VERSION = '2.18';
const CLIENT_SOURCE = 'default';
export const VERSION_QUERY = `version=${CLIENT_VERSION}&source=${CLIENT_SOURCE}`;
export const CLIENT_VERSION_VALUE = CLIENT_VERSION;
export const CLIENT_SOURCE_VALUE = CLIENT_SOURCE;

const SESSION_URL = `${API_ORIGIN}/api/auth/session?${VERSION_QUERY}`;

const DEFAULT_TIMEOUT_MS = 30_000;
/** Answers routinely run for minutes; the SDK's 30s default would abort them. */
export const ASK_TIMEOUT_MS = 600_000;

/**
 * The OpenTabs adapter aborts a tool handler after 25s of script execution,
 * which is far short of a Perplexity answer (let alone a research run). Tools
 * stop *waiting* at this budget and return what exists; the fetch keeps running
 * in the page, so the answer still lands server-side and get_conversation
 * returns it.
 */
export const COMPLETION_WAIT_MS = 16_000;

// --- Auth ---

interface SessionResponse {
  user?: {
    id?: string;
    email?: string;
    username?: string;
    org_role?: string;
    subscription_status?: string;
  };
}

/**
 * Perplexity keeps its session in an HttpOnly cookie, so there is nothing in
 * localStorage or `document.cookie` to inspect — the only honest readiness check
 * is asking the session endpoint who we are. Logged out it answers `200 {}`, so
 * the presence of `user.id` is the real signal.
 */
export const fetchSessionUser = async (): Promise<NonNullable<SessionResponse['user']> | null> => {
  try {
    const response = await fetchFromPage(SESSION_URL, { timeout: 15_000 });
    const data = (await response.json()) as SessionResponse;
    return data?.user?.id ? data.user : null;
  } catch {
    return null;
  }
};

export const isAuthenticated = async (): Promise<boolean> => (await fetchSessionUser()) !== null;

export const waitForAuth = async (): Promise<boolean> => {
  try {
    await waitUntil(async () => await isAuthenticated(), { interval: 1000, timeout: 6000 });
    return true;
  } catch {
    return false;
  }
};

export const requireSession = async (): Promise<NonNullable<SessionResponse['user']>> => {
  const user = await fetchSessionUser();
  if (!user) throw ToolError.auth('Not signed in to Perplexity — please log in at https://www.perplexity.ai.');
  return user;
};

// --- API caller ---

export interface ApiOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeout?: number;
}

interface PerplexityErrorBody {
  detail?: string | { error_code?: string; message?: string };
  error_code?: string;
  message?: string;
}

/** Pulls Perplexity's own message and error_code out of an SDK error whose text embeds the body. */
const describeError = (raw: string): { reason: string; code: string | null } => {
  const start = raw.indexOf('{');
  if (start < 0) return { reason: raw.slice(0, 300), code: null };
  try {
    const parsed = JSON.parse(raw.slice(start)) as PerplexityErrorBody;
    const detail = parsed.detail;
    if (typeof detail === 'string') return { reason: detail, code: parsed.error_code ?? null };
    return {
      reason: detail?.message ?? parsed.message ?? raw.slice(0, 300),
      code: detail?.error_code ?? parsed.error_code ?? null,
    };
  } catch {
    return { reason: raw.slice(0, 300), code: null };
  }
};

/**
 * Perplexity answers "this thread/Space is gone or was never yours" with 400 or
 * 403 plus an `error_code`, which the SDK's status mapping turns into
 * VALIDATION_ERROR / AUTH_ERROR. SPEC §0 wants NOT_FOUND for all of them.
 */
const NOT_FOUND_CODES = new Set([
  'ENTRY_DELETED',
  'ENTRY_EXPIRED',
  'VIEW_THREAD_NOT_ALLOWED',
  'INVALID_THREAD',
  'INVALID_COLLECTION',
  'VIEW_COLLECTION_NOT_ALLOWED',
  'COLLECTION_ACCESS_NOT_ALLOWED',
  'SPACE_ACCESS_NOT_ALLOWED',
]);

/**
 * `fetchFromPage` already throws `httpStatusToToolError` on every non-2xx, so a
 * `response.ok` branch here would be dead code. What it does NOT do is use the
 * SPEC §0 code names — it emits `RATE_LIMITED` and `http_error` — so re-map by
 * category and re-message with Perplexity's own reason instead of the raw body.
 */
const toSpecError = (error: ToolError, url: string): ToolError => {
  const { reason, code } = describeError(error.message);
  const where = `${url.replace(API_ORIGIN, '')} — ${reason}`;
  if (code && NOT_FOUND_CODES.has(code))
    return new ToolError(`Not found (${code}): ${where}`, 'NOT_FOUND', { category: 'not_found' });
  switch (error.category) {
    case 'auth':
      return new ToolError(`Perplexity rejected the session: ${where}`, 'AUTH_ERROR', { category: 'auth' });
    case 'not_found':
      return new ToolError(`Not found: ${where}`, 'NOT_FOUND', { category: 'not_found' });
    case 'validation':
      return new ToolError(`Perplexity rejected the request: ${where}`, 'VALIDATION_ERROR', { category: 'validation' });
    case 'rate_limit':
      return new ToolError(`Perplexity rate limited the request: ${where}`, 'RATE_LIMIT', {
        category: 'rate_limit',
        retryable: true,
        retryAfterMs: error.retryAfterMs,
      });
    case 'timeout':
      return new ToolError(`Perplexity request timed out: ${where}`, 'TIMEOUT', {
        category: 'timeout',
        retryable: true,
      });
    default:
      return new ToolError(`Perplexity request failed: ${where}`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: error.retryable,
      });
  }
};

const buildUrl = (endpoint: string, query: ApiOptions['query']): string => {
  const params = new URLSearchParams(VERSION_QUERY);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  return `${REST_BASE}${endpoint}?${params.toString()}`;
};

export const request = async (endpoint: string, options: ApiOptions = {}): Promise<Response> => {
  const url = buildUrl(endpoint, options.query);
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
    throw new ToolError(`Perplexity request failed: ${endpoint} — ${String(error).slice(0, 200)}`, 'UPSTREAM_ERROR', {
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
      `Perplexity returned a non-JSON body for ${endpoint} (${text.length} bytes). The API shape may have changed.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  }
};

// --- GraphQL ---

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: { message?: string }[];
}

/**
 * The Library pages the thread list through Relay persisted queries. The gateway
 * rejects ad-hoc GraphQL documents ("Access denied"), so the sha256 hashes that
 * ship with the frontend build are the only way in — and it answers HTTP 200
 * even for FORBIDDEN / PersistedQueryNotFound, so `errors` must be inspected.
 */
export const graphql = async <T>(
  operationName: string,
  sha256Hash: string,
  variables: Record<string, unknown>,
): Promise<T> => {
  const response = await request('/perplexity_ask/graphql', {
    method: 'POST',
    body: { operationName, variables, extensions: { persistedQuery: { version: 1, sha256Hash } } },
  });
  const payload = (await response.json()) as GraphqlEnvelope<T>;
  if (payload.errors?.length)
    throw new ToolError(
      `Perplexity GraphQL rejected ${operationName}: ${payload.errors[0]?.message ?? 'unknown error'}`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  if (!payload.data)
    throw new ToolError(`Perplexity GraphQL returned no data for ${operationName}.`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: false,
    });
  return payload.data;
};

// --- Shared helpers ---

export const toUnixSeconds = (value: string | undefined | null): number => {
  if (!value) return 0;
  // Perplexity stamps naive UTC datetimes ("2026-08-07T08:00:35.771841") with no
  // zone suffix, which Date would read as local time.
  const normalized = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  return Math.floor(new Date(normalized).getTime() / 1000) || 0;
};

export const conversationUrl = (conversationId: string): string => `${API_ORIGIN}/search/${conversationId}`;
export const projectUrl = (slug: string): string => `${API_ORIGIN}/projects/${slug}`;

/** Reads the thread id out of the active tab's /search/<slug> URL, or null. */
export const getCurrentConversationId = (): string | null => {
  const match = /\/search\/([^/?#]+)/.exec(getCurrentUrl() ?? '');
  return match?.[1] ?? null;
};

export const resolveConversationId = (explicit?: string): string => {
  const resolved = explicit ?? getCurrentConversationId();
  if (!resolved)
    throw ToolError.validation(
      'No conversation_id given and the active tab is not on a Perplexity thread (https://www.perplexity.ai/search/<slug>).',
    );
  return resolved;
};

export const randomUuid = (): string => crypto.randomUUID();
