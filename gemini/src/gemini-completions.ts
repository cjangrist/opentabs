import { ToolError } from '@opentabs-dev/plugin-sdk';
import { callRpcFrame, conversationUrl, getAuthTokens, toConversationId } from './gemini-api.js';
import { type GeminiTurn, getConversationTurns, getLatestTurn, mapTurnsToItems } from './gemini-messages.js';
import { resolveModel } from './gemini-models.js';
import { SEND_WAIT_MS, startGenerate } from './gemini-send.js';
import type { ResponseItem, ThinkingLevel } from './tools/normalized-schemas.js';

const NO_OMISSIONS = { reasoning: 0, tool_calls: 0, hidden: 0, empty: 0 };

const POLL_INTERVAL_MS = 1_500;

export interface CompletionRequest {
  text: string;
  modelId?: string;
  thinking?: boolean;
  thinkingLevel?: ThinkingLevel;
  includeReasoning: boolean;
  includeToolCalls: boolean;
}

export interface CompletionResult {
  conversation_id: string;
  message_id: string;
  status: 'completed' | 'in_progress';
  url: string;
  model: string;
  items: ResponseItem[];
  omitted: { reasoning: number; tool_calls: number; hidden: number; empty: number };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Newest conversation ids, used to recognise the chat a new send landed in. */
const topConversationIds = async (count: number): Promise<string[]> => {
  const frame = await callRpcFrame<unknown[]>('MaZiqc', [count, null]);
  if (frame.data === null) return [];
  return (Array.isArray(frame.data[2]) ? (frame.data[2] as unknown[]) : [])
    .map(row => (Array.isArray(row) && typeof row[0] === 'string' ? row[0] : null))
    .filter((id): id is string => id !== null);
};

interface PollOutcome {
  conversationId: string | null;
  turn: GeminiTurn | null;
}

/**
 * Polls the transcript for the turn the send produced. Gemini writes a turn only once
 * generation finishes, so a turn appearing IS the completion signal; if the budget
 * expires first the run is still going in the page and the caller reports in_progress.
 */
const pollForTurn = async (
  conversationId: string | null,
  previousResponseId: string | null,
  knownConversationIds: string[],
  deadline: number,
): Promise<PollOutcome> => {
  let resolvedId = conversationId;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (!resolvedId) {
      const after = await topConversationIds(5);
      resolvedId = after.find(id => !knownConversationIds.includes(id)) ?? null;
      if (!resolvedId) continue;
    }
    const latest = await getLatestTurn(resolvedId);
    if (latest && latest.responseId !== previousResponseId && latest.responseText)
      return { conversationId: resolvedId, turn: latest };
  }
  return { conversationId: resolvedId, turn: null };
};

const pendingItems = (request: CompletionRequest, conversationId: string): ResponseItem[] => [
  {
    id: `${conversationId}:pending`,
    type: 'message',
    role: 'user',
    status: 'completed',
    created_at: Math.floor(Date.now() / 1000),
    model: null,
    content: [{ type: 'input_text', text: request.text }],
  },
];

/**
 * Sends a prompt, either into a new chat (`conversationId` omitted) or as a reply.
 *
 * A reply must quote the previous turn's `[conversationId, responseId,
 * responseChoiceId]` context, which is read from the live transcript rather than
 * remembered client-side so a chat continued elsewhere still threads correctly.
 */
export const runCompletion = async (request: CompletionRequest, conversationId?: string): Promise<CompletionResult> => {
  const model = await resolveModel(request.modelId);
  const tokens = getAuthTokens();

  let context: [string, string, string] | undefined;
  let previousResponseId: string | null = null;
  if (conversationId) {
    const latest = await getLatestTurn(conversationId);
    if (!latest)
      throw new ToolError(`Gemini conversation ${conversationId} has no turns to reply to.`, 'NOT_FOUND', {
        category: 'not_found',
      });
    if (!latest.responseChoiceId)
      throw new ToolError(
        `Gemini conversation ${conversationId} has no response choice id on its latest turn, so a reply cannot be threaded onto it.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: false },
      );
    context = [latest.conversationId, latest.responseId, latest.responseChoiceId];
    previousResponseId = latest.responseId;
  }

  const knownConversationIds = conversationId ? [] : await topConversationIds(5);
  const deadline = Date.now() + SEND_WAIT_MS;
  await startGenerate(request.text, tokens.atToken, tokens.bl, tokens.fsid, {
    model,
    thinking: request.thinking,
    thinkingLevel: request.thinkingLevel,
    context,
  });

  const outcome = await pollForTurn(
    conversationId ? toConversationId(conversationId) : null,
    previousResponseId,
    knownConversationIds,
    deadline,
  );

  if (!outcome.conversationId)
    throw new ToolError(
      'Gemini accepted the message but has not yet published a conversation id. The generation is still running in the page — call list_conversations in a moment to find the new chat.',
      'TIMEOUT',
      { category: 'timeout', retryable: true },
    );

  const resolvedId = outcome.conversationId;
  if (!outcome.turn)
    return {
      conversation_id: resolvedId,
      message_id: '',
      status: 'in_progress',
      url: conversationUrl(resolvedId),
      model: model.id,
      items: pendingItems(request, resolvedId),
      omitted: { ...NO_OMISSIONS },
    };

  const { items, omitted } = mapTurnsToItems([outcome.turn], {
    includeReasoning: request.includeReasoning,
    includeToolCalls: request.includeToolCalls,
  });
  return {
    conversation_id: resolvedId,
    message_id: outcome.turn.responseChoiceId ?? outcome.turn.responseId,
    status: 'completed',
    url: conversationUrl(resolvedId),
    model: outcome.turn.modelId ?? model.id,
    items,
    omitted,
  };
};

/** Re-reads a conversation and returns its normalized items — used by deep research. */
export const readItems = async (
  conversationId: string,
  includeReasoning: boolean,
  includeToolCalls: boolean,
): Promise<ResponseItem[]> => {
  const { turns } = await getConversationTurns(conversationId);
  return mapTurnsToItems(turns, { includeReasoning, includeToolCalls }).items;
};
