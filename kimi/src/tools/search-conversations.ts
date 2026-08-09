import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchSearchPage, mapChatRow, stripHighlight } from '../kimi-conversations.js';
import { getModelCatalog, scenarioToModelId } from '../kimi-models.js';
import { walkTokenPages } from '../kimi-pagination.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

const searchResultSchema = conversationListItemSchema.extend({
  snippet: z
    .string()
    .nullable()
    .describe('Matched excerpt Kimi highlights, with its <em> markup stripped, or null when only the title matched.'),
});

export const searchConversations = defineTool({
  name: 'search_conversations',
  displayName: 'Search Conversations',
  description:
    'Full-text search over the account’s Kimi conversations, via ChatService/ListChats with a `query` — the endpoint the sidebar search box uses. ' +
    'It matches titles AND message bodies, wraps hits in <em> markup (stripped here), and pages with a real pageToken cursor, so results ARE walkable across a page boundary. ' +
    'NOTE 1: FeedService/ListFeeds also accepts a `query` and silently ignores it — it re-ranks but still returns every chat — so search is deliberately routed through ListChats. ' +
    'NOTE 2: Kimi’s search cursor blends two result sets (v1_cursor/v2_cursor) and is NOT a stable prefix across page sizes — asking for 4 rows at once returns different rows 3-4 than ' +
    'two requests of 2. Keep `limit` fixed while walking one query; every request this tool makes uses exactly `limit`, so a fetch_all walk and a manual cursor walk agree. ' +
    'Kimi reports no match count, so total is always null.',
  summary: 'Search conversations (paginated)',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().min(1).describe('Search text.'),
    ...paginationInputShape,
  }),
  output: paginatedOutput(searchResultSchema),
  handle: async params => {
    const catalog = await getModelCatalog();
    const scenarios = scenarioToModelId(catalog);
    return walkTokenPages(
      resolvePagination(params),
      (pageToken, pageSize) => fetchSearchPage(params.query, pageToken, pageSize),
      chat => ({
        ...mapChatRow(chat, scenarios),
        title: stripHighlight(chat.name),
        snippet: chat.messageContent ? stripHighlight(chat.messageContent) : null,
      }),
    );
  },
});
