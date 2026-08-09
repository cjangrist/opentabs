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
 * `GET /chat_session/fetch_page` rejects `count` outside 2..100 with
 * `ILLEGAL_COUNT` (biz_code 1) — verified live at 0, 1, 101, 150 and 1000.
 * Requests are clamped into that window; the normalized `limit` may still reach
 * SPEC's 200 by walking more than one upstream page.
 */
export const UPSTREAM_MIN_COUNT = 2;
export const UPSTREAM_MAX_COUNT = 100;

/**
 * A page of rows plus whatever the caller needs to resume after the last one.
 *
 * `exhausted` is the provider's own "no more data" signal, kept separate from
 * "this page was short" so a short final page is not mistaken for more data.
 */
export interface KeysetPage<TRow> {
  rows: TRow[];
  exhausted: boolean;
}

/**
 * DeepSeek's session cursor is a *keyset*, not a token: the next request repeats
 * the last row's sort key as `lte_cursor.updated_at` / `lte_cursor.pinned`. It is
 * `lte` — LESS THAN OR EQUAL — so the boundary row comes back again on the next
 * page (verified live: paging from row 3 of page 1 returns that same row as row 1
 * of page 2). Adding `lte_cursor.id` does not change that.
 *
 * The cursor therefore has to carry the id of the last row actually returned so
 * the walker can drop everything up to and including it. That same id also
 * expresses a mid-page resume, which `max_items` needs: `limit: 50, max_items: 2`
 * must return two rows and then continue at row 3 of the same upstream page.
 *
 * Encoded as `<pinned>|<updated_at>|<id>` — opaque to callers, who pass it back
 * verbatim.
 */
export interface KeysetPosition {
  pinned: boolean;
  updatedAt: number;
  lastId: string;
}

export const formatKeysetCursor = (position: KeysetPosition): string =>
  `${position.pinned ? '1' : '0'}|${position.updatedAt}|${position.lastId}`;

export const parseKeysetCursor = (cursor: string | undefined): KeysetPosition | undefined => {
  if (cursor === undefined) return undefined;
  const parts = cursor.split('|');
  const [pinned, updatedAt] = parts;
  const lastId = parts.slice(2).join('|');
  const parsedUpdatedAt = Number(updatedAt);
  if (parts.length < 3 || (pinned !== '0' && pinned !== '1') || !Number.isFinite(parsedUpdatedAt) || !lastId)
    throw ToolError.validation(
      `Invalid cursor "${cursor}" — pass back next_cursor verbatim, or omit it for the first page.`,
      'VALIDATION_ERROR',
    );
  return { pinned: pinned === '1', updatedAt: parsedUpdatedAt, lastId };
};

export interface KeysetRow {
  id: string;
  pinned: boolean;
  updatedAt: number;
}

/**
 * Walks the `lte_cursor` keyset under the SPEC §1 contract.
 *
 * Every page is sliced down to the remaining `max_items` budget before anything
 * is collected, so the ceiling cannot be exceeded even by one row, and the
 * returned cursor resumes at the exact row that was not taken. `truncated` is set
 * only when that ceiling — and not the page size — stopped the walk.
 */
export const walkKeysetPages = async <TRow extends KeysetRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (position: KeysetPosition | undefined, count: number) => Promise<KeysetPage<TRow>>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => {
  const target = pagination.fetchAll ? pagination.maxItems : Math.min(pagination.limit, pagination.maxItems);
  let position = parseKeysetCursor(pagination.cursor);
  const collected: TRow[] = [];
  let pagesFetched = 0;
  let exhausted = false;

  while (collected.length < target && !exhausted) {
    const budget = target - collected.length;
    // One extra row covers the boundary row `lte` hands back a second time, and
    // the request is bounded to the remaining budget so an over-collect is
    // physically impossible.
    const count = Math.min(UPSTREAM_MAX_COUNT, Math.max(budget + (position ? 1 : 0), UPSTREAM_MIN_COUNT));
    const page = await fetchPage(position, count);
    pagesFetched += 1;

    let fresh = page.rows;
    if (position) {
      const boundary = fresh.findIndex(row => row.id === position?.lastId);
      // A boundary row that has since been deleted (or moved, because sending a
      // message bumps updated_at) leaves no anchor, so fall back to the sort key
      // itself rather than replaying rows the caller already has.
      fresh =
        boundary >= 0
          ? fresh.slice(boundary + 1)
          : fresh.filter(row => row.updatedAt < (position?.updatedAt ?? Number.POSITIVE_INFINITY));
    }

    if (fresh.length === 0) {
      // A page that yielded nothing new is only "more data" if the provider says
      // so AND the page was full — otherwise the walk would spin forever.
      if (page.exhausted || page.rows.length < count) exhausted = true;
      break;
    }

    const slice = fresh.slice(0, budget);
    collected.push(...slice);
    const last = slice[slice.length - 1];
    if (last) position = { pinned: last.pinned, updatedAt: last.updatedAt, lastId: last.id };
    if (page.exhausted && slice.length === fresh.length) exhausted = true;
  }

  const hasMore = !exhausted;
  return {
    items: collected.map(mapRow),
    next_cursor: hasMore && position ? formatKeysetCursor(position) : null,
    has_more: hasMore,
    // fetch_page reports no count of any kind — only `has_more` — so passing a
    // number here would be a guess (SPEC §1).
    total: null,
    page_info: {
      returned: collected.length,
      pages_fetched: pagesFetched,
      truncated: hasMore && collected.length >= pagination.maxItems,
    },
  };
};

/**
 * Pages an array the provider already returned in full — the model list and the
 * normalized items of one conversation. `total` is genuinely known here, so it is
 * reported rather than nulled.
 *
 * The cursor is a bare offset, distinct from the keyset cursor above; callers
 * only ever pass back the `next_cursor` of the same tool.
 */
export const pageLocalArray = <TItem>(all: TItem[], pagination: PaginationRequest): PagedResult<TItem> => {
  const start = parseOffsetCursor(pagination.cursor);
  const target = pagination.fetchAll ? pagination.maxItems : Math.min(pagination.limit, pagination.maxItems);
  const slice = all.slice(start, start + target);
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

export const parseOffsetCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0)
    throw ToolError.validation(
      `Invalid cursor "${cursor}" — pass back next_cursor verbatim, or omit it for the first page.`,
      'VALIDATION_ERROR',
    );
  return offset;
};
