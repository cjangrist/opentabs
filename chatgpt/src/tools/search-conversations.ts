import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../chatgpt-api.js';
import { type RawConversationRow, mapConversationRow } from '../chatgpt-conversations.js';
import { walkCursorPages } from '../chatgpt-pagination.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

interface RawSearchResult extends RawConversationRow {
  payload?: { snippet?: string };
}

interface RawSearchResponse {
  items?: RawSearchResult[];
  cursor?: string | null;
}

export const searchConversations = defineTool({
  name: 'search_conversations',
  displayName: 'Search Conversations',
  description:
    'Search ChatGPT conversations by text across titles and message content. ' +
    'The endpoint IGNORES limit and always returns its own fixed page size (~28 observed); the real pagination ' +
    'primitive is its opaque cursor, so pass next_cursor back verbatim or set fetch_all. ' +
    'total is always null — the search endpoint reports no count. ' +
    'max_items is still a hard ceiling: an over-long page is trimmed to the remaining budget and truncated is set.',
  summary: 'Search conversations by keyword',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().describe('Search query text.'),
    ...paginationInputShape,
  }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params =>
    walkCursorPages(
      resolvePagination(params),
      async (cursor, limit) => {
        const data = await api<RawSearchResponse>('/conversations/search', {
          query: { query: params.query, limit, cursor },
        });
        return { rows: data.items ?? [], cursor: data.cursor };
      },
      mapConversationRow,
    ),
});
