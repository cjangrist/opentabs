import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getCurrentConversationId } from '../grok-api.js';
import {
  deleteConversationRecord,
  fetchConversationsPage,
  mapConversation,
  renameConversationRecord,
  setConversationStarred,
} from '../grok-conversations.js';
import { walkCursorPages } from '../grok-pagination.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

export const resolveConversationId = (provided: string | undefined): string => {
  const conversationId = provided ?? getCurrentConversationId();
  if (!conversationId)
    throw ToolError.validation(
      'No Grok conversation is open in the active tab. Pass a conversation_id from list_conversations.',
      'VALIDATION_ERROR',
    );
  return conversationId;
};

export const listConversations = defineTool({
  name: 'list_conversations',
  displayName: 'List Conversations',
  description:
    "List Grok chats newest first through the site's native cursor. Project chats are included and carry their " +
    'native project_id. Grok does not publish last-used model in list rows, so model_id is null.',
  summary: 'List Grok chats',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema),
  handle: params =>
    walkCursorPages(resolvePagination(params), cursor => fetchConversationsPage(cursor), mapConversation),
});

export const searchConversations = defineTool({
  name: 'search_conversations',
  displayName: 'Search Conversations',
  description:
    "Search Grok chat titles/content through the same native searchQuery endpoint as the site's Search dialog, then follow its opaque cursor. Results retain native Project membership.",
  summary: 'Search Grok chats',
  icon: 'search',
  group: 'Conversations',
  input: z.object({ query: z.string().trim().min(1), ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema),
  handle: params =>
    walkCursorPages(
      resolvePagination(params),
      cursor => fetchConversationsPage(cursor, { search: params.query }),
      mapConversation,
    ),
});

export const renameConversation = defineTool({
  name: 'rename_conversation',
  displayName: 'Rename Conversation',
  description:
    "Rename a Grok chat through its native update endpoint and verify the persisted title. Omit conversation_id to use the active tab's chat.",
  summary: 'Rename a Grok chat',
  icon: 'pencil',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1),
  }),
  output: z.object({ conversation_id: z.string(), title: z.string() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const stored = await renameConversationRecord(conversationId, params.title);
    return { conversation_id: conversationId, title: stored.title ?? '' };
  },
});

export const starConversation = defineTool({
  name: 'star_conversation',
  displayName: 'Star Conversation',
  description:
    "Star or unstar a Grok chat through the site's native update endpoint and verify the persisted state. Omit conversation_id to use the active tab's chat.",
  summary: 'Star or unstar a Grok chat',
  icon: 'star',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().trim().min(1).optional(),
    starred: z.boolean().optional().describe('Desired state (default true).'),
  }),
  output: conversationListItemSchema,
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const stored = await setConversationStarred(conversationId, params.starred ?? true);
    return mapConversation(stored);
  },
});

export const deleteConversation = defineTool({
  name: 'delete_conversation',
  displayName: 'Delete Conversation',
  description:
    "Soft-delete a Grok chat and verify it leaves active history. Grok retains deleted chats in its Deleted history, so this is recoverable there. Omit conversation_id to use the active tab's chat.",
  summary: 'Delete a Grok chat',
  icon: 'trash-2',
  group: 'Conversations',
  input: z.object({ conversation_id: z.string().trim().min(1).optional() }),
  output: z.object({ conversation_id: z.string(), deleted: z.boolean() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    await deleteConversationRecord(conversationId);
    return { conversation_id: conversationId, deleted: true };
  },
});
