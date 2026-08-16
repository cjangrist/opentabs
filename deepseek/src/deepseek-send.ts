import { ToolError, fetchFromPage, sleep } from '@opentabs-dev/plugin-sdk';
import {
  API_BASE,
  COMPLETION_PATH,
  COMPLETION_TIMEOUT_MS,
  COMPLETION_WAIT_MS,
  buildHeaders,
  conversationUrl,
  parseSseEvents,
  postApi,
} from './deepseek-api.js';
import { createChatSession, getConversationHistory, latestMessageId } from './deepseek-conversations.js';
import { type MappedItems, activeThread, mapMessagesToItems } from './deepseek-messages.js';
import { type DeepSeekModelCatalog, getModelCatalog, resolveModelId, resolveToggles } from './deepseek-models.js';
import { type PowChallenge, encodePowHeader, solvePowChallenge } from './pow.js';
import type { ThinkingLevel } from './tools/normalized-schemas.js';

export interface SendParams {
  text: string;
  model_id?: string;
  project_id?: string;
  thinking?: boolean;
  thinking_level?: ThinkingLevel;
  search?: boolean;
  tools?: string[];
  include_reasoning?: boolean;
  include_tool_calls?: boolean;
}

export interface SendResult extends MappedItems {
  conversation_id: string;
  message_id: string;
  model: string;
  url: string;
  status: 'completed' | 'in_progress';
}

// --- Proof of work ---

interface PowChallengeResponse {
  challenge?: PowChallenge;
}

/**
 * DeepSeek gates `POST /chat/completion` behind a proof of work: fetch a
 * challenge, solve it locally, and present the answer as `X-DS-PoW-Response`.
 * A solve costs roughly two seconds, which is why it is budgeted for inside the
 * 25s tool ceiling rather than treated as free.
 */
