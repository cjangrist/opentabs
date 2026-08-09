import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api, conversationUrl, graphql, toUnixSeconds } from './perplexity-api.js';
import type { RawEntry } from './perplexity-messages.js';
import type { FetchedPage } from './perplexity-pagination.js';
import type { ConversationListItem } from './tools/normalized-schemas.js';

/**
 * Relay persisted-query hashes the Library page uses. The gateway rejects ad-hoc
 * GraphQL documents ("Access denied"), so the hashes that travel with the
 * frontend build are the only way in; when Perplexity ships a new build they go
 * stale and the REST list below takes over.
 *
 * Only the *pagination* query is used, even for the first page: the root
 * `LibraryThreadsRelayQuery` silently ignores `count` and always returns 25
 * rows, while the pagination query honours `count` from a null cursor onwards
 * (both verified live).
 */
const LIBRARY_PAGE_QUERY_HASH = 'e207cce86b2c9b67fca3ea7d8450d675ec86c0c429b38e42e88f3b027e7c8729';
const LIBRARY_PAGE_OPERATION = 'LibraryRecentThreadsPaginationQuery';

const GRAPHQL_CURSOR_PREFIX = 'g:';
const REST_CURSOR_PREFIX = 'r:';

interface GraphqlThreadNode {
  contextUUID?: string;
  entryId?: string;
  readWriteToken?: string;
  slug?: string;
  name?: string;
  mode?: string;
  status?: string;
  displayModel?: { modelID?: string } | string | null;
  isPinned?: boolean;
  isArchived?: boolean;
  updatedAt?: string;
  space?: { id?: string; uuid?: string; slug?: string; title?: string } | null;
}

interface GraphqlThreadsData {
  viewer?: {
    recentGroup?: {
      threads?: { edges?: { node?: GraphqlThreadNode }[]; pageInfo?: { endCursor?: string; hasNextPage?: boolean } };
    };
  };
}

interface RestThreadRow {
  context_uuid?: string;
  uuid?: string;
  slug?: string;
  title?: string;
  display_model?: string;
  last_query_datetime?: string;
  has_next_page?: boolean;
  total_threads?: number;
  read_write_token?: string;
}

/** Everything a caller (and the follow-up path) needs about one thread row. */
export interface ThreadRow extends ConversationListItem {
  context_uuid: string;
  read_write_token: string | null;
}

const mapGraphqlNode = (node: GraphqlThreadNode): ThreadRow => {
  const slug = node.slug || node.contextUUID || '';
  return {
    id: slug,
    title: node.name ?? '',
    url: conversationUrl(slug),
    // The Library query publishes no creation time; only the thread detail
    // endpoint carries thread_metadata.created_at.
    created_at: 0,
    updated_at: toUnixSeconds(node.updatedAt),
    project_id: node.space?.uuid ?? node.space?.id ?? null,
    model_id: (typeof node.displayModel === 'string' ? node.displayModel : node.displayModel?.modelID) || null,
    is_archived: node.isArchived === true,
    // Perplexity's equivalent of starring is pinning a thread in the Library.
    is_starred: node.isPinned === true,
    context_uuid: node.contextUUID ?? '',
    read_write_token: node.readWriteToken || null,
  };
};

const mapRestRow = (row: RestThreadRow): ThreadRow => {
  const slug = row.slug || row.context_uuid || '';
  return {
    id: slug,
    title: row.title ?? '',
    url: conversationUrl(slug),
    created_at: 0,
    updated_at: toUnixSeconds(row.last_query_datetime),
    // list_ask_threads publishes no space membership, archive or pin state.
    project_id: null,
    model_id: row.display_model || null,
    is_archived: false,
    is_starred: false,
    context_uuid: row.context_uuid ?? '',
    read_write_token: row.read_write_token || null,
  };
};

