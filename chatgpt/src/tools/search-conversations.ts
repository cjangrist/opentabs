import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../chatgpt-api.js';
import { conversationListItemSchema, mapConversationListItem, toIsoTimestamp } from './schemas.js';

interface RawSearchResult {
  conversation_id?: string;
  title?: string;
  update_time?: number | string;
  is_archived?: boolean;
  is_starred?: boolean | null;
  payload?: { snippet?: string };
}

interface RawSearchResponse {
  items?: RawSearchResult[];
  cursor?: string;
}

/** Observed fixed page size — the endpoint accepts `limit` but always returns this many items. */
const DEFAULT_LIMIT = 28;

export const searchConversations = defineTool({
  name: 'search_conversations',
  displayName: 'Search Conversations',
  description:
    'Search ChatGPT conversations by text query. Searches across conversation titles and message content. ' +
    'The endpoint ignores `limit` and always returns its own fixed page size (~30 items observed) — pass ' +
    'the `next_cursor` from a previous response back as `cursor` to walk further pages.',
  summary: 'Search conversations by keyword',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().describe('Search query text'),
    cursor: z.string().optional().describe('Opaque pagination cursor from a previous response`s next_cursor'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Requested page size — the endpoint ignores this and always returns its own fixed page size'),
  }),
  output: z.object({
    items: z.array(conversationListItemSchema).describe('Matching conversations'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Cursor to pass back for the next page; null when there is definitively no more data'),
    has_more: z.boolean().describe('Whether next_cursor is non-null'),
    total: z.number().nullable().describe('Always null — the search endpoint reports no true total'),
    page_info: z
      .object({
        returned: z.number().int().describe('Number of items returned in this response'),
        pages_fetched: z.number().int().describe('Number of upstream pages walked to build this response'),
        truncated: z.boolean().describe('True if max_items stopped the walk while more pages remained'),
      })
      .describe('Pagination bookkeeping for this response'),
  }),
  handle: async params => {
    const data = await api<RawSearchResponse>('/conversations/search', {
      query: {
        query: params.query,
        limit: params.limit ?? DEFAULT_LIMIT,
        cursor: params.cursor,
      },
    });

    // The search endpoint uses conversation_id instead of id and a nested payload for snippets
    const items = (data.items ?? []).map(item =>
      mapConversationListItem({
        id: item.conversation_id,
        title: item.title,
        update_time: toIsoTimestamp(item.update_time) || undefined,
        is_archived: item.is_archived,
        is_starred: item.is_starred ?? undefined,
        snippet: item.payload?.snippet,
      }),
    );

    const nextCursor = data.cursor || null;
    return {
      items,
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
      total: null,
      page_info: {
        returned: items.length,
        pages_fetched: 1,
        truncated: false,
      },
    };
  },
});
