import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { resolveConversationId } from '../qwen-api.js';
import { sendTurn } from '../qwen-send.js';
import { TURN_DESCRIPTION_SUFFIX, turnInputShape, turnOutputSchema } from './turn-shapes.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Send a follow-up to an existing Qwen conversation. Omit conversation_id to use the active chat.qwen.ai tab. Qwen keeps history server side, so only the new message is uploaded, onto history.currentId. ' +
    TURN_DESCRIPTION_SUFFIX,
  summary: 'Send a message to a conversation',
  icon: 'send',
  group: 'Conversations',
  input: z.object({
    ...turnInputShape,
    conversation_id: z.string().optional().describe('Chat UUID. Omit to resolve it from the active chat.qwen.ai tab.'),
  }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params, { conversationId: resolveConversationId(params.conversation_id) }),
});
