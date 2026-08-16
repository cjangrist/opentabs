import { ToolError, fetchFromPage } from '@opentabs-dev/plugin-sdk';
import { API_BASE, REQUEST_TIMEOUT_MS, buildHeaders, getApi, parseSseEvents } from './deepseek-api.js';
import type { PagedResult } from './deepseek-pagination.js';
import type { PaginationRequest } from './tools/normalized-schemas.js';

/**
 * Warms the full-text index. chat.deepseek.com issues this GET when the search
 * panel opens, before it ever queries, so a walk that skipped it could quietly
 * return an empty page on a session whose index had gone cold. It answers
 * `biz_data: null` on success, so a null body is expected here.
 */
const prepareIndex = async (): Promise<void> => {
  await getApi<unknown>('/index/prepare', { allowNullData: true });
};

/** A run of text the index returns, with the matched span flagged. */
interface HighlightedParts {
  parts?: { highlight?: boolean; text?: string }[];
  is_begin?: boolean;
  is_end?: boolean;
}

interface RawSearchItem {
  chat_session_id?: string;
  chat_session_title?: HighlightedParts;
  chat_session_model_type?: string;
  message_id?: number;
  message_role?: string;
  timestamp?: number;
  seq_id?: string;
  content?: HighlightedParts;
  is_think?: boolean;
}

export interface SearchHit {
  conversationId: string;
  title: string;
  modelType: string;
  messageId: number;
  role: string;
  timestamp: number;
  seqId: string;
  snippet: string;
  isThinking: boolean;
}

/** The sentinel the index streams once the scan has reached the oldest message. */
const EXHAUSTED_SEQ_ID = '0';

/** Joins the highlighted runs back into plain text, marking a clipped excerpt. */
const flattenParts = (value: HighlightedParts | undefined, markTruncation: boolean): string => {
  const text = (value?.parts ?? []).map(part => part.text ?? '').join('');
  if (!markTruncation) return text;
  const prefix = value?.is_begin === false ? '…' : '';
  const suffix = value?.is_end === false ? '…' : '';
  return `${prefix}${text}${suffix}`;
};

export interface SearchPage {
  hits: SearchHit[];
  /** Pass as `before_seq_id` to continue; null once the index reports exhaustion. */
  nextSeqId: string | null;
}

/**
 * Runs one pass of `POST /index/query` — the endpoint the chat.deepseek.com
 * search box drives.
 *
 * The response is an SSE stream of `item` / `status` / `close` frames carrying
 * HTTP 200 regardless of outcome, so the `close` frame's `close_reason` is the
 * only place a failure is reported and it MUST be classified (SPEC §0).
 *
 * `status` frames publish the seq id the scan has reached; the last one is the
 * resume cursor, and the literal "0" means the whole history has been scanned.
 */
