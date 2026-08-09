import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, toUnixSeconds } from '../deepseek-api.js';
import { walkSearchPages } from '../deepseek-search.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

const searchResultSchema = conversationListItemSchema.extend({
  message_id: z.string().describe('Id of the matched message within the conversation.'),
  message_role: z.string().describe('Role of the matched message: "USER" or "ASSISTANT".'),
  snippet: z
    .string()
    .describe(
      'The matched excerpt with DeepSeek’s highlight runs flattened back to plain text; "…" marks a clipped edge.',
    ),
  is_thinking: z
    .boolean()
    .describe('True when the match is inside a DeepThink reasoning block rather than the answer.'),
});

export const searchConversations = defineTool({
  name: 'search_conversations',
  displayName: 'Search Conversations',
  description:
    'Full-text search over the account’s DeepSeek history, via POST /index/query — the endpoint the chat.deepseek.com search box uses. ' +
    'It matches MESSAGE bodies (including DeepThink reasoning), so one conversation can appear more than once, once per matched message, exactly as the site’s own results panel shows it. ' +
    'The response is an SSE stream carrying HTTP 200 whatever happens: a close frame of invalid_query / timeout / error is classified here rather than returned as an empty page. ' +
    'It takes NO page-size parameter — the server streams whatever batch it likes (10-50 hits observed) — so limit is applied by slicing and next_cursor carries an intra-batch offset alongside the real before_seq_id cursor. ' +
    'total is always null: the index never reports a match count. created_at is 0 and updated_at is the MATCHED MESSAGE’s time, not the conversation’s.',
  summary: 'Search conversations (paginated)',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().min(1).describe('Search text.'),
    ...paginationInputShape,
  }),
  output: paginatedOutput(searchResultSchema),
  handle: async params =>
    walkSearchPages(params.query, resolvePagination(params), hit => ({
      id: hit.conversationId,
      title: hit.title,
      url: conversationUrl(hit.conversationId),
      created_at: 0,
      updated_at: toUnixSeconds(hit.timestamp),
      project_id: null,
      model_id: hit.modelType || null,
      is_archived: false,
      // The index payload carries no pin flag; list_conversations reports the real one.
      is_starred: false,
      message_id: String(hit.messageId),
      message_role: hit.role,
      snippet: hit.snippet,
      is_thinking: hit.isThinking,
    })),
});
