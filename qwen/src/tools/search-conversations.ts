import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchArchivedIds, mapConversationRow, searchConversationPage } from '../qwen-conversations.js';
import { walkNumberedPages } from '../qwen-pagination.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

export const searchConversations = defineTool({
  name: 'search_conversations',
  displayName: 'Search Conversations',
  description:
    'Search conversations by text through GET /api/v2/chats/search?text=&page=. Qwen matches titles and message bodies and returns the same thin rows as list_conversations, paged by 1-based page number. ' +
    'This endpoint does NOT serve a fixed page size — verified live, one query returned 59 rows on page 1 and 13 more on page 2 — so a short page is not an end-of-data signal here and the walk only stops on an empty page or one whose rows were all seen before. ' +
    'total is null: Qwen publishes no match count.',
  summary: 'Search conversations (paginated)',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().min(1).describe('Text to search for in conversation titles and messages.'),
    ...paginationInputShape,
  }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    const archived = await fetchArchivedIds();
    return walkNumberedPages(
      resolvePagination(params),
      page => searchConversationPage(params.query, page),
      mapConversationRow(archived),
    );
  },
});
