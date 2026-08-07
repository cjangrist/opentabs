import {
  type FetchFromPageOptions,
  ToolError,
  buildQueryString,
  fetchFromPage,
  fetchJSON,
  getAuthCache,
  getCookie,
  setAuthCache,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

// --- Auth ---
// Claude.ai uses HttpOnly session cookies — requests with credentials: 'include'
// are automatically authenticated. We detect auth via the lastActiveOrg cookie,
// the only place claude.ai exposes the active org id in the page.

interface ClaudeAuth {
  orgId: string;
}

const getAuth = (): ClaudeAuth | null => {
  const cached = getAuthCache<ClaudeAuth>('claude');
  if (cached) return cached;

  const orgId = getCookie('lastActiveOrg');
  if (!orgId) return null;

  const auth: ClaudeAuth = { orgId };
  setAuthCache('claude', auth);
  return auth;
};

export const isAuthenticated = (): boolean => getAuth() !== null;

export const waitForAuth = async (): Promise<boolean> => {
  try {
    await waitUntil(() => isAuthenticated(), {
      interval: 500,
      timeout: 5000,
    });
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

export const api = async <T>(
  endpoint: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<T> => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth('Not authenticated — please log in to Claude.');

  const qs = options.query ? buildQueryString(options.query) : '';
  const url = qs ? `${API_BASE}${endpoint}?${qs}` : `${API_BASE}${endpoint}`;

  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  const init: FetchFromPageOptions = { method, headers };

  if (options.body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const data = await fetchJSON<T>(url, init);
  return data as T;
};

// Completions can run well past the SDK's 30s default, especially on Opus.
const COMPLETION_TIMEOUT_MS = 300_000;

interface SseFrame {
  type?: string;
  // Legacy `rendering_mode: 'text'` frames
  completion?: string;
  // Modern `rendering_mode: 'messages'` frames
  delta?: { type?: string; text?: string };
  content_block?: { type?: string; text?: string };
  error?: { type?: string; message?: string };
  message?: { error?: { message?: string } };
}

// For the streaming completion endpoint — collects SSE chunks into a full response.
// claude.ai emits two different SSE dialects depending on `rendering_mode`:
//   'text'     -> {type:'completion', completion:'...'}          (legacy)
//   'messages' -> {type:'content_block_delta', delta:{type:'text_delta', text:'...'}}
// Handle both so a server-side default flip cannot silently produce an empty string.
export const apiStream = async (endpoint: string, body: unknown): Promise<string> => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth('Not authenticated — please log in to Claude.');

  const url = `${API_BASE}${endpoint}`;
  const response = await fetchFromPage(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: COMPLETION_TIMEOUT_MS,
  });

  const text = await response.text();

  let fullText = '';
  let streamError: string | undefined;

  for (const line of text.split('\n')) {
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
      fullText += frame.completion;
      continue;
    }
    if (frame.type === 'content_block_start' && frame.content_block?.type === 'text' && frame.content_block.text) {
      fullText += frame.content_block.text;
      continue;
    }
    if (frame.type === 'content_block_delta' && frame.delta?.type === 'text_delta' && frame.delta.text) {
      fullText += frame.delta.text;
    }
  }

  // HTTP 200 on an SSE endpoint does not mean the completion succeeded — the
  // failure arrives as an in-stream frame. Never hand back a silent empty string.
  if (streamError) throw ToolError.internal(`Claude completion failed: ${streamError}`);
  if (!fullText) {
    throw ToolError.internal(
      `Claude completion returned no text (${text.length} bytes of stream). ` +
        'The completion SSE format may have changed.',
    );
  }

  return fullText;
};

// Org-scoped API shorthand
export const orgApi = async <T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<T> => {
  const orgId = getOrgId();
  return api<T>(`/organizations/${orgId}${path}`, options);
};
