import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { buildListEnrichment, mapConversationRow, searchConversationPage } from '../zai-conversations.js';
import { UPSTREAM_PAGE_SIZE, walkNumberedPages } from '../zai-pagination.js';
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
    'Search conversations by text through GET /api/v1/chats/search. z.ai matches on title and message content and returns the same thin rows as list_conversations, paged by 1-based page number at a fixed 60 rows per page — `limit` is honoured client-side and the cursor carries the offset within a page. ' +
    'No total is published, so total is null. project_id / is_starred / is_archived are filled the same way list_conversations fills them.',
  summary: 'Search conversations (paginated)',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().min(1).describe('Text to search for in conversation titles and messages.'),
    ...paginationInputShape,
  }),
  output: paginatedOutput(conversationListItemSchema).extend({
    upstream_page_size: z.number().int().describe(`Rows z.ai serves per upstream page (${UPSTREAM_PAGE_SIZE}).`),
  }),
  handle: async params => {
    const enrichment = await buildListEnrichment();
    const page = await walkNumberedPages(
      resolvePagination(params),
      pageNumber => searchConversationPage(params.query, pageNumber),
      mapConversationRow(enrichment),
    );
    return { ...page, upstream_page_size: UPSTREAM_PAGE_SIZE };
  },
});
