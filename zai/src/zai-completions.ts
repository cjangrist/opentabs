import { ToolError, fetchFromPage } from '@opentabs-dev/plugin-sdk';

// --- Aliyun captcha ---
//
// /api/v2/chat/completions refuses any completion without a `captcha_verify_param`
// and answers HTTP 200 with the refusal inside an SSE frame
// (`FRONTEND_CAPTCHA_REQUIRED`). z.ai mints the token by lazily injecting Aliyun's
// SDK, publishing `window.AliyunCaptchaConfig`, calling `initAliyunCaptcha` in
// silent mode and clicking a hidden trigger button — no user interaction. That
// bootstrap is reproduced here, and every input to it (SDK url, region, prefix,
// mode, scene id) is parsed out of the frontend bundle the page loaded rather than
// hardcoded: z.ai picks the scene id by hostname at runtime, and the whole config
// moves whenever the frontend is redeployed.

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
const SDK_LOAD_TIMEOUT_MS = 10_000;

export interface CaptchaConfig {
  sceneId: string;
  prefix: string | null;
  region: string | null;
  mode: string;
}

interface CaptchaBootstrap {
  scriptUrl: string;
  configs: CaptchaConfig[];
}

let cachedBootstrap: CaptchaBootstrap | null = null;

const bundleUrl = (): string | null => {
  for (const element of document.querySelectorAll<HTMLScriptElement>('script[src]')) {
    if (/\/z-ai\/frontend\/prod-fe-[\w.]+\/assets\/index-[\w-]+\.js$/.test(element.src)) return element.src;
  }
  return null;
};

/**
 * Reads every captcha config the bundle declares.
 *
 * z.ai ships two: a popup one guarded by `hostname === "chat.z.ai"` that the chat
 * composer uses, and a plain embed one for other surfaces. The hostname-guarded
 * match is preferred and the rest are kept as ordered fallbacks, so a redeploy that
 * reshuffles them degrades to "try the next scene" instead of failing outright.
 */
export const parseCaptchaConfigs = (bundle: string): CaptchaConfig[] => {
  const preferred: CaptchaConfig[] = [];
  const others: CaptchaConfig[] = [];
  const hostPattern = new RegExp(`${location.hostname.replace(/\./g, '\\.')}"\\s*\\?\\s*"([A-Za-z0-9]{4,20})"`);
  const marker = /SCENE_ID/g;
  let match = marker.exec(bundle);
  while (match) {
    const region = bundle.slice(Math.max(0, match.index - 300), match.index + 320);
    const prefix = /PREFIX\s*:\s*"([A-Za-z0-9_-]+)"/.exec(region)?.[1] ?? null;
    const mode = /MODE\s*:\s*"([a-z]+)"/.exec(region)?.[1] ?? 'popup';
    // REGION is minified to a shared const, so resolve the identifier when it is not
    // written inline.
    const regionToken = /REGION\s*:\s*("?[A-Za-z0-9_$]+"?)/.exec(region)?.[1] ?? null;
    let regionValue: string | null = null;
    if (regionToken?.startsWith('"')) regionValue = regionToken.slice(1, -1);
    else if (regionToken)
      regionValue = new RegExp(`\\b${regionToken}\\s*=\\s*"([a-z]{2,8})"`).exec(bundle)?.[1] ?? null;

    const conditional = hostPattern.exec(region);
    if (conditional?.[1]) preferred.push({ sceneId: conditional[1], prefix, region: regionValue, mode });
    else {
      const plain = /SCENE_ID\s*:\s*"([A-Za-z0-9]{4,20})"/.exec(region)?.[1];
      if (plain) others.push({ sceneId: plain, prefix, region: regionValue, mode });
    }
    match = marker.exec(bundle);
  }
  const seen = new Set<string>();
  return [...preferred, ...others].filter(config => !seen.has(config.sceneId) && seen.add(config.sceneId));
};

const CAPTCHA_SDK_PATTERN = /https?:\/\/[^"'`\s]*alicdn[^"'`\s]*[Cc]aptcha[^"'`\s]*\.js/;

const loadBootstrap = async (): Promise<CaptchaBootstrap> => {
  if (cachedBootstrap) return cachedBootstrap;
  const url = bundleUrl();
  if (!url)
    throw new ToolError(
      'Could not locate the z.ai frontend bundle in the page, so the captcha configuration cannot be read. Reload https://chat.z.ai.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  const bundle = await (await fetch(url)).text();
  const configs = parseCaptchaConfigs(bundle);
  const scriptUrl = CAPTCHA_SDK_PATTERN.exec(bundle)?.[0];
  if (configs.length === 0 || !scriptUrl)
    throw new ToolError(
      `The z.ai bundle no longer declares a captcha configuration (scenes=${configs.length}, sdk=${scriptUrl ?? 'none'}). Completions require a captcha token, so this must be re-derived.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  cachedBootstrap = { scriptUrl, configs };
  return cachedBootstrap;
};

