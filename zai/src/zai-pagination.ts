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
 * Every z.ai list endpoint pages by 1-based `page` number and serves a fixed 60
 * rows — `limit`, `page_size` and `offset` are all accepted and silently ignored
 * (proven by asking for 3 and receiving 60). A cursor therefore has to carry the
 * offset *within* a page as well as the page number, otherwise `max_items: 2`
 * could not resume at row 3.
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
 * Walks a page-numbered endpoint under the SPEC §1 contract.
 *
 * The ceiling is enforced by slicing every upstream page down to the remaining
 * budget before anything is collected, so `limit: 50, max_items: 2` returns two
 * items — never fifty with a cheerful `truncated: true` — and the returned cursor
 * resumes at the exact row that was not taken.
 *
 * `total` is the caller's problem to walk: z.ai publishes no count on any list
 * endpoint, so it is always null here.
 */
export const walkNumberedPages = async <TRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (page: number) => Promise<TRow[]>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => {
  const target = pagination.fetchAll ? pagination.maxItems : Math.min(pagination.limit, pagination.maxItems);
  const position = parseCursor(pagination.cursor);
  const collected: TRow[] = [];
  let pagesFetched = 0;
  let exhausted = false;

  while (collected.length < target && !exhausted) {
    const rows = await fetchPage(position.page);
    pagesFetched += 1;

    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    if (position.offset >= rows.length) {
      // A caller-supplied cursor can land exactly on a page end. Only a short page
      // proves there is no more data; a full one means the next page is where the
      // remaining rows live.
      if (rows.length < UPSTREAM_PAGE_SIZE) {
        exhausted = true;
        break;
      }
      position.page += 1;
      position.offset = 0;
      continue;
    }

    const budget = target - collected.length;
    const slice = rows.slice(position.offset, position.offset + budget);
    collected.push(...slice);
    const consumedWholePage = position.offset + slice.length >= rows.length;

    if (!consumedWholePage) {
      position.offset += slice.length;
    } else if (rows.length < UPSTREAM_PAGE_SIZE) {
      // A short page is the provider's end-of-data signal.
      exhausted = true;
      position.offset = rows.length;
    } else {
      position.page += 1;
      position.offset = 0;
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
 * Pages an array the provider already returned in full — folders, a folder's
 * chats, the model list, and the normalized items of one conversation. `total` is
 * genuinely known here, so it is reported rather than nulled.
 *
 * Cursors keep the `page:offset` shape of the numbered walker so callers never
 * have to care which primitive is underneath; page is pinned to 1.
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
