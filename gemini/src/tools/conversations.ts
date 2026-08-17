import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  deleteConversationRow,
  getConversationRow,
  listConversationRows,
  mapConversationListItem,
  renameConversationRow,
  setConversationStarred,
} from '../gemini-conversations.js';
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
    'project_id is the native Notebook resource and is_starred mirrors Gemini Pin. model_id remains null because the ' +
    'row omits it; is_archived is false because Gemini has no archive action.',
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
    await getConversationRow(conversationId);
    await renameConversationRow(conversationId, params.title);
    const updated = await getConversationRow(conversationId);
    if (updated.title !== params.title)
      throw new ToolError(
        `Gemini accepted the rename for ${conversationId}, but the stored title is "${updated.title}".`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      );
    return { conversation_id: updated.id, title: updated.title };
  },
});

export const starConversation = defineTool({
  name: 'star_conversation',
  displayName: 'Star Conversation',
  description:
    'Pin or unpin a Gemini chat. Gemini calls this action Pin, while the normalized conversation row exposes it as ' +
    'is_starred. The current title is read before the native title+pinned mutation and the stored row is verified after it.',
  summary: 'Pin or unpin a Gemini chat',
  icon: 'star',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Conversation id. Omit to use the active Gemini chat.'),
    starred: z.boolean().optional().describe('Desired state (default true).'),
  }),
  output: conversationListItemSchema,
  handle: async params =>
    mapConversationListItem(
      await setConversationStarred(resolveConversationId(params.conversation_id), params.starred ?? true),
    ),
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
    await getConversationRow(conversationId);
    await deleteConversationRow(conversationId);
    return { conversation_id: conversationId, deleted: true };
  },
});
