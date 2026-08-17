import { ToolError } from '@opentabs-dev/plugin-sdk';
import type { PageInfo, PaginationRequest } from './tools/normalized-schemas.js';

export interface CursorPage<TRow> {
  rows: TRow[];
  next: string | null;
}

export interface PagedResult<TItem> {
  items: TItem[];
  next_cursor: string | null;
  has_more: boolean;
  total: number | null;
  page_info: PageInfo;
}

interface CursorPosition {
  token: string | undefined;
  skip: number;
}

const MAX_CURSOR_PAGES = 200;

const encodeCursor = (token: string | undefined, skip: number): string => {
  const bytes = new TextEncoder().encode(JSON.stringify({ token: token ?? null, skip }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decodeCursor = (cursor: string | undefined): CursorPosition => {
  if (cursor === undefined) return { token: undefined, skip: 0 };
  try {
    const bytes = Uint8Array.from(atob(cursor), character => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
      token?: unknown;
      skip?: unknown;
    };
    if (
      (parsed.token !== null && parsed.token !== undefined && typeof parsed.token !== 'string') ||
      !Number.isInteger(parsed.skip) ||
      (parsed.skip as number) < 0
    )
      throw new Error('invalid fields');
    return {
      token: typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : undefined,
      skip: parsed.skip as number,
    };
  } catch {
    throw ToolError.validation(
      `Invalid cursor "${cursor}" — pass back next_cursor verbatim, or omit it for the first page.`,
      'VALIDATION_ERROR',
    );
  }
};

/**
 * Grok's list/search/project endpoints choose their own page size (20 at the
 * time of writing) and expose only an opaque `next` token. The cursor therefore
 * records both that token and an intra-page offset so a small normalized limit
 * never drops the unreturned tail of a provider page.
 */
export const walkCursorPages = async <TRow, TItem>(
  pagination: PaginationRequest,
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<TRow>>,
  mapRow: (row: TRow) => TItem,
): Promise<PagedResult<TItem>> => {
  const target = pagination.fetchAll ? pagination.maxItems : Math.min(pagination.limit, pagination.maxItems);
  const start = decodeCursor(pagination.cursor);
  const collected: TRow[] = [];
  let token = start.token;
  let skip = start.skip;
  let pagesFetched = 0;
  let resumeToken = token;
  let resumeSkip = skip;
  let hasMore = false;

  while (collected.length < target && pagesFetched < MAX_CURSOR_PAGES) {
    const pageToken = token;
    const pageSkip = skip;
    const page = await fetchPage(pageToken);
    pagesFetched += 1;

    const remaining = target - collected.length;
    const usable = page.rows.slice(Math.min(pageSkip, page.rows.length));
    const taken = usable.slice(0, remaining);
    collected.push(...taken);

    if (taken.length < usable.length) {
      resumeToken = pageToken;
      resumeSkip = pageSkip + taken.length;
      hasMore = true;
      break;
    }

    if (!page.next || page.next === pageToken) {
      hasMore = false;
      break;
    }

    resumeToken = page.next;
    resumeSkip = 0;
    hasMore = true;
    token = page.next;
    skip = 0;
    if (!pagination.fetchAll && collected.length > 0) break;
  }

  return {
    items: collected.map(row => mapRow(row)),
    next_cursor: hasMore ? encodeCursor(resumeToken, resumeSkip) : null,
    has_more: hasMore,
    total: null,
    page_info: {
      returned: collected.length,
      pages_fetched: pagesFetched,
      truncated: hasMore && (collected.length >= pagination.maxItems || pagesFetched >= MAX_CURSOR_PAGES),
    },
  };
};

export const pageLocalArray = <TItem>(all: TItem[], pagination: PaginationRequest): PagedResult<TItem> => {
  const rawCursor = pagination.cursor;
  if (rawCursor !== undefined && !/^[0-9]+$/.test(rawCursor))
    throw ToolError.validation(
      `Invalid cursor "${pagination.cursor}" — pass back next_cursor verbatim, or omit it for the first page.`,
      'VALIDATION_ERROR',
    );
  const offset = Number(rawCursor ?? '0');
  if (!Number.isSafeInteger(offset))
    throw ToolError.validation(
      `Invalid cursor "${pagination.cursor}" — pass back next_cursor verbatim, or omit it for the first page.`,
      'VALIDATION_ERROR',
    );
  const target = pagination.fetchAll ? pagination.maxItems : Math.min(pagination.limit, pagination.maxItems);
  const items = all.slice(offset, offset + target);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < all.length;
  return {
    items,
    next_cursor: hasMore ? String(nextOffset) : null,
    has_more: hasMore,
    total: all.length,
    page_info: {
      returned: items.length,
      pages_fetched: 1,
      truncated: hasMore && items.length >= pagination.maxItems,
    },
  };
};
