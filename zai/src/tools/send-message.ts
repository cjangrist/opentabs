import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { resolveConversationId } from '../zai-api.js';
import { sendTurn } from '../zai-send.js';
import { TURN_DESCRIPTION_SUFFIX, turnInputShape, turnOutputSchema } from './turn-shapes.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Send a follow-up message to an existing z.ai conversation. Omit conversation_id to use the conversation open in the active chat.z.ai tab. The prior turns are replayed to the model exactly as the web app replays them, and the new user turn is appended to the stored history first. ' +
    TURN_DESCRIPTION_SUFFIX,
  summary: 'Send a message to a conversation',
  icon: 'send',
  group: 'Conversations',
  input: z.object({
    ...turnInputShape,
    conversation_id: z.string().optional().describe('Chat UUID. Omit to resolve it from the active chat.z.ai tab.'),
  }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params, resolveConversationId(params.conversation_id)),
});
