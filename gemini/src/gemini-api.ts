import {
  ToolError,
  clearAuthCache,
  fetchFromPage,
  getAuthCache,
  getCurrentUrl,
  getPageGlobal,
  setAuthCache,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

// --- Auth ---
//
// gemini.google.com is a Google "WIZ" app: the session lives in HttpOnly cookies and
// the per-page CSRF token plus the backend build/session ids are published on
// `window.WIZ_global_data`. Every RPC below is a `batchexecute` call that needs all
// three, so their presence is the auth signal.

interface GeminiAuth {
  atToken: string;
  bl: string;
  fsid: string;
  email: string;
  userId: string;
}

const getWizData = (key: string): string | undefined => getPageGlobal(`WIZ_global_data.${key}`) as string | undefined;

const readAuthFromPage = (): GeminiAuth | null => {
  const atToken = getWizData('SNlM0e');
  const bl = getWizData('cfb2h');
  const fsid = getWizData('FdrFJe');
  if (!atToken || !bl || !fsid) return null;
  return {
    atToken,
    bl,
    fsid,
    email: getWizData('oPEP7c') ?? '',
    userId: getWizData('S06Grb') ?? '',
  };
};

/**
 * The cached copy is re-validated against the live page on every call: the `at`
 * token is rotated on every full page load, and a stale one makes every RPC fail
 * with a bare HTTP 400 that looks nothing like an auth error.
 */
const getAuth = (): GeminiAuth | null => {
  const live = readAuthFromPage();
  if (!live) return getAuthCache<GeminiAuth>('gemini') ?? null;
  const cached = getAuthCache<GeminiAuth>('gemini');
  if (cached?.atToken === live.atToken) return cached;
  setAuthCache('gemini', live);
  return live;
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

export const getUserInfo = (): { email: string; userId: string } => {
  const auth = requireAuth();
  return { email: auth.email, userId: auth.userId };
};

/** CSRF token plus backend build/session ids, needed by the streaming send path. */
export const getAuthTokens = (): { atToken: string; bl: string; fsid: string } => {
  const auth = requireAuth();
  return { atToken: auth.atToken, bl: auth.bl, fsid: auth.fsid };
};

const requireAuth = (): GeminiAuth => {
  const auth = getAuth();
  if (!auth) {
    clearAuthCache('gemini');
    throw ToolError.auth('Not authenticated — please log in to Google Gemini (https://gemini.google.com).');
  }
  return auth;
};

// --- batchexecute RPC ---

const RPC_TIMEOUT_MS = 60_000;

/**
 * Gemini's backend answers a `batchexecute` call with a length-prefixed stream of
 * JSON arrays, not a JSON document:
 *
 *   )]}'\n\n<byteLength>\n[["wrb.fr","<rpcId>","<payload-as-json-string>",…],…]\n…
 *
 * A failing RPC arrives on the SAME HTTP 200 as either an `["er",…]` frame or a
 * `wrb.fr` frame whose payload slot is null and whose slot 5 carries the gRPC status
 * plus a `BardErrorInfo`. Both must be classified — an HTTP 200 here means nothing.
 */
export interface RpcFrame<T> {
  /** Decoded payload, present only on success. */
  data: T | null;
  /** gRPC-ish status code from a null-payload frame, e.g. 13. */
  statusCode: number | null;
  /** `BardErrorInfo` detail codes, e.g. [1096] for "cursor is past the end". */
  errorInfo: number[];
}

/** `[type.googleapis.com/…BardErrorInfo, [1096]]` → `[1096]`. */
const extractBardErrorInfo = (details: unknown): number[] => {
  if (!Array.isArray(details)) return [];
  const codes: number[] = [];
  for (const detail of details) {
    if (!Array.isArray(detail)) continue;
    const [typeUrl, values] = detail as [unknown, unknown];
    if (typeof typeUrl !== 'string' || !typeUrl.includes('BardErrorInfo')) continue;
    if (Array.isArray(values)) codes.push(...values.filter((value): value is number => typeof value === 'number'));
  }
  return codes;
};

const parseBatchResponse = <T>(raw: string, rpcId: string): RpcFrame<T> => {
  const cleaned = raw.replace(/^\)\]\}'\n\n/, '');
  let result: RpcFrame<T> | null = null;

  for (const line of cleaned.split('\n')) {
    if (!line.startsWith('[[')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    for (const frame of parsed) {
      if (!Array.isArray(frame)) continue;

      if (frame[0] === 'er') {
        const code = typeof frame[5] === 'number' ? frame[5] : 500;
        throw classifyRpcStatus(rpcId, code);
      }

      if (frame[0] !== 'wrb.fr' || frame[1] !== rpcId) continue;

      const payload = frame[2];
      if (typeof payload === 'string' && payload.length > 0) {
        try {
          return { data: JSON.parse(payload) as T, statusCode: null, errorInfo: [] };
        } catch {
          throw new ToolError(
            `Gemini returned an undecodable payload for ${rpcId} (${payload.length} bytes). The RPC shape may have changed.`,
            'UPSTREAM_ERROR',
            { category: 'internal', retryable: false },
          );
        }
      }

      const status = Array.isArray(frame[5]) ? (frame[5] as unknown[]) : null;
      result = {
        data: null,
        statusCode: status && typeof status[0] === 'number' ? status[0] : null,
        errorInfo: extractBardErrorInfo(status?.[2]),
      };
    }
  }

  if (result) return result;
  throw new ToolError(
    `Gemini returned no ${rpcId} frame in a ${raw.length}-byte batchexecute response. The transport may have changed.`,
    'UPSTREAM_ERROR',
    { category: 'internal', retryable: false },
  );
};

export const classifyRpcStatus = (rpcId: string, code: number): ToolError => {
  if (code === 401 || code === 403 || code === 16) {
    clearAuthCache('gemini');
    return new ToolError(
      `Gemini rejected ${rpcId} (${code}) — the session expired. Reload https://gemini.google.com.`,
      'AUTH_ERROR',
      { category: 'auth' },
    );
  }
  if (code === 429 || code === 8)
    return new ToolError(`Gemini rate limited ${rpcId} (${code}).`, 'RATE_LIMIT', {
      category: 'rate_limit',
      retryable: true,
    });
  if (code === 404 || code === 5)
    return new ToolError(`Gemini has no such resource for ${rpcId} (${code}).`, 'NOT_FOUND', {
      category: 'not_found',
    });
  if (code === 3 || code === 400)
    return new ToolError(`Gemini rejected the arguments for ${rpcId} (${code}).`, 'VALIDATION_ERROR', {
      category: 'validation',
    });
  return new ToolError(`Gemini RPC ${rpcId} failed with status ${code}.`, 'UPSTREAM_ERROR', {
    category: 'internal',
    retryable: true,
  });
};

/** Low-level call that hands back the raw frame so callers can interpret error codes. */
export const callRpcFrame = async <T>(rpcId: string, args: unknown): Promise<RpcFrame<T>> => {
  const auth = requireAuth();
  const argsJson = typeof args === 'string' ? args : JSON.stringify(args);
  const body = `f.req=${encodeURIComponent(JSON.stringify([[[rpcId, argsJson, null, 'generic']]]))}&at=${encodeURIComponent(auth.atToken)}&`;
  const url =
    `/_/BardChatUi/data/batchexecute?rpcids=${rpcId}` +
    `&source-path=${encodeURIComponent(window.location.pathname)}` +
    `&bl=${encodeURIComponent(auth.bl)}&f.sid=${encodeURIComponent(auth.fsid)}` +
    `&hl=en&_reqid=${Math.floor(Math.random() * 10_000_000)}&rt=c`;

  const response = await fetchFromPage(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Same-Domain': '1',
    },
    body,
    timeout: RPC_TIMEOUT_MS,
  });

  return parseBatchResponse<T>(await response.text(), rpcId);
};

