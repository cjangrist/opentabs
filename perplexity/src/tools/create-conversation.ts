import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { ask, assertKnownModel, conversationUrl } from '../perplexity-api.js';
import { askResultSchema, focusInput, mapAskResult, modelIdInput, sourcesInput } from './schemas.js';

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description:
    'Start a new Perplexity thread with an initial query and wait for the complete answer. Returns the new thread ID, the answer in Markdown and the web sources it cited ([n] markers in the answer index into sources). Pass the returned conversation_id to send_message to ask a follow-up in the same thread.',
  summary: 'Start a new Perplexity thread',
  icon: 'plus',
  group: 'Conversations',
  input: z.object({
    text: z.string().min(1).describe('The query that starts the thread'),
    model_id: modelIdInput,
    focus: focusInput,
    sources: sourcesInput,
  }),
  output: askResultSchema,
  handle: async params => {
    if (params.model_id) await assertKnownModel(params.model_id);

    const result = await ask({
      text: params.text,
      modelId: params.model_id,
      focus: params.focus,
      sources: params.sources,
    });

    return mapAskResult(result, conversationUrl(result.conversationId));
  },
});
