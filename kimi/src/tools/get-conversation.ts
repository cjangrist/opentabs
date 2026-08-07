import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, getConversationTitle, getConversationTurns, getCurrentConversationId } from '../kimi-api.js';
import { turnSchema } from './schemas.js';

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_ITEMS = 1000;

export const getConversation = defineTool({
  name: 'get_conversation',
  displayName: 'Get Conversation',
  description:
    'Get the messages of a Kimi conversation as prompt/response turns. Reads the conversation currently open in ' +
    'the browser tab when no conversation_id is given. Turns are read from the Kimi API in pages of `limit` ' +
    'messages, newest page first — a single call only returns that page, not the whole history; check `has_more` ' +
    'and pass the returned `next_cursor` back as `cursor` to walk further into the history, or set `fetch_all` to ' +
    'follow the cursor automatically up to `max_items`. `items` is always in chronological (oldest-first) order ' +
    'regardless of how many pages were walked to build it.',
  summary: 'Get messages from a Kimi conversation',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z
      .string()
      .optional()
      .describe('Conversation ID to read. Defaults to the conversation open in the current tab.'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque pagination cursor from a previous response`s next_cursor. Omit to start at the newest message.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Messages per page requested from the API (default 50, max 200).'),
    fetch_all: z
      .boolean()
      .optional()
      .describe('Follow next_cursor until the conversation is exhausted or max_items is reached (default false).'),
    max_items: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Hard ceiling on total messages collected when fetch_all is true (default 1000).'),
  }),
  output: z.object({
    conversation_id: z.string().describe('Conversation ID that was read'),
    title: z.string().describe('Conversation title'),
    url: z.string().describe('URL to the conversation on kimi.com'),
    items: z.array(turnSchema).describe('Message turns in chronological (oldest-first) order'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Cursor to pass back to read older messages; null when there is definitively no more history'),
    has_more: z.boolean().describe('Whether next_cursor is non-null'),
    total: z.number().nullable().describe('Always null — the Kimi API reports no true message count'),
    page_info: z
      .object({
        returned: z.number().int().describe('Number of turns returned in this response'),
        pages_fetched: z.number().int().describe('Number of upstream ListMessages pages walked to build this response'),
        truncated: z.boolean().describe('True if max_items stopped the walk while older messages remained'),
      })
      .describe('Pagination bookkeeping for this response'),
  }),
  handle: async params => {
    const conversationId = params.conversation_id ?? getCurrentConversationId();
    if (!conversationId) {
      throw ToolError.validation(
        'No conversation is open in the current tab. Pass a conversation_id from list_conversations.',
      );
    }

    const limit = params.limit ?? DEFAULT_LIMIT;
    const maxItems = params.max_items ?? DEFAULT_MAX_ITEMS;

    const [title, page] = await Promise.all([
      getConversationTitle(conversationId),
      getConversationTurns(conversationId, limit, params.cursor, params.fetch_all ?? false, maxItems),
    ]);

    return {
      conversation_id: conversationId,
      title,
      url: conversationUrl(conversationId),
      items: page.turns,
      next_cursor: page.nextCursor,
      has_more: page.nextCursor !== null,
      total: null,
      page_info: {
        returned: page.turns.length,
        pages_fetched: page.pagesFetched,
        truncated: page.truncated,
      },
    };
  },
});
