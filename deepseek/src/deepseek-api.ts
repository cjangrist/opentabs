import { ToolError, fetchFromPage, getLocalStorage, waitUntil } from '@opentabs-dev/plugin-sdk';

export const API_ORIGIN = 'https://chat.deepseek.com';
export const API_BASE = `${API_ORIGIN}/api/v0`;
export const COMPLETION_PATH = '/api/v0/chat/completion';

/** localStorage key holding the bearer token the DeepSeek SPA signs requests with. */
const USER_TOKEN_KEY = 'userToken';
const DEVICE_ID_KEY = '__ds_remote_feature_did';

const CLIENT_VERSION = '2.3.0';
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long a chat tool waits for the completion stream before returning
 * `status: "in_progress"` (SPEC §2). The OpenTabs adapter aborts a handler at 25s
 * with a platform timeout carrying no result, and DeepSeek's proof-of-work solve
 * costs ~2s before the stream even opens, so the wait budget is kept well under it.
 */
export const COMPLETION_WAIT_MS = 18_000;
export const COMPLETION_TIMEOUT_MS = 300_000;

// DeepSeek business error codes, mirroring the enum in the site bundle.
/**
 * A catch-all "illegal argument" code. The same value carries `ILLEGAL_COUNT`,
 * `ILLEGAL_CHAT_SESSION_ID` and `invalid chat session id`, so the accompanying
 * `biz_msg` is the only thing that separates a bad parameter from a missing row.
 */
const BIZ_ILLEGAL_ARGUMENT = 1;
const BIZ_INVALID_PARAM = 2;
const BIZ_MISSING_TOKEN = 40002;
const BIZ_INVALID_TOKEN = 40003;
const BIZ_USER_IS_BANNED = 40012;
const BIZ_IP_ACCESS_RESTRICTED = 40029;
const BIZ_POW_HEADER_ERROR = 40300;
const BIZ_INVALID_POW_RESPONSE = 40301;
const BIZ_MUTED = 50006;

/** Both spellings DeepSeek uses when it cannot find the chat session you named. */
const SESSION_NOT_FOUND_PATTERN = /chat[_ ]session[_ ]id/i;

/**
 * DeepSeek timestamps are float seconds (e.g. 1786049193.788). SPEC §0 wants
 * integer unix seconds.
 */
export const toUnixSeconds = (value: number | null | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;

// --- Auth ---

/**
 * The SPA wraps its localStorage values as `{"value": ..., "__version": "0"}`.
 * Reads the inner value, tolerating a bare string for robustness.
 */
const readWrappedValue = (key: string): string | null => {
  const raw = getLocalStorage(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { value?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.value === 'string') return parsed.value;
  } catch {
    // Not JSON — fall through and treat the raw string as the value.
  }
  return raw.length > 0 ? raw : null;
};

const readUserToken = (): string | null => {
  const token = readWrappedValue(USER_TOKEN_KEY);
  return token && token.length > 0 ? token : null;
};

/** True when the page holds a DeepSeek bearer token — i.e. the user is logged in. */
export const isAuthenticated = (): boolean => readUserToken() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

const requireUserToken = (): string => {
  const token = readUserToken();
  if (!token) {
    throw ToolError.auth('Not authenticated — please log in to DeepSeek at https://chat.deepseek.com.');
  }
  return token;
};

/** The SPA's device id. `GET /client/settings` rejects a request without it. */
export const readDeviceId = (): string => getLocalStorage(DEVICE_ID_KEY) ?? '';

/** Reproduces the header set the DeepSeek web app stamps on every API request. */
export const buildHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${requireUserToken()}`,
    accept: '*/*',
    'x-client-platform': 'web',
    'x-client-version': CLIENT_VERSION,
    'x-client-locale': 'en_US',
    'x-client-bundle-id': 'com.deepseek.chat',
    ...extra,
  };

  try {
    headers['x-client-timezone-offset'] = String(-new Date().getTimezoneOffset() * 60);
  } catch {
    // Timezone is advisory — omit it when the environment does not expose it.
  }

  return headers;
};

// --- Envelope handling ---

interface ApiEnvelope<T> {
  code?: number;
  msg?: string;
  data?: { biz_code?: number; biz_msg?: string; biz_data?: T };
}

/**
 * Maps a DeepSeek business code onto the SPEC §0 error taxonomy.
 *
 * Every DeepSeek response is HTTP 200 with the real outcome in `data.biz_code`,
 * so this — not the status line — is where a rejected request is classified.
 */
export const bizErrorToToolError = (code: number, message: string): ToolError => {
  const detail = message || `code ${code}`;
  switch (code) {
    case BIZ_MISSING_TOKEN:
    case BIZ_INVALID_TOKEN:
      return ToolError.auth(
        `DeepSeek rejected the session (${detail}) — please reload https://chat.deepseek.com and log in.`,
        'AUTH_ERROR',
      );
    case BIZ_USER_IS_BANNED:
    case BIZ_IP_ACCESS_RESTRICTED:
      return ToolError.auth(`DeepSeek denied access: ${detail}`, 'AUTH_ERROR');
    case BIZ_MUTED:
      return ToolError.rateLimited(`DeepSeek has temporarily muted this account: ${detail}`, undefined, 'RATE_LIMIT');
    case BIZ_ILLEGAL_ARGUMENT:
      return SESSION_NOT_FOUND_PATTERN.test(detail)
        ? ToolError.notFound(`DeepSeek has no such conversation: ${detail}`, 'NOT_FOUND')
        : ToolError.validation(`DeepSeek rejected the request parameters: ${detail}`, 'VALIDATION_ERROR');
    case BIZ_INVALID_PARAM:
      return ToolError.validation(`DeepSeek rejected the request parameters: ${detail}`, 'VALIDATION_ERROR');
    case BIZ_POW_HEADER_ERROR:
    case BIZ_INVALID_POW_RESPONSE:
      return new ToolError(`DeepSeek rejected the proof-of-work header: ${detail}`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    default:
      return new ToolError(`DeepSeek API error: ${detail}`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: false,
      });
  }
};

