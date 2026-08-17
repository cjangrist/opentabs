import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
import { DEEP_SEARCH_WORKSPACE_ID, api, conversationUrl, toUnixSeconds } from './grok-api.js';
import type { CursorPage } from './grok-pagination.js';
import type { ConversationListItem } from './tools/normalized-schemas.js';

const UPSTREAM_PAGE_SIZE = 60;
const VERIFY_ATTEMPTS = 8;
const VERIFY_DELAY_MS = 350;

export interface RawConversation {
  conversationId?: string;
  title?: string;
  starred?: boolean;
  temporary?: boolean;
  createTime?: string;
  modifyTime?: string;
  workspaceId?: string;
  workspaces?: Array<{ workspaceId?: string }> | string[];
  taskResult?: unknown;
}

interface RawConversationPage {
  conversations?: RawConversation[];
  nextPageToken?: string;
}

export const conversationProjectIds = (conversation: RawConversation): string[] => {
  const ids: string[] = [];
  if (conversation.workspaceId) ids.push(conversation.workspaceId);
  for (const workspace of conversation.workspaces ?? []) {
    const id = typeof workspace === 'string' ? workspace : workspace.workspaceId;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

const projectIdOf = (conversation: RawConversation): string | null =>
  conversationProjectIds(conversation).find(projectId => projectId !== DEEP_SEARCH_WORKSPACE_ID) ?? null;

export const mapConversation = (
  conversation: RawConversation,
  projectId = projectIdOf(conversation),
): ConversationListItem => ({
  id: conversation.conversationId ?? '',
  title: conversation.title ?? '',
  url: conversationUrl(conversation.conversationId ?? ''),
  created_at: toUnixSeconds(conversation.createTime),
  updated_at: toUnixSeconds(conversation.modifyTime),
  project_id: projectId,
  model_id: null,
  is_archived: false,
  is_starred: conversation.starred === true,
});

export const fetchConversationsPage = async (
  cursor: string | undefined,
  options: { search?: string; projectId?: string } = {},
): Promise<CursorPage<RawConversation>> => {
  const payload = await api<RawConversationPage>('/app-chat/conversations', {
    query: {
      pageSize: UPSTREAM_PAGE_SIZE,
      pageToken: cursor,
      searchQuery: options.search,
      workspaceId: options.projectId,
      orderBy: 'ORDER_BY_LAST_USE_TIME',
    },
  });
  return {
    rows: (payload.conversations ?? []).filter(row => Boolean(row.conversationId)),
    next: payload.nextPageToken || null,
  };
};

export const getConversationMetadata = async (conversationId: string): Promise<RawConversation> => {
  const payload = await api<{ conversation?: RawConversation }>(
    `/app-chat/conversations_v2/${encodeURIComponent(conversationId)}`,
    { query: { includeWorkspaces: true, includeTaskResult: true } },
  );
  if (!payload.conversation?.conversationId)
    throw new ToolError(`Grok has no conversation with id "${conversationId}".`, 'NOT_FOUND', {
      category: 'not_found',
      retryable: false,
    });
  return payload.conversation;
};

export const conversationExists = async (conversationId: string): Promise<boolean> => {
  try {
    const payload = await api<{ exists?: boolean }>(
      `/app-chat/conversations/exists/${encodeURIComponent(conversationId)}`,
    );
    return payload.exists === true;
  } catch (error) {
    if (error instanceof ToolError && error.code === 'NOT_FOUND') return false;
    throw error;
  }
};

const settleConversation = async (
  conversationId: string,
  predicate: (conversation: RawConversation) => boolean,
): Promise<RawConversation | null> => {
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    try {
      const conversation = await getConversationMetadata(conversationId);
      if (predicate(conversation)) return conversation;
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== 'NOT_FOUND') throw error;
    }
    if (attempt < VERIFY_ATTEMPTS - 1) await sleep(VERIFY_DELAY_MS);
  }
  return null;
};

export const renameConversationRecord = async (conversationId: string, title: string): Promise<RawConversation> => {
  await getConversationMetadata(conversationId);
  await api<RawConversation>(`/app-chat/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PUT',
    body: { title },
  });
  const stored = await settleConversation(conversationId, conversation => conversation.title === title);
  if (!stored)
    throw new ToolError(
      `Grok accepted the rename but did not persist title ${JSON.stringify(title)}.`,
      'UPSTREAM_ERROR',
      {
        category: 'internal',
        retryable: true,
      },
    );
  return stored;
};

export const setConversationStarred = async (conversationId: string, starred: boolean): Promise<RawConversation> => {
  await getConversationMetadata(conversationId);
  await api<RawConversation>(`/app-chat/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PUT',
    body: { starred },
  });
  const stored = await settleConversation(conversationId, conversation => conversation.starred === starred);
  if (!stored)
    throw new ToolError(`Grok accepted starred=${starred} but did not persist it.`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return stored;
};

export const deleteConversationRecord = async (conversationId: string): Promise<void> => {
  await getConversationMetadata(conversationId);
  await api<void>(`/app-chat/conversations/soft/${encodeURIComponent(conversationId)}`, { method: 'DELETE' });
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    if (!(await conversationExists(conversationId))) return;
    if (attempt < VERIFY_ATTEMPTS - 1) await sleep(VERIFY_DELAY_MS);
  }
  throw new ToolError(`Grok still reports conversation ${conversationId} after deletion.`, 'UPSTREAM_ERROR', {
    category: 'internal',
    retryable: true,
  });
};

export const restoreConversationRecord = (conversationId: string): Promise<void> =>
  api('/app-chat/conversations/restore', { method: 'POST', body: { conversationId } });

export const collectConversations = async (
  options: { search?: string; projectId?: string } = {},
  maxPages = 200,
): Promise<{ rows: RawConversation[]; pagesFetched: number; complete: boolean }> => {
  const rows: RawConversation[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;
  let complete = false;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await fetchConversationsPage(cursor, options);
    pagesFetched += 1;
    for (const row of page.rows) {
      if (!row.conversationId || seenIds.has(row.conversationId)) continue;
      seenIds.add(row.conversationId);
      rows.push(row);
    }
    if (!page.next || page.next === cursor || seenCursors.has(page.next)) {
      complete = true;
      break;
    }
    seenCursors.add(page.next);
    cursor = page.next;
  }
  return { rows, pagesFetched, complete };
};

export const getConversationProjectId = async (conversationId: string): Promise<string | null> =>
  projectIdOf(await getConversationMetadata(conversationId));
