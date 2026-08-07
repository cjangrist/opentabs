import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { orgApi } from '../claude-api.js';

export const deleteConversation = defineTool({
  name: 'delete_conversation',
  displayName: 'Delete Conversation',
  description:
    'Permanently delete a Claude conversation. This cannot be undone, so conversation_id is required — unlike the other conversation tools it will not fall back to the active tab.',
  summary: 'Delete a conversation',
  icon: 'trash-2',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().describe('UUID of the conversation to delete.'),
  }),
  output: z.object({
    deleted: z.boolean(),
    conversation_id: z.string(),
  }),
  handle: async params => {
    await orgApi(`/chat_conversations/${params.conversation_id}`, { method: 'DELETE' });
    return { deleted: true, conversation_id: params.conversation_id };
  },
});
