import { ToolError } from '@opentabs-dev/plugin-sdk';
import type { PageInfo, PaginationRequest } from './tools/normalized-schemas.js';

export interface PagedResult<TItem> {
  items: TItem[];
  next_cursor: string | null;
  has_more: boolean;
  total: number | null;
  page_info: PageInfo;
}

/** Offset cursors are opaque to callers; ours are simply the next offset in decimal. */
const parseOffsetCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0)
    throw ToolError.validation(`Invalid cursor "${cursor}" — pass back next_cursor verbatim, or omit it.`);
  return offset;
};

export interface OffsetPage<TRow> {
  rows: TRow[];
  /** Whether the provider says more rows exist beyond this page. */
  hasMore: boolean;
}

/**
 * Walks an offset/limit endpoint under the SPEC §1 contract.
 *
 * Every upstream request is bounded to the remaining `max_items` budget, so the
 * ceiling cannot be exceeded even by one row, and `truncated` is set only when
 * that ceiling — not the page size — is what stopped the walk.
 *
 * `total` is always null for ChatGPT: /backend-api/conversations reports
 * `offset + items + 1`, which is a "there is at least one more" probe, not a
 * true count. Passing it through would be a lie.
 */
export const walkOffsetPages = async <TRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (offset: number, limit: number) => Promise<OffsetPage<TRow>>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => {
  const start = parseOffsetCursor(pagination.cursor);
  const collected: TRow[] = [];
  let offset = start;
  let pagesFetched = 0;
  let hasMore = false;

  do {
    const remaining = pagination.maxItems - collected.length;
    if (remaining <= 0) break;
    const page = await fetchPage(offset, Math.min(pagination.limit, remaining));
    pagesFetched += 1;
    collected.push(...page.rows);
    offset += page.rows.length;
    hasMore = page.hasMore;
    if (page.rows.length === 0) {
      hasMore = false;
      break;
    }
  } while (pagination.fetchAll && hasMore && collected.length < pagination.maxItems);

  return {
    items: collected.map(mapRow),
    next_cursor: hasMore ? String(offset) : null,
    has_more: hasMore,
    total: null,
    page_info: {
      returned: collected.length,
      pages_fetched: pagesFetched,
      truncated: hasMore && collected.length >= pagination.maxItems,
    },
  };
};

export interface CursorPage<TRow> {
  rows: TRow[];
  /** The provider's own opaque cursor, or null/'' when the walk is exhausted. */
  cursor: string | null | undefined;
}

/**
 * Walks an endpoint whose real pagination primitive is an opaque cursor
 * (/conversations/search, /gizmos/snorlax/sidebar, /gizmos/<id>/conversations).
 *
 * `next_cursor` is normalized to null — never "" — so `has_more` cannot be true
 * on an empty-string cursor that would restart the walk from the beginning.
 */
export const walkCursorPages = async <TRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (cursor: string | undefined, limit: number) => Promise<CursorPage<TRow>>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => {
  const collected: TRow[] = [];
  let cursor = pagination.cursor;
  let pagesFetched = 0;
  let truncated = false;

  do {
    const remaining = pagination.maxItems - collected.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const page = await fetchPage(cursor, Math.min(pagination.limit, remaining));
    pagesFetched += 1;
    // The endpoints ignore `limit` on some pages, so trim to the remaining
    // budget rather than trusting the server to respect the ceiling.
    const rows = page.rows.slice(0, remaining);
    const overflowed = rows.length < page.rows.length;
    collected.push(...rows);
    cursor = page.cursor || undefined;
    if (overflowed) {
      truncated = true;
      break;
    }
    if (rows.length === 0) {
      cursor = undefined;
      break;
    }
  } while (pagination.fetchAll && cursor);

  const nextCursor = cursor || null;
  return {
    items: collected.map(mapRow),
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
    total: null,
    page_info: {
      returned: collected.length,
      pages_fetched: pagesFetched,
      truncated: truncated && nextCursor !== null,
    },
  };
};

/**
 * Pages an array the provider already returned in full. Used for conversation
 * items and the model list, where chatgpt.com has no server-side paging
 * primitive; `total` is genuinely known there, so it is reported.
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
