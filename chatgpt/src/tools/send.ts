import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { resolveConversationId } from '../chatgpt-api.js';
import { sendTurn } from '../chatgpt-send.js';
import {
  itemVisibilityInputShape,
  messageOptionsInputShape,
  omittedSchema,
  responseItemSchema,
} from './normalized-schemas.js';

export const turnOutputSchema = z.object({
  conversation_id: z.string(),
  message_id: z.string().describe('Id of the assistant message this turn produced, or "" while it is still empty.'),
  model: z.string(),
  url: z.string(),
  status: z
    .enum(['completed', 'in_progress'])
    .describe(
      'in_progress means ChatGPT was still generating when the 18s wait budget expired. The generation keeps running ' +
        'in the page — poll get_conversation for the finished reply.',
    ),
  items: z.array(responseItemSchema).describe('SPEC §3 items for this turn only — the prompt and the reply.'),
  omitted: omittedSchema,
});

const SEND_NOTES =
  'model_id is validated against the live list first. Thinking is a model LANE here, not a toggle: thinking:true ' +
  'needs a model with an effort ladder, and thinking:false on such a model is rejected rather than ignored. ' +
  'thinking_level maps onto the native ladder (minimal/low\u2192min, medium\u2192standard, ' +
  'high\u2192extended, max\u2192max), falling back to the nearest lower step a model publishes. `search` and `tools` are ' +
  'rejected: ChatGPT searches autonomously with no per-message switch. Sending drives the page composer because ' +
  'POST /backend-api/f/conversation is gated by OpenAI Sentinel and 403s a direct call, so model selection drives ' +
  'the in-page picker; omit model_id/thinking/thinking_level to keep its current setting. ' +
  'Waits at most 18s (the adapter kills a tool at 25s) then returns status:"in_progress"; the generation keeps ' +
  'running and get_conversation returns the finished answer.';

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description: `Start a new ChatGPT conversation with a first message, returning the reply as normalized items. ${SEND_NOTES}`,
  summary: 'Create a conversation with a first message',
  icon: 'plus',
  group: 'Conversations',
  input: z.object({
    text: z.string().min(1).describe('First message to send.'),
    project_id: z
      .string()
      .optional()
      .describe(
        'Project id (starts with "g-p-"). The chat is created in the ungrouped list and moved into the project once ' +
          'it exists; the id is validated before anything is sent.',
      ),
    ...messageOptionsInputShape,
    ...itemVisibilityInputShape,
  }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params),
});

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description: `Send a follow-up in a ChatGPT conversation, returning the reply as normalized items. ${SEND_NOTES}`,
  summary: 'Send a message in a conversation',
  icon: 'send',
  group: 'Conversations',
  input: z.object({
    text: z.string().min(1).describe('Message to send.'),
    conversation_id: z
      .string()
      .optional()
      .describe('Conversation UUID. Omit to use the conversation open in the active chatgpt.com tab.'),
    ...messageOptionsInputShape,
    ...itemVisibilityInputShape,
  }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params, resolveConversationId(params.conversation_id)),
});
