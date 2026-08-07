import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { sendTurn } from '../claude-send.js';
import {
  itemVisibilityInputShape,
  messageOptionsInputShape,
  omittedSchema,
  responseItemSchema,
} from './normalized-schemas.js';

export const turnOutputSchema = z.object({
  conversation_id: z.string(),
  message_id: z.string().describe('UUID of the assistant message this turn produced.'),
  model: z.string(),
  url: z.string(),
  status: z
    .enum(['completed', 'in_progress'])
    .describe(
      'in_progress means Claude was still generating when the 18s wait budget expired. The completion keeps running in the page — poll get_conversation for the finished reply.',
    ),
  items: z.array(responseItemSchema).describe('SPEC §3 items for this turn only — the prompt and the reply.'),
  omitted: omittedSchema,
});

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description:
    'Create a Claude conversation and send its first message, returning the reply as normalized items. ' +
    'model_id is validated against the live model list before anything is sent. ' +
    'thinking maps to Claude\'s thinking_mode ("auto"/"extended" vs "off"); thinking_level maps to its reasoning effort by name ' +
    '(minimal→low, low→low, medium→medium, high→high, max→max), falling back to the nearest lower step a model publishes. ' +
    "search sets the conversation's enabled_web_search and whether the web_search tool is declared — Claude still decides autonomously whether to search. " +
    "For Claude's Research feature use start_deep_research. tools is rejected: claude.ai has no per-message tool allow-list. " +
    'Waits at most 18s (the adapter kills a tool at 25s) then returns status:"in_progress"; the completion keeps running and get_conversation returns the finished answer.',
  summary: 'Create a conversation with a first message',
  icon: 'plus',
  group: 'Conversations',
  input: z.object({
    text: z.string().describe('First message to send.'),
    project_id: z.string().optional().describe('Create the conversation inside this project.'),
    ...messageOptionsInputShape,
    ...itemVisibilityInputShape,
  }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params),
});
