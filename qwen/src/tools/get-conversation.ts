import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, resolveConversationId } from '../qwen-api.js';
import { getConversationDetail } from '../qwen-conversations.js';
import { mapConversation } from '../qwen-messages.js';
import { pageLocalArray } from '../qwen-pagination.js';
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
    'Read a conversation as an ordered array of OpenAI-Responses-style items (message / reasoning / web_search_call / tool_call). Omit conversation_id to use the active chat.qwen.ai tab. ' +
    'GET /api/v2/chats/<id> returns the whole tree in one response — its limit / cursor / direction params are accepted and silently ignored (verified live) — so pagination is applied over the normalized items, making total a true total. ' +
    'Only the branch the page renders is returned (walked from history.currentId up through parentId); regenerated and edited turns are counted in omitted.hidden. ' +
    'An assistant turn is a content_list of phase-labelled parts: every answer part is joined with a blank line, thinking phases become reasoning (text from extra.summary_thought), search phases become web_search_call, and any other phase becomes a labelled tool_call rather than being dropped. ' +
    "Qwen's [[n]] markers resolve to url_citation annotations with real offsets. omitted covers the WHOLE conversation, not just this page.",
  summary: 'Get a conversation as normalized items',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Chat UUID. Omit to resolve it from the active chat.qwen.ai tab.'),
    ...paginationInputShape,
    ...itemVisibilityInputShape,
  }),
  output: itemPageOutput.extend({
    conversation_id: z.string(),
    title: z.string(),
    url: z.string(),
    chat_type: z.string().describe('Qwen routing type of the conversation: t2t, search, deep_research, …'),
  }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const detail = await getConversationDetail(conversationId);
    const { items, omitted } = mapConversation(detail, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
    });
    return {
      ...pageLocalArray(items, resolvePagination(params)),
      omitted,
      conversation_id: conversationId,
      title: detail.title ?? '',
      url: conversationUrl(conversationId),
      chat_type: detail.chat_type ?? '',
    };
  },
});
