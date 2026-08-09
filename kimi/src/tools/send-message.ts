import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { resolveConversationId } from '../kimi-api.js';
import { sendTurn } from '../kimi-send.js';
import { TURN_DESCRIPTION_SUFFIX, turnInputShape, turnOutputSchema } from './turn-shapes.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Send a message in an existing Kimi conversation and return the reply as normalized SPEC §3 items. ' +
    'Omit conversation_id to use the conversation open in the active kimi.com tab. ' +
    'The message is threaded onto the newest message in the chat, so no branch is created. ' +
    TURN_DESCRIPTION_SUFFIX,
  summary: 'Send a message and get the reply',
  icon: 'send',
  group: 'Conversations',
  input: z.object({
    ...turnInputShape,
    conversation_id: z.string().optional().describe('Kimi chat id. Omit to resolve it from the active kimi.com tab.'),
  }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params, resolveConversationId(params.conversation_id)),
});
