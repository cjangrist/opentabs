import { ToolError } from '@opentabs-dev/plugin-sdk';
import {
  type RpcFrame,
  asArray,
  asString,
  callRpc,
  callRpcFrame,
  classifyRpcStatus,
  conversationUrl,
  toNotebookResource,
  toConversationId,
  tupleToUnixSeconds,
} from './gemini-api.js';
import { type TokenPage, walkTokenPages } from './gemini-pagination.js';
import type { ConversationListItem, PaginationRequest } from './tools/normalized-schemas.js';

// RPC ids, captured from gemini.google.com's own client traffic (2026-08).
const RPC_LIST_CONVERSATIONS = 'MaZiqc';
const RPC_SEARCH_CONVERSATIONS = 'unqWSc';
const RPC_UPDATE_CONVERSATION = 'MUAZcd';
const RPC_DELETE_CONVERSATION = 'GzXR5e';

/**
 * `MaZiqc` signals "your cursor is past the last row" with an HTTP 200 whose
 * `wrb.fr` payload slot is null, gRPC status 13 and `BardErrorInfo` detail 1096.
 * A structurally invalid cursor produces status 13 with NO BardErrorInfo, so the
 * two are distinguishable and only 1096 is treated as end-of-list.
 */
const END_OF_LIST_DETAIL = 1096;

const isEndOfList = (frame: RpcFrame<unknown>): boolean =>
  frame.data === null && frame.errorInfo.includes(END_OF_LIST_DETAIL);

export interface ConversationRow {
  id: string;
  title: string;
  updatedAt: number;
  projectId: string | null;
  isStarred: boolean;
}

/** Row layout: [id, title, pinned@2, …, updated@5, …, notebook@7, …, lastResponseChoiceId@21]. */
const mapConversationRow = (row: unknown): ConversationRow | null => {
  if (!Array.isArray(row)) return null;
  const id = asString(row[0]);
  if (!id) return null;
  return {
    id,
    title: typeof row[1] === 'string' ? row[1] : '',
    updatedAt: tupleToUnixSeconds(row[5]),
    projectId: asString(row[7]),
    isStarred: row[2] === true || row[2] === 1,
  };
};

/**
 * Gemini hard-caps a `MaZiqc` page at 100 rows however large a page size is asked
 * for; the walker's own bound is therefore clamped to that before the request.
 */
export const MAX_CONVERSATION_PAGE = 100;

export const mapConversationListItem = (row: ConversationRow): ConversationListItem => ({
  id: row.id,
  title: row.title,
  url: conversationUrl(row.id),
  // Gemini publishes one mutation timestamp and no separate creation time.
  created_at: row.updatedAt,
  updated_at: row.updatedAt,
  project_id: row.projectId,
  model_id: null,
  is_archived: false,
  is_starred: row.isStarred,
});

const fetchConversationPage = async (
  token: string | undefined,
  limit: number,
  projectId?: string,
): Promise<TokenPage<ConversationRow>> => {
  const args: unknown[] = [Math.min(limit, MAX_CONVERSATION_PAGE), token ?? null];
  args[2] = projectId ? [null, null, 1, toNotebookResource(projectId), 1] : [null, null, 1];
  const frame = await callRpcFrame<unknown[]>(RPC_LIST_CONVERSATIONS, args);
  if (isEndOfList(frame)) return { rows: [], nextToken: null };
  if (frame.data === null)
    throw new ToolError(
      `Gemini rejected the conversation cursor (status ${frame.statusCode ?? 'unknown'}). Pass next_cursor back verbatim, or omit it for the first page.`,
      'VALIDATION_ERROR',
      { category: 'validation' },
    );
  const payload = frame.data;
  const rows = asArray(payload[2])
    .map(mapConversationRow)
    .filter((row): row is ConversationRow => row !== null);
  return { rows, nextToken: asString(payload[1]) };
};

export const listConversationRows = (pagination: PaginationRequest) =>
  walkTokenPages(pagination, fetchConversationPage, mapConversationListItem);

export const listProjectConversationRows = (projectId: string, pagination: PaginationRequest) =>
  walkTokenPages(
    pagination,
    (token, limit) => fetchConversationPage(token, limit, projectId),
    row => mapConversationListItem({ ...row, projectId: row.projectId ?? toNotebookResource(projectId) }),
  );

/** Search rows are `[[id, title], snippets?, …]`; the cursor sits beside the row array. */
const mapSearchRow = (row: unknown): ConversationRow | null => {
  if (!Array.isArray(row)) return null;
  const head = asArray(row[0]);
  const id = asString(head[0]);
  if (!id) return null;
  const updatedAt = asArray(row[2]).reduce<number>((latest, entry) => {
    const timestamp = tupleToUnixSeconds(asArray(entry)[2]);
    return Math.max(latest, timestamp);
  }, 0);
  return {
    id,
    title: typeof head[1] === 'string' ? head[1] : '',
    updatedAt,
    projectId: null,
    isStarred: false,
  };
};

const fetchSearchPage = async (query: string, token: string | undefined): Promise<TokenPage<ConversationRow>> => {
  // The cursor is argument 2, not 1 — passing it in slot 1 is rejected with gRPC 3.
  const frame = await callRpcFrame<unknown[]>(RPC_SEARCH_CONVERSATIONS, [query, null, token ?? null]);
  if (isEndOfList(frame)) return { rows: [], nextToken: null };
  if (frame.data === null)
    throw new ToolError(
      `Gemini rejected the search cursor (status ${frame.statusCode ?? 'unknown'}).`,
      'VALIDATION_ERROR',
      { category: 'validation' },
    );
  const rows = asArray(frame.data[0])
    .map(mapSearchRow)
    .filter((row): row is ConversationRow => row !== null);
  return { rows, nextToken: asString(frame.data[1]) };
};

