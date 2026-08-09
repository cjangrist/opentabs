import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, resolveConversationId } from '../perplexity-api.js';
import { fetchWholeThread } from '../perplexity-conversations.js';
import { mapEntriesToItems } from '../perplexity-messages.js';
import { pageLocalArray } from '../perplexity-pagination.js';
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
    'Read a Perplexity thread as an ordered array of OpenAI-Responses-style items (message / reasoning / ' +
    'web_search_call / tool_call). Omit conversation_id to use the active tab. Each entry is one prompt and one ' +
    'answer, mapping to a user message, the steps the run took (THOUGHT → reasoning, SEARCH_WEB+SEARCH_RESULTS → ' +
    'web_search_call, CODE → tool_call), and an assistant message. The ' +
    'answer is the rendered `ask_text` block; when a turn is still streaming and it is absent, every numbered ' +
    "`ask_text_<n>_markdown` section is joined in order — never just the last one. Perplexity's " +
    'numbered [n] citations become url_citation annotations with real offsets. One entry holds both halves of a ' +
    'turn, so the assistant item carries the entry\'s own uuid and the user item is that uuid plus ":query" — the ' +
    'only synthesized id here. The thread cursor is followed to the end before paging, so `total` IS a true item ' +
    'total and `omitted` covers the whole conversation. `offset` upstream is silently ignored.',
  summary: 'Get a Perplexity thread as normalized items',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z
      .string()
      .optional()
      .describe('Thread slug (from /search/<slug>) or any entry uuid inside it. Omit to use the active tab.'),
    ...paginationInputShape,
    ...itemVisibilityInputShape,
  }),
  output: itemPageOutput.extend({
    conversation_id: z.string(),
    title: z.string(),
    url: z.string(),
    project_id: z.string().nullable().describe('Owning Space, or null.'),
    created_at: z.number().int().describe('Unix seconds.'),
    updated_at: z.number().int().describe('Unix seconds.'),
  }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const thread = await fetchWholeThread(conversationId);
    const { items, omitted } = mapEntriesToItems(thread.entries, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
    });
    const page = pageLocalArray(items, resolvePagination(params));
    const slug = thread.entries[0]?.thread_url_slug || conversationId;
    return {
      ...page,
      page_info: {
        ...page.page_info,
        pages_fetched: thread.pagesFetched,
        truncated: page.page_info.truncated || thread.truncated,
      },
      // The item count is only a TRUE total when the whole thread was read. If
      // the upstream page cap stopped the walk, older entries were never seen,
      // so reporting a concrete total would understate the conversation.
      total: thread.truncated ? null : page.total,
      omitted,
      conversation_id: slug,
      title: thread.title,
      url: conversationUrl(slug),
      project_id: thread.projectId,
      created_at: thread.createdAt,
      updated_at: thread.updatedAt,
    };
  },
});
