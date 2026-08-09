import { ToolError } from '@opentabs-dev/plugin-sdk';
import {
  type RpcFrame,
  asArray,
  asString,
  callRpc,
  callRpcFrame,
  conversationUrl,
  toConversationId,
  tupleToUnixSeconds,
} from './gemini-api.js';
import { type TokenPage, walkTokenPages } from './gemini-pagination.js';
import type { PaginationRequest } from './tools/normalized-schemas.js';

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
}

/** Row layout: [id, title, _, _, _, [seconds, nanos], …, lastResponseChoiceId@21]. */
const mapConversationRow = (row: unknown): ConversationRow | null => {
  if (!Array.isArray(row)) return null;
  const id = asString(row[0]);
  if (!id) return null;
  return {
    id,
    title: typeof row[1] === 'string' ? row[1] : '',
    updatedAt: tupleToUnixSeconds(row[5]),
  };
};

/**
 * Gemini hard-caps a `MaZiqc` page at 100 rows however large a page size is asked
 * for; the walker's own bound is therefore clamped to that before the request.
 */
export const MAX_CONVERSATION_PAGE = 100;

const fetchConversationPage = async (token: string | undefined, limit: number): Promise<TokenPage<ConversationRow>> => {
  const frame = await callRpcFrame<unknown[]>(RPC_LIST_CONVERSATIONS, [
    Math.min(limit, MAX_CONVERSATION_PAGE),
    token ?? null,
  ]);
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
  walkTokenPages(pagination, fetchConversationPage, row => ({
    id: row.id,
    title: row.title,
    url: conversationUrl(row.id),
    // Gemini's list rows carry a single mutation timestamp and no creation time.
    created_at: row.updatedAt,
    updated_at: row.updatedAt,
    project_id: null,
    model_id: null,
    is_archived: false,
    is_starred: false,
  }));

/** Search rows are `[[id, title], snippets?, …]`; the cursor sits beside the row array. */
const mapSearchRow = (row: unknown): ConversationRow | null => {
  if (!Array.isArray(row)) return null;
  const head = asArray(row[0]);
  const id = asString(head[0]);
  if (!id) return null;
  return { id, title: typeof head[1] === 'string' ? head[1] : '', updatedAt: 0 };
};

const fetchSearchPage = async (query: string, token: string | undefined): Promise<TokenPage<ConversationRow>> => {
  const frame = await callRpcFrame<unknown[]>(RPC_SEARCH_CONVERSATIONS, [query, token ?? null]);
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

export const searchConversationRows = (query: string, pagination: PaginationRequest) =>
  walkTokenPages(
    pagination,
    token => fetchSearchPage(query, token),
    row => ({
      id: row.id,
      title: row.title,
      url: conversationUrl(row.id),
      created_at: 0,
      updated_at: 0,
      project_id: null,
      model_id: null,
      is_archived: false,
      is_starred: false,
    }),
  );

/** `MUAZcd` is a field-mask update: `[null, [["title"]], [conversationId, newTitle]]`. */
export const renameConversationRow = async (conversationId: string, title: string): Promise<void> => {
  await callRpc(RPC_UPDATE_CONVERSATION, [null, [['title']], [toConversationId(conversationId), title]]);
};

export const deleteConversationRow = async (conversationId: string): Promise<void> => {
  await callRpc(RPC_DELETE_CONVERSATION, [toConversationId(conversationId)]);
};