const enrichSearchItems = async <T extends { id: string }>(items: T[]): Promise<T[]> => {
  const enriched = [...items];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (!item) continue;
      try {
        const row = await getConversationRow(item.id);
        enriched[index] = { ...item, project_id: row.projectId, is_starred: row.isStarred };
      } catch (error) {
        // Search and metadata are separate snapshots. If a result was deleted in
        // between, keep the search row instead of discarding a valid match.
        if (!(error instanceof ToolError) || error.code !== 'NOT_FOUND') throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
  return enriched;
};

export const searchConversationRows = async (query: string, pagination: PaginationRequest) => {
  const page = await walkTokenPages(
    pagination,
    token => fetchSearchPage(query, token),
    row => ({
      id: row.id,
      title: row.title,
      url: conversationUrl(row.id),
      created_at: row.updatedAt,
      updated_at: row.updatedAt,
      project_id: row.projectId,
      model_id: null,
      is_archived: false,
      is_starred: false,
    }),
  );
  return { ...page, items: await enrichSearchItems(page.items) };
};

/** `MUAZcd` is a field-mask update: `[null, [["title"]], [conversationId, newTitle]]`. */
export const renameConversationRow = async (conversationId: string, title: string): Promise<void> => {
  await callRpc(RPC_UPDATE_CONVERSATION, [null, [['title']], [toConversationId(conversationId), title]]);
};

export const deleteConversationRow = async (conversationId: string): Promise<void> => {
  await callRpc(RPC_DELETE_CONVERSATION, [toConversationId(conversationId)]);
};

/**
 * Gemini's own conversation page reads one metadata row with the id-filter shape
 * below. This also finds Notebook-origin chats that the global Recents RPC omits.
 */
export const getConversationRow = async (conversationId: string): Promise<ConversationRow> => {
  const target = toConversationId(conversationId);
  const frame = await callRpcFrame<unknown[]>(RPC_LIST_CONVERSATIONS, [1, null, [null, null, 1, null, 1, target]]);
  if (frame.data === null && !isEndOfList(frame))
    throw classifyRpcStatus(RPC_LIST_CONVERSATIONS, frame.statusCode ?? 500);
  const match = asArray(frame.data?.[2])
    .map(mapConversationRow)
    .find((row): row is ConversationRow => row?.id === target);
  if (match) return match;
  throw new ToolError(`Gemini has no conversation ${target} (or it belongs to another account).`, 'NOT_FOUND', {
    category: 'not_found',
  });
};

/** Collects every notebook member by walking MaZiqc's native cursor to exhaustion. */
export const collectProjectConversationRows = async (projectId: string): Promise<ConversationRow[]> => {
  const rows: ConversationRow[] = [];
  let token: string | undefined;
  const seenTokens = new Set<string>();
  const maxPages = 100;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchConversationPage(token, MAX_CONVERSATION_PAGE, projectId);
    rows.push(...result.rows);
    if (!result.nextToken || seenTokens.has(result.nextToken)) return rows;
    seenTokens.add(result.nextToken);
    token = result.nextToken;
  }
  throw new ToolError(
    `Gemini notebook ${toNotebookResource(projectId)} did not exhaust within ${maxPages} pages.`,
    'UPSTREAM_ERROR',
    { category: 'internal', retryable: false },
  );
};

/** Stops at the page containing the id; absence is proven only by exhausting the native cursor. */
export const projectContainsConversation = async (projectId: string, conversationId: string): Promise<boolean> => {
  const target = toConversationId(conversationId);
  let token: string | undefined;
  const seenTokens = new Set<string>();
  const maxPages = 100;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchConversationPage(token, MAX_CONVERSATION_PAGE, projectId);
    if (result.rows.some(row => row.id === target)) return true;
    if (!result.nextToken || seenTokens.has(result.nextToken)) return false;
    seenTokens.add(result.nextToken);
    token = result.nextToken;
  }
  throw new ToolError(
    `Gemini notebook ${toNotebookResource(projectId)} did not exhaust within ${maxPages} pages while checking ${target}.`,
    'UPSTREAM_ERROR',
    { category: 'internal', retryable: false },
  );
};

/**
 * MUAZcd uses one field mask for both notebook assignment and removal. A chat
 * belongs to at most one notebook, so assigning a new resource is also a move.
 */
export const setConversationProject = async (conversationId: string, projectId: string | null): Promise<void> => {
  const id = toConversationId(conversationId);
  const row: unknown[] = [id];
  if (projectId) {
    row[7] = toNotebookResource(projectId);
    row[13] = [2];
  }
  await callRpc(RPC_UPDATE_CONVERSATION, [null, [['bot_id', 'bot_project_metadata']], row]);
};

/** Gemini calls starring "Pin"; the persisted row exposes the same state in slot 2. */
export const setConversationStarred = async (conversationId: string, starred: boolean): Promise<ConversationRow> => {
  const current = await getConversationRow(conversationId);
  await callRpc(RPC_UPDATE_CONVERSATION, [null, [['pinned']], [current.id, null, starred ? 1 : 0]]);
  const updated = await getConversationRow(current.id);
  if (updated.isStarred !== starred)
    throw new ToolError(
      `Gemini accepted the pin update for ${current.id}, but the stored row still reports is_starred=${updated.isStarred}.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  return updated;
};
