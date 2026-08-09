import { ToolError, fetchFromPage } from '@opentabs-dev/plugin-sdk';
import {
  COMPLETION_TIMEOUT_MS,
  classifyCompletionEnvelope,
  getBearerToken,
  getClientVersion,
  isRiskControlChallenged,
  riskControlError,
} from './qwen-api.js';

/**
 * Total wall-clock a send handler may consume, measured from handler entry rather
 * than from the moment the stream starts. The OpenTabs adapter aborts a tool handler
 * after 25s of *script execution*, and that clock includes preparation — the model
 * bootstrap and the chat-session POST both cost real time before a single token is
 * generated. The 5s of headroom covers reading the turn back afterwards.
 */
export const HANDLER_BUDGET_MS = 20_000;

// --- SSE ---

/** Splits an SSE body into the JSON payload of each `data:` record. */
const parseSseData = (body: string): unknown[] => {
  const payloads: unknown[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    const joined = dataLines.join('\n');
    if (joined === '[DONE]') continue;
    try {
      payloads.push(JSON.parse(joined));
    } catch {
      // Qwen emits keep-alive comments between records; skip anything unparseable.
    }
  }
  return payloads;
};

interface StreamFrame {
  'response.created'?: { chat_id?: string; parent_id?: string; response_id?: string };
  choices?: { delta?: { role?: string; content?: unknown; phase?: string; status?: string } }[];
  error?: unknown;
  code?: string | number;
  msg?: string;
  detail?: string;
  success?: boolean;
}

/**
 * Qwen answers every completion with HTTP 200 and reports failure as a frame inside
 * the stream — a risk-control rejection, a quota refusal and a bad parameter all
 * arrive this way. Returning the assembled text without inspecting the frames would
 * turn each of those into a silent empty answer.
 */
const describeStreamError = (frame: StreamFrame): string | null => {
  if (frame.success === false) return frame.msg ?? frame.detail ?? `code ${frame.code ?? 'unknown'}`;
  if (frame.error !== undefined && frame.error !== null) {
    if (typeof frame.error === 'string') return frame.error;
    const nested = frame.error as { message?: string; detail?: string; code?: string | number };
    return nested.message ?? nested.detail ?? `code ${nested.code ?? 'unknown'}`;
  }
  // A bare code/detail frame with no choices is Qwen's inline rejection shape.
  if (frame.choices === undefined && (frame.msg !== undefined || frame.detail !== undefined))
    return frame.msg ?? frame.detail ?? null;
  return null;
};

export interface CompletionOutcome {
  responseId: string;
  parentMessageId: string;
  /** Concatenated `answer`-phase text. Empty for a turn that only produced tool phases. */
  text: string;
  /** Phases seen in the stream, in order — useful for diagnosing an empty answer. */
  phases: string[];
  streamBytes: number;
}

/**
 * Folds the completion stream.
 *
 * `incremental_output: true` makes every `answer` delta a suffix, so the reply is a
 * plain concatenation. Reasoning and web-search phases instead resend a cumulative
 * snapshot on every frame, and their real content is only attached to the *stored*
 * message — so this deliberately extracts nothing but the answer text and the ids,
 * and the caller re-reads the chat record for everything else.
 */
export const foldStream = (body: string): CompletionOutcome => {
  const payloads = parseSseData(body);
  const outcome: CompletionOutcome = {
    responseId: '',
    parentMessageId: '',
    text: '',
    phases: [],
    streamBytes: body.length,
  };
  let previousPhase = '';

  for (const payload of payloads) {
    const frame = payload as StreamFrame;
    const error = describeStreamError(frame);
    if (error)
      throw new ToolError(`Qwen completion failed: ${error}`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });

    const created = frame['response.created'];
    if (created) {
      outcome.responseId = created.response_id ?? outcome.responseId;
      outcome.parentMessageId = created.parent_id ?? outcome.parentMessageId;
      continue;
    }

    for (const choice of frame.choices ?? []) {
      const delta = choice.delta;
      if (!delta) continue;
      const phase = delta.phase ?? 'answer';
      if (phase !== previousPhase) {
        outcome.phases.push(phase);
        previousPhase = phase;
      }
      if (phase === 'answer' && typeof delta.content === 'string') outcome.text += delta.content;
    }
  }

  return outcome;
};

const completionUrl = (conversationId: string): string =>
  `/api/v2/chat/completions?chat_id=${encodeURIComponent(conversationId)}`;

/**
 * Runs a completion to the end and folds it, raising on an in-stream error.
 *
 * The Baxia `bx-ua` / `bx-umidtoken` risk-control headers are NOT set here: the SDK
 * the page loads patches `window.fetch` and adds them itself, and this plugin runs in
 * the MAIN world so that patched fetch is the one used. Signing them here would send
 * a stale token.
 *
 * A challenged session is checked for BEFORE posting, because Baxia does not reject
 * a request — it holds it. Measured live, a completion issued under the verification
 * slider hung for 307 seconds; without this guard the handler would simply block for
 * the whole COMPLETION_TIMEOUT_MS and then blame the SSE format.
 */
export const runCompletion = async (
  conversationId: string,
  body: Record<string, unknown>,
): Promise<CompletionOutcome> => {
  if (isRiskControlChallenged()) throw riskControlError();

  const response = await fetchFromPage(completionUrl(conversationId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getBearerToken()}`,
      'content-type': 'application/json',
      accept: 'application/json',
      source: 'web',
      Version: getClientVersion(),
      'x-accel-buffering': 'no',
    },
    credentials: 'include',
    timeout: COMPLETION_TIMEOUT_MS,
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  // The endpoint answers HTTP 200 with a plain JSON envelope instead of a stream when
  // it refuses the request, so that is classified before any SSE parsing — otherwise
  // a refusal reads as an empty stream and the caller is told the wrong thing.
  const refusal = classifyCompletionEnvelope(raw);
  if (refusal) throw refusal;

  const outcome = foldStream(raw);
  // No text, no phases and no in-stream error means the frames were not understood —
  // a re-versioned payload, or an interstitial served at HTTP 200. Gating this on a
  // zero-byte body would let every one of those through as success.
  if (!outcome.text && outcome.phases.length === 0) {
    if (isRiskControlChallenged()) throw riskControlError();
    throw new ToolError(
      `Qwen returned a completion stream with no content and no error (${raw.length} bytes). The SSE format may have changed.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  }
  return outcome;
};

/**
 * Starts a completion without draining it. Deep research holds the same SSE
 * connection open for many minutes while persisting progress server-side, and
 * SPEC §7 requires start_deep_research to return promptly.
 */
export const startCompletion = (conversationId: string, body: Record<string, unknown>): void => {
  void runCompletion(conversationId, body).catch(() => {
    // The run continues in the page; get_deep_research reports the real outcome.
  });
};