/** Unwraps DeepSeek's `{code, data: {biz_code, biz_data}}` envelope. */
const unwrap = <T>(envelope: ApiEnvelope<T>, allowNullData: boolean): T => {
  if (envelope.code !== undefined && envelope.code !== 0) {
    throw bizErrorToToolError(envelope.code, envelope.msg ?? '');
  }
  const data = envelope.data;
  if (!data)
    throw new ToolError('DeepSeek returned an empty response envelope.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  if (data.biz_code !== undefined && data.biz_code !== 0) {
    throw bizErrorToToolError(data.biz_code, data.biz_msg ?? '');
  }
  if (data.biz_data === undefined || data.biz_data === null) {
    if (allowNullData) return null as T;
    throw new ToolError('DeepSeek returned no data for this request.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  }
  return data.biz_data;
};

const callApi = async <T>(
  path: string,
  init?: RequestInit & { timeout?: number; allowNullData?: boolean },
): Promise<T> => {
  const response = await fetchFromPage(`${API_BASE}${path}`, {
    ...init,
    headers: buildHeaders((init?.headers as Record<string, string>) ?? {}),
    credentials: 'include',
    timeout: init?.timeout ?? REQUEST_TIMEOUT_MS,
  });

  const body = await response.text();
  let envelope: ApiEnvelope<T>;
  try {
    envelope = JSON.parse(body) as ApiEnvelope<T>;
  } catch {
    throw new ToolError(
      `DeepSeek returned a non-JSON response for ${path} — the session may have been bounced to a challenge page.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  }
  return unwrap<T>(envelope, init?.allowNullData === true);
};

export const getApi = <T>(path: string, options?: { allowNullData?: boolean }): Promise<T> =>
  callApi<T>(path, { method: 'GET', allowNullData: options?.allowNullData });

export const postApi = <T>(
  path: string,
  body: unknown,
  options?: { timeout?: number; allowNullData?: boolean },
): Promise<T> =>
  callApi<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeout: options?.timeout,
    allowNullData: options?.allowNullData,
  });

// --- Page state ---

export const conversationUrl = (conversationId: string): string => `${API_ORIGIN}/a/chat/s/${conversationId}`;

/** Reads the chat session id out of an /a/chat/s/<id> URL, or null when none is open. */
export const getCurrentConversationId = (): string | null => {
  const match = window.location.pathname.match(/\/chat\/s\/([0-9a-fA-F-]{36})/);
  return match?.[1] ?? null;
};

export const resolveConversationId = (explicit?: string): string => {
  if (explicit) return explicit;
  const current = getCurrentConversationId();
  if (!current)
    throw ToolError.validation(
      'No conversation_id given and the active tab is not on a DeepSeek conversation (https://chat.deepseek.com/a/chat/s/<id>).',
      'VALIDATION_ERROR',
    );
  return current;
};

// --- SSE ---

export interface SseEvent {
  event: string;
  data: string;
}

/** Splits an SSE body into its `event:`/`data:` records. */
export const parseSseEvents = (body: string): SseEvent[] => {
  const events: SseEvent[] = [];

  for (const block of body.split(/\r?\n\r?\n/)) {
    if (block.trim().length === 0) continue;
    let name = '';
    const dataLines: string[] = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }

    if (dataLines.length > 0 || name.length > 0) events.push({ event: name, data: dataLines.join('\n') });
  }

  return events;
};