const graphqlPage = async (
  cursor: string | undefined,
  limit: number,
  searchTerm?: string,
): Promise<FetchedPage<ThreadRow>> => {
  const data = await graphql<GraphqlThreadsData>(LIBRARY_PAGE_OPERATION, LIBRARY_PAGE_QUERY_HASH, {
    count: limit,
    cursor: cursor ?? null,
    includeSearchPreview: false,
    searchTerm: searchTerm ?? null,
    sortOrder: 'NEWEST',
    statuses: null,
    threadTypes: null,
    sources: null,
    includeTemporary: null,
  });
  const threads = data.viewer?.recentGroup?.threads;
  if (!threads)
    throw new ToolError('Perplexity GraphQL returned no thread connection.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: false,
    });
  const rows = (threads.edges ?? []).map(edge => edge.node).filter((node): node is GraphqlThreadNode => Boolean(node));
  const hasMore = threads.pageInfo?.hasNextPage === true;
  return {
    rows: rows.map(mapGraphqlNode),
    hasMore,
    nextCursor: hasMore && threads.pageInfo?.endCursor ? `${GRAPHQL_CURSOR_PREFIX}${threads.pageInfo.endCursor}` : null,
    // The Relay connection publishes no total.
    total: null,
  };
};

const restPage = async (offset: number, limit: number, searchTerm?: string): Promise<FetchedPage<ThreadRow>> => {
  const rows = await api<RestThreadRow[]>('/thread/list_ask_threads', {
    method: 'POST',
    body: { limit, offset, ascending: false, ...(searchTerm ? { search_term: searchTerm } : {}) },
    timeout: 25_000,
  });
  const list = Array.isArray(rows) ? rows : [];
  const hasMore = list[0]?.has_next_page === true;
  return {
    rows: list.map(mapRestRow),
    hasMore,
    nextCursor: hasMore ? `${REST_CURSOR_PREFIX}${offset + list.length}` : null,
    total: typeof list[0]?.total_threads === 'number' ? list[0].total_threads : null,
  };
};

/**
 * One page of the Library.
 *
 * The Relay query is preferred because it is the only source that reports space
 * membership, archive and pin state. It carries no total, so `total` is null
 * there; the REST fallback does report a real `total_threads` and it is passed
 * through. A cursor is tagged with the engine that minted it so a cursor can
 * never be replayed against the other one.
 */
export const fetchConversationsPage = async (
  cursor: string | undefined,
  limit: number,
  searchTerm?: string,
): Promise<FetchedPage<ThreadRow>> => {
  if (cursor?.startsWith(REST_CURSOR_PREFIX))
    return restPage(Number(cursor.slice(REST_CURSOR_PREFIX.length)), limit, searchTerm);
  const graphqlCursor = cursor?.startsWith(GRAPHQL_CURSOR_PREFIX) ? cursor.slice(GRAPHQL_CURSOR_PREFIX.length) : cursor;
  if (graphqlCursor !== undefined && cursor !== undefined && !cursor.startsWith(GRAPHQL_CURSOR_PREFIX))
    throw ToolError.validation(`Invalid cursor "${cursor}" — pass back next_cursor verbatim, or omit it.`);
  try {
    return await graphqlPage(graphqlCursor, limit, searchTerm);
  } catch (error) {
    // A stale persisted-query hash must not take the whole tool down; fall back
    // to the REST list, which cannot report space/archive/pin state.
    if (cursor !== undefined) throw error;
    return restPage(0, limit, searchTerm);
  }
};

// --- Thread detail ---

interface ThreadResponse {
  entries?: RawEntry[];
  thread_metadata?: {
    title?: string;
    created_at?: string;
    updated_at?: string;
    thread_status?: string;
    collection_info?: { uuid?: string; slug?: string; title?: string } | null;
  };
  has_next_page?: boolean;
  /** Opaque DynamoDB-key-shaped token; never parsed, only round-tripped verbatim. */
  next_cursor?: string;
}

export interface ThreadPage {
  entries: RawEntry[];
  title: string;
  createdAt: number;
  updatedAt: number;
  projectId: string | null;
  nextCursor: string | null;
  hasNextPage: boolean;
}

/**
 * Reads one page of a thread.
 *
 * `offset` is accepted by this endpoint but silently ignored at every value
 * (verified live: offsets 0/1/2/100 against a 4-entry thread all returned the
 * identical newest window). The real primitive is the undocumented
 * `has_next_page` / `next_cursor` pair the payload itself returns, round-tripped
 * verbatim. Do not reintroduce `offset`.
 */
