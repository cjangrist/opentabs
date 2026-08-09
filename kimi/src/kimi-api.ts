import {
  ToolError,
  fetchFromPage,
  getCurrentUrl,
  getLocalStorage,
  setLocalStorage,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

// --- Constants ---

const API_ORIGIN = 'https://www.kimi.com';
const RPC_BASE = `${API_ORIGIN}/apiv2`;
const REFRESH_URL = `${API_ORIGIN}/api/auth/token/refresh`;

const ACCESS_TOKEN_KEY = 'access_token';
const REFRESH_TOKEN_KEY = 'refresh_token';

const RPC_TIMEOUT_MS = 60_000;
const CHAT_TIMEOUT_MS = 300_000;

/**
 * The OpenTabs adapter aborts a tool handler after 25s of script execution
 * (SPEC §2). Chat tools therefore stop *waiting* here and return what exists,
 * leaving the streaming fetch running in the page so the answer still lands.
 */
export const COMPLETION_WAIT_MS = 18_000;

export const conversationUrl = (conversationId: string): string => `${API_ORIGIN}/chat/${conversationId}`;
export const projectUrl = (projectId: string): string => `${API_ORIGIN}/project/${projectId}`;

/** Kimi timestamps are RFC-3339 strings; SPEC §0 wants unix seconds. */
export const toUnixSeconds = (value: string | undefined | null): number =>
  value ? Math.floor(new Date(value).getTime() / 1000) || 0 : 0;

// --- Auth ---

const readAccessToken = (): string | null => {
  const token = getLocalStorage(ACCESS_TOKEN_KEY);
  return token && token.length > 0 ? token : null;
};

const readRefreshToken = (): string | null => {
  const token = getLocalStorage(REFRESH_TOKEN_KEY);
  return token && token.length > 0 ? token : null;
};

/** True when the page holds a Kimi access token — i.e. the user is logged in. */
export const isAuthenticated = (): boolean => readAccessToken() !== null;

export const waitForAuth = (): Promise<boolean> =>
  waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 }).then(
    () => true,
    () => false,
  );

const requireAccessToken = (): string => {
  const token = readAccessToken();
  if (!token) throw ToolError.auth('Not authenticated — please log in to Kimi at https://www.kimi.com.');
  return token;
};

/**
 * Kimi access tokens live ~15 minutes. When one expires mid-session the SPA
 * silently refreshes it; a plugin call can land in that gap, so exchange the
 * long-lived refresh token for a fresh access token and persist it the same
 * way the app does.
 */
