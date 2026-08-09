import { ToolError, fetchFromPage } from '@opentabs-dev/plugin-sdk';
import { asArray, asString } from './gemini-api.js';
import { type ResolvedModel, resolveThinkingHeaderValue } from './gemini-models.js';
import type { ThinkingLevel } from './tools/normalized-schemas.js';

/**
 * The OpenTabs adapter aborts a tool handler after 25s of script execution, which is
 * shorter than a Gemini Pro answer. Tools therefore stop *reading* the stream at this
 * budget without aborting the request, so generation continues in the page and the
 * answer still lands server-side (SPEC §2).
 */
export const STREAM_WAIT_MS = 18_000;
const STREAM_TIMEOUT_MS = 300_000;

export interface SendResult {
  conversationId: string | null;
  responseId: string | null;
  responseChoiceId: string | null;
  text: string;
  complete: boolean;
}

export interface SendOptions {
  model: ResolvedModel;
  thinking?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** `[conversationId, responseId, responseChoiceId]` when continuing a conversation. */
  context?: [string, string, string];
}

/**
 * `StreamGenerate` takes a jspb positional array, not a JSON object. Positions are
 * mirrored from gemini.google.com's own composer request; unset slots stay null.
 */
const buildRequestBody = (prompt: string, atToken: string, context?: [string, string, string]): string => {
  const inner: unknown[] = new Array(69).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ['en'];
  if (context) inner[2] = [context[0], context[1], context[2]];
  inner[6] = [1];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[2]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[61] = [];
  inner[68] = 2;
  const outer = JSON.stringify([null, JSON.stringify(inner)]);
  return `f.req=${encodeURIComponent(outer)}&at=${encodeURIComponent(atToken)}&`;
};

/**
 * Mode + thinking are carried in headers, not the body. Slot 4 is the mode id and
 * slot 15 is the thinking selector (1 = standard, 2 = Extended thinking); both are
 * serialized with JSON.stringify so no value can produce a malformed jspb array.
 */
const buildModelHeader = (modelId: string, thinkingValue: number, sessionId: string): string =>
  JSON.stringify([
    1,
    null,
    null,
    null,
    modelId,
    null,
    null,
    0,
    [4, 5, 6, 8],
    null,
    null,
    2,
    null,
    null,
    3,
    thinkingValue,
    sessionId,
  ]);

interface StreamState {
  conversationId: string | null;
  responseId: string | null;
  responseChoiceId: string | null;
  text: string;
  errorCode: number | null;
}

/**
 * Every streamed chunk repeats the whole answer so far, so the last chunk carrying
 * text wins. Errors arrive inside the same HTTP 200 as an `["er", …, code]` frame
 * and are recorded rather than skipped.
 */
const consumeChunk = (raw: string, state: StreamState): void => {
  for (const line of raw.split('\n')) {
    if (!line.startsWith('[[')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const frame of asArray(parsed)) {
      if (!Array.isArray(frame)) continue;
      if (frame[0] === 'er') {
        state.errorCode = typeof frame[5] === 'number' ? frame[5] : 500;
        continue;
      }
      if (frame[0] !== 'wrb.fr' || typeof frame[2] !== 'string') continue;
      let data: unknown;
      try {
        data = JSON.parse(frame[2]);
      } catch {
        continue;
      }
      if (!Array.isArray(data)) continue;
      const ids = asArray(data[1]);
      const conversationId = asString(ids[0]);
      const responseId = asString(ids[1]);
      if (conversationId?.startsWith('c_')) state.conversationId = conversationId;
      if (responseId?.startsWith('r_')) state.responseId = responseId;

      const candidate = asArray(asArray(data[4])[0]);
      const choiceId = asString(candidate[0]);
      if (choiceId?.startsWith('rc_')) state.responseChoiceId = choiceId;
      const text = asArray(candidate[1])[0];
      if (typeof text === 'string' && text) state.text = text;
    }
  }
};

const classifyStreamError = (code: number): ToolError => {
  if (code === 401 || code === 403)
    return new ToolError(
      'Gemini rejected the message — the session expired. Reload https://gemini.google.com.',
      'AUTH_ERROR',
      { category: 'auth' },
    );
  if (code === 429)
    return new ToolError('Gemini rate limited the message.', 'RATE_LIMIT', { category: 'rate_limit', retryable: true });
  return new ToolError(`Gemini failed to generate a response (status ${code}).`, 'UPSTREAM_ERROR', {
    category: 'internal',
    retryable: true,
  });
};

/**
 * Sends a prompt and reads the stream until it finishes or {@link STREAM_WAIT_MS}
 * elapses, whichever comes first. The reader is abandoned rather than cancelled at
 * the deadline so the in-flight generation is never aborted.
 */
export const streamGenerate = async (
  prompt: string,
  atToken: string,
  bl: string,
  fsid: string,
  options: SendOptions,
): Promise<SendResult> => {
  const thinkingValue = resolveThinkingHeaderValue(options.model, options.thinking, options.thinkingLevel);
  const sessionId = crypto.randomUUID();
  const url =
    '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' +
    `?bl=${encodeURIComponent(bl)}&f.sid=${encodeURIComponent(fsid)}&hl=en` +
    `&_reqid=${Math.floor(Math.random() * 10_000_000)}&rt=c`;

  const response = await fetchFromPage(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Same-Domain': '1',
      'x-goog-ext-73010989-jspb': '[0]',
      'x-goog-ext-73010990-jspb': '[0,0,0]',
      'x-goog-ext-525001261-jspb': buildModelHeader(options.model.id, thinkingValue, crypto.randomUUID()),
      'x-goog-ext-525005358-jspb': JSON.stringify([sessionId, 1]),
    },
    body: buildRequestBody(prompt, atToken, options.context),
    timeout: STREAM_TIMEOUT_MS,
  });

  const state: StreamState = {
    conversationId: null,
    responseId: null,
    responseChoiceId: null,
    text: '',
    errorCode: null,
  };

  const body = response.body;
  let complete = false;
  if (!body) {
    consumeChunk(await response.text(), state);
    complete = true;
  } else {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + STREAM_WAIT_MS;
    let buffered = '';
    while (Date.now() < deadline) {
      const timeLeft = deadline - Date.now();
      const next = await Promise.race([
        reader.read(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), timeLeft)),
      ]);
      if (next === null) break;
      if (next.done) {
        complete = true;
        break;
      }
      buffered += decoder.decode(next.value, { stream: true });
      consumeChunk(buffered, state);
    }
  }

  if (state.errorCode !== null) throw classifyStreamError(state.errorCode);
  return {
    conversationId: state.conversationId,
    responseId: state.responseId,
    responseChoiceId: state.responseChoiceId,
    text: state.text,
    complete,
  };
};
