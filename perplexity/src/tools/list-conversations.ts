import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchConversationsPage } from '../perplexity-conversations.js';
import { walkCursorPages } from '../perplexity-pagination.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

const PAGINATION_NOTES =
  'Paged through the Relay connection the Library page itself drives, which honours `limit` and returns an opaque ' +
  'cursor. `total` is null: that connection publishes no count. `created_at` is 0 — no Perplexity list endpoint ' +
  'reports a thread creation time (get_conversation does). If the persisted-query hash the Library ships goes stale, ' +
  'the first page falls back to POST /rest/thread/list_ask_threads, which does report a real `total` but cannot ' +
  'report Space membership, archive or pin state; cursors are tagged with the engine that minted them.';

export const listConversations = defineTool({
  name: 'list_conversations',
  displayName: 'List Conversations',
  description:
    "List the account's Perplexity threads, newest first — the same list the Library shows, including threads " +
    `filed in a Space (project_id) and archived ones (is_archived). is_starred is Perplexity's pin. ${PAGINATION_NOTES}`,
  summary: 'List Perplexity threads',
  icon: 'list',
  group: 'Conversations',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    const pagination = resolvePagination(params);
    const page = await walkCursorPages(
      pagination,
      (cursor, limit) => fetchConversationsPage(cursor, limit),
      row => {
        const { context_uuid, read_write_token, ...item } = row;
        void context_uuid;
        void read_write_token;
        return item;
      },
    );
    return page;
  },
});

export const searchConversations = defineTool({
  name: 'search_conversations',
  displayName: 'Search Conversations',
  description:
    "Search the account's Perplexity threads by free text. Perplexity matches the query against thread titles and " +
    `content server-side; there is no relevance score, results stay newest-first. ${PAGINATION_NOTES}`,
  summary: 'Search Perplexity threads',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().min(1).describe('Free-text search term.'),
    ...paginationInputShape,
  }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    const pagination = resolvePagination(params);
    return walkCursorPages(
      pagination,
      (cursor, limit) => fetchConversationsPage(cursor, limit, params.query),
      row => {
        const { context_uuid, read_write_token, ...item } = row;
        void context_uuid;
        void read_write_token;
        return item;
      },
    );
  },
});
