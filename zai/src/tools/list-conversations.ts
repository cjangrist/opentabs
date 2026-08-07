import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { buildListEnrichment, fetchConversationPage, mapConversationRow } from '../zai-conversations.js';
import { UPSTREAM_PAGE_SIZE, walkNumberedPages } from '../zai-pagination.js';
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
    'List z.ai chat conversations, newest first. Drives GET /api/v1/chats/, which pages by 1-based page number at a fixed 60 rows; limit, page_size and offset are accepted and silently ignored upstream, so `limit` is honoured here by slicing and the cursor carries the row offset within a page ("<page>:<offset>"). ' +
    'z.ai publishes no count, so total is always null — walk with has_more / next_cursor. ' +
    'The thin row endpoint carries no membership or flags, so project_id and is_starred are filled from /api/v1/folders/ and /api/v1/chats/pinned once per call. model_id is always null here; get_conversation reports it. ' +
    'is_archived is always false HERE, verified live: archiving removes a chat from this endpoint entirely. ' +
    'Agent-mode chats are included — unlike the web app, this does not filter on type=default.',
  summary: 'List conversations (paginated)',
  icon: 'list',
  group: 'Conversations',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema).extend({
    upstream_page_size: z
      .number()
      .int()
      .describe(`Rows z.ai serves per upstream page regardless of limit (${UPSTREAM_PAGE_SIZE}).`),
  }),
  handle: async params => {
    const enrichment = await buildListEnrichment();
    const page = await walkNumberedPages(
      resolvePagination(params),
      fetchConversationPage,
      mapConversationRow(enrichment),
    );
    return { ...page, upstream_page_size: UPSTREAM_PAGE_SIZE };
  },
});
