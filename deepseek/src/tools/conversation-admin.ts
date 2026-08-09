import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, resolveConversationId } from '../deepseek-api.js';
import {
  deleteChatSession,
  getConversationHistory,
  renameChatSession,
  setChatSessionPinned,
} from '../deepseek-conversations.js';

const conversationIdInput = z
  .string()
  .optional()
  .describe('DeepSeek chat session id. Omit to resolve it from the active chat.deepseek.com tab.');

export const renameConversation = defineTool({
  name: 'rename_conversation',
  displayName: 'Rename Conversation',
  description:
    'Rename a DeepSeek conversation via POST /chat_session/update_title — the same call the sidebar’s Rename menu item makes. ' +
    'Returns the title DeepSeek stored, which is what the sidebar then renders.',
  summary: 'Rename a conversation',
  icon: 'pencil',
  group: 'Conversations',
  input: z.object({
    conversation_id: conversationIdInput,
    title: z.string().min(1).describe('The new title.'),
  }),
  output: z.object({ conversation_id: z.string(), title: z.string(), url: z.string() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const title = await renameChatSession(conversationId, params.title);
    return { conversation_id: conversationId, title, url: conversationUrl(conversationId) };
  },
});

export const deleteConversation = defineTool({
  name: 'delete_conversation',
  displayName: 'Delete Conversation',
  description:
    'Permanently delete a DeepSeek conversation via POST /chat_session/delete — the same call the sidebar’s Delete menu item makes. ' +
    'DeepSeek has no archive or trash, so this is IRREVERSIBLE. That endpoint answers biz_code 0 (success) for an id that does not exist — verified live — ' +
    'so the conversation is read back first and an unknown id raises NOT_FOUND rather than a false success.',
  summary: 'Delete a conversation',
  icon: 'trash-2',
  group: 'Conversations',
  input: z.object({ conversation_id: conversationIdInput }),
  output: z.object({ conversation_id: z.string(), deleted: z.boolean() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    // Confirm it exists first: /chat_session/delete answers biz_code 0 for an
    // unknown id, so calling it blind would report a deletion that never happened.
    await getConversationHistory(conversationId);
    await deleteChatSession(conversationId);
    return { conversation_id: conversationId, deleted: true };
  },
});

export const pinConversation = defineTool({
  name: 'pin_conversation',
  displayName: 'Pin Conversation',
  description:
    'Pin or unpin a DeepSeek conversation via POST /chat_session/update_pinned. Pinned chats sort to the top of the sidebar and of list_conversations, ' +
    'and surface as is_starred there. This is DeepSeek’s only per-chat flag — it has no archive concept.',
  summary: 'Pin or unpin a conversation',
  icon: 'pin',
  group: 'Conversations',
  input: z.object({
    conversation_id: conversationIdInput,
    pinned: z.boolean().describe('True to pin, false to unpin.'),
  }),
  output: z.object({ conversation_id: z.string(), is_starred: z.boolean() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    await setChatSessionPinned(conversationId, params.pinned);
    return { conversation_id: conversationId, is_starred: params.pinned };
  },
});
