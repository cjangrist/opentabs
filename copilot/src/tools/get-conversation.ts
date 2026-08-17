import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl } from '../copilot-api.js';
import { conversationTimes, getConversationHistory } from '../copilot-conversations.js';
import { mapMessagesToItems } from '../copilot-messages.js';
import { pageLocalArray } from '../copilot-pagination.js';
import { findConversationProject } from '../copilot-projects.js';
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
    'Read every Copilot history page, reverse the native newest-first stream, and return OpenAI-Responses-style items ' +
    'oldest first. Omit conversation_id to use the active tab. Normalized pagination is applied only after the full ' +
    'history is reconstructed, so total is exact and omitted covers the whole conversation. All text blocks are ' +
    'retained; images/documents/cards become labelled placeholders. Citation offsets are preserved where Copilot ' +
    'publishes them, and reasoning/tool items are returned only when requested.',
  summary: 'Get a Copilot chat as normalized items',
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
    const [{ metadata, messages }, projectId] = await Promise.all([
      getConversationHistory(conversationId),
      findConversationProject(conversationId),
    ]);
    const mapped = mapMessagesToItems(messages, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
    });
    const times = conversationTimes(metadata, messages);
    return {
      ...pageLocalArray(mapped.items, resolvePagination(params)),
      omitted: mapped.omitted,
      conversation_id: conversationId,
      title: metadata.title ?? '',
      url: conversationUrl(conversationId, projectId),
      created_at: times.createdAt,
      updated_at: times.updatedAt,
      message_count: messages.length,
    };
  },
});
