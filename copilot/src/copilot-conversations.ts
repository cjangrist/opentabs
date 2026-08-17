import { ToolError } from '@opentabs-dev/plugin-sdk';
import { callApi, conversationUrl, deleteApi, getApi, patchApi, postApi, toUnixSeconds } from './copilot-api.js';
import type { CursorPage } from './copilot-pagination.js';
import type { RawMessage } from './copilot-messages.js';
import type { ConversationListItem } from './tools/normalized-schemas.js';

const CONVERSATION_TYPES = 'chat,character,xbox,group';
const MAX_HISTORY_PAGES = 200;

export interface RawConversation {
  id?: string;
  title?: string | null;
  type?: string;
  isPinned?: boolean | null;
  updatedAt?: string;
  continuedAt?: string | null;
  projectId?: string | null;
  scope?: string;
}

interface RawPage<T> {
  results?: T[];
  next?: string | null;
}

export interface SearchRow {
  type?: 'conversation' | 'message';
  conversationId?: string;
  title?: string | null;
  updatedAt?: string;
  messageId?: string;
  snippet?: string;
  conversationType?: string;
}

export const mapConversationRow = (row: RawConversation, projectId?: string | null): ConversationListItem => ({
  id: row.id ?? '',
  title: row.title ?? '',
  url: conversationUrl(row.id ?? '', projectId ?? row.projectId),
  // Copilot's list and detail metadata omit creation time. get_conversation
  // derives the real value from the oldest message when history is non-empty.
  created_at: 0,
  updated_at: toUnixSeconds(row.updatedAt),
  project_id: projectId ?? row.projectId ?? null,
  model_id: null,
  is_archived: false,
  is_starred: row.isPinned === true,
});

export const fetchConversationsPage = async (cursor: string | undefined): Promise<CursorPage<RawConversation>> => {
  const query = new URLSearchParams({ types: CONVERSATION_TYPES });
  if (cursor) query.set('cursor', cursor);
  const page = await getApi<RawPage<RawConversation>>(`/conversations?${query.toString()}`);
  return {
    rows: (page.results ?? []).filter(row => Boolean(row.id)),
    next: page.next || null,
  };
};

export const fetchSearchPage = async (
  queryText: string,
  cursor: string | undefined,
  timeout?: number,
): Promise<CursorPage<SearchRow>> => {
  const query = new URLSearchParams({ query: queryText });
  if (cursor) query.set('cursor', cursor);
  const page = await callApi<RawPage<SearchRow>>(`/conversations/search?${query.toString()}`, {
    method: 'GET',
    timeout,
  });
  return {
    rows: (page.results ?? []).filter(row => Boolean(row.conversationId)),
    next: page.next || null,
  };
};

export const getConversationMetadata = async (conversationId: string, timeout?: number): Promise<RawConversation> => {
  const conversation = await callApi<RawConversation>(`/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'GET',
    timeout,
  });
  if (!conversation.id)
    throw ToolError.notFound(`Copilot has no conversation with id "${conversationId}".`, 'NOT_FOUND');
  return conversation;
};

const fetchHistoryPage = (
  conversationId: string,
  cursor: string | undefined,
  timeout?: number,
): Promise<RawPage<RawMessage>> => {
  const query = new URLSearchParams({ 'api-version': '2' });
  if (cursor) query.set('cursor', cursor);
  return callApi<RawPage<RawMessage>>(
    `/conversations/${encodeURIComponent(conversationId)}/history?${query.toString()}`,
    { method: 'GET', timeout },
  );
};

export const getLatestConversationMessages = async (conversationId: string, timeout: number): Promise<RawMessage[]> =>
  (await fetchHistoryPage(conversationId, undefined, timeout)).results?.reverse() ?? [];

export const createEmptyConversation = async (projectId?: string): Promise<string> => {
  const path = projectId ? `/projects/${encodeURIComponent(projectId)}/conversations` : '/conversations';
  const conversation = await postApi<RawConversation>(path, projectId ? undefined : {});
  if (!conversation.id)
    throw new ToolError('Copilot did not return an id for the new conversation.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return conversation.id;
};

const fetchHistoryPages = async (
  conversationId: string,
  deadline?: number,
): Promise<{ messages: RawMessage[]; pagesFetched: number; truncated: boolean }> => {
  const messages: RawMessage[] = [];
  const seenMessages = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;
  let complete = false;

  for (
    let pageNumber = 0;
    pageNumber < MAX_HISTORY_PAGES && (deadline === undefined || Date.now() < deadline);
    pageNumber += 1
  ) {
    const timeout = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
    const page = await fetchHistoryPage(conversationId, cursor, timeout);
    pagesFetched += 1;
    const rows = page.results ?? [];
    for (const row of rows) {
      const id = row.id ?? '';
      if (id && seenMessages.has(id)) continue;
      if (id) seenMessages.add(id);
      messages.push(row);
    }
    if (!page.next) {
      complete = true;
      break;
    }
    if (page.next === cursor || seenCursors.has(page.next) || rows.length === 0) break;
    seenCursors.add(page.next);
    cursor = page.next;
  }

  return { messages: messages.reverse(), pagesFetched, truncated: !complete };
};

export const getConversationHistory = async (
  conversationId: string,
  timeout?: number,
): Promise<{ metadata: RawConversation; messages: RawMessage[]; pagesFetched: number; truncated: boolean }> => {
  const deadline = timeout === undefined ? undefined : Date.now() + Math.max(1, timeout);
  const [metadata, history] = await Promise.all([
    getConversationMetadata(conversationId, timeout),
    fetchHistoryPages(conversationId, deadline),
  ]);
  return { metadata, ...history };
};

export const renameConversationRecord = async (conversationId: string, title: string): Promise<void> => {
  await patchApi(`/conversations/${encodeURIComponent(conversationId)}`, { title });
};

export const setConversationPinned = async (conversationId: string, isPinned: boolean): Promise<void> => {
  await patchApi(`/conversations/${encodeURIComponent(conversationId)}`, { isPinned });
};

export const setConversationProject = async (conversationId: string, projectId: string | null): Promise<void> => {
  await patchApi(`/conversations/${encodeURIComponent(conversationId)}`, { projectId });
};

export const deleteConversationRecord = async (conversationId: string): Promise<void> => {
  await deleteApi(`/conversations/${encodeURIComponent(conversationId)}`);
};

export const conversationTimes = (metadata: RawConversation, messages: RawMessage[]) => ({
  createdAt: messages.length > 0 ? toUnixSeconds(messages[0]?.createdAt) : 0,
  updatedAt: toUnixSeconds(metadata.updatedAt) || toUnixSeconds(messages.at(-1)?.createdAt),
});
