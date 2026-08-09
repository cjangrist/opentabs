import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, resolveConversationId } from '../qwen-api.js';
import { getConversationDetail } from '../qwen-conversations.js';
import { mapConversation } from '../qwen-messages.js';
import { pageLocalArray } from '../qwen-pagination.js';
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
    'Read a conversation as an ordered array of OpenAI-Responses-style items (message / reasoning / web_search_call / tool_call). Omit conversation_id to use the conversation open in the active chat.qwen.ai tab. ' +
    'GET /api/v2/chats/<id> returns the whole message tree in one response — its limit / cursor / direction parameters are accepted and silently ignored (verified live: asking for 2 messages of an 8-message chat returns all 8) — so SPEC pagination is applied over the normalized items instead, which makes total a true total. ' +
    'Only the branch the page renders is returned (walked from history.currentId up through parentId); regenerated and edited turns on abandoned branches are counted in omitted.hidden. ' +
    'An assistant turn is an ordered content_list of phase-labelled parts: every answer/ReportGeneration part is joined with a blank line, think/thinking_summary/DeepThinking/ResearchPlanning/ResearchNotice become reasoning items, web_search/WebResearch/image_search/web_extractor become web_search_call items, and any other phase becomes a labelled tool_call rather than being dropped. ' +
    'Reasoning text is read from extra.summary_thought (Qwen\'s default thinking_format is "summary", which leaves the part\'s own content empty). ' +
    "Qwen's inline [[n]] and [[n,m]] citation markers are resolved to url_citation annotations with real offsets, against extra.deep_research.references for a research report or the position in extra.web_search_info for a plain search. " +
    "Content parts carry no id of their own, so reasoning/web_search/tool ids are synthesized as rs_/ws_/tc_ plus the message id and the part index; message ids are Qwen's own. " +
    'omitted covers the WHOLE conversation, not just the returned page.',
  summary: 'Get a conversation as normalized items',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Chat UUID. Omit to resolve it from the active chat.qwen.ai tab.'),
    ...paginationInputShape,
    ...itemVisibilityInputShape,
  }),
  output: itemPageOutput.extend({
    conversation_id: z.string(),
    title: z.string(),
    url: z.string(),
    chat_type: z.string().describe('Qwen routing type of the conversation: t2t, search, deep_research, …'),
  }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const detail = await getConversationDetail(conversationId);
    const { items, omitted } = mapConversation(detail, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
    });
    return {
      ...pageLocalArray(items, resolvePagination(params)),
      omitted,
      conversation_id: conversationId,
      title: detail.title ?? '',
      url: conversationUrl(conversationId),
      chat_type: detail.chat_type ?? '',
    };
  },
});
