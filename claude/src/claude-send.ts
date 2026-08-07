import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
import { COMPLETION_WAIT_MS, orgApi, runCompletion } from './claude-api.js';
import {
  applyConversationSettings,
  buildCompletionBody,
  getConversationDetail,
  moveConversations,
} from './claude-conversations.js';
import { conversationEffort } from './claude-conversations.js';
import { type MappedItems, mapMessagesToItems } from './claude-messages.js';
import { getBootstrap, resolveModelId, resolveThinking } from './claude-models.js';
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

/** claude.ai's built-in tool set is fixed; a caller-supplied allow-list has nowhere to go. */
const rejectToolSelection = (tools: string[] | undefined): void => {
  if (tools && tools.length > 0)
    throw ToolError.validation(
      'claude.ai does not accept a per-message tool allow-list — the composer only exposes the Web search and Research toggles. ' +
        'Use search / thinking, or start_deep_research. See list_capabilities().features.',
    );
};

/** Creates an empty conversation so settings and project membership can be applied before the first turn. */
export const createEmptyConversation = async (name: string): Promise<string> => {
  const uuid = crypto.randomUUID();
  await orgApi('/chat_conversations', { method: 'POST', body: { uuid, name } });
  return uuid;
};

export interface PreparedTurn {
  conversationId: string;
  body: Record<string, unknown>;
  model: string;
  parentMessageUuid: string | undefined;
}

/**
 * Applies model / thinking / search / research selection and returns the exact
 * completion body. Every validation happens here, before any request is sent.
 */
export const prepareTurn = async (
  params: SendParams,
  options: { conversationId?: string; research: boolean },
): Promise<PreparedTurn> => {
  rejectToolSelection(params.tools);

  const bootstrap = await getBootstrap();
  const model = resolveModelId(bootstrap, params.model_id);
  const thinking = resolveThinking(bootstrap, model, params.thinking, params.thinking_level);

  if (options.research) {
    const modelRow = bootstrap.models.find(row => row.id === model);
    if (!modelRow?.capabilities.deep_research.supported)
      throw ToolError.validation(
        `Model "${model}" does not support Claude's Research feature. Models that do: ${bootstrap.models
          .filter(row => row.capabilities.deep_research.supported && row.is_available)
          .map(row => row.id)
          .join(', ')}`,
      );
  }
  if (params.search === true) {
    const modelRow = bootstrap.models.find(row => row.id === model);
    if (!modelRow?.capabilities.web_search.supported)
      throw ToolError.validation(`Model "${model}" cannot search the web — see list_models().capabilities.web_search.`);
  }

  let conversationId = options.conversationId;
  let parentMessageUuid: string | undefined;

  if (conversationId) {
    const detail = await getConversationDetail(conversationId);
    parentMessageUuid = detail.current_leaf_message_uuid;
  } else {
    conversationId = await createEmptyConversation('');
    if (params.project_id) await moveConversations([conversationId], params.project_id);
  }

  const settings: Record<string, unknown> = {};
  if (options.research) settings.compass_mode = 'advanced';
  if (params.search !== undefined) settings.enabled_web_search = params.search;
  await applyConversationSettings(conversationId, settings);

  return {
    conversationId,
    parentMessageUuid,
    model,
    body: buildCompletionBody({
      prompt: params.text,
      model,
      thinking,
      search: params.search !== false,
      research: options.research,
      parentMessageUuid,
      isNewConversation: false,
    }),
  };
};

/** Returns only the messages produced by this turn, so callers do not re-read history. */
export const collectTurn = async (
  conversationId: string,
  parentMessageUuid: string | undefined,
  params: SendParams,
  status: 'completed' | 'in_progress' = 'completed',
): Promise<SendResult> => {
  const detail = await getConversationDetail(conversationId);
  const messages = detail.chat_messages ?? [];
  const parentIndex = parentMessageUuid ? messages.findIndex(message => message.uuid === parentMessageUuid) : -1;
  const turn = messages.slice(parentIndex + 1);

  const mapped = mapMessagesToItems(turn, {
    includeReasoning: params.include_reasoning ?? false,
    includeToolCalls: params.include_tool_calls ?? false,
    effort: conversationEffort(detail),
    model: detail.model || null,
  });

  const assistant = [...turn].reverse().find(message => message.sender === 'assistant');
  return {
    ...mapped,
    conversation_id: conversationId,
    message_id: assistant?.uuid ?? '',
    model: detail.model ?? '',
    url: `https://claude.ai/chat/${conversationId}`,
    status: status === 'completed' && assistant ? 'completed' : 'in_progress',
  };
};

/**
 * Full send. Waits up to COMPLETION_WAIT_MS for the stream, then stops *waiting*
 * (without cancelling it) and reads back whatever landed. The OpenTabs adapter
 * kills a handler at 25s, and a handler killed mid-await takes the in-page fetch
 * down with it — which loses the answer entirely. Returning early keeps the
 * completion alive in the page, so a slow answer still lands and is readable with
 * get_conversation.
 */
export const sendTurn = async (params: SendParams, conversationId?: string): Promise<SendResult> => {
  const prepared = await prepareTurn(params, { conversationId, research: false });
  // Capture rather than re-throw: a failure that arrives after the budget must not
  // surface as an unhandled rejection in the page.
  let completionError: unknown;
  const completion = runCompletion(prepared.conversationId, prepared.body).then(
    () => 'completed' as const,
    (error: unknown) => {
      completionError = error;
      return 'failed' as const;
    },
  );
  const outcome = await Promise.race([completion, sleep(COMPLETION_WAIT_MS).then(() => 'in_progress' as const)]);
  if (outcome === 'failed') throw completionError;
  return collectTurn(prepared.conversationId, prepared.parentMessageUuid, params, outcome);
};
