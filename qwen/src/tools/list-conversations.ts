import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchArchivedIds, fetchConversationPage, mapConversationRow } from '../qwen-conversations.js';
import { UPSTREAM_PAGE_SIZE, walkNumberedPages } from '../qwen-pagination.js';
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
    'List Qwen chat conversations, newest first. Drives GET /api/v2/chats/, which pages by 1-based page number and serves a fixed 60 rows: limit, page_size and offset are all accepted and silently ignored upstream (verified live — asking for 3 returns 60), so `limit` is honoured here by slicing and the cursor carries the row offset within a page as "<page>:<offset>". ' +
    'Qwen publishes no count on any list endpoint, so total is always null — walk with has_more / next_cursor. ' +
    "The web app sends exclude_project=true so project chats stay behind the project view; that is deliberately omitted here, so a project's conversations are listed too with their project_id exposed rather than silently dropped. " +
    'is_archived is filled from GET /api/v2/chats/archived once per call, because archived chats are absent from this endpoint entirely. model_id is always null here — the row endpoint never reports which model answered; get_conversation does.',
  summary: 'List conversations (paginated)',
  icon: 'list',
  group: 'Conversations',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema).extend({
    upstream_page_size: z
      .number()
      .int()
      .describe(`Rows Qwen serves per upstream page regardless of limit (${UPSTREAM_PAGE_SIZE}).`),
  }),
  handle: async params => {
    const archived = await fetchArchivedIds();
    const page = await walkNumberedPages(
      resolvePagination(params),
      fetchConversationPage,
      mapConversationRow(archived),
    );
    return { ...page, upstream_page_size: UPSTREAM_PAGE_SIZE };
  },
});
