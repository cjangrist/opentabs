import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { listConversations as fetchConversations } from '../qwen-api.js';
import { conversationSchema, mapConversation } from './schemas.js';

export const listConversations = defineTool({
  name: 'list_conversations',
  displayName: 'List Conversations',
  description:
    "List the account's Qwen conversations, pinned first and then newest first — the same list the Qwen sidebar shows. Chats filed under a project are included too, with their project_id set. Use a returned id with get_conversation or send_message.",
  summary: 'List recent Qwen conversations',
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
    conversations: z.array(conversationSchema).describe('Conversations, pinned first then newest first'),
  }),
  handle: async params => {
    const conversations = await fetchConversations(params.limit ?? 30);
    return { conversations: conversations.map(mapConversation) };
  },
});
