import { ToolError, fetchFromPage } from '@opentabs-dev/plugin-sdk';

// --- Aliyun captcha ---
//
// /api/v2/chat/completions refuses any completion without a `captcha_verify_param`
// and answers HTTP 200 with the refusal inside an SSE frame
// (`FRONTEND_CAPTCHA_REQUIRED`). The token is minted by the Aliyun SDK the page
// already loads: z.ai calls `initAliyunCaptcha` in silent ("isSign") mode and
// clicks a hidden trigger button, so no user interaction is involved. That is
// reproduced here rather than hardcoding anything — the scene id is read out of
// the frontend bundle the page loaded, because it is chosen by hostname at runtime
// (`hostname === "chat.z.ai" ? … : …`).

interface AliyunCaptchaOptions {
  SceneId: string;
  prefix?: string;
  region?: string;
  mode: string;
  element: string;
  button: string;
  language: string;
  timeout: number;
  delayBeforeSuccess: boolean;
  success: (verifyParam: string) => void;
  fail: (reason: unknown) => void;
  onError: (reason: unknown) => void;
  getInstance: (instance: unknown) => void;
}

declare global {
  interface Window {
    initAliyunCaptcha?: (options: AliyunCaptchaOptions) => void;
    AliyunCaptchaConfig?: { region?: string; prefix?: string };
  }
}

const CAPTCHA_ELEMENT_ID = 'opentabs-zai-captcha-element';
const CAPTCHA_BUTTON_ID = 'opentabs-zai-captcha-button';
const CAPTCHA_TIMEOUT_MS = 15_000;

let cachedSceneIds: string[] | null = null;

const bundleUrl = (): string | null => {
  for (const element of document.querySelectorAll<HTMLScriptElement>('script[src]')) {
    if (/\/z-ai\/frontend\/prod-fe-[\w.]+\/assets\/index-[\w-]+\.js$/.test(element.src)) return element.src;
  }
  return null;
};

/**
 * Extracts every captcha scene id the bundle defines, preferring the one guarded by
 * the current hostname. The bundle ships two config objects (a popup one for chat
 * and an embed one elsewhere), so candidates are tried in order rather than assumed.
 */
const extractSceneIds = (bundle: string): string[] => {
  const preferred: string[] = [];
  const others: string[] = [];
  const hostPattern = new RegExp(`${location.hostname.replace(/\./g, '\\.')}"\\s*\\?\\s*"([A-Za-z0-9]{4,20})"`);
  const marker = /SCENE_ID/g;
  let match = marker.exec(bundle);
  while (match) {
    const region = bundle.slice(match.index, match.index + 300);
    const conditional = hostPattern.exec(region);
    if (conditional?.[1]) preferred.push(conditional[1]);
    else {
      const plain = /SCENE_ID\s*:\s*"([A-Za-z0-9]{4,20})"/.exec(region);
      if (plain?.[1]) others.push(plain[1]);
    }
    match = marker.exec(bundle);
  }
  return [...new Set([...preferred, ...others])];
};

const getSceneIds = async (): Promise<string[]> => {
  if (cachedSceneIds) return cachedSceneIds;
  const url = bundleUrl();
  if (!url)
    throw new ToolError(
      'Could not locate the z.ai frontend bundle in the page, so the captcha scene id cannot be read. Reload https://chat.z.ai.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  const response = await fetch(url);
  const ids = extractSceneIds(await response.text());
  if (ids.length === 0)
    throw new ToolError(
      'The z.ai bundle no longer declares a captcha SCENE_ID. Sending requires a captcha token, so this must be re-derived before send_message can work.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  cachedSceneIds = ids;
  return ids;
};

const ensureCaptchaHost = (): void => {
  for (const id of [CAPTCHA_ELEMENT_ID, CAPTCHA_BUTTON_ID]) {
    if (document.getElementById(id)) continue;
    const node = id === CAPTCHA_BUTTON_ID ? document.createElement('button') : document.createElement('div');
    node.id = id;
    node.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;';
    document.body.appendChild(node);
  }
};

const mintWithScene = (sceneId: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`captcha timed out after ${CAPTCHA_TIMEOUT_MS}ms`))),
      CAPTCHA_TIMEOUT_MS,
    );
    const settle = (fn: () => void) =>
      finish(() => {
        clearTimeout(timer);
        fn();
      });

    try {
      window.initAliyunCaptcha?.({
        SceneId: sceneId,
        prefix: window.AliyunCaptchaConfig?.prefix,
        region: window.AliyunCaptchaConfig?.region,
        mode: 'popup',
        element: `#${CAPTCHA_ELEMENT_ID}`,
        button: `#${CAPTCHA_BUTTON_ID}`,
        language: 'en',
        timeout: CAPTCHA_TIMEOUT_MS - 2000,
        delayBeforeSuccess: false,
        success: verifyParam => settle(() => resolve(verifyParam)),
        fail: reason => settle(() => reject(new Error(`captcha failed: ${String(reason).slice(0, 120)}`))),
        onError: reason => settle(() => reject(new Error(`captcha error: ${String(reason).slice(0, 120)}`))),
        getInstance: () => {
          // z.ai's own flow triggers verification by clicking the hidden button.
          setTimeout(() => document.getElementById(CAPTCHA_BUTTON_ID)?.click(), 200);
        },
      });
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });

