import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, getConversation as fetchConversation, getCurrentConversationId } from '../perplexity-api.js';
import { mapTurn, turnSchema } from './schemas.js';

export const getConversation = defineTool({
  name: 'get_conversation',
  displayName: 'Get Conversation',
  description:
    'Get a Perplexity thread as prompt/response turns, each with the web sources that answer cited. Reads the thread open in the current tab when no conversation_id is given. Turns come from the Perplexity API, so the whole thread is returned regardless of what is scrolled into view.',
  summary: 'Get a Perplexity thread with its citations',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z
      .string()
      .optional()
      .describe(
        'Thread ID to read (the slug in the /search/<id> URL). Defaults to the thread open in the current tab. Any entry UUID inside the thread also resolves it.',
      ),
    limit: z.number().int().min(1).max(200).optional().describe('Maximum number of turns to read (default 50).'),
  }),
  output: z.object({
    conversation_id: z.string().describe('Canonical thread ID that was read'),
    title: z.string().describe('Thread title'),
    url: z.string().describe('URL to the thread on perplexity.ai'),
    turns: z.array(turnSchema).describe('Turns in chronological order, each with its cited sources'),
  }),
  handle: async params => {
    const conversationId = params.conversation_id ?? getCurrentConversationId();
    if (!conversationId) {
      throw ToolError.validation(
        'No Perplexity thread is open in the current tab. Pass a conversation_id from list_conversations.',
      );
    }

    const detail = await fetchConversation(conversationId, params.limit ?? 50);

    return {
      conversation_id: detail.conversationId,
      title: detail.title,
      url: conversationUrl(detail.conversationId),
      turns: detail.turns.map(mapTurn),
    };
  },
});
