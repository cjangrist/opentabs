import { ToolError } from '@opentabs-dev/plugin-sdk';
import { callRpcFrame, conversationUrl, getAuthTokens, toConversationId } from './gemini-api.js';
import { getConversationTurns, mapTurnsToItems } from './gemini-messages.js';
import { resolveModel } from './gemini-models.js';
import { streamGenerate } from './gemini-send.js';
import type { ResponseItem, ThinkingLevel } from './tools/normalized-schemas.js';

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
  model_id: string;
  items: ResponseItem[];
}

/** Newest conversation ids, used to recognise the one a timed-out create landed in. */
const topConversationIds = async (count: number): Promise<string[]> => {
  const frame = await callRpcFrame<unknown[]>('MaZiqc', [count, null]);
  if (frame.data === null) return [];
  const rows = Array.isArray(frame.data[2]) ? (frame.data[2] as unknown[]) : [];
  return rows
    .map(row => (Array.isArray(row) && typeof row[0] === 'string' ? row[0] : null))
    .filter((id): id is string => id !== null);
};

const buildItems = (request: CompletionRequest, responseId: string, text: string, modelId: string): ResponseItem[] => {
  const now = Math.floor(Date.now() / 1000);
  const items: ResponseItem[] = [
    {
      id: `${responseId}:prompt`,
      type: 'message',
      role: 'user',
      status: 'completed',
      created_at: now,
      model: null,
      content: [{ type: 'input_text', text: request.text }],
    },
  ];
  if (text)
    items.push({
      id: responseId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      created_at: now,
      model: modelId,
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  return items;
};

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
  if (conversationId) {
    const { turns } = await getConversationTurns(conversationId);
    const latest = turns[turns.length - 1];
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
  }

  const before = conversationId ? [] : await topConversationIds(5);
  const result = await streamGenerate(request.text, tokens.atToken, tokens.bl, tokens.fsid, {
    model,
    thinking: request.thinking,
    thinkingLevel: request.thinkingLevel,
    context,
  });

  let resolvedId = result.conversationId ?? (conversationId ? toConversationId(conversationId) : null);
  if (!resolvedId) {
    // The 18s read budget elapsed before Gemini flushed the id frame; the generation
    // is still running in the page, so find the chat it created.
    const after = await topConversationIds(5);
    resolvedId = after.find(id => !before.includes(id)) ?? null;
  }
  if (!resolvedId)
    throw new ToolError(
      'Gemini accepted the message but has not yet published a conversation id. Call list_conversations in a moment to find the new chat.',
      'TIMEOUT',
      { category: 'timeout', retryable: true },
    );

  const responseId = result.responseId ?? `${resolvedId}:pending`;
  return {
    conversation_id: resolvedId,
    message_id: result.responseChoiceId ?? responseId,
    status: result.complete && result.text ? 'completed' : 'in_progress',
    url: conversationUrl(resolvedId),
    model_id: model.id,
    items: buildItems(request, responseId, result.text, model.id),
  };
};

/** Re-reads a conversation and returns its normalized items — used after a send. */
export const readItems = async (
  conversationId: string,
  includeReasoning: boolean,
  includeToolCalls: boolean,
): Promise<ResponseItem[]> => {
  const { turns } = await getConversationTurns(conversationId);
  return mapTurnsToItems(turns, { includeReasoning, includeToolCalls }).items;
};
