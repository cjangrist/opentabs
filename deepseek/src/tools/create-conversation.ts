import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { sendTurn } from '../deepseek-send.js';
import { TURN_DESCRIPTION_SUFFIX, turnInputShape, turnOutputSchema } from './turn-shapes.js';

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description:
    `Start a new DeepSeek conversation and send the first message. ${TURN_DESCRIPTION_SUFFIX} ` +
    'model_id picks the mode the chat is FIXED to for its whole life — DeepSeek cannot switch modes mid-conversation.',
  summary: 'Start a conversation',
  icon: 'message-square-plus',
  group: 'Conversations',
  input: z.object({ ...turnInputShape }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params),
});