const refreshAccessToken = async (): Promise<string | null> => {
  const refreshToken = readRefreshToken();
  if (!refreshToken) return null;

  const response = await fetch(REFRESH_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${refreshToken}` },
    credentials: 'include',
  });
  if (!response.ok) return null;

  let payload: { access_token?: string; refresh_token?: string };
  try {
    payload = (await response.json()) as { access_token?: string; refresh_token?: string };
  } catch {
    // A 2xx whose body is not JSON (gateway interstitial, captive portal, empty body) means
    // the refresh did not actually happen — treat it as not-authenticated rather than letting
    // a raw SyntaxError escape callRpc uncategorised.
    return null;
  }
  if (!payload.access_token) return null;

  setLocalStorage(ACCESS_TOKEN_KEY, payload.access_token);
  if (payload.refresh_token) setLocalStorage(REFRESH_TOKEN_KEY, payload.refresh_token);
  return payload.access_token;
};

/** Device id the Kimi web app stamps on every gateway request. */
const readDeviceId = (): string => {
  const raw = getLocalStorage('volcano-token-info');
  if (!raw) return '';
  try {
    return (JSON.parse(raw) as { webId?: string }).webId ?? '';
  } catch {
    return '';
  }
};

/**
 * Reproduces the header set the Kimi web app sends. `x-msh-version` is not
 * cosmetic: without it the gateway serves an older experiment bucket whose
 * model list ("K2.6 Instant/Thinking/Agent") does not match what the site's own
 * model picker shows ("Instant/K3/K3 Swarm").
 */
const buildHeaders = (token: string, contentType: string): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    Authorization: `Bearer ${token}`,
    'x-msh-platform': 'web',
    'x-msh-version': '2.0.0',
    'x-language': 'en-US',
    'connect-protocol-version': '1',
  };

  const deviceId = readDeviceId();
  if (deviceId) headers['x-msh-device-id'] = deviceId;

  const trafficId = getLocalStorage('msh_user_id');
  if (trafficId) headers['x-traffic-id'] = trafficId;

  try {
    headers['r-timezone'] = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Timezone is advisory — omit it when the environment does not expose Intl.
  }

  return headers;
};

// --- Error classification (SPEC §0) ---

interface ConnectErrorBody {
  code?: string;
  message?: string;
  details?: {
    debug?: {
      reason?: string;
      localizedMessage?: { message?: string };
      violations?: { field?: { elements?: { fieldName?: string }[] }; message?: string }[];
    };
  }[];
}

/**
 * The gateway answers a rejected request with a Connect error envelope whose
 * `details` carry buf.validate violations naming the exact offending field.
 * Surfacing that beats echoing a base64 protobuf blob at the caller.
 */
const describeConnectError = (body: ConnectErrorBody): string => {
  const violations = (body.details ?? []).flatMap(detail => detail.debug?.violations ?? []);
  if (violations.length > 0) {
    return violations
      .map(violation => {
        const field = (violation.field?.elements ?? []).map(element => element.fieldName ?? '?').join('.');
        return `${field}: ${violation.message ?? 'invalid'}`;
      })
      .join('; ');
  }
  const localized = (body.details ?? [])
    .map(detail => detail.debug?.localizedMessage?.message)
    .find(message => typeof message === 'string' && message.length > 0);
  return body.message ?? localized ?? body.code ?? 'unknown error';
};

const CONNECT_CODE_TO_TOOL_ERROR: Record<string, (method: string, reason: string) => ToolError> = {
  unauthenticated: (_method, reason) =>
    ToolError.auth(`Kimi rejected the session (${reason}) — please reload https://www.kimi.com and log in.`),
  permission_denied: (_method, reason) =>
    ToolError.auth(`Kimi denied permission (${reason}) — please reload https://www.kimi.com and log in.`),
  not_found: (method, reason) => ToolError.notFound(`Kimi ${method}: ${reason}`),
  invalid_argument: (method, reason) => ToolError.validation(`Kimi rejected the request to ${method}: ${reason}`),
  resource_exhausted: (_method, reason) =>
    new ToolError(`Kimi rate limited: ${reason}`, 'RATE_LIMIT', { category: 'rate_limit', retryable: true }),
  deadline_exceeded: (method, reason) =>
    new ToolError(`Kimi timed out on ${method}: ${reason}`, 'TIMEOUT', { category: 'timeout', retryable: true }),
  unavailable: (method, reason) =>
    new ToolError(`Kimi is unavailable for ${method}: ${reason}`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    }),
};

export const connectErrorToToolError = (method: string, body: ConnectErrorBody): ToolError => {
  const reason = describeConnectError(body);
  const build = body.code ? CONNECT_CODE_TO_TOOL_ERROR[body.code] : undefined;
  if (build) return build(method, reason);
  return new ToolError(`Kimi ${method} failed (${body.code ?? 'unknown'}): ${reason}`, 'UPSTREAM_ERROR', {
    category: 'internal',
    retryable: true,
  });
};

const parseErrorBody = (raw: string): ConnectErrorBody => {
  try {
    return JSON.parse(raw) as ConnectErrorBody;
  } catch {
    return { message: raw.slice(0, 300) };
  }
};

// --- Connect-RPC unary calls (application/json) ---

/**
 * Calls a Connect-RPC unary method. Retries once with a refreshed access token
 * when the gateway rejects the current one.
 *
 * `fetch` is used directly rather than `fetchFromPage` because these calls are
 * same-origin from the kimi.com page and need the Authorization header the SPA
 * itself sends; every non-2xx is classified here into a SPEC §0 code.
 */
