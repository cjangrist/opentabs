import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  chatAndEnrich,
  conversationUrl,
  createEmptyConversation,
  getCurrentConversationId,
  resolveModelId,
} from '../copilot-api.js';
import { chatResultSchema, mapChatResult, modelIdInput, searchInput, thinkingInput } from './schemas.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Send a message to Copilot and wait for the complete reply. Continues the conversation named by conversation_id, or the one open in the current tab; starts a new conversation when neither is available. Copilot keeps the whole conversation as context, so follow-ups thread naturally.',
  summary: 'Send a message to Copilot and get the reply',
  icon: 'send',
  group: 'Chat',
  input: z.object({
    text: z.string().min(1).describe('Message text to send to Copilot'),
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
    const modelId = resolveModelId(params.model_id, params.thinking, params.search);
    const conversationId = params.conversation_id ?? getCurrentConversationId() ?? (await createEmptyConversation());

    const result = await chatAndEnrich({ text: params.text, conversationId, modelId });
    return mapChatResult(result, conversationUrl(result.conversationId));
  },
});
