import { ToolError, fetchFromPage, getCookie, waitUntil, type FetchFromPageOptions } from '@opentabs-dev/plugin-sdk';

export const ORIGIN = 'https://grok.com';
export const ASSET_ORIGIN = 'https://assets.grok.com';
const REST_BASE = `${ORIGIN}/rest`;
const USER_ID_COOKIE = 'x-userid';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface GrokUser {
  id: string;
  email: string;
  name: string;
  username: string;
  subscriptionTier: string;
  createdAt: string;
}

interface RawUser {
  userId?: string;
  email?: string;
  givenName?: string;
  familyName?: string;
  xUsername?: string;
  xSubscriptionType?: string;
  createTime?: string;
}

interface ErrorBody {
  code?: string | number;
  message?: string;
  detail?: string | { message?: string };
  error?: string | { message?: string };
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeout?: number;
}

const describeError = (raw: string): string => {
  const start = raw.indexOf('{');
  if (start < 0) return raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw.slice(start)) as ErrorBody;
    if (typeof parsed.detail === 'string') return parsed.detail;
    if (parsed.detail && typeof parsed.detail === 'object' && parsed.detail.message) return parsed.detail.message;
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error === 'object' && parsed.error.message) return parsed.error.message;
    return parsed.message ?? raw.slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
};

const NOT_FOUND_PATTERN = /\bnot found\b|\bdoes not exist\b|\bunknown conversation\b/i;

const toSpecError = (error: ToolError, url: string): ToolError => {
  const reason = describeError(error.message);
  const where = `${url} — ${reason}`;
  if (NOT_FOUND_PATTERN.test(reason))
    return new ToolError(`Not found: ${where}`, 'NOT_FOUND', { category: 'not_found', retryable: false });
  switch (error.category) {
    case 'auth':
      return new ToolError(`Grok rejected the request: ${where}`, 'AUTH_ERROR', {
        category: 'auth',
        retryable: false,
      });
    case 'not_found':
      return new ToolError(`Not found: ${where}`, 'NOT_FOUND', {
        category: 'not_found',
        retryable: false,
      });
    case 'validation':
      return new ToolError(`Grok rejected the request: ${where}`, 'VALIDATION_ERROR', {
        category: 'validation',
        retryable: false,
      });
    case 'rate_limit':
      return new ToolError(`Grok rate limited the request: ${where}`, 'RATE_LIMIT', {
        category: 'rate_limit',
        retryable: true,
        retryAfterMs: error.retryAfterMs,
      });
    case 'timeout':
      return new ToolError(`Grok request timed out: ${where}`, 'TIMEOUT', {
        category: 'timeout',
        retryable: true,
      });
    default:
      return new ToolError(`Grok request failed: ${where}`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: error.retryable,
      });
  }
};

const buildQuery = (query: ApiOptions['query']): string => {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
};

export const api = async <T>(endpoint: string, options: ApiOptions = {}): Promise<T> => {
  const query = buildQuery(options.query);
  const url = `${REST_BASE}${endpoint}${query ? `?${query}` : ''}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: FetchFromPageOptions = {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetchFromPage(url, init);
  } catch (error) {
    if (error instanceof ToolError) throw toSpecError(error, url);
    throw new ToolError(`Grok request failed: ${url} — ${String(error).slice(0, 200)}`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    throw new ToolError(
      `Grok returned a non-JSON body for ${endpoint} (${text.length} bytes). The API shape may have changed or an interstitial was served.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  }

  const errorBody = parsed as ErrorBody;
  if (
    parsed &&
    typeof parsed === 'object' &&
    errorBody.message &&
    (errorBody.code !== undefined || errorBody.error !== undefined)
  ) {
    const reason = describeError(JSON.stringify(errorBody));
    if (NOT_FOUND_PATTERN.test(reason))
      throw new ToolError(`Not found: ${reason}`, 'NOT_FOUND', {
        category: 'not_found',
        retryable: false,
      });
    throw new ToolError(`Grok returned an error payload: ${reason}`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: false,
    });
  }
  return parsed;
};

const readUserId = (): string | null => {
  const value = getCookie(USER_ID_COOKIE);
  return value && value.length > 0 ? value : null;
};

export const isAuthenticated = (): boolean => readUserId() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

export const requireUserId = (): string => {
  const userId = readUserId();
  if (!userId) {
    throw new ToolError('Not authenticated — please log in to Grok at https://grok.com.', 'AUTH_ERROR', {
      category: 'auth',
      retryable: false,
    });
  }
  return userId;
};

export const getCurrentUser = async (): Promise<GrokUser> => {
  const user = await api<RawUser>('/auth/get-user');
  if (!user.userId)
    throw new ToolError('Grok did not return an account — please log in at https://grok.com.', 'AUTH_ERROR', {
      category: 'auth',
      retryable: false,
    });
  return {
    id: user.userId,
    email: user.email ?? '',
    name: [user.givenName, user.familyName].filter(Boolean).join(' '),
    username: user.xUsername ?? '',
    subscriptionTier: user.xSubscriptionType ?? '',
    createdAt: user.createTime ?? '',
  };
};

export const toUnixSeconds = (value: unknown): number => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    return Math.floor(Math.abs(value) > 1e11 ? value / 1000 : value);
  }
  if (typeof value !== 'string' || value.trim().length === 0) return 0;
  if (/^-?\d+(?:\.\d+)?$/.test(value.trim())) return toUnixSeconds(Number(value));
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : Math.floor(timestamp / 1000);
};

export const conversationUrl = (conversationId: string): string => `${ORIGIN}/c/${conversationId}`;

export const projectUrl = (projectId: string): string => `${ORIGIN}/project/${projectId}`;

export const getCurrentConversationId = (): string | null => {
  const match = window.location.pathname.match(/\/c\/([0-9a-fA-F-]{36})/);
  return match?.[1] ?? null;
};
