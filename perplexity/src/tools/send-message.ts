import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  ask,
  assertKnownModel,
  conversationUrl,
  getConversation,
  getCurrentConversationId,
} from '../perplexity-api.js';
import { askResultSchema, focusInput, mapAskResult, modelIdInput, sourcesInput } from './schemas.js';

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Ask Perplexity a question and wait for the complete answer, with its web sources. Continues the thread named by conversation_id, or the thread open in the current tab; starts a new thread when neither is available. Follow-ups see the earlier turns, so pronouns and references resolve against them.',
  summary: 'Ask Perplexity and get the answer with sources',
  icon: 'send',
  group: 'Chat',
  input: z.object({
    text: z.string().min(1).describe('The query to send'),
    conversation_id: z
      .string()
      .optional()
      .describe('Thread to continue. Defaults to the thread open in the current tab, else starts a new one.'),
    model_id: modelIdInput,
    focus: focusInput,
    sources: sourcesInput,
  }),
  output: askResultSchema,
  handle: async params => {
    if (params.model_id) await assertKnownModel(params.model_id);

    const conversationId = params.conversation_id ?? getCurrentConversationId() ?? undefined;

    // A follow-up must point at the current tip of the thread and carry the
    // thread's write token; without both the gateway starts a fresh thread.
    const thread = conversationId ? await getConversation(conversationId, 1) : undefined;

    const result = await ask({
      text: params.text,
      modelId: params.model_id,
      focus: params.focus,
      sources: params.sources,
      lastEntryId: thread?.lastEntryId,
      readWriteToken: thread?.readWriteToken,
    });

    const resolvedId = thread?.conversationId ?? result.conversationId;
    return mapAskResult({ ...result, conversationId: resolvedId }, conversationUrl(resolvedId));
  },
});
