import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchConversationsPage, mapConversationRow } from '../claude-conversations.js';
import { walkOffsetPages } from '../claude-pagination.js';
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
    'List chat conversations in the active Claude organization, newest first. Drives /chat_conversations_v2 — the endpoint the claude.ai sidebar itself uses — with a real limit/offset cursor. ' +
    'claude.ai reports no conversation count, so total is always null; walk with has_more / next_cursor. ' +
    'is_archived is always false because claude.ai has no archive action for conversations.',
  summary: 'List conversations (paginated)',
  icon: 'list',
  group: 'Conversations',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => walkOffsetPages(resolvePagination(params), fetchConversationsPage, mapConversationRow),
});
