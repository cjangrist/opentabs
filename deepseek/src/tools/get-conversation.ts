import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, resolveConversationId, toUnixSeconds } from '../deepseek-api.js';
import { getConversationHistory } from '../deepseek-conversations.js';
import { activeThread, mapMessagesToItems } from '../deepseek-messages.js';
import { pageLocalArray } from '../deepseek-pagination.js';
import {
  itemPageOutput,
  itemVisibilityInputShape,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

export const getConversation = defineTool({
  name: 'get_conversation',
  displayName: 'Get Conversation',
  description:
    'Read a DeepSeek conversation as an ordered array of OpenAI-Responses-style items (message / reasoning / web_search_call / tool_call), oldest first. ' +
    'Omit conversation_id to use the conversation open in the active chat.deepseek.com tab. ' +
    'GET /chat/history_messages has no server-side paging (limit/count/page_size are all ignored — verified live), so the whole thread is fetched once and pagination applies to the NORMALIZED items, which is why total IS a true total here. ' +
    'DeepSeek returns the whole message TREE including branches abandoned by an edit or regenerate; only the live thread — parent_id walked back from current_message_id — is returned, and off-thread messages count in omitted.hidden. ' +
    'Every REQUEST/RESPONSE fragment of a turn is joined with a blank line; FILE and TIP fragments become labelled placeholders rather than being dropped. ' +
    '[citation:N] markers resolve against the turn’s own results, so url_citation annotations carry REAL offsets. omitted covers the whole conversation.',
  summary: 'Get a conversation as normalized items',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z
      .string()
      .optional()
      .describe('DeepSeek chat session id. Omit to resolve it from the active chat.deepseek.com tab.'),
    ...paginationInputShape,
    ...itemVisibilityInputShape,
  }),
  output: itemPageOutput.extend({
    conversation_id: z.string(),
    title: z.string(),
    url: z.string(),
    model_id: z.string().nullable().describe('The mode this conversation is fixed to.'),
    created_at: z.number().int().describe('Unix seconds, from chat_session.inserted_at.'),
    updated_at: z.number().int().describe('Unix seconds.'),
  }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const history = await getConversationHistory(conversationId);
    const thread = activeThread(history.messages, history.session.current_message_id);
    const modelId = history.session.model_type || null;

    const { items, omitted } = mapMessagesToItems(thread, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
      model: modelId,
    });
    omitted.hidden += history.messages.length - thread.length;

    return {
      ...pageLocalArray(items, resolvePagination(params)),
      omitted,
      conversation_id: conversationId,
      title: history.session.title ?? '',
      url: conversationUrl(conversationId),
      model_id: modelId,
      created_at: toUnixSeconds(history.session.inserted_at),
      updated_at: toUnixSeconds(history.session.updated_at),
    };
  },
});