/** Injects Aliyun's SDK the same way z.ai does, and only when it is not already there. */
const ensureCaptchaSdk = async (bootstrap: CaptchaBootstrap): Promise<void> => {
  if (typeof window.initAliyunCaptcha === 'function') return;
  const first = bootstrap.configs[0];
  window.AliyunCaptchaConfig = {
    region: first?.region ?? window.AliyunCaptchaConfig?.region,
    prefix: first?.prefix ?? window.AliyunCaptchaConfig?.prefix,
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('captcha SDK load timed out')), SDK_LOAD_TIMEOUT_MS);
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${bootstrap.scriptUrl}"]`);
    const target = existing ?? document.createElement('script');
    if (!existing) {
      target.src = bootstrap.scriptUrl;
      target.async = true;
    }
    target.addEventListener('load', () => settle(resolve));
    target.addEventListener('error', () => settle(() => reject(new Error('captcha SDK failed to load'))));
    if (!existing) document.head.appendChild(target);
  });
  if (typeof window.initAliyunCaptcha !== 'function')
    throw new Error('captcha SDK loaded but initAliyunCaptcha is still missing');
};

const ensureCaptchaHost = (): void => {
  for (const id of [CAPTCHA_ELEMENT_ID, CAPTCHA_BUTTON_ID]) {
    if (document.getElementById(id)) continue;
    const node = id === CAPTCHA_BUTTON_ID ? document.createElement('button') : document.createElement('div');
    node.id = id;
    if (node instanceof HTMLButtonElement) {
      node.type = 'button';
      node.tabIndex = -1;
      node.setAttribute('aria-hidden', 'true');
    }
    node.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;';
    document.body.appendChild(node);
  }
};

const mintWithConfig = (config: CaptchaConfig): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`captcha timed out after ${CAPTCHA_TIMEOUT_MS}ms`));
    }, CAPTCHA_TIMEOUT_MS);
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    try {
      window.initAliyunCaptcha?.({
        SceneId: config.sceneId,
        prefix: config.prefix ?? undefined,
        region: config.region ?? undefined,
        mode: config.mode,
        element: `#${CAPTCHA_ELEMENT_ID}`,
        button: `#${CAPTCHA_BUTTON_ID}`,
        language: 'en',
        timeout: CAPTCHA_TIMEOUT_MS - 2000,
        delayBeforeSuccess: false,
        success: verifyParam => settle(() => resolve(verifyParam)),
        fail: reason => settle(() => reject(new Error(`captcha failed: ${String(reason).slice(0, 120)}`))),
        onError: reason => settle(() => reject(new Error(`captcha error: ${String(reason).slice(0, 120)}`))),
        getInstance: () => {
          // z.ai triggers verification by clicking its hidden button; so do we.
          setTimeout(() => document.getElementById(CAPTCHA_BUTTON_ID)?.click(), 200);
        },
      });
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });

/** Mints a single-use captcha token, trying each scene the bundle declares. */
export const mintCaptchaToken = async (): Promise<string> => {
  const bootstrap = await loadBootstrap();
  try {
    await ensureCaptchaSdk(bootstrap);
  } catch (error) {
    throw new ToolError(
      `Could not load z.ai's Aliyun captcha SDK, so a completion cannot be authorized — ${String(error).slice(0, 160)}`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  }
  ensureCaptchaHost();
  let lastError: unknown;
  for (const config of bootstrap.configs) {
    try {
      return await mintWithConfig(config);
    } catch (error) {
      lastError = error;
    }
  }
  throw new ToolError(
    `z.ai captcha verification failed for every scene the bundle declares — ${String(lastError).slice(0, 160)}`,
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
 * Total wall-clock a send handler may consume, measured from handler entry rather
 * than from the moment the stream starts. The OpenTabs adapter aborts at 25s of
 * script execution and that clock includes preparation (model bootstrap, chat
 * creation, bundle read, captcha round trip), which alone can cost several seconds.
 * The 5s of headroom covers reading the turn back afterwards.
 */
export const HANDLER_BUDGET_MS = 20_000;

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
