import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { orgApi, resolveConversationId } from '../claude-api.js';
import { type RawConversationRow, mapConversationRow } from '../claude-conversations.js';
import { conversationListItemSchema } from './normalized-schemas.js';

export const renameConversation = defineTool({
  name: 'rename_conversation',
  displayName: 'Rename Conversation',
  description:
    'Rename a Claude conversation. Omit conversation_id to rename the conversation open in the active claude.ai tab.',
  summary: 'Rename a conversation',
  icon: 'pencil',
  group: 'Conversations',
  input: z.object({
    title: z.string().min(1).describe('New conversation title.'),
    conversation_id: z.string().optional().describe('Conversation UUID. Omit to use the active claude.ai tab.'),
  }),
  output: z.object({ conversation: conversationListItemSchema }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const updated = await orgApi<RawConversationRow>(`/chat_conversations/${conversationId}`, {
      method: 'PUT',
      body: { name: params.title },
    });
    return { conversation: mapConversationRow({ ...updated, uuid: updated.uuid ?? conversationId }) };
  },
});
