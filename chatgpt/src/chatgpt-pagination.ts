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
    const requested = Math.min(pagination.limit, remaining);
    const page = await fetchPage(offset, requested);
    pagesFetched += 1;
    collected.push(...page.rows);
    offset += page.rows.length;
    // A page shorter than the one asked for is definitively the end, whatever
    // the provider's "there is more" probe claims — otherwise next_cursor is
    // non-null at the true end and the caller burns a request to discover it.
    hasMore = page.hasMore && page.rows.length >= requested;
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
 * Cursor tokens carry the provider's own opaque cursor plus how many rows of
 * that page the caller has already consumed.
 *
 * The intra-page offset exists because these endpoints ignore `limit` and return
 * a fixed page (~28-30 rows): when `max_items` cuts a page in half, advancing to
 * the provider's NEXT cursor would silently skip every row the ceiling trimmed.
 *
 * It is encoded as base64url'd JSON rather than a `<cursor>#<n>` suffix: the
 * provider's cursors are opaque, so any in-band separator we pick could occur
 * inside one and be mis-parsed — a `#` in a real cursor would resume from the
 * wrong page, which is exactly the dropped-rows bug this encoding prevents.
 */
const CURSOR_PREFIX = 'ot1.';

interface CursorToken {
  providerCursor: string | undefined;
  skip: number;
}

const parseCursorToken = (token: string | undefined): CursorToken => {
  if (token === undefined) return { providerCursor: undefined, skip: 0 };
  // Anything that is not one of ours is treated as a bare provider cursor.
  if (!token.startsWith(CURSOR_PREFIX)) return { providerCursor: token || undefined, skip: 0 };
  try {
    const json = atob(token.slice(CURSOR_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(json) as { c?: string | null; s?: number };
    const skip = typeof parsed.s === 'number' && Number.isInteger(parsed.s) && parsed.s >= 0 ? parsed.s : 0;
    return { providerCursor: parsed.c || undefined, skip };
  } catch {
    throw ToolError.validation(`Invalid cursor "${token}" — pass back next_cursor verbatim, or omit it.`);
  }
};

const formatCursorToken = (providerCursor: string | undefined, skip: number): string => {
  if (skip === 0) return providerCursor ?? '';
  const json = JSON.stringify({ c: providerCursor ?? null, s: skip });
  return CURSOR_PREFIX + btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

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
  let { providerCursor, skip } = parseCursorToken(pagination.cursor);
  let nextToken: string | null = null;
  let pagesFetched = 0;
  let truncated = false;

  for (;;) {
    const remaining = pagination.maxItems - collected.length;
    if (remaining <= 0) {
      truncated = true;
      nextToken = formatCursorToken(providerCursor, skip) || null;
      break;
    }
    const page = await fetchPage(providerCursor, Math.min(pagination.limit, remaining));
    pagesFetched += 1;
    const available = page.rows.slice(skip);
    const taken = available.slice(0, remaining);
    collected.push(...taken);

    if (taken.length < available.length) {
      // The ceiling cut this page short. Resume from the same provider cursor,
      // remembering how far in we got, so nothing between here and the next
      // provider cursor is skipped.
      truncated = true;
      nextToken = formatCursorToken(providerCursor, skip + taken.length);
      break;
    }

    const following = page.cursor || undefined;
    skip = 0;
    providerCursor = following;
    if (available.length === 0 || following === undefined) {
      nextToken = null;
      break;
    }
    nextToken = formatCursorToken(following, 0) || null;
    if (!pagination.fetchAll) break;
  }

  return {
    items: collected.map(mapRow),
    next_cursor: nextToken,
    has_more: nextToken !== null,
    total: null,
    page_info: {
      returned: collected.length,
      pages_fetched: pagesFetched,
      truncated: truncated && nextToken !== null,
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
