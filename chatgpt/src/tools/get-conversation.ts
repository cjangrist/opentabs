import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, resolveConversationId } from '../chatgpt-api.js';
import { getConversationDetail } from '../chatgpt-conversations.js';
import { mapConversationToItems } from '../chatgpt-messages.js';
import { pageLocalArray } from '../chatgpt-pagination.js';
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
    'Read a conversation as ordered OpenAI-Responses items (message / reasoning / web_search_call / tool_call). ' +
    'Omit conversation_id to use the active chatgpt.com tab. Only the active branch is walked. ' +
    'ChatGPT splits one rendered assistant bubble across several nodes ("commentary" then "final"), so consecutive ' +
    'assistant text nodes are merged into ONE message item joined with a blank line — the item count therefore ' +
    'matches the turns the page renders. Every content type is read: code, thoughts, reasoning_recap, ' +
    'execution_output, tether_browsing_display and tether_quote each hide their payload under a different key from ' +
    'text/multimodal_text, and empty tool messages carry theirs in metadata.search_result_groups. Inline citation ' +
    'control runs (U+E200-U+E206) are stripped and each cited source becomes a url_citation anchored where the run ' +
    'stood. Pagination is over the normalized items, so total IS a true total; omitted covers the WHOLE conversation.',
  summary: 'Get a conversation as normalized items',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z
      .string()
      .optional()
      .describe('Conversation UUID. Omit to resolve it from the active chatgpt.com tab.'),
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
    const { items, omitted } = mapConversationToItems(detail, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
      model: detail.default_model_slug ?? null,
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
