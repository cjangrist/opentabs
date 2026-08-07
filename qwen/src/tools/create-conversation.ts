import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { chat, conversationUrl, resolveModelId } from '../qwen-api.js';
import { chatResultSchema, mapChatResult, modelIdInput, searchInput, thinkingInput } from './schemas.js';

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description:
    'Start a new Qwen conversation by sending an initial message, and wait for the full reply. Returns the new conversation ID plus the response text. Pass the returned conversation_id to send_message to continue the thread.',
  summary: 'Start a new Qwen conversation',
  icon: 'plus',
  group: 'Conversations',
  input: z.object({
    text: z.string().min(1).describe('Message text that starts the conversation'),
    model_id: modelIdInput,
    thinking: thinkingInput,
    search: searchInput,
  }),
  output: chatResultSchema,
  handle: async params => {
    const modelId = await resolveModelId(params.model_id);
    const result = await chat({
      text: params.text,
      modelId,
      thinking: params.thinking,
      search: params.search ?? false,
    });

    return mapChatResult(result, conversationUrl(result.conversationId));
  },
});
