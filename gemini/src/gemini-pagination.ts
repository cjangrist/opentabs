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
 * Walks an opaque-token endpoint (Gemini's `MaZiqc` / `unqWSc`) under the SPEC §1
 * contract.
 *
 * `fetchPage` is asked for at most `min(limit, maxItems - collected)` rows, so an
 * endpoint that honours a page size (`MaZiqc`) physically cannot over-collect. The
 * search RPC has no page-size argument at all and always returns its own page, so the
 * result is ALSO sliced to the ceiling here — otherwise `limit:3, max_items:6` would
 * return 23 rows with a cheerful `truncated:true`. When the slice cuts into a page,
 * `next_cursor` still points at the start of the following provider page, so resuming
 * after a mid-page ceiling skips the remainder of that page; the affected tool says so
 * in its description.
 *
 * `total` is always null: no Gemini list endpoint reports a count, only a cursor.
 */
export const walkTokenPages = async <TRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (token: string | undefined, limit: number) => Promise<TokenPage<TRow>>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => {
  const ceiling = pagination.fetchAll ? pagination.maxItems : Math.min(pagination.limit, pagination.maxItems);
  const collected: TRow[] = [];
  let token: string | undefined = pagination.cursor;
  let pagesFetched = 0;
  let nextToken: string | null = null;

  do {
    const remaining = ceiling - collected.length;
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
  } while (pagination.fetchAll && nextToken && collected.length < ceiling);

  const overflowed = collected.length > ceiling;
  const returned = overflowed ? collected.slice(0, ceiling) : collected;
  const hasMore = nextToken !== null || overflowed;
  // Truncation means a CEILING dropped data, not that ordinary paging left more
  // behind: either the max_items budget stopped the walk, or a provider page came
  // back larger than the ceiling and had to be sliced.
  const truncated = overflowed || (hasMore && returned.length >= pagination.maxItems);

  return {
    items: returned.map(mapRow),
    // `|| null` not `?? null`: an empty-string token must read as "exhausted".
    next_cursor: nextToken || null,
    has_more: hasMore,
    total: null,
    page_info: { returned: returned.length, pages_fetched: pagesFetched, truncated },
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
