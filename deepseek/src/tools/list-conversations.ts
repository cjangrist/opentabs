import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { listConversations as fetchConversations } from '../deepseek-api.js';
import { conversationSchema, mapConversation } from './schemas.js';

export const listConversations = defineTool({
  name: 'list_conversations',
  displayName: 'List Conversations',
  description:
    "List the account's DeepSeek chat conversations, newest first — the same list the DeepSeek sidebar shows. Returns conversation IDs, titles and URLs. Use a returned id with get_conversation or send_message.",
  summary: 'List recent DeepSeek conversations',
  icon: 'list',
  group: 'Conversations',
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Maximum number of conversations to return (default 30, max 200).'),
  }),
  output: z.object({
    conversations: z.array(conversationSchema).describe('Conversations, newest first'),
  }),
  handle: async params => {
    const conversations = await fetchConversations(params.limit ?? 30);
    return { conversations: conversations.map(mapConversation) };
  },
});