export const buildPowHeader = async (targetPath: string): Promise<string> => {
  const response = await postApi<PowChallengeResponse>('/chat/create_pow_challenge', { target_path: targetPath });
  const challenge = response.challenge;
  if (!challenge)
    throw new ToolError('DeepSeek did not return a proof-of-work challenge.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });

  const answer = solvePowChallenge(challenge);
  if (answer === null)
    throw new ToolError(
      `Could not solve DeepSeek's proof-of-work challenge below difficulty ${challenge.difficulty}.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  return encodePowHeader(challenge, answer);
};

// --- Validation ---

/** DeepSeek's composer exposes DeepThink and Search; there is no tool allow-list. */
const rejectToolSelection = (tools: string[] | undefined): void => {
  if (tools && tools.length > 0)
    throw ToolError.validation(
      'DeepSeek accepts no per-message tool allow-list — the composer exposes only the DeepThink and Search toggles, ' +
        'and the browsing tools it runs behind Search are chosen by the model. Use thinking / search instead. ' +
        'See list_capabilities().features.',
      'VALIDATION_ERROR',
    );
};

/** DeepSeek has no projects; a project_id could only ever be a silent no-op. */
const rejectProjectSelection = (projectId: string | undefined): void => {
  if (projectId)
    throw ToolError.validation(
      'DeepSeek has no projects, folders or spaces — there is no endpoint and no UI for them, so project_id cannot be honoured. ' +
        'See list_capabilities().features.projects.',
      'VALIDATION_ERROR',
    );
};

export interface PreparedTurn {
  catalog: DeepSeekModelCatalog;
  modelId: string;
  thinkingEnabled: boolean;
  searchEnabled: boolean;
}

/**
 * Applies model / thinking / search selection. Every validation happens here,
 * before any request is sent (SPEC §4).
 *
 * `existingModelType` locks a follow-up to the mode the conversation was created
 * with: DeepSeek fixes the mode at creation and its own UI says so
 * ("To switch modes, please start a new chat"), so a different model_id would be
 * silently ignored by the server.
 */
export const prepareTurn = async (params: SendParams, existingModelType?: string): Promise<PreparedTurn> => {
  rejectToolSelection(params.tools);
  rejectProjectSelection(params.project_id);

  const catalog = await getModelCatalog();

  if (existingModelType && params.model_id !== undefined && params.model_id !== existingModelType)
    throw ToolError.validation(
      `This DeepSeek conversation is fixed to mode "${existingModelType}" and cannot be switched to "${params.model_id}" — ` +
        'DeepSeek picks the mode when the chat is created ("To switch modes, please start a new chat"). ' +
        'Use create_conversation(model_id) to start one in a different mode.',
      'VALIDATION_ERROR',
    );

  const effectiveModelId = existingModelType || resolveModelId(catalog, params.model_id);
  const runtime = catalog.runtimeById[effectiveModelId];
  if (!runtime)
    throw ToolError.validation(
      `This conversation runs on mode "${effectiveModelId}", which the live picker no longer offers. ` +
        `Valid ids: ${catalog.models.map(model => model.id).join(', ')}.`,
      'VALIDATION_ERROR',
    );

  const toggles = resolveToggles(runtime, params);
  return { catalog, modelId: effectiveModelId, ...toggles };
};

// --- Streaming ---

/**
 * Streaming replies always carry HTTP 200 — DeepSeek reports failures as a
 * `toast`/`hint` frame with `type: "error"` inside the stream, so the status code
 * alone never reveals a rejected request (SPEC §0).
 */
export const findStreamError = (body: string): string | null => {
  for (const event of parseSseEvents(body)) {
    if (event.event !== 'toast' && event.event !== 'hint') continue;
    try {
      const payload = JSON.parse(event.data) as { type?: string; content?: string };
      if (payload.type === 'error') return payload.content || 'unknown error';
    } catch {
      // Ignore frames that are not JSON.
    }
  }
  return null;
};

const postCompletion = async (options: {
  conversationId: string;
  parentMessageId: number | null;
  modelType: string;
  text: string;
  thinkingEnabled: boolean;
  searchEnabled: boolean;
}): Promise<string> => {
  const powHeader = await buildPowHeader(COMPLETION_PATH);
  const response = await fetchFromPage(`${API_BASE}/chat/completion`, {
    method: 'POST',
    headers: buildHeaders({ 'content-type': 'application/json', 'x-ds-pow-response': powHeader }),
    credentials: 'include',
    timeout: COMPLETION_TIMEOUT_MS,
    body: JSON.stringify({
      chat_session_id: options.conversationId,
      parent_message_id: options.parentMessageId,
      model_type: options.modelType,
      prompt: options.text,
      ref_file_ids: [],
      thinking_enabled: options.thinkingEnabled,
      search_enabled: options.searchEnabled,
      action: null,
      preempt: false,
    }),
  });
  return response.text();
};

/**
 * Reads back only the messages this turn produced, so callers do not re-read the
 * whole history. The persisted tree is authoritative — it is what the page
 * renders — which is also why the SSE deltas are not folded a second time here.
 */
export const collectTurn = async (
  conversationId: string,
  parentMessageId: number | null,
  params: SendParams,
  modelId: string,
  status: 'completed' | 'in_progress',
): Promise<SendResult> => {
  const history = await getConversationHistory(conversationId);
  const thread = activeThread(history.messages, history.session.current_message_id);
  const parentIndex =
    parentMessageId === null ? -1 : thread.findIndex(message => message.message_id === parentMessageId);
  // A parent that is no longer on the live thread means the tree moved under us
  // (a concurrent edit or regenerate). Slicing from -1 would silently return the
  // WHOLE history as "this turn", so fail loud instead (SPEC §3).
  if (parentMessageId !== null && parentIndex < 0)
    throw new ToolError(
      `DeepSeek re-parented conversation ${conversationId} while this message was in flight — message ${parentMessageId} is no longer on the live thread. Read the conversation with get_conversation.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  const turn = thread.slice(parentIndex + 1);

  const mapped = mapMessagesToItems(turn, {
    includeReasoning: params.include_reasoning ?? false,
    includeToolCalls: params.include_tool_calls ?? false,
    model: modelId || null,
  });

  const assistant = [...turn].reverse().find(message => message.role === 'ASSISTANT');
  const settled = assistant?.status === 'FINISHED' && assistant.has_pending_fragment !== true;

  return {
    ...mapped,
    conversation_id: conversationId,
    message_id: assistant?.message_id !== undefined ? String(assistant.message_id) : '',
    model: modelId,
    url: conversationUrl(conversationId),
    // The persisted message status is authoritative: DeepSeek keeps generating
    // after the wait budget expires and flips it to FINISHED when it lands.
    status: status === 'completed' && settled ? 'completed' : 'in_progress',
  };
};

/**
 * Full send. Waits up to COMPLETION_WAIT_MS for the stream, then stops *waiting*
 * (without cancelling it) and reads back whatever landed.
 *
 * The OpenTabs adapter aborts a handler at 25s with a platform-level timeout
 * carrying no result at all. Returning early instead yields a well-formed answer
 * with `status: "in_progress"`; the streaming fetch keeps running in the page, so
 * `get_conversation` returns the finished reply.
 */
export const sendTurn = async (params: SendParams, conversationId?: string): Promise<SendResult> => {
  let existingModelType: string | undefined;
  let parentMessageId: number | null = null;

  if (conversationId) {
    const history = await getConversationHistory(conversationId);
    existingModelType = history.session.model_type;
    parentMessageId = latestMessageId(history);
  }

  const prepared = await prepareTurn(params, existingModelType);
  const targetConversationId = conversationId ?? (await createChatSession());

  // Capture rather than re-throw: a failure that arrives after the wait budget
  // must not surface as an unhandled rejection in the page.
  let streamError: unknown;
  let streamBody: string | null = null;
  const completion = postCompletion({
    conversationId: targetConversationId,
    parentMessageId,
    modelType: prepared.modelId,
    text: params.text,
    thinkingEnabled: prepared.thinkingEnabled,
    searchEnabled: prepared.searchEnabled,
  }).then(
    body => {
      streamBody = body;
      return 'completed' as const;
    },
    (error: unknown) => {
      streamError = error;
      return 'failed' as const;
    },
  );

  const outcome = await Promise.race([completion, sleep(COMPLETION_WAIT_MS).then(() => 'in_progress' as const)]);
  if (outcome === 'failed') throw streamError;
  if (outcome === 'completed' && streamBody !== null) {
    const message = findStreamError(streamBody);
    if (message)
      throw new ToolError(`DeepSeek rejected the message: ${message}`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: false,
      });
  }

  return collectTurn(targetConversationId, parentMessageId, params, prepared.modelId, outcome);
};