/** Call that treats any error frame as fatal. Use `callRpcFrame` when a code is meaningful. */
export const callRpc = async <T>(rpcId: string, args: unknown): Promise<T> => {
  const frame = await callRpcFrame<T>(rpcId, args);
  if (frame.data === null) throw classifyRpcStatus(rpcId, frame.statusCode ?? 500);
  return frame.data;
};

// --- Shared helpers ---

/** Gemini timestamps are `[seconds, nanos]` tuples. */
export const tupleToUnixSeconds = (value: unknown): number => {
  if (!Array.isArray(value) || typeof value[0] !== 'number') return 0;
  return Math.floor(value[0]);
};

/** Ids are stored as `c_<hex>` / `r_<hex>` / `rc_<hex>` but routed as bare hex. */
export const stripIdPrefix = (id: string): string => id.replace(/^(c|r|rc)_/, '');
export const toConversationId = (id: string): string => (id.startsWith('c_') ? id : `c_${id}`);

export const conversationUrl = (conversationId: string): string =>
  `https://gemini.google.com/app/${stripIdPrefix(conversationId)}`;

/** Resolves the conversation id from the active gemini.google.com tab when omitted. */
export const resolveConversationId = (explicit?: string): string => {
  if (explicit) return toConversationId(explicit);
  const match = /gemini\.google\.com\/app\/([0-9a-f]{8,})/.exec(getCurrentUrl() ?? '');
  if (!match?.[1])
    throw ToolError.validation(
      'No conversation_id given and the active tab is not on a Gemini conversation (https://gemini.google.com/app/<id>).',
    );
  return toConversationId(match[1]);
};

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const asString = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
