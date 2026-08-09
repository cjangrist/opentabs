import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { sendTurn } from '../kimi-send.js';
import { TURN_DESCRIPTION_SUFFIX, turnInputShape, turnOutputSchema } from './turn-shapes.js';

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description:
    'Start a new Kimi conversation with a first message and return the reply as normalized SPEC §3 items. ' +
    'project_id files the new conversation into a project — the ONLY way a Kimi chat ever joins one, since Kimi has no move/add operation ' +
    'for an existing chat (see list_capabilities().features.project_membership). ' +
    'Kimi mints the chat id inside the streaming response and has no CreateChat RPC, so when the wait budget expires first the new chat is ' +
    'identified by diffing the conversation feed — measured live, it appears there ~1.5s after generation starts. ' +
    TURN_DESCRIPTION_SUFFIX,
  summary: 'Start a new Kimi conversation',
  icon: 'plus',
  group: 'Conversations',
  input: z.object({
    ...turnInputShape,
    project_id: z.string().optional().describe('Create the conversation inside this Kimi project.'),
  }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params),
});
