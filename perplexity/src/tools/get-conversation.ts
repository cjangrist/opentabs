import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  type ConversationDetail,
  conversationUrl,
  getConversation as fetchConversation,
  getCurrentConversationId,
} from '../perplexity-api.js';
import { mapTurn, turnSchema } from './schemas.js';

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_ITEMS = 1000;

export const getConversation = defineTool({
  name: 'get_conversation',
  displayName: 'Get Conversation',
  description:
    'Get a Perplexity thread as prompt/response turns, each with the web sources that answer cited. Reads the ' +
    'thread open in the current tab when no conversation_id is given. Turns are read from the Perplexity API in ' +
    'pages of `limit`, newest page first — a single call only returns that page, not the whole thread; check ' +
    '`has_more` and pass the returned `next_cursor` back as `cursor` to walk further into the history, or set ' +
    '`fetch_all` to follow the cursor automatically up to `max_items`. `items` is always in chronological ' +
    '(oldest-first) order regardless of how many pages were walked to build it.',
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
    cursor: z
      .string()
      .optional()
      .describe('Opaque pagination cursor from a previous response`s next_cursor. Omit to start at the newest turn.'),
    limit: z.number().int().min(1).max(200).optional().describe('Turns per page requested from the API (default 50).'),
    fetch_all: z
      .boolean()
      .optional()
      .describe('Follow next_cursor until the thread is exhausted or max_items is reached (default false).'),
    max_items: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Hard ceiling on total turns collected when fetch_all is true (default 1000).'),
  }),
  output: z.object({
    conversation_id: z.string().describe('Canonical thread ID that was read'),
    title: z.string().describe('Thread title'),
    url: z.string().describe('URL to the thread on perplexity.ai'),
    items: z.array(turnSchema).describe('Turns in chronological (oldest-first) order, each with its cited sources'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Cursor to pass back to read older turns; null when there is definitively no more history'),
    has_more: z.boolean().describe('Whether next_cursor is non-null'),
    total: z.number().nullable().describe('Always null — the thread endpoint reports no true turn count'),
    page_info: z
      .object({
        returned: z.number().int().describe('Number of turns returned in this response'),
        pages_fetched: z.number().int().describe('Number of upstream pages walked to build this response'),
        truncated: z.boolean().describe('True if max_items stopped the walk while older turns remained'),
      })
      .describe('Pagination bookkeeping for this response'),
  }),
  handle: async params => {
    const conversationId = params.conversation_id ?? getCurrentConversationId();
    if (!conversationId) {
      throw ToolError.validation(
        'No Perplexity thread is open in the current tab. Pass a conversation_id from list_conversations.',
      );
    }

    const limit = params.limit ?? DEFAULT_LIMIT;
    const maxItems = params.max_items ?? DEFAULT_MAX_ITEMS;

    let cursor = params.cursor;
    let pagesFetched = 0;
    let collected = 0;
    let truncated = false;
    // Pages are fetched newest-window-first (the cursor walks backward through history);
    // reversing the page order — not each page's own oldest-first contents — reassembles
    // true chronology.
    const pages: ReturnType<typeof mapTurn>[][] = [];
    let detail!: ConversationDetail;

    for (;;) {
      detail = await fetchConversation(conversationId, limit, cursor);
      pagesFetched += 1;
      const page = detail.turns.map(mapTurn);
      pages.push(page);
      collected += page.length;
      cursor = detail.nextCursor ?? undefined;

      if (!params.fetch_all || !cursor) break;
      if (collected >= maxItems) {
        truncated = true;
        break;
      }
    }

    const items = pages.slice().reverse().flat();
    const nextCursor = cursor ?? null;

    return {
      conversation_id: detail.conversationId,
      title: detail.title,
      url: conversationUrl(detail.conversationId),
      items,
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
      total: null,
      page_info: {
        returned: items.length,
        pages_fetched: pagesFetched,
        truncated,
      },
    };
  },
});
