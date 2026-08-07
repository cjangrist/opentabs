import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { listConversations as fetchConversations } from '../perplexity-api.js';
import { conversationSchema, mapConversation } from './schemas.js';

export const listConversations = defineTool({
  name: 'list_conversations',
  displayName: 'List Conversations',
  description:
    "List the account's Perplexity threads, newest first — the same list the Library page shows. Threads that live inside a Space are included and carry space_name. Use a returned id with get_conversation or send_message.",
  summary: 'List recent Perplexity threads',
  icon: 'list',
  group: 'Conversations',
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Maximum number of threads to return (default 50, max 500).'),
  }),
  output: z.object({
    conversations: z.array(conversationSchema).describe('Threads, newest first'),
  }),
  handle: async params => {
    const conversations = await fetchConversations(params.limit ?? 50);
    return { conversations: conversations.map(mapConversation) };
  },
});
