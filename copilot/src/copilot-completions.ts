import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
import { COMPLETION_WAIT_MS, conversationUrl, startGatewayTurn, waitForGatewayRun } from './copilot-api.js';
import {
  createEmptyConversation,
  getConversationMetadata,
  getLatestConversationMessages,
} from './copilot-conversations.js';
import { mapGatewayRunToItems, mapMessagesToItems, type OmittedLedger } from './copilot-messages.js';
import { resolveMode, type ModeRequest } from './copilot-models.js';
import { findConversationProject } from './copilot-projects.js';
import type { ResponseItem } from './tools/normalized-schemas.js';

const TITLE_POLL_ATTEMPTS = 4;
const TITLE_POLL_INTERVAL_MS = 500;
const PROJECT_LOOKUP_BUDGET_MS = 2_000;
const HANDLER_GATEWAY_BUDGET_MS = 21_000;
const HANDLER_TOTAL_BUDGET_MS = 24_000;

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
  timeout: number,
): Promise<{ items: ResponseItem[]; omitted: OmittedLedger }> => {
  const messages = await getLatestConversationMessages(conversationId, timeout);
  return mapMessagesToItems(messages.slice(-2), { includeReasoning, includeToolCalls });
};

export const runCompletion = async (request: CompletionRequest, conversationId?: string): Promise<CompletionResult> => {
  const startedAt = Date.now();
  const text = request.text.trim();
  if (!text) throw ToolError.validation('Message text must contain non-whitespace characters.', 'VALIDATION_ERROR');
  const modelId = await resolveMode(request);
  const resolvedConversationId = conversationId ?? (await createEmptyConversation(request.projectId));
  if (conversationId) await getConversationMetadata(conversationId);
  let projectId = request.projectId ?? null;
  if (!projectId && conversationId) {
    try {
      projectId = await findConversationProject(conversationId, Date.now() + PROJECT_LOOKUP_BUDGET_MS);
    } catch (error) {
      if (!(error instanceof ToolError) || !error.retryable) throw error;
    }
  }
  const run = startGatewayTurn({ conversationId: resolvedConversationId, modelId, prompt: text });
  const waitMs = Math.max(0, Math.min(COMPLETION_WAIT_MS, HANDLER_GATEWAY_BUDGET_MS - (Date.now() - startedAt)));
  await waitForGatewayRun(run, current => current.done, waitMs);

  let mapped = mapGatewayRunToItems(run, {
    includeReasoning: request.includeReasoning,
    includeToolCalls: request.includeToolCalls,
  });
  if (run.done && !run.text) {
    const remaining = Math.max(1, startedAt + HANDLER_TOTAL_BUDGET_MS - Date.now());
    mapped = await authoritativeFallback(
      resolvedConversationId,
      request.includeReasoning,
      request.includeToolCalls,
      remaining,
    );
    if (!mapped.items.some(item => item.type === 'message' && item.role === 'assistant'))
      throw new ToolError(
        `Copilot completed the turn in conversation ${resolvedConversationId}, but its persisted assistant content is not readable yet. Poll get_conversation instead of sending the prompt again.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      );
  }

  let title = run.title;
  if (run.done) {
    for (let attempt = 0; attempt < TITLE_POLL_ATTEMPTS && !title; attempt += 1) {
      let remaining = startedAt + HANDLER_TOTAL_BUDGET_MS - Date.now();
      if (remaining <= TITLE_POLL_INTERVAL_MS) break;
      if (attempt > 0) {
        await sleep(TITLE_POLL_INTERVAL_MS);
        remaining = startedAt + HANDLER_TOTAL_BUDGET_MS - Date.now();
        if (remaining <= TITLE_POLL_INTERVAL_MS) break;
      }
      try {
        title = (await getConversationMetadata(resolvedConversationId, remaining)).title ?? '';
      } catch (error) {
        if (!(error instanceof ToolError) || error.code !== 'NOT_FOUND') throw error;
      }
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
