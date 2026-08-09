import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { sendTurn } from '../qwen-send.js';
import { TURN_DESCRIPTION_SUFFIX, turnInputShape, turnOutputSchema } from './turn-shapes.js';

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description:
    'Start a new Qwen conversation and send the first message. project_id creates the chat inside that project. ' +
    TURN_DESCRIPTION_SUFFIX,
  summary: 'Start a new conversation',
  icon: 'message-square-plus',
  group: 'Conversations',
  input: z.object({
    ...turnInputShape,
    project_id: z.string().optional().describe('Project id from list_projects to create the conversation inside.'),
  }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params),
});
