import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { orgApi } from '../claude-api.js';
import { type RawConversationRow, mapConversationRow } from '../claude-conversations.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

interface RawSearchRow {
  conversation?: RawConversationRow;
  matched_snippet?: string;
  title_matches?: unknown;
}

const searchResultSchema = conversationListItemSchema.extend({
  snippet: z
    .string()
    .nullable()
    .describe('Matched excerpt claude.ai highlights, or null when the match is on the title.'),
});

export const searchConversations = defineTool({
  name: 'search_conversations',
  displayName: 'Search Conversations',
  description:
    "Full-text search over the account's conversations, via /conversation/search/v2 — the endpoint the claude.ai sidebar search box uses. " +
    'IMPORTANT: this endpoint has NO cursor and NO offset. It returns a single relevance-ranked page of at most `limit` matches (its `n` parameter, hard-capped at 200 — n=500 is rejected with HTTP 400), ' +
    'and the ranking is not a stable prefix: asking for 10 does not return the 5 from a limit-5 call plus 5 more. ' +
    'has_more is therefore always false, next_cursor always null, total always null, and passing a cursor raises VALIDATION_ERROR rather than silently returning page 1 again. ' +
    'Raise `limit` to see more matches.',
  summary: 'Search conversations (single relevance page)',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().min(1).describe('Search text.'),
    ...paginationInputShape,
  }),
  output: paginatedOutput(searchResultSchema),
  handle: async params => {
    if (params.cursor !== undefined)
      throw ToolError.validation(
        "claude.ai's conversation search has no cursor — next_cursor is always null. Raise `limit` (max 200) instead of paging.",
      );
    const pagination = resolvePagination(params);
    const requested = Math.min(pagination.limit, pagination.maxItems);
    const response = await orgApi<{ data?: RawSearchRow[] }>('/conversation/search/v2', {
      query: { query: params.query, n: requested, target_snippet_size: 100 },
    });
    const rows = (response.data ?? []).filter(row => row.conversation?.uuid);
    const items = rows.map(row => ({
      ...mapConversationRow(row.conversation ?? {}),
      snippet: row.matched_snippet || null,
    }));
    return {
      items,
      next_cursor: null,
      has_more: false,
      total: null,
      page_info: { returned: items.length, pages_fetched: 1, truncated: items.length >= requested },
    };
  },
});
