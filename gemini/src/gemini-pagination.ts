import { ToolError } from '@opentabs-dev/plugin-sdk';
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
 * A cursor is `<providerToken>|<skip>`: the token to fetch from, and how many rows of
 * THAT page were already returned. The skip exists because Gemini's search RPC takes no
 * page-size argument and always returns its own ~23-row page, so a small `limit` has to
 * slice the page — and without recording the skip, resuming would silently drop the rest
 * of it. `MaZiqc` honours a page size, so its cursors always carry `|0`.
 */
const encodeCursor = (token: string | null, skip: number): string | null =>
  !token && skip === 0 ? null : `${token ?? ''}|${skip}`;

const decodeCursor = (cursor: string | undefined): { token: string | undefined; skip: number } => {
  if (!cursor) return { token: undefined, skip: 0 };
  const separator = cursor.lastIndexOf('|');
  if (separator < 0) return { token: cursor, skip: 0 };
  const skip = Number(cursor.slice(separator + 1));
  if (!Number.isInteger(skip) || skip < 0)
    throw ToolError.validation(`Invalid cursor "${cursor}" — pass back next_cursor verbatim, or omit it.`);
  return { token: cursor.slice(0, separator) || undefined, skip };
};

/**
 * Walks an opaque-token endpoint (Gemini's `MaZiqc` / `unqWSc`) under the SPEC §1
 * contract.
 *
 * `fetchPage` is asked for at most `min(limit, maxItems - collected)` rows, so an
 * endpoint that honours a page size physically cannot over-collect. Where the endpoint
 * ignores the size, the surplus is sliced off here and its position recorded in the
 * cursor's skip component — the ceiling stays hard AND nothing is lost on resume.
 *
 * `total` is always null: no Gemini list endpoint reports a count, only a cursor.
 */
export const walkTokenPages = async <TRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (token: string | undefined, limit: number) => Promise<TokenPage<TRow>>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => {
  const ceiling = pagination.fetchAll ? pagination.maxItems : Math.min(pagination.limit, pagination.maxItems);
  const start = decodeCursor(pagination.cursor);
  const collected: TRow[] = [];

  let token: string | undefined = start.token;
  let skip = start.skip;
  let pagesFetched = 0;
  let nextToken: string | null = null;
  // Provenance of the most recent page, so a mid-page ceiling can resume inside it.
  let lastToken: string | undefined = start.token;
  let lastSkip = start.skip;
  let lastUsable = 0;

  do {
    const remaining = ceiling - collected.length;
    if (remaining <= 0) break;
    const page: TokenPage<TRow> = await fetchPage(token, Math.min(pagination.limit, remaining) + skip);
    pagesFetched += 1;
    const usable = skip > 0 ? page.rows.slice(skip) : page.rows;
    lastToken = token;
    lastSkip = skip;
    lastUsable = usable.length;
    collected.push(...usable);
    nextToken = page.nextToken;
    if (usable.length === 0) {
      nextToken = null;
      break;
    }
    skip = 0;
    token = page.nextToken ?? undefined;
  } while (pagination.fetchAll && nextToken && collected.length < ceiling);

  const overflow = Math.max(0, collected.length - ceiling);
  const returned = overflow > 0 ? collected.slice(0, ceiling) : collected;
  const hasMore = overflow > 0 || nextToken !== null;
  // Truncation means a CEILING dropped data, not that ordinary paging left more behind.
  const truncated = hasMore && returned.length >= pagination.maxItems;
  const nextCursor =
    overflow > 0
      ? // Re-fetch the page that overflowed and skip everything already returned from it.
        encodeCursor(lastToken ?? null, lastSkip + (lastUsable - overflow))
      : // `|| null` not `?? null`: an empty-string token must read as "exhausted".
        (nextToken && encodeCursor(nextToken, 0)) || null;

  return {
    items: returned.map(mapRow),
    next_cursor: nextCursor,
    has_more: hasMore,
    total: null,
    page_info: { returned: returned.length, pages_fetched: pagesFetched, truncated },
  };
};

/**
 * Pages an array Gemini already returned in full (the model catalogue, or the normalized
 * item list of a conversation). `total` is genuinely known here, so it is reported.
 */
export const pageLocalArray = <TItem>(all: TItem[], pagination: PaginationRequest): PagedResult<TItem> => {
  const raw = Number(pagination.cursor ?? '0');
  if (!Number.isInteger(raw) || raw < 0)
    throw ToolError.validation(`Invalid cursor "${pagination.cursor}" — pass back next_cursor verbatim, or omit it.`);
  const offset = raw;
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