/** Mints a single-use captcha token, trying each scene the bundle declares. */
export const mintCaptchaToken = async (): Promise<string> => {
  if (typeof window.initAliyunCaptcha !== 'function')
    throw new ToolError(
      'The Aliyun captcha SDK is not loaded on this page, so a completion cannot be authorized. Reload https://chat.z.ai and try again.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  ensureCaptchaHost();
  const scenes = await getSceneIds();
  let lastError: unknown;
  for (const sceneId of scenes) {
    try {
      return await mintWithScene(sceneId);
    } catch (error) {
      lastError = error;
    }
  }
  throw new ToolError(
    `z.ai captcha verification failed for every known scene — ${String(lastError).slice(0, 160)}`,
    'UPSTREAM_ERROR',
    { category: 'internal', retryable: true },
  );
};

// --- Completion stream ---

interface StreamError {
  detail?: string;
  message?: string;
  code?: string | number;
  error_code?: string;
}

interface StreamFrame {
  type?: string;
  data?: {
    phase?: string;
    delta_content?: string;
    done?: boolean;
    error?: StreamError;
    data?: { error?: StreamError; done?: boolean };
  };
  error?: StreamError;
}

const describeStreamError = (error: StreamError): string =>
  `${error.detail ?? error.message ?? 'unknown error'}${error.code !== undefined ? ` (code ${error.code})` : ''}`;

/**
 * z.ai answers every completion with HTTP 200 and reports failure as an SSE frame —
 * an outdated `x-fe-version`, a missing captcha token and a rate limit all arrive
 * this way. Returning the assembled text without inspecting the frames would turn
 * each of those into a silent empty answer.
 */
export const parseCompletionStream = (raw: string): { text: string; streamError: string | undefined } => {
  let text = '';
  let streamError: string | undefined;

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let frame: StreamFrame;
    try {
      frame = JSON.parse(payload) as StreamFrame;
    } catch {
      continue;
    }

    const error = frame.error ?? frame.data?.error ?? frame.data?.data?.error;
    if (error) {
      streamError ??= describeStreamError(error);
      continue;
    }
    if (typeof frame.data?.delta_content === 'string') text += frame.data.delta_content;
  }

  return { text, streamError };
};

const COMPLETION_TIMEOUT_MS = 600_000;

/**
 * The OpenTabs adapter aborts a tool handler after 25s of script execution. Tools
 * therefore stop *waiting* at this budget without cancelling the request: the fetch
 * keeps running in the page and the answer still lands server-side, so the caller
 * polls get_conversation for the finished reply.
 */
export const COMPLETION_WAIT_MS = 18_000;

export interface CompletionOutcome {
  text: string;
  streamBytes: number;
}

/** Runs a completion to the end, raising on an in-stream error. */
export const runCompletion = async (
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<CompletionOutcome> => {
  const url = `/api/v2/chat/completions?requestId=${crypto.randomUUID()}&timestamp=${Date.now()}&version=0.0.1&platform=web&signature_timestamp=${Date.now()}`;
  const response = await fetchFromPage(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    timeout: COMPLETION_TIMEOUT_MS,
  });

  const raw = await response.text();
  const { text, streamError } = parseCompletionStream(raw);

  if (streamError)
    throw new ToolError(`z.ai completion failed: ${streamError}`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  if (!text && raw.length === 0)
    throw new ToolError(
      'z.ai returned an empty completion stream. The SSE format may have changed.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );

  return { text, streamBytes: raw.length };
};

/**
 * Starts a completion without draining it. Deep research holds the same SSE
 * connection open for many minutes while persisting progress server-side, and
 * SPEC §7 requires start_deep_research to return promptly.
 */
export const startCompletion = (body: Record<string, unknown>, headers: Record<string, string>): void => {
  void runCompletion(body, headers).catch(() => {
    // The run continues in the page; get_deep_research reports the real outcome.
  });
};
