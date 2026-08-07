import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { resolveConversationId } from '../claude-api.js';
import { sendTurn } from '../claude-send.js';
import { turnOutputSchema } from './create-conversation.js';
import { itemVisibilityInputShape, messageOptionsInputShape } from './normalized-schemas.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Send a message in an existing Claude conversation and return the reply as normalized items. ' +
    'Omit conversation_id to use the conversation open in the active claude.ai tab. ' +
    "The message is threaded onto the conversation's current leaf, so branches are not created. " +
    'model_id is validated against the live model list before anything is sent; thinking / thinking_level / search behave exactly as on create_conversation. ' +
    'Opus at high effort routinely runs past 25s, which is where the OpenTabs adapter kills a tool — so this waits at most 18s and then returns status:"in_progress" with whatever landed, leaving the completion running in the page. Poll get_conversation for the finished reply.',
  summary: 'Send a message and get the reply',
  icon: 'send',
  group: 'Conversations',
  input: z.object({
    text: z.string().describe('Message to send.'),
    conversation_id: z
      .string()
      .optional()
      .describe('Conversation UUID. Omit to resolve it from the active claude.ai tab.'),
    ...messageOptionsInputShape,
    ...itemVisibilityInputShape,
  }),
  output: turnOutputSchema,
  handle: async params => sendTurn(params, resolveConversationId(params.conversation_id)),
});
