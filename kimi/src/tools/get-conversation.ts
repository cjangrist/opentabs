import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, getConversationTitle, getConversationTurns, getCurrentConversationId } from '../kimi-api.js';
import { turnSchema } from './schemas.js';

export const getConversation = defineTool({
  name: 'get_conversation',
  displayName: 'Get Conversation',
  description:
    'Get the messages of a Kimi conversation as prompt/response turns. Reads the conversation currently open in the browser tab when no conversation_id is given. Messages are fetched from the Kimi API, so the whole history is available regardless of what is scrolled into view.',
  summary: 'Get messages from a Kimi conversation',
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
      .describe('Maximum number of messages to read (default 50, max 200).'),
  }),
  output: z.object({
    conversation_id: z.string().describe('Conversation ID that was read'),
    title: z.string().describe('Conversation title'),
    url: z.string().describe('URL to the conversation on kimi.com'),
    turns: z.array(turnSchema).describe('Message turns in chronological order'),
  }),
  handle: async params => {
    const conversationId = params.conversation_id ?? getCurrentConversationId();
    if (!conversationId) {
      throw ToolError.validation(
        'No conversation is open in the current tab. Pass a conversation_id from list_conversations.',
      );
    }

    const [title, { turns }] = await Promise.all([
      getConversationTitle(conversationId),
      getConversationTurns(conversationId, params.limit ?? 50),
    ]);

    return {
      conversation_id: conversationId,
      title,
      url: conversationUrl(conversationId),
      turns,
    };
  },
});
