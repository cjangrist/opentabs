import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { chat, conversationUrl, getCurrentConversationId, getCurrentMessageId, resolveModelId } from '../qwen-api.js';
import { chatResultSchema, mapChatResult, modelIdInput, searchInput, thinkingInput } from './schemas.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Send a message to Qwen and wait for the complete reply. Continues the conversation named by conversation_id, or the one open in the current tab; starts a new conversation when neither is available. Returns the response text along with the conversation and message IDs needed for follow-ups.',
  summary: 'Send a message to Qwen and get the reply',
  icon: 'send',
  group: 'Chat',
  input: z.object({
    text: z.string().min(1).describe('Message text to send to Qwen'),
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
    // Qwen stores messages as a tree, so a follow-up must point at the message
    // that is currently the tip of the branch the site displays.
    const parentMessageId = conversationId ? await getCurrentMessageId(conversationId) : null;
    const modelId = await resolveModelId(params.model_id);

    const result = await chat({
      text: params.text,
      conversationId,
      parentMessageId,
      modelId,
      thinking: params.thinking,
      search: params.search ?? false,
    });

    return mapChatResult(result, conversationUrl(result.conversationId));
  },
});
