import { ToolError, fetchFromPage } from '@opentabs-dev/plugin-sdk';
import { classifyRpcStatus } from './gemini-api.js';
import { type ResolvedModel, resolveThinkingHeaderValue } from './gemini-models.js';
import type { ThinkingLevel } from './tools/normalized-schemas.js';

/**
 * The OpenTabs adapter aborts a tool handler after 25s of script execution, which is
 * shorter than a Gemini Pro answer, so `create_conversation` / `send_message` stop
 * waiting well before that and let the generation finish in the page (SPEC §2).
 */
export const SEND_WAIT_MS = 18_000;
const SEND_TIMEOUT_MS = 300_000;
const RESEARCH_SEND_TIMEOUT_MS = 7_000;
const RESEARCH_AMBIGUOUS_ERROR = 'RESEARCH_CONFIRMATION_AMBIGUOUS';

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

export type ResearchPhase = 'plan' | 'start';

/**
 * Gemini Deep Research is a two-turn protocol. The first 97-slot request creates
 * a plan; the 98-slot continuation confirms that plan and starts the task. The
 * composer also supplies two opaque signed strings in slots 3 and 4, but live
 * requests with those slots unset produced the same native plan and task records,
 * so the adapter never copies short-lived browser tokens into plugin state.
 */
const buildResearchRequestBody = (
  prompt: string,
  atToken: string,
  phase: ResearchPhase,
  context?: [string, string, string],
): string => {
  if (phase === 'start' && !context)
    throw ToolError.validation('A Gemini Deep Research start confirmation requires the plan turn context.');

  const inner: unknown[] = new Array(phase === 'plan' ? 97 : 98).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0, null, null, [null, null, null, null, null, null, []]];
  inner[1] = ['en'];
  inner[2] = context
    ? [context[0], context[1], context[2], null, null, null, null, null, null, '']
    : ['', '', '', null, null, null, null, null, null, ''];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[phase === 'plan' ? 0 : 1]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[49] = 1;
  inner[53] = 0;
  inner[54] = phase === 'plan' ? [[[[[1]]]]] : [];
  inner[55] = phase === 'plan' ? [[1]] : [];
  inner[59] = crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = 1;
  inner[80] = 1;
  inner[91] = 0;
  inner[96] = 0;
  if (phase === 'start') inner[97] = [0];
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

const streamGenerateUrl = (bl: string, fsid: string): string =>
  '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' +
  `?bl=${encodeURIComponent(bl)}&f.sid=${encodeURIComponent(fsid)}&hl=en` +
  `&_reqid=${Math.floor(Math.random() * 10_000_000)}&rt=c`;

const streamGenerateHeaders = (modelId: string, thinkingValue: number): Record<string, string> => ({
  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  'X-Same-Domain': '1',
  'x-goog-ext-73010989-jspb': '[0]',
  'x-goog-ext-73010990-jspb': '[0,0,0]',
  'x-goog-ext-525001261-jspb': buildModelHeader(modelId, thinkingValue, crypto.randomUUID()),
  'x-goog-ext-525005358-jspb': JSON.stringify([crypto.randomUUID(), 1]),
});

const streamStatusCode = (frame: unknown[]): number | null => {
  if (typeof frame[5] === 'number') return frame[5];
  const status = Array.isArray(frame[5]) ? frame[5] : null;
  return status && typeof status[0] === 'number' ? status[0] : null;
};

