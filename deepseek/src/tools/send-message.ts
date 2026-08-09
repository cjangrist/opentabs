import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { resolveConversationId } from '../deepseek-api.js';
import { sendTurn } from '../deepseek-send.js';
import { TURN_DESCRIPTION_SUFFIX, turnInputShape, turnOutputSchema } from './turn-shapes.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    `Send a follow-up message to an existing DeepSeek conversation. ${TURN_DESCRIPTION_SUFFIX} ` +
    'Omit conversation_id to use the conversation open in the active chat.deepseek.com tab. ' +
    'The message threads onto the live leaf of the message tree (chat_session.current_message_id).',
  summary: 'Send a message',
  icon: 'send',
  group: 'Conversations',
  input: z.object({
    conversation_id: z
      .string()
      .optional()
      .describe('DeepSeek chat session id. Omit to resolve it from the active chat.deepseek.com tab.'),
    ...turnInputShape,
  }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params, resolveConversationId(params.conversation_id)),
});
