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
    'DeepSeek has no archive or trash, so this is IRREVERSIBLE and conversation_id is therefore REQUIRED: unlike the other tools here it will not fall back to the active tab, so an argument-less call cannot destroy whatever chat happens to be open. ' +
    'The endpoint answers biz_code 0 (success) for an id that does not exist — verified live — so the conversation is read back first and an unknown id raises NOT_FOUND rather than a false success.',
  summary: 'Delete a conversation',
  icon: 'trash-2',
  group: 'Conversations',
  input: z.object({
    conversation_id: z
      .string()
      .min(1)
      .describe(
        'DeepSeek chat session id. REQUIRED — this tool never resolves from the active tab, because deletion is irreversible.',
      ),
  }),
  output: z.object({ conversation_id: z.string(), deleted: z.boolean() }),
  handle: async params => {
    // Confirm it exists first: /chat_session/delete answers biz_code 0 for an
    // unknown id, so calling it blind would report a deletion that never happened.
    await getConversationHistory(params.conversation_id);
    await deleteChatSession(params.conversation_id);
    return { conversation_id: params.conversation_id, deleted: true };
  },
});

export const starConversation = defineTool({
  name: 'star_conversation',
  displayName: 'Star Conversation',
  description:
    'Star or unstar a DeepSeek conversation. DeepSeek calls this "pin" (POST /chat_session/update_pinned); it is the same concept the normalized ' +
    'conversation item exposes as is_starred, so it uses the shared star_conversation name rather than a DeepSeek-only one. ' +
    'Starred conversations sort to the top of the sidebar and of list_conversations. This is DeepSeek’s only per-chat flag — it has no archive concept. ' +
    'Omit conversation_id to use the active chat.deepseek.com tab.',
  summary: 'Star or unstar a conversation',
  icon: 'star',
  group: 'Conversations',
  input: z.object({
    conversation_id: conversationIdInput,
    starred: z.boolean().optional().describe('True to star (default), false to unstar.'),
  }),
  output: z.object({ conversation_id: z.string(), is_starred: z.boolean() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const starred = params.starred ?? true;
    await setChatSessionPinned(conversationId, starred);
    return { conversation_id: conversationId, is_starred: starred };
  },
});
