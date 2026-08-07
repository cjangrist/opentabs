import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, resolveConversationId } from '../chatgpt-api.js';
import { patchConversation } from '../chatgpt-conversations.js';

const mutationOutput = z.object({
  conversation_id: z.string(),
  url: z.string(),
  success: z.literal(true),
});

const conversationIdInput = z.object({
  conversation_id: z
    .string()
    .optional()
    .describe('Conversation UUID. Omit to resolve it from the active chatgpt.com tab.'),
});

export const renameConversation = defineTool({
  name: 'rename_conversation',
  displayName: 'Rename Conversation',
  description:
    'Rename a ChatGPT conversation. Omit conversation_id to rename the one open in the active tab. ' +
    'Sent as PATCH /backend-api/conversation/<id> {title}, which answers {"success": true}.',
  summary: 'Rename a conversation',
  icon: 'pencil',
  group: 'Conversations',
  input: conversationIdInput.extend({ title: z.string().min(1).describe('New conversation title.') }),
  output: mutationOutput,
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    await patchConversation(conversationId, { title: params.title });
    return { conversation_id: conversationId, url: conversationUrl(conversationId), success: true as const };
  },
});

export const deleteConversation = defineTool({
  name: 'delete_conversation',
  displayName: 'Delete Conversation',
  description:
    'Permanently delete a ChatGPT conversation. Omit conversation_id to delete the one open in the active tab. ' +
    'Sent as PATCH /backend-api/conversation/<id> {is_visible:false} — the same call the row menu makes. Irreversible.',
  summary: 'Delete a conversation',
  icon: 'trash-2',
  group: 'Conversations',
  input: conversationIdInput,
  output: mutationOutput,
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    await patchConversation(conversationId, { is_visible: false });
    return { conversation_id: conversationId, url: conversationUrl(conversationId), success: true as const };
  },
});

export const archiveConversation = defineTool({
  name: 'archive_conversation',
  displayName: 'Archive Conversation',
  description:
    'Archive or unarchive a ChatGPT conversation. Archived conversations leave the sidebar but stay readable and ' +
    'are listed by list_conversations({is_archived:true}). Omit conversation_id to use the active tab.',
  summary: 'Archive or unarchive a conversation',
  icon: 'archive',
  group: 'Conversations',
  input: conversationIdInput.extend({
    archived: z.boolean().optional().describe('True to archive (default), false to restore.'),
  }),
  output: mutationOutput,
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    await patchConversation(conversationId, { is_archived: params.archived ?? true });
    return { conversation_id: conversationId, url: conversationUrl(conversationId), success: true as const };
  },
});

export const starConversation = defineTool({
  name: 'star_conversation',
  displayName: 'Star Conversation',
  description:
    'Star or unstar a ChatGPT conversation. Starred conversations are listed by ' +
    'list_conversations({is_starred:true}). Omit conversation_id to use the active tab.',
  summary: 'Star or unstar a conversation',
  icon: 'star',
  group: 'Conversations',
  input: conversationIdInput.extend({
    starred: z.boolean().optional().describe('True to star (default), false to unstar.'),
  }),
  output: mutationOutput,
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    await patchConversation(conversationId, { is_starred: params.starred ?? true });
    return { conversation_id: conversationId, url: conversationUrl(conversationId), success: true as const };
  },
});
