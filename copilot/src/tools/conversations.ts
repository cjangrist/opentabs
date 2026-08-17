import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getCurrentConversationId } from '../copilot-api.js';
import {
  deleteConversationRecord,
  fetchConversationsPage,
  getConversationMetadata,
  mapConversationRow,
  renameConversationRecord,
  setConversationPinned,
  type RawConversation,
} from '../copilot-conversations.js';
import { pageLocalArray } from '../copilot-pagination.js';
import { collectProjectConversationsWithStats, collectProjectsWithStats } from '../copilot-projects.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

const MAX_PAGES = 200;

export const resolveConversationId = (provided: string | undefined): string => {
  const conversationId = provided ?? getCurrentConversationId();
  if (!conversationId)
    throw ToolError.validation(
      'No Copilot conversation is open in the active tab. Pass a conversation_id from list_conversations.',
      'VALIDATION_ERROR',
    );
  return conversationId;
};

interface ConversationWithProject {
  row: RawConversation;
  projectId: string | null;
}

const collectGlobalConversations = async (): Promise<{ rows: RawConversation[]; pagesFetched: number }> => {
  const rows: RawConversation[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = await fetchConversationsPage(cursor);
    pagesFetched += 1;
    rows.push(...page.rows);
    if (!page.next || page.next === cursor || page.rows.length === 0) break;
    cursor = page.next;
  }
  return { rows, pagesFetched };
};

/** Includes chats filed in Projects, which Copilot intentionally omits from the global Recent list. */
export const collectAllConversationsWithStats = async (): Promise<{
  rows: ConversationWithProject[];
  pagesFetched: number;
}> => {
  const [globalResult, projectsResult] = await Promise.all([collectGlobalConversations(), collectProjectsWithStats()]);
  const projectRows = await Promise.all(
    projectsResult.rows.map(async project => ({
      projectId: project.id ?? '',
      result: project.id ? await collectProjectConversationsWithStats(project.id) : { rows: [], pagesFetched: 0 },
    })),
  );
  const byId = new Map<string, ConversationWithProject>();
  for (const row of globalResult.rows) {
    if (row.id) byId.set(row.id, { row, projectId: null });
  }
  for (const project of projectRows) {
    for (const row of project.result.rows) {
      if (row.id) byId.set(row.id, { row, projectId: project.projectId });
    }
  }
  const rows = [...byId.values()].sort((left, right) => {
    const leftTime = Date.parse(left.row.updatedAt ?? left.row.continuedAt ?? '') || 0;
    const rightTime = Date.parse(right.row.updatedAt ?? right.row.continuedAt ?? '') || 0;
    return rightTime - leftTime;
  });
  return {
    rows,
    pagesFetched:
      globalResult.pagesFetched +
      projectsResult.pagesFetched +
      projectRows.reduce((total, project) => total + project.result.pagesFetched, 0),
  };
};

export const collectAllConversations = async (): Promise<ConversationWithProject[]> =>
  (await collectAllConversationsWithStats()).rows;

export const listConversations = defineTool({
  name: 'list_conversations',
  displayName: 'List Conversations',
  description:
    "List all Copilot chats newest first. Copilot's global Recent endpoint deliberately hides chats moved into a " +
    'Project, so this tool exhausts that cursor and every native Project-members cursor, de-duplicates by id, and ' +
    'paginates the complete sorted result locally. total is therefore exact. Copilot publishes no creation time or ' +
    'last-used model in list rows, so created_at is 0 and model_id is null; is_starred maps native Pin.',
  summary: 'List every Copilot chat',
  icon: 'message-square',
  group: 'Conversations',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    const collected = await collectAllConversationsWithStats();
    const page = pageLocalArray(
      collected.rows.map(({ row, projectId }) => mapConversationRow(row, projectId)),
      resolvePagination(params),
    );
    page.page_info.pages_fetched = collected.pagesFetched;
    return page;
  },
});

export const renameConversation = defineTool({
  name: 'rename_conversation',
  displayName: 'Rename Conversation',
  description:
    "Rename a Copilot chat through its native PATCH endpoint and verify the stored title. Omit conversation_id to use the active tab's chat.",
  summary: 'Rename a Copilot chat',
  icon: 'pencil',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1),
  }),
  output: z.object({ conversation_id: z.string(), title: z.string() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    await getConversationMetadata(conversationId);
    await renameConversationRecord(conversationId, params.title);
    const updated = await getConversationMetadata(conversationId);
    if (updated.title !== params.title)
      throw new ToolError(
        `Copilot accepted the rename for ${conversationId}, but stored title ${JSON.stringify(updated.title ?? '')}.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      );
    return { conversation_id: conversationId, title: updated.title ?? '' };
  },
});

export const starConversation = defineTool({
  name: 'star_conversation',
  displayName: 'Star Conversation',
  description:
    'Pin or unpin a Copilot chat. Copilot labels this Pin, while the normalized row exposes is_starred. The stored state is verified after mutation.',
  summary: 'Pin or unpin a Copilot chat',
  icon: 'star',
  group: 'Conversations',
  input: z.object({
    conversation_id: z.string().trim().min(1).optional(),
    starred: z.boolean().optional().describe('Desired Pin state (default true).'),
  }),
  output: conversationListItemSchema,
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    const desired = params.starred ?? true;
    await getConversationMetadata(conversationId);
    await setConversationPinned(conversationId, desired);
    const updated = await getConversationMetadata(conversationId);
    if (updated.isPinned !== desired)
      throw new ToolError(`Copilot did not persist Pin=${desired} for ${conversationId}.`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    const all = await collectAllConversations();
    const projectId = all.find(entry => entry.row.id === conversationId)?.projectId ?? null;
    return mapConversationRow(updated, projectId);
  },
});

export const deleteConversation = defineTool({
  name: 'delete_conversation',
  displayName: 'Delete Conversation',
  description:
    "Permanently delete a Copilot chat through the native endpoint. This cannot be undone. Omit conversation_id to use the active tab's chat.",
  summary: 'Delete a Copilot chat',
  icon: 'trash-2',
  group: 'Conversations',
  input: z.object({ conversation_id: z.string().trim().min(1).optional() }),
  output: z.object({ conversation_id: z.string(), deleted: z.boolean() }),
  handle: async params => {
    const conversationId = resolveConversationId(params.conversation_id);
    await getConversationMetadata(conversationId);
    await deleteConversationRecord(conversationId);
    const stillPresent = (await collectAllConversations()).some(entry => entry.row.id === conversationId);
    if (stillPresent)
      throw new ToolError(`Copilot still lists ${conversationId} after deletion.`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return { conversation_id: conversationId, deleted: true };
  },
});
