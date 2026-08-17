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
    'That RPC takes NO page-size argument — it returns a page of its own choosing (~23-25 rows) — so limit and ' +
    'max_items are enforced by this tool as hard ceilings on the result. When a ceiling cuts into a provider page, ' +
    'next_cursor records how far into that page was already returned, so resuming continues inside the same page ' +
    'and nothing is lost. Gemini reports no total, so total is always null. Search-hit timestamps are decoded, then ' +
    'each returned id is resolved through Gemini’s native one-row metadata lookup so Notebook membership and Pin state are real.',
  summary: 'Search Gemini chats',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().trim().min(1).describe('Search text, matched against chat titles and message content.'),
    ...paginationInputShape,
  }),
  output: paginatedOutput(conversationListItemSchema),
  handle: params => searchConversationRows(params.query, resolvePagination(params)),
});
