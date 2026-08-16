import { toUnixSeconds } from './deepseek-api.js';
import type { ResponseItem } from './tools/normalized-schemas.js';

// --- Raw history_messages shapes ---

export interface RawSearchResult {
  url?: string;
  title?: string;
  snippet?: string;
  site_name?: string | null;
  /** The number that appears inline in the answer as `[citation:N]`. */
  cite_index?: number | null;
}

export interface RawFile {
  id?: string;
  file_name?: string;
  file_size?: number;
  status?: string;
  is_image?: boolean;
}

export interface RawFragment {
  id?: number;
  /**
   * REQUEST (user text), RESPONSE (answer), THINK (reasoning), SEARCH and
   * TOOL_SEARCH (web lookups), TOOL_OPEN (page fetch), TOOL_FIND (find-in-page),
   * FILE (attachment), TIP (an inline notice the transcript renders).
   */
  type?: string;
  status?: string;
  content?: string | null;
  queries?: { query?: string }[];
  results?: RawSearchResult[];
  result?: RawSearchResult | null;
  pattern?: string;
  reference?: { id?: number; type?: string } | null;
  files?: RawFile[];
  style?: string;
  elapsed_secs?: number;
}

export interface RawChatMessage {
  message_id?: number;
  parent_id?: number | null;
  role?: string;
  status?: string;
  inserted_at?: number;
  thinking_enabled?: boolean;
  search_enabled?: boolean;
  has_pending_fragment?: boolean;
  fragments?: RawFragment[];
}

export interface RawChatSession {
  id?: string;
  title?: string | null;
  model_type?: string;
  pinned?: boolean;
  updated_at?: number;
  inserted_at?: number;
  current_message_id?: number;
}

export interface OmittedCounts {
  reasoning: number;
  tool_calls: number;
  hidden: number;
  empty: number;
}

export interface MappedItems {
  items: ResponseItem[];
  omitted: OmittedCounts;
}

/** DeepSeek's citation markers are `[citation:N]`, where N is a result's cite_index. */
const CITATION_MARKER = /\[citation:(\d+)]/g;

const WEB_SEARCH_FRAGMENTS = new Set(['SEARCH', 'TOOL_SEARCH']);

/**
 * DeepSeek returns the whole message TREE, including branches abandoned by an
 * edit or a regenerate, and marks the live leaf as `chat_session.current_message_id`.
 * Walking parent_id back from that leaf yields exactly the thread the page renders;
 * pairing messages by array order instead would interleave dead branches and
 * manufacture turns that were never shown (SPEC §3).
 */
export const activeThread = (messages: RawChatMessage[], currentMessageId: number | undefined): RawChatMessage[] => {
  if (messages.length === 0) return [];
  const byId = new Map<number, RawChatMessage>();
  for (const message of messages) if (typeof message.message_id === 'number') byId.set(message.message_id, message);

  const leafId =
    currentMessageId !== undefined && byId.has(currentMessageId)
      ? currentMessageId
      : // No usable leaf (a chat still being written) — fall back to the highest id,
        // which is the newest message DeepSeek has recorded.
        Math.max(...[...byId.keys()]);

  const chain: RawChatMessage[] = [];
  const visited = new Set<number>();
  let cursor = byId.get(leafId);
  while (cursor && typeof cursor.message_id === 'number' && !visited.has(cursor.message_id)) {
    visited.add(cursor.message_id);
    chain.unshift(cursor);
    cursor = cursor.parent_id === null || cursor.parent_id === undefined ? undefined : byId.get(cursor.parent_id);
  }
  return chain;
};

const itemStatus = (status: string | undefined = 'FINISHED'): 'completed' | 'in_progress' | 'incomplete' => {
  if (status === 'FINISHED') return 'completed';
  if (status === 'FAILED') return 'incomplete';
  // WIP / PENDING: DeepSeek is still writing this fragment.
  return 'in_progress';
};

const messageStatus = (message: RawChatMessage): 'completed' | 'in_progress' | 'incomplete' => {
  if (message.has_pending_fragment === true) return 'in_progress';
  if (message.status === 'FINISHED') return 'completed';
  if (message.status === 'FAILED') return 'incomplete';
  return 'in_progress';
};

