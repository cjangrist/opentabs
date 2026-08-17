import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, toUnixSeconds } from '../grok-api.js';
import { getConversationMetadata } from '../grok-conversations.js';
import { getConversationResponses, mapResponsesToItems } from '../grok-messages.js';
import { pageLocalArray } from '../grok-pagination.js';
import { resolveConversationId } from './conversations.js';
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
    "Read Grok's current native response-tree branch and return every stored text part as OpenAI-Responses-style " +
    'items, oldest first. Omit conversation_id to use the active tab. Attachments become labelled placeholders; ' +
    'reasoning headers, tool calls, searches, and page opens are optional and counted when omitted. Grok publishes ' +
    'citation URLs without text offsets, so their normalized offsets are null.',
  summary: 'Get a Grok chat as normalized items',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().trim().min(1).optional(),
    ...paginationInputShape,
    ...itemVisibilityInputShape,
  }),
  output: itemPageOutput.extend({
    conversation_id: z.string(),
    title: z.string(),
    url: z.string(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
    message_count: z.number().int(),
  }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const [metadata, history] = await Promise.all([
      getConversationMetadata(conversationId),
      getConversationResponses(conversationId),
    ]);
    const mapped = mapResponsesToItems(history.responses, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
    });
    const page = pageLocalArray(mapped.items, resolvePagination(params));
    return {
      ...page,
      omitted: mapped.omitted,
      conversation_id: conversationId,
      title: metadata.title ?? '',
      url: conversationUrl(conversationId),
      created_at: toUnixSeconds(metadata.createTime),
      updated_at: toUnixSeconds(metadata.modifyTime ?? metadata.createTime),
      message_count: history.responses.length,
    };
  },
});
