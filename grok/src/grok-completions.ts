import { ToolError } from '@opentabs-dev/plugin-sdk';
import { conversationUrl } from './grok-api.js';
import { getConversationMetadata } from './grok-conversations.js';
import { liveRunResponses, startGatewayRun, waitForGatewayRun, type GatewayRun } from './grok-gateway.js';
import { getConversationResponses, getTipResponseId, mapResponsesToItems } from './grok-messages.js';
import { resolveMode } from './grok-models.js';
import { getProjectRecord } from './grok-projects.js';
import type { ThinkingLevel } from './tools/normalized-schemas.js';

const WAIT_BUDGET_MS = 18_000;
const START_ID_WAIT_MS = 10_000;
const RETENTION_MS = 1_800_000;
const retainedRuns = new Map<string, GatewayRun>();
const retainedTimers = new Map<string, ReturnType<typeof setTimeout>>();

const retainRun = (run: GatewayRun): void => {
  const key = run.responseId || run.conversationId;
  if (!key) return;
  clearTimeout(retainedTimers.get(key));
  retainedRuns.set(key, run);
  retainedTimers.set(
    key,
    setTimeout(() => {
      if (retainedRuns.get(key) === run) {
        retainedRuns.delete(key);
        retainedTimers.delete(key);
        if (!run.done && !run.error) run.close();
      }
    }, RETENTION_MS),
  );
};

const storedTurnResponses = async (run: GatewayRun) => {
  const history = await getConversationResponses(run.conversationId);
  const byId = new Map(
    history.responses.filter(response => response.responseId).map(response => [response.responseId, response]),
  );
  const assistant = byId.get(run.responseId);
  if (!assistant) return liveRunResponses(run);
  const user = assistant.parentResponseId ? byId.get(assistant.parentResponseId) : byId.get(run.messageId);
  return user ? [user, assistant] : [assistant];
};

export interface CompletionRequest {
  text: string;
  conversationId?: string;
  projectId?: string;
  modelId?: string;
  thinking?: boolean;
  thinkingLevel?: ThinkingLevel;
  search?: boolean;
  tools?: string[];
  includeReasoning: boolean;
  includeToolCalls: boolean;
}

export const runCompletion = async (request: CompletionRequest) => {
  const text = request.text.trim();
  if (!text) throw ToolError.validation('Message text must not be blank.', 'VALIDATION_ERROR');

  const modePromise = resolveMode({
    modelId: request.modelId,
    thinking: request.thinking,
    thinkingLevel: request.thinkingLevel,
    tools: request.tools,
  });
  const conversationPromise = request.conversationId
    ? getConversationMetadata(request.conversationId)
    : Promise.resolve(null);
  const projectPromise = request.projectId ? getProjectRecord(request.projectId) : Promise.resolve(null);
  const [mode, , project] = await Promise.all([modePromise, conversationPromise, projectPromise]);
  if (request.conversationId && request.projectId)
    throw ToolError.validation('project_id is only valid when creating a conversation.', 'VALIDATION_ERROR');

  const parentResponseId = request.conversationId ? await getTipResponseId(request.conversationId) : null;
  const run = startGatewayRun({
    text,
    modelId: mode.id,
    conversationId: request.conversationId,
    parentResponseId,
    search: request.search,
    workspaceIds: project?.workspaceId ? [project.workspaceId] : undefined,
  });

  const gotIds = await waitForGatewayRun(
    run,
    current => Boolean(current.conversationId && current.responseId && current.messageId),
    START_ID_WAIT_MS,
  );
  if (!gotIds) {
    retainRun(run);
    throw new ToolError(
      run.conversationId
        ? `Grok accepted the message in conversation ${run.conversationId} but did not publish message ids before the tool budget. Do not retry the prompt; poll that conversation.`
        : 'Grok accepted the message but did not publish a conversation id before the tool budget. Do not retry immediately; inspect the Grok history.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  }

  const remaining = Math.max(0, WAIT_BUDGET_MS - (Date.now() - run.startedAt));
  if (!run.done && remaining > 0) await waitForGatewayRun(run, current => current.done, remaining);
  if (!run.done) retainRun(run);

  let responses = liveRunResponses(run);
  if (run.done) {
    try {
      responses = await storedTurnResponses(run);
    } catch {
      responses = liveRunResponses(run);
    }
  }
  const mapped = mapResponsesToItems(responses, {
    includeReasoning: request.includeReasoning,
    includeToolCalls: request.includeToolCalls,
  });
  let title = run.title;
  if (!title) {
    try {
      title = (await getConversationMetadata(run.conversationId)).title ?? '';
    } catch {
      title = '';
    }
  }

  return {
    conversation_id: run.conversationId,
    message_id: run.responseId,
    status: run.done ? ('completed' as const) : ('in_progress' as const),
    url: conversationUrl(run.conversationId),
    model: mode.id,
    title,
    items: mapped.items,
    omitted: mapped.omitted,
  };
};
