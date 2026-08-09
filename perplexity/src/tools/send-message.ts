import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { resolveConversationId } from '../perplexity-api.js';
import { resolveCollection } from '../perplexity-projects.js';
import { type SendResult, sendTurn } from '../perplexity-send.js';
import {
  itemVisibilityInputShape,
  messageOptionsInputShape,
  omittedSchema,
  responseItemSchema,
} from './normalized-schemas.js';

const SELECTION_NOTES =
  'model_id is validated against the live list before any request is sent. Thinking is a MODEL here, not a flag: ' +
  'thinking:true swaps to the picker row\'s "…thinking" sibling and thinking:false swaps back, and a row offering ' +
  'only one of the two rejects the value. thinking_level always raises VALIDATION_ERROR — Perplexity publishes no ' +
  'effort ladder. search:false uses the "writing" focus, answering with no web results. tools must be empty.';

const BUDGET_NOTES =
  'Stops WAITING after ~16s and returns status:"in_progress" without cancelling the run, which completes ' +
  'server-side — poll get_conversation for the finished answer. Perplexity always answers HTTP 200 here; failures ' +
  'arrive as an in-stream error_code frame and are classified, never returned as an empty answer.';

const output = z.object({
  conversation_id: z.string(),
  message_id: z.string().describe('Backend uuid of the answer entry this turn produced.'),
  model: z.string().describe('Model that actually produced the answer.'),
  url: z.string(),
  status: z.enum(['completed', 'in_progress']),
  items: z.array(responseItemSchema).describe('SPEC §3 items for this turn only.'),
  omitted: omittedSchema,
});

const shape = (result: SendResult) => result;

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description: `Start a new Perplexity thread with an initial query. ${SELECTION_NOTES} ${BUDGET_NOTES} Pass project_id to file the new thread into a Space.`,
  summary: 'Start a new Perplexity thread',
  icon: 'plus',
  group: 'Conversations',
  input: z.object({
    text: z.string().min(1).describe('The query that starts the thread.'),
    project_id: z.string().optional().describe('Space uuid or slug to create the thread inside.'),
    ...messageOptionsInputShape,
    ...itemVisibilityInputShape,
  }),
  output,
  handle: async params => {
    const projectId = params.project_id ? (await resolveCollection(params.project_id)).uuid : undefined;
    return shape(await sendTurn({ ...params, project_id: projectId }));
  },
});

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description: `Ask a follow-up in an existing Perplexity thread. Omit conversation_id to use the active tab. A follow-up must point at the thread's newest entry and carry its write token; both are read automatically — without them Perplexity starts a fresh thread. ${SELECTION_NOTES} ${BUDGET_NOTES}`,
  summary: 'Send a follow-up to a Perplexity thread',
  icon: 'send',
  group: 'Conversations',
  input: z.object({
    text: z.string().min(1).describe('The follow-up query.'),
    conversation_id: z.string().optional().describe('Thread slug. Omit to use the active tab.'),
    ...messageOptionsInputShape,
    ...itemVisibilityInputShape,
  }),
  output,
  handle: async params => shape(await sendTurn(params, resolveConversationId(params.conversation_id))),
});
