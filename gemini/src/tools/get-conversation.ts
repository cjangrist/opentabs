import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, resolveConversationId } from '../gemini-api.js';
import { getConversationTurns, mapTurnsToItems } from '../gemini-messages.js';
import { pageLocalArray } from '../gemini-pagination.js';
import {
  itemPageOutput,
  itemVisibilityInputShape,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

export const getConversation = defineTool({
  name: 'get_conversation',
  displayName: 'Get Conversation',
  description:
    'Read a Gemini chat as an ordered array of OpenAI-Responses-style items (message / reasoning / web_search_call), ' +
    'oldest turn first. Omit conversation_id to use the chat open in the active gemini.google.com tab. ' +
    'The transcript RPC (hNvQHb) walks backwards from the newest turn in pages of 100; this tool follows that cursor ' +
    'to the end (up to 2000 turns), re-orders chronologically, then paginates over the normalized items — so total ' +
    'IS a true total and omitted covers the WHOLE conversation, not just the returned page. ' +
    "Every text block of a turn is joined with a blank line. Reasoning items come from Gemini's thought summaries " +
    'and have a synthesized id (<responseId>:reasoning) because Gemini gives them none. ' +
    'annotations is always empty: the transcript RPC carries no citation offsets or grounding URLs for ordinary ' +
    'answers — research runs expose their sources as a web_search_call item instead.',
  summary: 'Get a Gemini chat as normalized items',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Conversation id. Omit to use the active gemini.google.com tab.'),
    ...paginationInputShape,
    ...itemVisibilityInputShape,
  }),
  output: itemPageOutput.extend({
    conversation_id: z.string(),
    url: z.string(),
    turn_count: z.number().int().describe('Prompt/response turns read from Gemini.'),
    transcript_truncated: z
      .boolean()
      .describe('True when the transcript walk stopped at the 2000-turn ceiling rather than at the first turn.'),
  }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const { turns, truncated } = await getConversationTurns(conversationId);
    const { items, omitted } = mapTurnsToItems(turns, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
    });
    return {
      ...pageLocalArray(items, resolvePagination(params)),
      omitted,
      conversation_id: conversationId,
      url: conversationUrl(conversationId),
      turn_count: turns.length,
      transcript_truncated: truncated,
    };
  },
});
