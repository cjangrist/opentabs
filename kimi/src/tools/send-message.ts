import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { chat, conversationUrl, getCurrentConversationId, getLatestMessageId, resolveModel } from '../kimi-api.js';
import { chatResultSchema, mapChatResult } from './schemas.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Send a message to Kimi and wait for the complete reply. Continues the conversation named by conversation_id, or the one open in the current tab; starts a new conversation when neither is available. Returns the response text along with the conversation and message IDs needed for follow-ups.',
  summary: 'Send a message to Kimi and get the reply',
  icon: 'send',
  group: 'Chat',
  input: z.object({
    text: z.string().min(1).describe('Message text to send to Kimi'),
    conversation_id: z
      .string()
      .optional()
      .describe(
        'Conversation to continue. Defaults to the conversation open in the current tab, else starts a new one.',
      ),
    model_id: z
      .string()
      .optional()
      .describe('Model ID from list_models (e.g., "k2d6", "k3"). Defaults to the fast "Instant" model.'),
    thinking: z.boolean().optional().describe('Enable Kimi reasoning mode for this message (default false).'),
    search: z.boolean().optional().describe('Allow Kimi to use web search while answering (default false).'),
  }),
  output: chatResultSchema,
  handle: async params => {
    const conversationId = params.conversation_id ?? getCurrentConversationId() ?? undefined;
    const parentMessageId = conversationId ? await getLatestMessageId(conversationId) : undefined;
    const model = await resolveModel(params.model_id);

    const result = await chat({
      text: params.text,
      conversationId,
      parentMessageId,
      scenario: model.scenario,
      kimiPlusId: model.kimiPlusId,
      thinking: params.thinking ?? false,
      useSearch: params.search ?? false,
      reasoningEffort: params.thinking ? 'REASONING_EFFORT_LOW' : 'REASONING_EFFORT_NONE',
    });

    return mapChatResult(result, conversationUrl(result.conversationId));
  },
});
