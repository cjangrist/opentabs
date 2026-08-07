import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { chatAndEnrich, conversationUrl, createEmptyConversation, resolveModelId } from '../copilot-api.js';
import { chatResultSchema, mapChatResult, modelIdInput, searchInput, thinkingInput } from './schemas.js';

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description:
    'Start a new Copilot conversation by sending an initial message, and wait for the full reply. Returns the new conversation ID plus the response text. Pass the returned conversation_id to send_message to continue the thread.',
  summary: 'Start a new Copilot conversation',
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
    const modelId = resolveModelId(params.model_id, params.thinking, params.search);
    // Copilot's chat gateway only ever posts into an existing conversation, so
    // a new chat is a REST create followed by the usual send.
    const conversationId = await createEmptyConversation();
    const result = await chatAndEnrich({ text: params.text, conversationId, modelId });
    return mapChatResult(result, conversationUrl(result.conversationId));
  },
});
