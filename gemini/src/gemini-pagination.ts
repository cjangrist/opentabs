import type { PageInfo, PaginationRequest } from './tools/normalized-schemas.js';

export interface TokenPage<TRow> {
  rows: TRow[];
  /** Opaque continuation token from the provider, or null when it reported the end. */
  nextToken: string | null;
}

export interface PagedResult<TItem> {
  items: TItem[];
  next_cursor: string | null;
  has_more: boolean;
  total: number | null;
  page_info: PageInfo;
}

/**
 * Walks an opaque-token endpoint (Gemini's `MaZiqc` / `unqWSc` / `hNvQHb`) under the
 * SPEC §1 contract.
 *
 * Every upstream request is bounded to `min(limit, maxItems - collected)`, so the
 * ceiling cannot be exceeded even by one row — `limit:50, max_items:2` physically
 * asks Gemini for 2. `truncated` is set only when that ceiling, not the page size,
 * stopped the walk.
 *
 * `total` is always null: no Gemini list endpoint reports a count, only a cursor.
 */
export const walkTokenPages = async <TRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (token: string | undefined, limit: number) => Promise<TokenPage<TRow>>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => {
  const collected: TRow[] = [];
  let token: string | undefined = pagination.cursor;
  let pagesFetched = 0;
  let nextToken: string | null = null;

  do {
    const remaining = pagination.maxItems - collected.length;
    if (remaining <= 0) break;
    const page: TokenPage<TRow> = await fetchPage(token, Math.min(pagination.limit, remaining));
    pagesFetched += 1;
    collected.push(...page.rows);
    nextToken = page.nextToken;
    if (page.rows.length === 0) {
      nextToken = null;
      break;
    }
    token = page.nextToken ?? undefined;
  } while (pagination.fetchAll && nextToken && collected.length < pagination.maxItems);

  const hasMore = nextToken !== null;
  const truncated = hasMore && collected.length >= pagination.maxItems;

  return {
    items: collected.map(mapRow),
    // `|| null` not `?? null`: an empty-string token must read as "exhausted".
    next_cursor: hasMore ? nextToken || null : null,
    has_more: hasMore,
    total: null,
    page_info: { returned: collected.length, pages_fetched: pagesFetched, truncated },
  };
};

/**
 * Pages an array Gemini already returned in full (the normalized item list of a
 * conversation page). `total` is genuinely known here, so it is reported.
 */
export const pageLocalArray = <TItem>(all: TItem[], pagination: PaginationRequest): PagedResult<TItem> => {
  const start = Number(pagination.cursor ?? '0');
  const offset = Number.isInteger(start) && start >= 0 ? start : 0;
  const budget = pagination.fetchAll ? Math.min(pagination.maxItems, all.length) : pagination.limit;
  const slice = all.slice(offset, offset + Math.min(budget, pagination.maxItems));
  const nextOffset = offset + slice.length;
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