export const runSearchPage = async (query: string, beforeSeqId: string | undefined): Promise<SearchPage> => {
  const response = await fetchFromPage(`${API_BASE}/index/query`, {
    method: 'POST',
    headers: buildHeaders({ 'content-type': 'application/json' }),
    credentials: 'include',
    timeout: REQUEST_TIMEOUT_MS,
    body: JSON.stringify({ query, before_seq_id: beforeSeqId ?? null }),
  });

  const events = parseSseEvents(await response.text());
  const hits: SearchHit[] = [];
  let lastSeqId: string | null = null;
  let closeSeen = false;
  let closeReason: string | undefined;

  for (const event of events) {
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }

    if (event.event === 'item') {
      const item = payload as RawSearchItem;
      if (!item.chat_session_id) continue;
      hits.push({
        conversationId: item.chat_session_id,
        title: flattenParts(item.chat_session_title, false),
        modelType: item.chat_session_model_type ?? '',
        messageId: item.message_id ?? 0,
        role: item.message_role ?? '',
        timestamp: item.timestamp ?? 0,
        seqId: item.seq_id ?? '',
        snippet: flattenParts(item.content, true),
        isThinking: item.is_think === true,
      });
      if (item.seq_id) lastSeqId = item.seq_id;
      continue;
    }
    if (event.event === 'status') {
      const seqId = (payload as { queried_seq_id?: string }).queried_seq_id;
      if (seqId) lastSeqId = seqId;
      continue;
    }
    if (event.event === 'close') {
      closeSeen = true;
      closeReason = (payload as { close_reason?: string }).close_reason;
    }
  }

  if (!closeSeen)
    throw new ToolError(
      "DeepSeek's conversation index closed the stream without a close frame — the search did not complete.",
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  if (closeReason === 'invalid_query')
    throw ToolError.validation(
      `DeepSeek's index rejected the query "${query}" — it must be non-empty and indexable.`,
      'VALIDATION_ERROR',
    );
  if (closeReason === 'timeout')
    throw ToolError.timeout("DeepSeek's conversation index timed out while scanning. Retry.", 'TIMEOUT');
  if (closeReason === 'error')
    throw new ToolError("DeepSeek's conversation index reported an error.", 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  if (closeReason === undefined)
    throw new ToolError(
      "DeepSeek's conversation index sent a close frame without a reason — the search did not complete.",
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  if (closeReason !== 'success') {
    if (/(?:rate|quota|throttl)/i.test(closeReason))
      throw ToolError.rateLimited(
        `DeepSeek's conversation index rate limited the search (${closeReason}). Retry later.`,
        undefined,
        'RATE_LIMIT',
      );
    throw new ToolError(
      `DeepSeek's conversation index closed with an unrecognized reason (${closeReason}) — treating it as a failure.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  }

  return { hits, nextSeqId: lastSeqId === null || lastSeqId === EXHAUSTED_SEQ_ID ? null : lastSeqId };
};

/**
 * A search cursor has to carry the offset *within* an upstream batch as well as
 * the seq id: `/index/query` takes no page-size parameter and streams whatever
 * batch it likes (40-50 hits observed for a broad query, 10 for a narrow one), so
 * a `limit` of 5 must return five hits and then resume at hit 6 of the SAME batch.
 *
 * Encoded as `<offset>|<before_seq_id>` — opaque to callers, who pass it back verbatim.
 */
interface SearchPosition {
  seqId: string | undefined;
  offset: number;
}

const parseSearchCursor = (cursor: string | undefined): SearchPosition => {
  if (cursor === undefined) return { seqId: undefined, offset: 0 };
  const separator = cursor.indexOf('|');
  const offset = separator < 0 ? Number.NaN : Number(cursor.slice(0, separator));
  if (!Number.isInteger(offset) || offset < 0)
    throw ToolError.validation(
      `Invalid cursor "${cursor}" — pass back next_cursor verbatim, or omit it for the first page.`,
      'VALIDATION_ERROR',
    );
  const seqId = cursor.slice(separator + 1);
  return { seqId: seqId.length > 0 ? seqId : undefined, offset };
};

const formatSearchCursor = (position: SearchPosition): string => `${position.offset}|${position.seqId ?? ''}`;

/**
 * Walks `/index/query` under the SPEC §1 contract.
 *
 * Each batch is sliced down to the remaining `max_items` budget before anything
 * is collected, so the ceiling cannot be exceeded, and the cursor resumes at the
 * exact hit that was not taken. `truncated` is set only when that ceiling — and
 * not the batch size — stopped the walk.
 */
export const walkSearchPages = async <TItem>(
  query: string,
  pagination: PaginationRequest,
  mapHit: (hit: SearchHit) => TItem,
): Promise<PagedResult<TItem>> => {
  const target = pagination.fetchAll ? pagination.maxItems : Math.min(pagination.limit, pagination.maxItems);
  const position = parseSearchCursor(pagination.cursor);
  const collected: SearchHit[] = [];
  let pagesFetched = 0;
  let exhausted = false;

  await prepareIndex();

  while (collected.length < target && !exhausted) {
    const budget = target - collected.length;
    const page = await runSearchPage(query, position.seqId);
    pagesFetched += 1;

    if (position.offset >= page.hits.length) {
      // A caller-supplied cursor can land exactly on a batch end; only a null
      // nextSeqId proves there is genuinely nothing beyond it.
      if (page.nextSeqId === null) {
        exhausted = true;
        break;
      }
      position.seqId = page.nextSeqId;
      position.offset = 0;
      continue;
    }

    const slice = page.hits.slice(position.offset, position.offset + budget);
    collected.push(...slice);
    const consumedWholeBatch = position.offset + slice.length >= page.hits.length;

    if (!consumedWholeBatch) {
      position.offset += slice.length;
    } else if (page.nextSeqId === null) {
      exhausted = true;
      position.offset = page.hits.length;
    } else {
      position.seqId = page.nextSeqId;
      position.offset = 0;
    }
  }

  const hasMore = !exhausted;
  return {
    items: collected.map(mapHit),
    next_cursor: hasMore ? formatSearchCursor(position) : null,
    has_more: hasMore,
    // The index streams matches without ever reporting how many exist.
    total: null,
    page_info: {
      returned: collected.length,
      pages_fetched: pagesFetched,
      truncated: hasMore && collected.length >= pagination.maxItems,
    },
  };
};