const toSearchResults = (results: RawSearchResult[] | undefined) =>
  (results ?? [])
    .filter(result => typeof result.url === 'string' && result.url.length > 0)
    .map(result => ({
      title: result.title ?? '',
      url: result.url ?? '',
      snippet: result.snippet || null,
      site_name: result.site_name || null,
    }));

/** DeepSeek batches several queries into one search fragment; all of them are kept. */
const joinQueries = (queries: { query?: string }[] | undefined): string | null => {
  const all = (queries ?? []).map(entry => entry.query ?? '').filter(query => query.length > 0);
  return all.length > 0 ? all.join(' | ') : null;
};

const describeFiles = (files: RawFile[] | undefined): string =>
  (files ?? [])
    .map(file => {
      const size = typeof file.file_size === 'number' ? `, ${file.file_size} bytes` : '';
      const kind = file.is_image ? 'image' : 'file';
      return `[${kind} "${file.file_name ?? '(unnamed)'}"${size}]`;
    })
    .join('\n');

export interface SourceRef {
  url: string;
  title: string;
}

/**
 * Maps every `cite_index` a conversation published to its source.
 *
 * DeepSeek numbers citations per MESSAGE, so a marker is resolved against the
 * sources of its own message first; the conversation-wide map is only a fallback
 * for a message whose search fragment was pruned.
 */
export const collectSourceRefs = (fragments: RawFragment[]): Map<number, SourceRef> => {
  const refs = new Map<number, SourceRef>();
  for (const fragment of fragments) {
    const results = [...(fragment.results ?? []), ...(fragment.result ? [fragment.result] : [])];
    for (const result of results) {
      if (typeof result.cite_index !== 'number' || !result.url) continue;
      if (!refs.has(result.cite_index)) refs.set(result.cite_index, { url: result.url, title: result.title ?? '' });
    }
  }
  return refs;
};

interface Annotation {
  type: 'url_citation';
  url: string;
  title: string;
  start_index: number | null;
  end_index: number | null;
}

/**
 * Resolves every `[citation:N]` marker in the assembled text against the sources
 * the conversation recorded, so annotations carry REAL offsets into the
 * output_text.
 *
 * A marker whose index was never published gets no annotation rather than a
 * guessed one — the marker itself stays in the text, so nothing is hidden.
 */
const annotateCitations = (text: string, refs: Map<number, SourceRef>): Annotation[] => {
  const annotations: Annotation[] = [];
  for (const match of text.matchAll(CITATION_MARKER)) {
    const source = refs.get(Number(match[1]));
    if (!source || match.index === undefined) continue;
    annotations.push({
      type: 'url_citation',
      url: source.url,
      title: source.title,
      start_index: match.index,
      end_index: match.index + match[0].length,
    });
  }
  return annotations;
};

export interface MapOptions {
  includeReasoning: boolean;
  includeToolCalls: boolean;
  /** The conversation's model_type, surfaced on assistant messages. */
  model: string | null;
}

/**
 * Flattens DeepSeek's fragments into SPEC §3 Responses items.
 *
 * One `message` item per DeepSeek message keeps the item count equal to the turn
 * count the page renders; the reasoning and tool items belonging to that message
 * are emitted immediately before it, in fragment order. EVERY REQUEST/RESPONSE
 * fragment is concatenated into that one message, never just the first.
 *
 * `messages` must be the active thread in chronological order.
 */
