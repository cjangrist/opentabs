import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { resolveConversationId } from '../zai-api.js';
import {
  deleteConversationById,
  getConversationDetail,
  mapConversationDetail,
  renameConversationById,
  setConversationArchived,
} from '../zai-conversations.js';
import { conversationListItemSchema } from './normalized-schemas.js';

export const renameConversation = defineTool({
  name: 'rename_conversation',
  displayName: 'Rename Conversation',
  description:
    'Rename a conversation. z.ai merges the posted chat blob over the stored one; the existing blob is read back and re-sent whole so the message history cannot be lost if that merge ever became a replace.',
  summary: 'Rename a conversation',
  icon: 'pencil',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Chat UUID. Omit to use the active chat.z.ai tab.'),
    title: z.string().min(1).describe('New title.'),
  }),
  output: conversationListItemSchema,
  handle: async params =>
    mapConversationDetail(await renameConversationById(resolveConversationId(params.conversation_id), params.title)),
});

export const deleteConversation = defineTool({
  name: 'delete_conversation',
  displayName: 'Delete Conversation',
  description: 'Permanently delete a conversation. This cannot be undone — z.ai has no trash for chats.',
  summary: 'Delete a conversation',
  icon: 'trash-2',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().describe('Chat UUID to delete. Required — this tool never resolves from the tab.'),
  }),
  output: z.object({ deleted: z.boolean(), conversation_id: z.string() }),
  handle: async params => {
    await getConversationDetail(params.conversation_id);
    await deleteConversationById(params.conversation_id);
    return { deleted: true, conversation_id: params.conversation_id };
  },
});

export const archiveConversation = defineTool({
  name: 'archive_conversation',
  displayName: 'Archive Conversation',
  description:
    'Archive or unarchive a conversation. POST /api/v1/chats/<id>/archive is a toggle upstream, so the current state is read first and the request is skipped when it already matches. Archived chats leave the main list and appear under /api/v1/chats/archived.',
  summary: 'Archive or unarchive a conversation',
  icon: 'archive',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Chat UUID. Omit to use the active chat.z.ai tab.'),
    archived: z.boolean().optional().describe('Desired state (default true).'),
  }),
  output: conversationListItemSchema,
  handle: async params =>
    mapConversationDetail(
      await setConversationArchived(resolveConversationId(params.conversation_id), params.archived ?? true),
    ),
});
