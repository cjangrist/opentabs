import { ToolError } from '@opentabs-dev/plugin-sdk';
import type { PageInfo, PaginationRequest } from './tools/normalized-schemas.js';

export interface PagedResult<TItem> {
  items: TItem[];
  next_cursor: string | null;
  has_more: boolean;
  total: number | null;
  page_info: PageInfo;
}

export interface FetchedPage<TRow> {
  rows: TRow[];
  hasMore: boolean;
  /** Cursor for the page after this one; ignored by the offset walker. */
  nextCursor: string | null;
  /** A real total across all pages, or null when the provider reports none. */
  total: number | null;
}

/** Offset cursors are opaque to callers; ours are simply the next offset in decimal. */
const parseOffsetCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0)
    throw ToolError.validation(`Invalid cursor "${cursor}" — pass back next_cursor verbatim, or omit it.`);
  return offset;
};

/**
 * Walks any paged endpoint under the SPEC §1 contract.
 *
 * Every upstream request is bounded to the remaining `max_items` budget, so the
 * ceiling cannot be exceeded even by one row, and `truncated` is set only when
 * that ceiling — not the page size — is what stopped the walk.
 */
const walk = async <TRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (cursor: string | undefined, limit: number) => Promise<FetchedPage<TRow>>,
  mapRow: (row: TRow) => TItem,
  advance: (previousCursor: string | undefined, page: FetchedPage<TRow>, collected: number) => string | null,
): Promise<PagedResult<TItem>> => {
  const collected: TRow[] = [];
  let cursor = pagination.cursor;
  let pagesFetched = 0;
  let hasMore = false;
  let total: number | null = null;

  do {
    const remaining = pagination.maxItems - collected.length;
    if (remaining <= 0) break;
    const page = await fetchPage(cursor, Math.min(pagination.limit, remaining));
    pagesFetched += 1;
    collected.push(...page.rows);
    total = page.total;
    hasMore = page.hasMore;
    cursor = advance(cursor, page, collected.length) ?? undefined;
    if (page.rows.length === 0 || !cursor) {
      hasMore = hasMore && cursor !== undefined;
      break;
    }
  } while (pagination.fetchAll && hasMore && collected.length < pagination.maxItems);

  const truncated = hasMore && collected.length >= pagination.maxItems;

  return {
    items: collected.map(mapRow),
    // `|| null` rather than `?? null`: an empty-string cursor is exhaustion, not a page.
    next_cursor: hasMore ? cursor || null : null,
    has_more: hasMore,
    total,
    page_info: { returned: collected.length, pages_fetched: pagesFetched, truncated },
  };
};

/** Walks a `limit`/`offset` endpoint, synthesising decimal offset cursors. */
export const walkOffsetPages = async <TRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (offset: number, limit: number) => Promise<FetchedPage<TRow>>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => {
  const start = parseOffsetCursor(pagination.cursor);
  let offset = start;
  return walk(
    { ...pagination, cursor: String(start) },
    async (cursor, limit) => fetchPage(parseOffsetCursor(cursor), limit),
    mapRow,
    (previous, page) => {
      offset = parseOffsetCursor(previous) + page.rows.length;
      // An empty page advances the offset by nothing, so handing back a cursor
      // would point at the identical empty page forever. Treat it as exhaustion
      // even when the provider still claims there is more.
      return page.hasMore && page.rows.length > 0 ? String(offset) : null;
    },
  );
};

/** Walks an opaque-cursor endpoint, round-tripping the provider's own token. */
export const walkCursorPages = async <TRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (cursor: string | undefined, limit: number) => Promise<FetchedPage<TRow>>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => walk(pagination, fetchPage, mapRow, (_previous, page) => page.nextCursor);

/**
 * Pages an array already held in full. Used where Perplexity has no server-side
 * paging primitive (a thread page's normalized items); `total` is genuinely
 * known for that slice, so it is reported rather than nulled.
 */
export const pageLocalArray = <TItem>(all: TItem[], pagination: PaginationRequest): PagedResult<TItem> => {
  const start = parseOffsetCursor(pagination.cursor);
  const budget = pagination.fetchAll ? Math.min(pagination.maxItems, all.length) : pagination.limit;
  const take = Math.min(budget, pagination.maxItems);
  const slice = all.slice(start, start + take);
  const nextOffset = start + slice.length;
  const hasMore = nextOffset < all.length;
  return {
    items: slice,
    next_cursor: hasMore ? String(nextOffset) : null,
    has_more: hasMore,
    total: all.length,
    page_info: {
      returned: slice.length,
      pages_fetched: 1,
      truncated: hasMore && slice.length >= pagination.maxItems,
    },
  };
};
