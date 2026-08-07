import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../chatgpt-api.js';
import { conversationDetailSchema, mapConversationDetail } from './schemas.js';

export const getConversation = defineTool({
  name: 'get_conversation',
  displayName: 'Get Conversation',
  description:
    'Get a ChatGPT conversation with its full message history. Messages are returned in chronological order following the active branch of the conversation tree. By default only the user-visible dialogue is returned; the `omitted` counts report how many reasoning, tool and hidden messages were left out.',
  summary: 'Get a conversation with messages',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().describe('Conversation ID (UUID)'),
    include_reasoning: z
      .boolean()
      .optional()
      .describe('Include the assistant thinking summaries and "Thought for Ns" recaps (default false)'),
    include_tool_messages: z
      .boolean()
      .optional()
      .describe('Include tool calls (web search, python, ...) and their results (default false)'),
  }),
  output: z.object({ conversation: conversationDetailSchema }),
  handle: async params => {
    const data = await api<Record<string, unknown>>(`/conversation/${params.conversation_id}`);
    return {
      conversation: mapConversationDetail(data as Parameters<typeof mapConversationDetail>[0], {
        includeReasoning: params.include_reasoning,
        includeToolMessages: params.include_tool_messages,
      }),
    };
  },
});