export const mapMessagesToItems = (messages: RawChatMessage[], options: MapOptions): MappedItems => {
  const items: ResponseItem[] = [];
  const omitted: OmittedCounts = { reasoning: 0, tool_calls: 0, hidden: 0, empty: 0 };
  const conversationRefs = collectSourceRefs(messages.flatMap(message => message.fragments ?? []));

  for (const message of messages) {
    const fragments = message.fragments ?? [];
    const messageId = String(message.message_id ?? '');
    const role = message.role === 'ASSISTANT' ? 'assistant' : message.role === 'USER' ? 'user' : 'system';
    const textParts: string[] = [];
    const messageRefs = collectSourceRefs(fragments);
    let pendingToolCall = false;
    let fragmentIndex = -1;

    for (const fragment of fragments) {
      fragmentIndex += 1;
      // Fragment ids restart at 1 in every message, so they are namespaced with
      // the message id. The positional index is the fallback for a fragment that
      // carries no id at all, and must NOT be derived from a counter that only
      // some branches advance — that would let two fragments share an id.
      const fragmentId = `${messageId}#${fragment.id ?? `i${fragmentIndex}`}`;

      if (fragment.type === 'REQUEST' || fragment.type === 'RESPONSE') {
        if (fragment.content) textParts.push(fragment.content);
        else omitted.empty += 1;
        continue;
      }

      if (fragment.type === 'FILE') {
        const described = describeFiles(fragment.files);
        if (described) textParts.push(described);
        else omitted.empty += 1;
        continue;
      }

      if (fragment.type === 'TIP') {
        // An inline notice the transcript itself renders (e.g. "Search is
        // unavailable in Expert Mode"). Kept as a labelled placeholder rather
        // than dropped, so nothing the user saw disappears.
        if (fragment.content)
          textParts.push(`[tip${fragment.style ? ` ${fragment.style.toLowerCase()}` : ''}: ${fragment.content}]`);
        else omitted.empty += 1;
        continue;
      }

      if (fragment.type === 'THINK') {
        if (!fragment.content) {
          omitted.empty += 1;
          continue;
        }
        if (!options.includeReasoning) {
          omitted.reasoning += 1;
          continue;
        }
        items.push({
          // DeepSeek gives reasoning no id of its own — fragment ids restart at 1
          // in every message — so it is namespaced with the message id
          // (SPEC §0 allows synthesizing where the provider has none).
          id: `rs_${fragmentId}`,
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: fragment.content }],
          // DeepThink is on/off; DeepSeek publishes no native effort id.
          effort: null,
        });
        continue;
      }

      if (WEB_SEARCH_FRAGMENTS.has(fragment.type ?? '')) {
        const status = itemStatus(fragment.status);
        if (status === 'in_progress') pendingToolCall = true;
        if (!options.includeToolCalls) {
          omitted.tool_calls += 1;
          continue;
        }
        items.push({
          id: `ws_${fragmentId}`,
          type: 'web_search_call',
          status,
          action: { type: 'search', query: joinQueries(fragment.queries), url: null },
          results: toSearchResults(fragment.results),
        });
        continue;
      }

      if (fragment.type === 'TOOL_OPEN') {
        const status = itemStatus(fragment.status);
        if (status === 'in_progress') pendingToolCall = true;
        if (!options.includeToolCalls) {
          omitted.tool_calls += 1;
          continue;
        }
        items.push({
          id: `ws_${fragmentId}`,
          type: 'web_search_call',
          status,
          // A page fetch, not a query — SPEC §3 puts the provider's action kind in
          // `type`, leaves `query` null and carries the target in `url`.
          action: { type: 'open_page', query: null, url: fragment.result?.url ?? null },
          results: toSearchResults(fragment.result ? [fragment.result] : []),
        });
        continue;
      }

      if (fragment.type === 'TOOL_FIND') {
        const status = itemStatus(fragment.status);
        if (status === 'in_progress') pendingToolCall = true;
        if (!options.includeToolCalls) {
          omitted.tool_calls += 1;
          continue;
        }
        items.push({
          id: `tc_${fragmentId}`,
          type: 'tool_call',
          name: 'find_in_page',
          status,
          arguments: {
            pattern: fragment.pattern ?? '',
            reference_fragment_id: fragment.reference?.id ?? null,
            reference_type: fragment.reference?.type ?? null,
          },
          // DeepSeek records no result body for a find — only whether it ran.
          output: null,
        });
        continue;
      }

      // An unrecognised fragment type is never dropped silently.
      omitted.hidden += 1;
    }

    const combined = textParts.join('\n\n');
    if (!combined) {
      if (fragments.length === 0) omitted.empty += 1;
      continue;
    }

    const refs = messageRefs.size > 0 ? messageRefs : conversationRefs;
    items.push({
      id: messageId,
      type: 'message',
      role,
      status: pendingToolCall ? 'in_progress' : messageStatus(message),
      created_at: toUnixSeconds(message.inserted_at),
      model: role === 'assistant' ? options.model : null,
      content:
        role === 'user'
          ? [{ type: 'input_text', text: combined }]
          : [{ type: 'output_text', text: combined, annotations: annotateCitations(combined, refs) }],
    });
  }

  return { items, omitted };
};
