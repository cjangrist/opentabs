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
 * Rows a full `/api/v2/chats/` page carries. `limit`, `page_size` and `offset` are
 * all accepted and silently ignored — proven live by asking for 3 and receiving 60 —
 * so a cursor has to carry the offset *within* a page as well as the page number,
 * otherwise `max_items: 2` could not resume at row 3.
 *
 * This is documentation, not a control flow input: `/api/v2/chats/search` serves 59
 * rows on a page that is followed by 13 more, so "short page" is NOT an end-of-data
 * signal on Qwen and the walker below deliberately does not use one.
 */
export const UPSTREAM_PAGE_SIZE = 60;

interface CursorPosition {
  page: number;
  offset: number;
}

const parseCursor = (cursor: string | undefined): CursorPosition => {
  if (cursor === undefined) return { page: 1, offset: 0 };
  const match = /^(\d+):(\d+)$/.exec(cursor);
  const page = match ? Number(match[1]) : Number.NaN;
  const offset = match ? Number(match[2]) : Number.NaN;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(offset) || offset < 0)
    throw ToolError.validation(`Invalid cursor "${cursor}" — pass back next_cursor verbatim, or omit it.`);
  return { page, offset };
};

const formatCursor = (position: CursorPosition): string => `${position.page}:${position.offset}`;

/**
 * Walks a 1-based page-numbered endpoint under the SPEC §1 contract.
 *
 * The ceiling is enforced by slicing every upstream page down to the remaining
 * budget *before* anything is collected, so `limit: 50, max_items: 2` returns two
 * items — never fifty with a cheerful `truncated: true` — and the returned cursor
 * resumes at the exact row that was not taken.
 *
 * Exhaustion is only ever concluded from an empty page, or from a page whose rows
 * were all seen already (an endpoint that ignores `page` must not loop forever).
 * Qwen serves a 59-row search page followed by a 13-row one, so treating a
 * short page as the end would silently drop those 13 rows. The cost is that a walk
 * which exactly fills its budget reports `has_more: true` until the next call proves
 * otherwise — the safe direction to be wrong in.
 *
 * `total` is always null: no Qwen list endpoint publishes a count.
 */
export const walkNumberedPages = async <TRow extends { id?: string }, TItem>(
  pagination: PaginationRequest,
  fetchPage: (page: number) => Promise<TRow[]>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => {
  const target = pagination.fetchAll ? pagination.maxItems : Math.min(pagination.limit, pagination.maxItems);
  const position = parseCursor(pagination.cursor);
  const collected: TRow[] = [];
  const seen = new Set<string>();
  let pagesFetched = 0;
  let exhausted = false;

  while (collected.length < target && !exhausted) {
    const rows = await fetchPage(position.page);
    pagesFetched += 1;

    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    if (pagesFetched > 1 && rows.every(row => row.id !== undefined && seen.has(row.id))) {
      exhausted = true;
      break;
    }
    for (const row of rows) if (row.id) seen.add(row.id);

    if (position.offset >= rows.length) {
      position.page += 1;
      position.offset = 0;
      continue;
    }

    const budget = target - collected.length;
    const slice = rows.slice(position.offset, position.offset + budget);
    collected.push(...slice);

    if (position.offset + slice.length >= rows.length) {
      position.page += 1;
      position.offset = 0;
    } else {
      position.offset += slice.length;
    }
  }

  const hasMore = !exhausted;
  return {
    items: collected.map(mapRow),
    next_cursor: hasMore ? formatCursor(position) : null,
    has_more: hasMore,
    total: null,
    page_info: {
      returned: collected.length,
      pages_fetched: pagesFetched,
      truncated: hasMore && collected.length >= pagination.maxItems,
    },
  };
};

/**
 * Pages an array the provider already returned in full — the model list, a project's
 * conversations, and the normalized items of one conversation. `total` is genuinely
 * known here, so it is reported rather than nulled.
 *
 * Cursors keep the `page:offset` shape of the numbered walker so callers never have
 * to care which primitive is underneath; page is pinned to 1.
 */
export const pageLocalArray = <TItem>(all: TItem[], pagination: PaginationRequest): PagedResult<TItem> => {
  const { offset: start } = parseCursor(pagination.cursor);
  const target = pagination.fetchAll ? pagination.maxItems : Math.min(pagination.limit, pagination.maxItems);
  const slice = all.slice(start, start + target);
  const nextOffset = start + slice.length;
  const hasMore = nextOffset < all.length;
  return {
    items: slice,
    next_cursor: hasMore ? formatCursor({ page: 1, offset: nextOffset }) : null,
    has_more: hasMore,
    total: all.length,
    page_info: {
      returned: slice.length,
      pages_fetched: 1,
      truncated: hasMore && slice.length >= pagination.maxItems,
    },
  };
};
