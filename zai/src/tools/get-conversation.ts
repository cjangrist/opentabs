import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, resolveConversationId } from '../zai-api.js';
import { getConversationDetail } from '../zai-conversations.js';
import { loadConversationItems } from '../zai-messages.js';
import { pageLocalArray } from '../zai-pagination.js';
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
    'Read a conversation as an ordered array of OpenAI-Responses-style items (message / reasoning / web_search_call / tool_call). Omit conversation_id to use the conversation open in the active chat.z.ai tab. ' +
    'GET /api/v1/chats/<id> returns the message tree with every assistant turn stubbed out — no content at all — so the text, reasoning and tool calls are fetched from POST /api/v1/chats/<id>/messages/batch and both are combined here. ' +
    'Only the branch the page renders is returned (walked from history.currentId up through parentId); regenerated and edited turns on abandoned branches are counted in omitted.hidden. ' +
    'All text blocks of a turn are joined with a blank line, and 【turnNsearchM】 markers are resolved to url_citation annotations against the [ref_id=…†title†url] headers in the matching tool output, with real offsets into the joined text. ' +
    'Pagination is applied over the normalized items, so total IS a true total. omitted covers the whole conversation, not just the returned page.',
  summary: 'Get a conversation as normalized items',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Chat UUID. Omit to resolve it from the active chat.z.ai tab.'),
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
    const { items, omitted } = await loadConversationItems(detail, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
      effort: detail.chat?.reasoning_effort ?? null,
    });
    return {
      ...pageLocalArray(items, resolvePagination(params)),
      omitted,
      conversation_id: conversationId,
      title: detail.title ?? '',
      url: conversationUrl(conversationId),
    };
  },
});