export const callRpc = async <T>(method: string, body: Record<string, unknown>): Promise<T> => {
  const send = async (token: string): Promise<Response> =>
    fetch(`${RPC_BASE}/${method}`, {
      method: 'POST',
      headers: buildHeaders(token, 'application/json'),
      credentials: 'include',
      body: JSON.stringify(body),
    });

  let response = await send(requireAccessToken());

  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw ToolError.auth('Kimi session expired — please reload https://www.kimi.com and log in.');
    response = await send(refreshed);
  }

  if (!response.ok) throw connectErrorToToolError(method, parseErrorBody(await response.text()));

  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolError(
      `Kimi returned a non-JSON body for ${method} (${text.length} bytes). The gateway response shape may have changed.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  }
};

// --- Connect streaming protocol (application/connect+json) ---

/** Wraps a JSON payload in a Connect envelope: 1 flag byte + 4-byte big-endian length + body. */
const encodeConnectFrame = (payload: unknown): Uint8Array => {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const frame = new Uint8Array(5 + json.length);
  new DataView(frame.buffer).setUint32(1, json.length);
  frame.set(json, 5);
  return frame;
};

/**
 * Opens a Connect streaming request and returns the live `Response` WITHOUT
 * draining it, so the caller can read frames as they arrive.
 *
 * Deep research needs this: the run stays open for minutes and parks — still
 * open — when it asks a clarifying question, so a buffered read would surface
 * neither the chat id nor the question until the run was already over.
 */
export const openConnectStream = async (method: string, payload: Record<string, unknown>): Promise<Response> => {
  const response = await fetch(`${RPC_BASE}/${method}`, {
    method: 'POST',
    headers: buildHeaders(requireAccessToken(), 'application/connect+json'),
    credentials: 'include',
    body: encodeConnectFrame(payload) as unknown as BodyInit,
  });
  if (!response.ok) throw connectErrorToToolError(method, parseErrorBody(await response.text()));
  return response;
};

/** Splits a Connect stream body back into its individual JSON events. */
export const decodeConnectFrames = (buffer: Uint8Array): Record<string, unknown>[] => {
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let offset = 0;

  while (offset + 5 <= buffer.length) {
    const length = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 4).getUint32(0);
    const body = decoder.decode(buffer.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
    try {
      events.push(JSON.parse(body) as Record<string, unknown>);
    } catch {
      // Trailer frames can be empty — skip anything that is not JSON.
    }
  }

  return events;
};

/**
 * Connect streaming replies always carry HTTP 200 — a failure arrives as an
 * end-of-stream frame holding an `error` object, so the status code alone never
 * reveals an expired token (SPEC §0).
 */
export const findStreamError = (events: Record<string, unknown>[]): ConnectErrorBody | null => {
  for (const event of events) {
    const error = (event as { error?: ConnectErrorBody }).error;
    if (error?.code) return error;
  }
  return null;
};

/** POSTs a Connect streaming request and returns its decoded event frames. */
export const callStreamingRpc = async (
  method: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>[]> => {
  const frame = encodeConnectFrame(payload);

  const send = async (token: string): Promise<Record<string, unknown>[]> => {
    const response = await fetchFromPage(`${RPC_BASE}/${method}`, {
      method: 'POST',
      headers: buildHeaders(token, 'application/connect+json'),
      body: frame as unknown as BodyInit,
      timeout: method.endsWith('/Chat') ? CHAT_TIMEOUT_MS : RPC_TIMEOUT_MS,
    });
    return decodeConnectFrames(new Uint8Array(await response.arrayBuffer()));
  };

  let events = await send(requireAccessToken());
  let streamError = findStreamError(events);

  if (streamError?.code === 'unauthenticated') {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw connectErrorToToolError(method, streamError);
    events = await send(refreshed);
    streamError = findStreamError(events);
  }

  if (streamError) throw connectErrorToToolError(method, streamError);
  return events;
};

/** Reads the chat id out of a /chat/<id> URL, or null when no chat is open. */
export const getCurrentConversationId = (): string | null => {
  const url = getCurrentUrl() ?? (typeof window === 'undefined' ? '' : window.location.href);
  const match = /\/chat\/([0-9a-fA-F-]{36})/.exec(url);
  return match?.[1] ?? null;
};

/** Resolves the conversation id from the active kimi.com tab when the caller omits one. */
export const resolveConversationId = (explicit?: string): string => {
  if (explicit) return explicit;
  const current = getCurrentConversationId();
  if (!current)
    throw ToolError.validation(
      'No conversation_id given and the active tab is not on a Kimi conversation (https://www.kimi.com/chat/<id>).',
    );
  return current;
};
