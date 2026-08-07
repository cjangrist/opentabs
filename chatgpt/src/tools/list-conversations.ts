import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchConversationPage, mapConversationRow } from '../chatgpt-conversations.js';
import { walkOffsetPages } from '../chatgpt-pagination.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

export const listConversations = defineTool({
  name: 'list_conversations',
  displayName: 'List Conversations',
  description:
    'List ChatGPT conversations, newest activity first, in the same order as the rendered sidebar. ' +
    'Paginated by offset behind an opaque cursor — pass next_cursor back verbatim. ' +
    'total is always null: /backend-api/conversations reports "offset + items + 1", a "there is more" probe rather ' +
    'than a real count, so passing it through would be a lie — use has_more. ' +
    'max_items is a hard ceiling: each upstream request is bounded to the remaining budget.',
  summary: 'List your ChatGPT conversations',
  icon: 'list',
  group: 'Conversations',
  input: z.object({
    ...paginationInputShape,
    order: z.enum(['updated', 'created']).optional().describe('Sort key (default "updated").'),
    is_archived: z.boolean().optional().describe('Filter to archived (true) or unarchived (false) conversations.'),
    is_starred: z.boolean().optional().describe('Filter to starred (true) or unstarred (false) conversations.'),
  }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params =>
    walkOffsetPages(
      resolvePagination(params),
      (offset, limit) =>
        fetchConversationPage(offset, limit, {
          order: params.order,
          is_archived: params.is_archived,
          is_starred: params.is_starred,
        }),
      mapConversationRow,
    ),
});
