import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, getConversation as fetchConversation, getCurrentConversationId } from '../deepseek-api.js';
import { mapTurn, turnSchema } from './schemas.js';

export const getConversation = defineTool({
  name: 'get_conversation',
  displayName: 'Get Conversation',
  description:
    'Get the messages of a DeepSeek conversation as prompt/response turns. Reads the conversation currently open in the browser tab when no conversation_id is given. Messages come from the DeepSeek API, so the whole history is available regardless of what is scrolled into view.',
  summary: 'Get messages from a DeepSeek conversation',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z
      .string()
      .optional()
      .describe('Conversation ID to read. Defaults to the conversation open in the current tab.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Maximum number of turns to return, counting back from the newest (default 50, max 200).'),
  }),
  output: z.object({
    conversation_id: z.string().describe('Conversation ID that was read'),
    title: z.string().describe('Conversation title'),
    model_id: z.string().describe('Model the conversation uses ("default", "expert" or "vision")'),
    url: z.string().describe('URL to the conversation on chat.deepseek.com'),
    turns: z.array(turnSchema).describe('Message turns in chronological order'),
  }),
  handle: async params => {
    const conversationId = params.conversation_id ?? getCurrentConversationId();
    if (!conversationId) {
      throw ToolError.validation(
        'No conversation is open in the current tab. Pass a conversation_id from list_conversations.',
      );
    }

    const conversation = await fetchConversation(conversationId, params.limit ?? 50);

    return {
      conversation_id: conversationId,
      title: conversation.title,
      model_id: conversation.modelId,
      url: conversationUrl(conversationId),
      turns: conversation.turns.map(mapTurn),
    };
  },
});