/** StreamGenerate reports failures inside HTTP-200 response frames. */
const assertStreamSucceeded = (raw: string, phase: ResearchPhase): void => {
  let sawFrame = false;
  for (const line of raw.replace(/^\)\]\}'\n\n/, '').split('\n')) {
    if (!line.startsWith('[[')) continue;
    let frames: unknown;
    try {
      frames = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(frames)) continue;
    for (const value of frames) {
      if (!Array.isArray(value)) continue;
      sawFrame = true;
      if (value[0] === 'er') throw classifyRpcStatus(`StreamGenerate:${phase}`, streamStatusCode(value) ?? 500);
      if (value[0] === 'wrb.fr' && (typeof value[2] !== 'string' || value[2].length === 0)) {
        const code = streamStatusCode(value);
        if (code !== null && code !== 0) throw classifyRpcStatus(`StreamGenerate:${phase}`, code);
      }
    }
  }
  if (!sawFrame)
    throw new ToolError(
      `Gemini returned no decodable StreamGenerate frames during the Deep Research ${phase} turn (${raw.length} bytes).`,
      RESEARCH_AMBIGUOUS_ERROR,
      { category: 'internal', retryable: phase === 'plan' },
    );
};

/**
 * Issues the generation request and returns as soon as Gemini has accepted it,
 * WITHOUT reading the response body.
 *
 * This is deliberate and was verified live: consuming the stream and then abandoning
 * the reader when the tool budget expires cancels the body, and Gemini then throws
 * the whole turn away — a Pro answer abandoned at 18s never appeared in the
 * transcript, while the identical prompt left unread persisted in full. Callers poll
 * the transcript RPC for the result instead, which is also the authoritative copy.
 *
 * `fetchFromPage` already raises `httpStatusToToolError` on every non-2xx, so a
 * rejected send still surfaces here rather than silently doing nothing.
 */
export const startGenerate = async (
  prompt: string,
  atToken: string,
  bl: string,
  fsid: string,
  options: SendOptions,
): Promise<void> => {
  const thinkingValue = resolveThinkingHeaderValue(options.model, options.thinking, options.thinkingLevel);
  const response = await fetchFromPage(streamGenerateUrl(bl, fsid), {
    method: 'POST',
    headers: streamGenerateHeaders(options.model.id, thinkingValue),
    body: buildRequestBody(prompt, atToken, options.context),
    timeout: SEND_TIMEOUT_MS,
    // Gemini persists a turn only when generation FINISHES, and a Pro answer routinely
    // runs past the 25s tool budget. Without keepalive the request dies with the tool
    // handler and the whole turn is discarded — verified live: identical Pro sends were
    // lost from the plugin but persisted when issued from a context that outlived them.
    // The request body is ~1 KB, far inside keepalive's 64 KiB limit.
    keepalive: true,
  });

  if (response.status !== 200)
    throw new ToolError(`Gemini refused the message (HTTP ${response.status}).`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
};

/**
 * Runs one short control turn of the Deep Research protocol and consumes its
 * response so an error frame cannot be mistaken for a started task. The actual
 * research runs asynchronously after the confirmation response has closed.
 */
export const runResearchGenerate = async (
  prompt: string,
  atToken: string,
  bl: string,
  fsid: string,
  model: ResolvedModel,
  phase: ResearchPhase,
  context?: [string, string, string],
): Promise<void> => {
  const response = await fetchFromPage(streamGenerateUrl(bl, fsid), {
    method: 'POST',
    headers: streamGenerateHeaders(model.id, 1),
    body: buildResearchRequestBody(prompt, atToken, phase, context),
    timeout: RESEARCH_SEND_TIMEOUT_MS,
  }).catch(error => {
    if (error instanceof ToolError) throw error;
    const detail = error instanceof Error ? error.message : 'unknown fetch failure';
    throw new ToolError(`Gemini Deep Research ${phase} transport failed: ${detail}`, RESEARCH_AMBIGUOUS_ERROR, {
      category: 'internal',
      retryable: phase === 'plan',
    });
  });
  if (response.status !== 200)
    throw new ToolError(`Gemini refused the Deep Research ${phase} turn (HTTP ${response.status}).`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown response-read failure';
    throw new ToolError(
      `Gemini Deep Research ${phase} response could not be read: ${detail}`,
      RESEARCH_AMBIGUOUS_ERROR,
      {
        category: 'internal',
        retryable: phase === 'plan',
      },
    );
  }
  assertStreamSucceeded(raw, phase);
};
