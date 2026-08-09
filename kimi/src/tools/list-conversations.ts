import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchConversationsPage, mapChatRow } from '../kimi-conversations.js';
import { getModelCatalog } from '../kimi-models.js';
import { walkTokenPages } from '../kimi-pagination.js';
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
    'List the account’s Kimi conversations, newest first. Drives FeedService/ListFeeds — the endpoint the kimi.com sidebar itself uses — ' +
    'with its real pageToken cursor, which honours the requested page size exactly. ' +
    'Unlike the rendered sidebar, this ALSO returns chats that live inside a project (project_id set); the sidebar hides those under Projects. ' +
    'Kimi publishes no conversation count, so total is always null — walk with has_more / next_cursor. ' +
    'is_archived and is_starred are always false: Kimi has neither concept for chats (the row menu offers Delete only). ' +
    'The upstream endpoint rejects a page size above 100, so a larger limit is served by walking more than one upstream page.',
  summary: 'List conversations (paginated)',
  icon: 'list',
  group: 'Conversations',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    const catalog = await getModelCatalog();
    const scenarios = new Map(Object.values(catalog.runtimeById).map(runtime => [runtime.scenario, runtime.id]));
    return walkTokenPages(resolvePagination(params), fetchConversationsPage, chat => mapChatRow(chat, scenarios));
  },
});