export const fetchThreadPage = async (conversationId: string, limit: number, cursor?: string): Promise<ThreadPage> => {
  const data = await api<ThreadResponse>(`/thread/${encodeURIComponent(conversationId)}`, {
    query: { with_parent_info: true, with_schematized_response: true, limit, cursor },
    timeout: 45_000,
  });
  const entries = data?.entries ?? [];
  if (entries.length === 0)
    throw ToolError.notFound(`Perplexity thread "${conversationId}" has no entries or does not exist.`);
  const metadata = data?.thread_metadata ?? {};
  return {
    entries,
    title: metadata.title ?? entries[0]?.thread_title ?? '',
    createdAt: toUnixSeconds(metadata.created_at),
    updatedAt: toUnixSeconds(metadata.updated_at),
    projectId: metadata.collection_info?.uuid ?? null,
    hasNextPage: data?.has_next_page === true,
    nextCursor: data?.has_next_page ? data?.next_cursor || null : null,
  };
};

/** Upstream pages walked before a thread read gives up; 20 × 50 entries. */
const THREAD_PAGE_SIZE = 50;
const MAX_THREAD_PAGES = 20;

export interface WholeThread extends Omit<ThreadPage, 'nextCursor' | 'hasNextPage'> {
  /** True when MAX_THREAD_PAGES stopped the walk before the thread ran out. */
  truncated: boolean;
  pagesFetched: number;
}

/**
 * Reads a whole thread by following its cursor to the end.
 *
 * Pages arrive newest-window-first, so the collected entries are re-sorted by
 * their own creation time rather than trusting page order. Reading the thread in
 * full is what lets get_conversation report a true `total` and an `omitted`
 * ledger that covers the whole conversation instead of one page.
 */
export const fetchWholeThread = async (conversationId: string): Promise<WholeThread> => {
  const collected: RawEntry[] = [];
  let cursor: string | undefined;
  let page: ThreadPage | undefined;
  let pagesFetched = 0;

  do {
    page = await fetchThreadPage(conversationId, THREAD_PAGE_SIZE, cursor);
    pagesFetched += 1;
    collected.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && pagesFetched < MAX_THREAD_PAGES);

  const seen = new Set<string>();
  const entries = collected
    .filter(entry => {
      const key = entry.backend_uuid ?? entry.uuid ?? '';
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => toUnixSeconds(left.entry_created_datetime) - toUnixSeconds(right.entry_created_datetime));

  return {
    entries,
    title: page?.title ?? '',
    createdAt: page?.createdAt ?? 0,
    updatedAt: page?.updatedAt ?? 0,
    projectId: page?.projectId ?? null,
    truncated: Boolean(cursor),
    pagesFetched,
  };
};

export interface ThreadTip {
  conversationId: string;
  contextUuid: string;
  lastEntryId: string;
  readWriteToken: string;
}

/** The newest entry of a thread, which a follow-up must point at. */
export const fetchThreadTip = async (conversationId: string): Promise<ThreadTip> => {
  const page = await fetchThreadPage(conversationId, 1);
  const entry = page.entries[page.entries.length - 1];
  return {
    conversationId: entry?.thread_url_slug || conversationId,
    contextUuid: entry?.context_uuid ?? '',
    lastEntryId: entry?.backend_uuid ?? '',
    readWriteToken: entry?.read_write_token ?? '',
  };
};

// --- Mutations ---

/**
 * Renaming is keyed on the thread's context uuid and needs the per-thread write
 * token, both of which come from the thread's newest entry.
 */
export const renameThread = async (tip: ThreadTip, title: string): Promise<void> => {
  await api('/thread/set_thread_title', {
    method: 'POST',
    body: { context_uuid: tip.contextUuid, title, read_write_token: tip.readWriteToken },
  });
};

export const deleteThread = async (tip: ThreadTip): Promise<void> => {
  await api('/thread/delete_thread_by_entry_uuid', {
    method: 'DELETE',
    body: { entry_uuid: tip.lastEntryId, read_write_token: tip.readWriteToken },
  });
};

export const setThreadArchived = async (contextUuid: string, archived: boolean): Promise<void> => {
  await api(archived ? '/thread/batch_archive_threads' : '/thread/batch_unarchive_threads', {
    method: 'POST',
    body: { context_uuids: [contextUuid] },
  });
};
