import { ToolError, fetchFromPage } from '@opentabs-dev/plugin-sdk';
import { type ResolvedModel, resolveThinkingHeaderValue } from './gemini-models.js';
import type { ThinkingLevel } from './tools/normalized-schemas.js';

/**
 * The OpenTabs adapter aborts a tool handler after 25s of script execution, which is
 * shorter than a Gemini Pro answer, so `create_conversation` / `send_message` stop
 * waiting well before that and let the generation finish in the page (SPEC §2).
 */
export const SEND_WAIT_MS = 18_000;
const SEND_TIMEOUT_MS = 300_000;

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
      'x-goog-ext-525005358-jspb': JSON.stringify([crypto.randomUUID(), 1]),
    },
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
