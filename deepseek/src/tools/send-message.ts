import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  chat,
  conversationUrl,
  getCurrentConversationId,
  getLatestMessageId,
  resolveModelType,
} from '../deepseek-api.js';
import { chatResultSchema, mapChatResult, modelIdInput, searchInput, thinkingInput } from './schemas.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Send a message to DeepSeek and wait for the complete reply. Continues the conversation named by conversation_id, or the one open in the current tab; starts a new conversation when neither is available. Returns the response text along with the conversation and message IDs needed for follow-ups.',
  summary: 'Send a message to DeepSeek and get the reply',
  icon: 'send',
  group: 'Chat',
  input: z.object({
    text: z.string().min(1).describe('Message text to send to DeepSeek'),
    conversation_id: z
      .string()
      .optional()
      .describe(
        'Conversation to continue. Defaults to the conversation open in the current tab, else starts a new one.',
      ),
    model_id: modelIdInput,
    thinking: thinkingInput,
    search: searchInput,
  }),
  output: chatResultSchema,
  handle: async params => {
    const conversationId = params.conversation_id ?? getCurrentConversationId() ?? undefined;
    // DeepSeek threads replies by parent id, so a follow-up must point at the
    // current tip of the conversation.
    const parentMessageId = conversationId ? await getLatestMessageId(conversationId) : null;
    const modelType = await resolveModelType(params.model_id);

    const result = await chat({
      text: params.text,
      conversationId,
      parentMessageId,
      modelType,
      thinking: params.thinking ?? false,
      search: params.search ?? false,
    });

    return mapChatResult(result, conversationUrl(result.conversationId));
  },
});
