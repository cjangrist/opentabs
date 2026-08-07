import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
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
  'model_id is validated against the live model list before anything is typed. ' +
  'On chatgpt.com thinking is a model LANE, not a toggle: thinking:true is only valid on a model that publishes a ' +
  'reasoning-effort ladder, and thinking:false on such a model is rejected rather than silently ignored — pick a ' +
  'non-thinking model id instead. thinking_level maps onto the native ladder (minimal/low→min, medium→standard, ' +
  'high→extended, max→max), falling back to the nearest lower step a model publishes. ' +
  '`search` is rejected: ChatGPT searches autonomously and exposes no per-message switch. `tools` is rejected too. ' +
  'The message is sent by driving the page composer, because POST /backend-api/f/conversation is gated by OpenAI ' +
  'Sentinel (proof-of-work + Turnstile) and answers 403 to a direct call. Selecting a model therefore drives the ' +
  'picker in the page; omit model_id/thinking/thinking_level to send with whatever the composer already has. ' +
  'Waits at most 18s (the adapter kills a tool at 25s) then returns status:"in_progress"; the generation keeps ' +
  'running and get_conversation returns the finished answer.';

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description: `Start a new ChatGPT conversation with a first message and return the reply as normalized items. ${SEND_NOTES} project_id moves the new conversation into that project once it exists.`,
  summary: 'Create a conversation with a first message',
  icon: 'plus',
  group: 'Conversations',
  input: z.object({
    text: z.string().min(1).describe('First message to send.'),
    project_id: z.string().optional().describe('Move the new conversation into this project (id starts with "g-p-").'),
    ...messageOptionsInputShape,
    ...itemVisibilityInputShape,
  }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params),
});

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description: `Send a follow-up message in an existing ChatGPT conversation and return the reply as normalized items. Omit conversation_id to use the conversation open in the active tab. ${SEND_NOTES}`,
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
  handle: async params => sendTurn(params, params.conversation_id ?? undefined),
});
