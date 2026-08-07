import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { sendTurn } from '../zai-send.js';
import { TURN_DESCRIPTION_SUFFIX, turnInputShape, turnOutputSchema } from './turn-shapes.js';

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description:
    'Start a new z.ai conversation and send the first message. project_id moves the new chat into that folder. ' +
    TURN_DESCRIPTION_SUFFIX,
  summary: 'Start a new conversation',
  icon: 'message-square-plus',
  group: 'Conversations',
  input: z.object({
    ...turnInputShape,
    project_id: z.string().optional().describe('Folder id from list_projects to create the conversation inside.'),
  }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params),
});
