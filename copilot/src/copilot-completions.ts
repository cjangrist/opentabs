import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
import { COMPLETION_WAIT_MS, conversationUrl, startGatewayTurn, waitForGatewayRun } from './copilot-api.js';
import { createEmptyConversation, getConversationHistory, getConversationMetadata } from './copilot-conversations.js';
import { mapGatewayRunToItems, mapMessagesToItems, type OmittedLedger } from './copilot-messages.js';
import { resolveMode, type ModeRequest } from './copilot-models.js';
import { findConversationProject } from './copilot-projects.js';
import type { ResponseItem } from './tools/normalized-schemas.js';

const TITLE_POLL_ATTEMPTS = 4;
const TITLE_POLL_INTERVAL_MS = 500;

export interface CompletionRequest extends ModeRequest {
  text: string;
  includeReasoning: boolean;
  includeToolCalls: boolean;
  projectId?: string;
}

export interface CompletionResult {
  conversation_id: string;
  message_id: string;
  status: 'completed' | 'in_progress';
  url: string;
  model: string;
  title: string;
  items: ResponseItem[];
  omitted: OmittedLedger;
}

const authoritativeFallback = async (
  conversationId: string,
  includeReasoning: boolean,
  includeToolCalls: boolean,
): Promise<{ items: ResponseItem[]; omitted: OmittedLedger }> => {
  const history = await getConversationHistory(conversationId);
  return mapMessagesToItems(history.messages.slice(-2), { includeReasoning, includeToolCalls });
};

export const runCompletion = async (request: CompletionRequest, conversationId?: string): Promise<CompletionResult> => {
  const text = request.text.trim();
  if (!text) throw ToolError.validation('Message text must contain non-whitespace characters.', 'VALIDATION_ERROR');
  const modelId = await resolveMode(request);
  const resolvedConversationId = conversationId ?? (await createEmptyConversation(request.projectId));
  if (conversationId) await getConversationMetadata(conversationId);

  const projectId = request.projectId ?? (conversationId ? await findConversationProject(conversationId) : null);
  const run = startGatewayTurn({ conversationId: resolvedConversationId, modelId, prompt: text });
  await waitForGatewayRun(run, current => current.done, COMPLETION_WAIT_MS);

  let mapped = mapGatewayRunToItems(run, {
    includeReasoning: request.includeReasoning,
    includeToolCalls: request.includeToolCalls,
  });
  if (run.done && !run.text) {
    mapped = await authoritativeFallback(resolvedConversationId, request.includeReasoning, request.includeToolCalls);
    if (!mapped.items.some(item => item.type === 'message' && item.role === 'assistant'))
      throw new ToolError('Copilot completed the turn without any renderable assistant content.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: false,
      });
  }

  let title = run.title;
  if (run.done) {
    for (let attempt = 0; attempt < TITLE_POLL_ATTEMPTS && !title; attempt += 1) {
      if (attempt > 0) await sleep(TITLE_POLL_INTERVAL_MS);
      title = (await getConversationMetadata(resolvedConversationId).catch(() => null))?.title ?? '';
    }
  }

  return {
    conversation_id: resolvedConversationId,
    message_id: run.messageId || run.parentMessageId,
    status: run.done ? 'completed' : 'in_progress',
    url: conversationUrl(resolvedConversationId, projectId),
    model: modelId,
    title,
    items: mapped.items,
    omitted: mapped.omitted,
  };
};
