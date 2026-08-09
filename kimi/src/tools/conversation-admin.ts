import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { resolveConversationId } from '../kimi-api.js';
import { deleteChat, getChat, mapChatRow, renameChat } from '../kimi-conversations.js';
import { getModelCatalog, scenarioToModelId } from '../kimi-models.js';
import { conversationListItemSchema } from './normalized-schemas.js';

export const renameConversation = defineTool({
  name: 'rename_conversation',
  displayName: 'Rename Conversation',
  description:
    'Rename a Kimi conversation via ChatService/UpdateChat. Omit conversation_id to rename the conversation open in the active kimi.com tab. ' +
    'UpdateChat takes NO update_mask and replaces the chat wholesale, so the chat is re-read afterwards to prove the new title actually stuck ' +
    'rather than trusting the HTTP 200.',
  summary: 'Rename a conversation',
  icon: 'pencil',
  group: 'Conversations',
  input: z.object({
    title: z.string().min(1).describe('New conversation title.'),
    conversation_id: z.string().optional().describe('Kimi chat id. Omit to use the active kimi.com tab.'),
  }),
  output: z.object({ conversation: conversationListItemSchema }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    await renameChat(conversationId, params.title);
    const [chat, catalog] = await Promise.all([getChat(conversationId), getModelCatalog()]);
    const scenarios = scenarioToModelId(catalog);
    return { conversation: mapChatRow(chat, scenarios) };
  },
});

export const deleteConversation = defineTool({
  name: 'delete_conversation',
  displayName: 'Delete Conversation',
  description:
    'Permanently delete a Kimi conversation. This cannot be undone, so conversation_id is required — unlike the other conversation tools it will not fall back to the active tab.',
  summary: 'Delete a conversation',
  icon: 'trash-2',
  group: 'Conversations',
  input: z.object({ conversation_id: z.string().describe('Kimi chat id to delete.') }),
  output: z.object({ deleted: z.boolean(), conversation_id: z.string() }),
  handle: async params => {
    await deleteChat(params.conversation_id);
    return { deleted: true, conversation_id: params.conversation_id };
  },
});
