import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, resolveConversationId } from '../kimi-api.js';
import { chatEffort, getChat, getConversationMessages } from '../kimi-conversations.js';
import { mapMessagesToItems } from '../kimi-messages.js';
import { getModelCatalog, scenarioToModelId } from '../kimi-models.js';
import { pageLocalArray } from '../kimi-pagination.js';
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
    'Read a Kimi conversation as an ordered array of OpenAI-Responses-style items (message / reasoning / web_search_call / tool_call), oldest first. ' +
    'Omit conversation_id to use the conversation open in the active kimi.com tab. ' +
    'A Kimi conversation is a handful of messages carrying dozens of blocks each, so ChatService/ListMessages is walked to the end and pagination ' +
    'is applied to the NORMALIZED items rather than to messages — which is also why total IS a true total here. ' +
    'Every text block of a turn is joined with a blank line, and a spawned sub-agent’s message is kept as a labelled section rather than dropped. ' +
    'Kimi’s [^N^] citation markers are resolved against the conversation’s search results, so url_citation annotations carry REAL offsets into the output_text. ' +
    'Reasoning ids are prefixed with the message id because Kimi restarts block ids at 1 in every message. ' +
    'omitted covers the whole conversation, not just the returned page.',
  summary: 'Get a conversation as normalized items',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Kimi chat id. Omit to resolve it from the active kimi.com tab.'),
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
    const [chat, messages, catalog] = await Promise.all([
      getChat(conversationId),
      getConversationMessages(conversationId),
      getModelCatalog(),
    ]);
    const scenarios = scenarioToModelId(catalog);
    const { items, omitted } = mapMessagesToItems(messages, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
      effort: chatEffort(chat),
      model: (chat.lastRequest?.scenario && scenarios.get(chat.lastRequest.scenario)) || null,
    });
    return {
      ...pageLocalArray(items, resolvePagination(params)),
      omitted,
      conversation_id: conversationId,
      title: chat.name ?? '',
      url: conversationUrl(conversationId),
    };
  },
});
