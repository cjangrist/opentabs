import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { chat, conversationUrl, resolveModel } from '../kimi-api.js';
import { chatResultSchema, mapChatResult } from './schemas.js';

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description:
    'Start a new Kimi conversation by sending an initial message, and wait for the full reply. Returns the new conversation ID plus the response text. Pass the returned conversation_id to send_message to continue the thread.',
  summary: 'Start a new Kimi conversation',
  icon: 'plus',
  group: 'Conversations',
  input: z.object({
    text: z.string().min(1).describe('Message text that starts the conversation'),
    model_id: z
      .string()
      .optional()
      .describe('Model ID from list_models (e.g., "k2d6", "k3"). Defaults to the fast "Instant" model.'),
    thinking: z.boolean().optional().describe('Enable Kimi reasoning mode for this message (default false).'),
    search: z.boolean().optional().describe('Allow Kimi to use web search while answering (default false).'),
  }),
  output: chatResultSchema,
  handle: async params => {
    const model = await resolveModel(params.model_id);
    const result = await chat({
      text: params.text,
      scenario: model.scenario,
      kimiPlusId: model.kimiPlusId,
      thinking: params.thinking ?? false,
      useSearch: params.search ?? false,
      reasoningEffort: params.thinking ? 'REASONING_EFFORT_LOW' : 'REASONING_EFFORT_NONE',
    });

    return mapChatResult(result, conversationUrl(result.conversationId));
  },
});
