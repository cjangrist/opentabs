import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  deleteConversationById,
  getConversationDetail,
  mapConversationDetail,
  renameConversationById,
  setConversationArchived,
} from '../qwen-conversations.js';
import { conversationListItemSchema } from './normalized-schemas.js';

export const renameConversation = defineTool({
  name: 'rename_conversation',
  displayName: 'Rename Conversation',
  description:
    'Rename a conversation through POST /api/v2/chats/<id>. Qwen treats that POST as a field-level patch — the web app sends only the keys it changes and the server merges them — so sending the title alone cannot clobber the message history. The record is read back afterwards, so the returned title is the stored one rather than an echo of the request.',
  summary: 'Rename a conversation',
  icon: 'pencil',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().describe('Chat UUID.'),
    title: z.string().min(1).describe('New conversation title.'),
  }),
  output: conversationListItemSchema,
  handle: async params => mapConversationDetail(await renameConversationById(params.conversation_id, params.title)),
});

export const archiveConversation = defineTool({
  name: 'archive_conversation',
  displayName: 'Archive Conversation',
  description:
    'Archive or unarchive a conversation. POST /api/v2/chats/<id>/archive is a toggle upstream, so the current state is read first and the call is skipped when it already matches — asking to archive something already archived never silently un-archives it. An archived chat disappears from list_conversations and moves to GET /api/v2/chats/archived.',
  summary: 'Archive or unarchive a conversation',
  icon: 'archive',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().describe('Chat UUID.'),
    archived: z.boolean().optional().describe('Desired state (default true).'),
  }),
  output: conversationListItemSchema,
  handle: async params =>
    mapConversationDetail(await setConversationArchived(params.conversation_id, params.archived ?? true)),
});

export const deleteConversation = defineTool({
  name: 'delete_conversation',
  displayName: 'Delete Conversation',
  description:
    'Permanently delete a conversation through DELETE /api/v2/chats/<id>. Qwen has no trash — this cannot be undone. The chat is read first so a missing id raises NOT_FOUND instead of reporting a successful delete of something that never existed.',
  summary: 'Delete a conversation',
  icon: 'trash-2',
  group: 'Conversations',
  input: z.object({ conversation_id: z.string().describe('Chat UUID.') }),
  output: z.object({ deleted: z.boolean(), conversation_id: z.string(), title: z.string() }),
  handle: async params => {
    const detail = await getConversationDetail(params.conversation_id);
    await deleteConversationById(params.conversation_id);
    return { deleted: true, conversation_id: params.conversation_id, title: detail.title ?? '' };
  },
});
