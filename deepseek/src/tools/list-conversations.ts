import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchConversationsPage, mapSessionRow } from '../deepseek-conversations.js';
import { walkKeysetPages } from '../deepseek-pagination.js';
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
    'List the account’s DeepSeek conversations, pinned first then newest first — the exact order the sidebar renders. ' +
    'Drives GET /chat_session/fetch_page, the endpoint the sidebar itself uses, with its real keyset cursor over (pinned, updated_at). ' +
    'That cursor is INCLUSIVE (lte), so the boundary row is returned again upstream; next_cursor carries the last id seen and this tool drops the repeat, ' +
    'which is why page 1 and page 2 are disjoint here. ' +
    'The endpoint rejects count outside 2..100 (ILLEGAL_COUNT), so a larger limit is served by walking more than one upstream page. ' +
    'total is always null: fetch_page reports no count of any kind, only has_more. ' +
    'created_at is always 0 — the session list carries no creation time; get_conversation resolves the real one. ' +
    'project_id is always null and is_archived always false: DeepSeek has neither concept. is_starred mirrors DeepSeek’s pin.',
  summary: 'List conversations (paginated)',
  icon: 'list',
  group: 'Conversations',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => walkKeysetPages(resolvePagination(params), fetchConversationsPage, mapSessionRow),
});
