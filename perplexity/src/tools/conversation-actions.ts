import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, resolveConversationId } from '../perplexity-api.js';
import { deleteThread, fetchThreadTip, renameThread, setThreadArchived } from '../perplexity-conversations.js';

export const renameConversation = defineTool({
  name: 'rename_conversation',
  displayName: 'Rename Conversation',
  description:
    "Rename a Perplexity thread. Perplexity keys the rename on the thread's context uuid plus its per-thread write " +
    "token, both read from the thread's newest entry, so the thread must exist and be writable by this account.",
  summary: 'Rename a Perplexity thread',
  icon: 'pencil',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Thread slug. Omit to use the active tab.'),
    title: z.string().min(1).describe('New title.'),
  }),
  output: z.object({ conversation_id: z.string(), title: z.string(), url: z.string() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const tip = await fetchThreadTip(conversationId);
    await renameThread(tip, params.title);
    return { conversation_id: tip.conversationId, title: params.title, url: conversationUrl(tip.conversationId) };
  },
});

export const deleteConversation = defineTool({
  name: 'delete_conversation',
  displayName: 'Delete Conversation',
  description:
    'Permanently delete a Perplexity thread. This cannot be undone. Perplexity deletes by entry uuid plus the ' +
    "thread's write token, both read from the thread's newest entry.",
  summary: 'Delete a Perplexity thread',
  icon: 'trash-2',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Thread slug. Omit to use the active tab.'),
  }),
  output: z.object({ conversation_id: z.string(), deleted: z.boolean() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const tip = await fetchThreadTip(conversationId);
    await deleteThread(tip);
    return { conversation_id: tip.conversationId, deleted: true };
  },
});

export const archiveConversation = defineTool({
  name: 'archive_conversation',
  displayName: 'Archive Conversation',
  description:
    'Archive or unarchive a Perplexity thread. Archived threads LEAVE the Library listing entirely — Perplexity ' +
    'offers no way to list them back — so a successful archive shows up as the thread disappearing from ' +
    'list_conversations, and is_archived there is false for everything it can still see. The URL keeps working. ' +
    'Set archived:false to restore.',
  summary: 'Archive a Perplexity thread',
  icon: 'archive',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().optional().describe('Thread slug. Omit to use the active tab.'),
    archived: z.boolean().optional().describe('True to archive (default), false to unarchive.'),
  }),
  output: z.object({ conversation_id: z.string(), is_archived: z.boolean() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const tip = await fetchThreadTip(conversationId);
    const archived = params.archived ?? true;
    await setThreadArchived(tip.contextUuid, archived);
    return { conversation_id: tip.conversationId, is_archived: archived };
  },
});
