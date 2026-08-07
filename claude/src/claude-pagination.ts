import { ToolError } from '@opentabs-dev/plugin-sdk';
import type { PageInfo, PaginationRequest } from './tools/normalized-schemas.js';

export interface OffsetPage<TRow> {
  rows: TRow[];
  /** Whether the provider says more rows exist beyond this page. */
  hasMore: boolean;
  /** A real total across all pages, or null when the provider reports none. */
  total: number | null;
}

export interface PagedResult<TItem> {
  items: TItem[];
  next_cursor: string | null;
  has_more: boolean;
  total: number | null;
  page_info: PageInfo;
}

/** Cursors are opaque to callers; ours are simply the next offset in decimal. */
const parseCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0)
    throw ToolError.validation(`Invalid cursor "${cursor}" — pass back next_cursor verbatim, or omit it.`);
  return offset;
};

/**
 * Walks an offset/limit endpoint under the SPEC §1 contract.
 *
 * Every upstream request is bounded to the remaining `max_items` budget, so the
 * ceiling cannot be exceeded even by one row, and `truncated` is set only when
 * that ceiling — not the page size — is what stopped the walk.
 */
export const walkOffsetPages = async <TRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (offset: number, limit: number) => Promise<OffsetPage<TRow>>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => {
  const start = parseCursor(pagination.cursor);
  const collected: TRow[] = [];
  let offset = start;
  let pagesFetched = 0;
  let hasMore = false;
  let total: number | null = null;

  do {
    const remaining = pagination.maxItems - collected.length;
    if (remaining <= 0) break;
    const page = await fetchPage(offset, Math.min(pagination.limit, remaining));
    pagesFetched += 1;
    collected.push(...page.rows);
    offset += page.rows.length;
    hasMore = page.hasMore;
    total = page.total;
    if (page.rows.length === 0) {
      hasMore = false;
      break;
    }
  } while (pagination.fetchAll && hasMore && collected.length < pagination.maxItems);

  const truncated = hasMore && collected.length >= pagination.maxItems;

  return {
    items: collected.map(mapRow),
    next_cursor: hasMore ? String(offset) : null,
    has_more: hasMore,
    total,
    page_info: { returned: collected.length, pages_fetched: pagesFetched, truncated },
  };
};

/**
 * Pages an array the provider already returned in full. Used where claude.ai has
 * no server-side paging primitive (conversation trees, organizations); `total` is
 * genuinely known, so it is reported rather than nulled.
 */
export const pageLocalArray = <TItem>(all: TItem[], pagination: PaginationRequest): PagedResult<TItem> => {
  const start = parseCursor(pagination.cursor);
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
