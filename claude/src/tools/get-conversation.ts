import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, resolveConversationId } from '../claude-api.js';
import { conversationEffort, getConversationDetail } from '../claude-conversations.js';
import { mapMessagesToItems } from '../claude-messages.js';
import { pageLocalArray } from '../claude-pagination.js';
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
    'Read a conversation as an ordered array of OpenAI-Responses-style items (message / reasoning / web_search_call / tool_call). ' +
    'Omit conversation_id to use the conversation open in the active claude.ai tab. ' +
    'claude.ai returns the whole message tree in one request, so pagination is applied over the normalized items and total IS a true total. ' +
    'Every text block of a turn is joined with a blank line and citation offsets are re-based onto the joined text. ' +
    'omitted accounts for everything left out and is computed over the whole conversation, not just the returned page.',
  summary: 'Get a conversation as normalized items',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z
      .string()
      .optional()
      .describe('Conversation UUID. Omit to resolve it from the active claude.ai tab.'),
    ...paginationInputShape,
    ...itemVisibilityInputShape,
  }),
  output: itemPageOutput.extend({
    conversation_id: z.string(),
    title: z.string(),
    url: z.string(),
  }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const detail = await getConversationDetail(conversationId);
    const { items, omitted } = mapMessagesToItems(detail.chat_messages ?? [], {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
      effort: conversationEffort(detail),
      model: detail.model || null,
    });
    return {
      ...pageLocalArray(items, resolvePagination(params)),
      omitted,
      conversation_id: conversationId,
      title: detail.name ?? '',
      url: conversationUrl(conversationId),
    };
  },
});
