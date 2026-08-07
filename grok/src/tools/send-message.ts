import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  chatAndEnrich,
  conversationUrl,
  getCurrentConversationId,
  getTipResponseId,
  resolveModelId,
} from '../grok-api.js';
import { chatResultSchema, mapChatResult, modelIdInput, searchInput, thinkingInput } from './schemas.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Send a message to Grok and wait for the complete reply. Continues the conversation named by conversation_id, or the one open in the current tab; starts a new conversation when neither is available. Returns the response text along with the conversation and message IDs needed for follow-ups.',
  summary: 'Send a message to Grok and get the reply',
  icon: 'send',
  group: 'Chat',
  input: z.object({
    text: z.string().min(1).describe('Message text to send to Grok'),
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
    // Grok stores messages as a tree, so a follow-up must point at the message
    // that is currently the tip of the branch the site displays.
    const parentResponseId = conversationId ? await getTipResponseId(conversationId) : null;
    const modelId = await resolveModelId(params.model_id, params.thinking);

    const result = await chatAndEnrich({
      text: params.text,
      conversationId,
      parentResponseId,
      modelId,
      search: params.search,
    });

    return mapChatResult(result, conversationUrl(result.conversationId));
  },
});
