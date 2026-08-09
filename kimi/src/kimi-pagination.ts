import { ToolError } from '@opentabs-dev/plugin-sdk';
import type { PageInfo, PaginationRequest } from './tools/normalized-schemas.js';

export interface PagedResult<TItem> {
  items: TItem[];
  next_cursor: string | null;
  has_more: boolean;
  total: number | null;
  page_info: PageInfo;
}

/**
 * Every Kimi list endpoint pages with an opaque `pageToken` / `nextPageToken`
 * pair and honours `pageSize` exactly (asking for 3 returns 3, proven live).
 * `FeedService/ListFeeds` and `ProjectService/ListProjects` reject a pageSize
 * above 100 with `invalid_argument`, so an upstream request is clamped here
 * while the normalized `limit` may still go to SPEC's 200 across two calls.
 */
export const UPSTREAM_PAGE_LIMIT = 100;

export interface TokenPage<TRow> {
  rows: TRow[];
  nextPageToken: string | null;
  /** A real count across all pages, or null when the endpoint reports none. */
  total: number | null;
}

/**
 * A cursor has to carry the offset *within* the upstream page as well as the
 * page token: `limit: 50, max_items: 2` must return two rows and then resume at
 * row 3 of the same upstream page, which a bare page token cannot express.
 *
 * Encoded as `<offset>|<token>` — opaque to callers, who pass it back verbatim.
 */
interface CursorPosition {
  token: string | undefined;
  offset: number;
}

const parseCursor = (cursor: string | undefined): CursorPosition => {
  if (cursor === undefined) return { token: undefined, offset: 0 };
  const separator = cursor.indexOf('|');
  const offset = separator < 0 ? Number.NaN : Number(cursor.slice(0, separator));
  if (!Number.isInteger(offset) || offset < 0)
    throw ToolError.validation(`Invalid cursor "${cursor}" — pass back next_cursor verbatim, or omit it.`);
  const token = cursor.slice(separator + 1);
  return { token: token.length > 0 ? token : undefined, offset };
};

const formatCursor = (position: CursorPosition): string => `${position.offset}|${position.token ?? ''}`;

/**
 * Walks a `pageToken`-paginated Kimi endpoint under the SPEC §1 contract.
 *
 * Every upstream request is bounded to the remaining `max_items` budget and each
 * page is sliced down to it before anything is collected, so the ceiling cannot
 * be exceeded even by one row — `limit: 50, max_items: 2` returns exactly two —
 * and the returned cursor resumes at the exact row that was not taken.
 * `truncated` is set only when that ceiling, and not the page size, stopped the
 * walk.
 */
export const walkTokenPages = async <TRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (pageToken: string | undefined, pageSize: number) => Promise<TokenPage<TRow>>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => {
  const target = pagination.fetchAll ? pagination.maxItems : Math.min(pagination.limit, pagination.maxItems);
  const position = parseCursor(pagination.cursor);
  const collected: TRow[] = [];
  let pagesFetched = 0;
  let exhausted = false;
  let total: number | null = null;

  while (collected.length < target && !exhausted) {
    const budget = target - collected.length;
    // `limit` is the PAGE SIZE the caller asked the provider for (SPEC §1), not
    // just a ceiling: asking for the whole remaining budget in one request would
    // make a fetch_all walk hit different upstream pages than the equivalent
    // manual cursor walk. Kimi's search cursor is not a stable prefix across
    // page sizes, so those two must issue identical requests.
    const wanted = Math.min(pagination.limit, budget);
    const pageSize = Math.min(UPSTREAM_PAGE_LIMIT, Math.max(wanted + position.offset, 1));
    const page = await fetchPage(position.token, pageSize);
    pagesFetched += 1;
    total = page.total;

    if (page.rows.length === 0) {
      exhausted = true;
      break;
    }
    if (position.offset >= page.rows.length) {
      // A caller-supplied cursor can land exactly on a page end; only a missing
      // nextPageToken proves there is genuinely no more data beyond it.
      if (!page.nextPageToken) {
        exhausted = true;
        break;
      }
      position.token = page.nextPageToken;
      position.offset = 0;
      continue;
    }

    const slice = page.rows.slice(position.offset, position.offset + budget);
    collected.push(...slice);
    const consumedWholePage = position.offset + slice.length >= page.rows.length;

    if (!consumedWholePage) {
      position.offset += slice.length;
    } else if (!page.nextPageToken) {
      exhausted = true;
      position.offset = page.rows.length;
    } else {
      position.token = page.nextPageToken;
      position.offset = 0;
    }
  }

  const hasMore = !exhausted;
  return {
    items: collected.map(mapRow),
    next_cursor: hasMore ? formatCursor(position) : null,
    has_more: hasMore,
    total,
    page_info: {
      returned: collected.length,
      pages_fetched: pagesFetched,
      truncated: hasMore && collected.length >= pagination.maxItems,
    },
  };
};

/**
 * Pages an array the provider already returned in full — the model list and the
 * normalized items of one conversation. `total` is genuinely known here, so it
 * is reported rather than nulled.
 *
 * Cursors keep the `<offset>|<token>` shape of the token walker, with an empty
 * token, so callers never have to care which primitive is underneath.
 */
export const pageLocalArray = <TItem>(all: TItem[], pagination: PaginationRequest): PagedResult<TItem> => {
  const { offset: start } = parseCursor(pagination.cursor);
  const target = pagination.fetchAll ? pagination.maxItems : Math.min(pagination.limit, pagination.maxItems);
  const slice = all.slice(start, start + target);
  const nextOffset = start + slice.length;
  const hasMore = nextOffset < all.length;
  return {
    items: slice,
    next_cursor: hasMore ? formatCursor({ token: undefined, offset: nextOffset }) : null,
    has_more: hasMore,
    total: all.length,
    page_info: {
      returned: slice.length,
      pages_fetched: 1,
      truncated: hasMore && slice.length >= pagination.maxItems,
    },
  };
};
