import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { searchConversationRows } from '../gemini-conversations.js';
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
    "Full-text search across the account's Gemini chats, driving the same RPC (unqWSc) as the Search chats page. " +
    "Gemini chooses the page size itself — the limit is applied as the walker's ceiling, not as a page size the " +
    'server honours — and reports no total, so total is always null. created_at/updated_at are 0 because the search ' +
    'rows carry no timestamps; call get_conversation or list_conversations for those.',
  summary: 'Search Gemini chats',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().min(1).describe('Search text, matched against chat titles and message content.'),
    ...paginationInputShape,
  }),
  output: paginatedOutput(conversationListItemSchema),
  handle: params => searchConversationRows(params.query, resolvePagination(params)),
});
