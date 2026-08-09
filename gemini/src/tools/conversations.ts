import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { deleteConversationRow, listConversationRows, renameConversationRow } from '../gemini-conversations.js';
import { resolveConversationId } from '../gemini-api.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

const PAGINATION_NOTE =
  "Paginated with Gemini's own opaque continuation token (RPC MaZiqc). Gemini hard-caps a page at 100 rows however " +
  'large a limit is requested, and reports no total, so total is always null. The end of the list arrives as an ' +
  'HTTP 200 whose payload slot is null with BardErrorInfo 1096 — that specific code is treated as exhaustion and ' +
  'every other status is raised.';

export const listConversations = defineTool({
  name: 'list_conversations',
  displayName: 'List Conversations',
  description:
    'List the Gemini chats in the account, newest first, exactly as the Recents sidebar orders them. ' +
    PAGINATION_NOTE +
    ' Gemini publishes only one timestamp per row (last update), so created_at mirrors updated_at. ' +
    'project_id, model_id, is_archived and is_starred are always null/false: the list RPC carries none of them and ' +
    'gemini.google.com has no archive action.',
  summary: 'List Gemini chats',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema),
  handle: params => listConversationRows(resolvePagination(params)),
});

export const renameConversation = defineTool({
  name: 'rename_conversation',
  displayName: 'Rename Conversation',
  description:
    'Rename a Gemini chat. Sends the site\'s own field-mask update (RPC MUAZcd with mask ["title"]). ' +
    'Omit conversation_id to rename the chat open in the active gemini.google.com tab.',
  summary: 'Rename a Gemini chat',
  icon: 'pencil',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Conversation id. Omit to use the active gemini.google.com tab.'),
    title: z.string().min(1).describe('The new title.'),
  }),
  output: z.object({ conversation_id: z.string(), title: z.string() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    await renameConversationRow(conversationId, params.title);
    return { conversation_id: conversationId, title: params.title };
  },
});

export const deleteConversation = defineTool({
  name: 'delete_conversation',
  displayName: 'Delete Conversation',
  description:
    'Permanently delete a Gemini chat (RPC GzXR5e). This removes the prompts and responses from Gemini Apps Activity ' +
    'and cannot be undone. Omit conversation_id to delete the chat open in the active gemini.google.com tab.',
  summary: 'Delete a Gemini chat',
  icon: 'trash-2',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Conversation id. Omit to use the active gemini.google.com tab.'),
  }),
  output: z.object({ conversation_id: z.string(), deleted: z.boolean() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    await deleteConversationRow(conversationId);
    return { conversation_id: conversationId, deleted: true };
  },
});
