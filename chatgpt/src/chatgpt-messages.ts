import { toUnixSeconds } from './chatgpt-api.js';
import type { ResponseItem } from './tools/normalized-schemas.js';

// --- Raw chatgpt.com conversation shapes ---

export interface RawSearchResultEntry {
  url?: string;
  title?: string;
  snippet?: string;
  attribution?: string;
}

export interface RawSearchResultGroup {
  domain?: string;
  entries?: RawSearchResultEntry[];
}

export interface RawContentReferenceItem {
  title?: string;
  url?: string;
  snippet?: string;
  attribution?: string;
}

export interface RawContentReference {
  type?: string;
  matched_text?: string;
  start_idx?: number;
  end_idx?: number;
  items?: RawContentReferenceItem[];
  url?: string;
  title?: string;
  alt?: string;
}

export interface RawMessagePart {
  content_type?: string;
  asset_pointer?: string;
  width?: number;
  height?: number;
  text?: string;
  transcription?: string;
  [key: string]: unknown;
}

export interface RawMessageContent {
  content_type?: string;
  /** text / multimodal_text */
  parts?: (string | RawMessagePart)[];
  /** code / execution_output */
  text?: string;
  /** thoughts */
  thoughts?: { summary?: string; content?: string }[];
  /** reasoning_recap */
  content?: string;
  /** tether_browsing_display */
  result?: string;
  summary?: string;
  /** tether_quote */
  title?: string;
  url?: string;
  language?: string;
}

export interface RawMessage {
  id?: string;
  author?: { role?: string; name?: string | null };
  content?: RawMessageContent;
  recipient?: string;
  channel?: string | null;
  status?: string;
  end_turn?: boolean | null;
  weight?: number;
  create_time?: number | string | null;
  metadata?: {
    model_slug?: string;
    default_model_slug?: string;
    is_visually_hidden_from_conversation?: boolean;
    search_result_groups?: RawSearchResultGroup[];
    search_queries?: { q?: string; type?: string }[];
    content_references?: RawContentReference[];
    reasoning_status?: string;
    finished_text?: string;
    is_complete?: boolean;
    command?: string;
  };
}

export interface RawNode {
  id?: string;
  message?: RawMessage | null;
  parent?: string | null;
  children?: string[];
}

export interface RawConversationDetail {
  conversation_id?: string;
  title?: string;
  create_time?: number | string;
  update_time?: number | string;
  is_archived?: boolean;
  is_starred?: boolean | null;
  gizmo_id?: string | null;
  default_model_slug?: string | null;
  async_status?: number | null;
  mapping?: Record<string, RawNode>;
  current_node?: string;
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

export interface MapOptions {
  includeReasoning: boolean;
  includeToolCalls: boolean;
  /** Conversation-level default, used when a message carries no model_slug. */
  model: string | null;
}

const TOOL_OUTPUT_LIMIT = 8000;
const REASONING_CONTENT_TYPES = new Set(['thoughts', 'reasoning_recap']);
/** Recipients whose invocation is a web search rather than a generic tool call. */
const WEB_SEARCH_RECIPIENTS = new Set(['web', 'web.run', 'browser', 'search']);

export interface UrlCitation {
  type: 'url_citation';
  url: string;
  title: string;
  start_index: number | null;
  end_index: number | null;
}

/**
 * Rebuilds the active branch: walk `parent` links from current_node back to the
 * root. Edited turns leave dead siblings in `mapping`, so iterating the map
 * would replay abandoned branches as extra turns.
 */
export const activeBranchNodes = (mapping: Record<string, RawNode>, currentNode: string | undefined): RawNode[] => {
  const parentOf = new Map<string, string>();
  for (const [nodeId, node] of Object.entries(mapping)) {
    if (node.parent) parentOf.set(nodeId, node.parent);
    for (const childId of node.children ?? []) if (!parentOf.has(childId)) parentOf.set(childId, nodeId);
  }
  const ordered: RawNode[] = [];
  const seen = new Set<string>();
  let current = currentNode ?? Object.keys(mapping).find(id => (mapping[id]?.children ?? []).length === 0);
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = mapping[current];
    if (node) ordered.unshift(node);
    current = parentOf.get(current);
  }
  return ordered;
};

/** Renders one content part. Non-text parts become a labelled placeholder, never "". */
const renderPart = (part: string | RawMessagePart): string => {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  const contentType = typeof part.content_type === 'string' ? part.content_type : '';
  if (contentType === 'image_asset_pointer') {
    const width = typeof part.width === 'number' ? part.width : '?';
    const height = typeof part.height === 'number' ? part.height : '?';
    const pointer = typeof part.asset_pointer === 'string' ? ` ${part.asset_pointer}` : '';
    return `[image ${width}x${height}${pointer}]`;
  }
  if (contentType === 'audio_transcription' && typeof part.transcription === 'string') return part.transcription;
  if (typeof part.text === 'string' && part.text) return part.text;
  if (typeof part.transcription === 'string' && part.transcription) return part.transcription;
  return contentType ? `[${contentType}]` : '';
};

/** Joins every part of a message. Reading only parts[0] dropped 673 of 946 messages. */
export const renderParts = (parts: (string | RawMessagePart)[] | undefined): string =>
  (parts ?? [])
    .map(renderPart)
    .filter(text => text.length > 0)
    .join('\n');

const renderSearchResultGroups = (groups: RawSearchResultGroup[] | undefined): string => {
  const lines = (groups ?? []).flatMap(group =>
    (group.entries ?? []).map(entry => `- ${entry.title ?? ''}${entry.url ? ` (${entry.url})` : ''}`),
  );
  return lines.length > 0 ? `[search results]\n${lines.join('\n')}` : '';
};

/**
 * Extracts a message's readable text across every content type the backend
 * emits. Only `text` and `multimodal_text` carry `parts`; `code`,
 * `execution_output`, `thoughts`, `reasoning_recap`, `tether_browsing_display`
 * and `tether_quote` each store their payload under a different key, and an
 * otherwise-empty tool message hides its payload in metadata.search_result_groups.
 */
export const extractMessageText = (message: RawMessage): string => {
  const content = message.content;
  if (!content) return '';

  const fromParts = renderParts(content.parts);
  if (fromParts) return fromParts;
  if (typeof content.text === 'string' && content.text) return content.text;
  if (Array.isArray(content.thoughts) && content.thoughts.length > 0) {
    const rendered = content.thoughts
      .map(thought => [thought.summary, thought.content].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n');
    if (rendered) return rendered;
  }
  if (typeof content.content === 'string' && content.content) return content.content;
  if (typeof content.result === 'string' && content.result) return content.result;
  if (typeof content.summary === 'string' && content.summary) return content.summary;
  if (typeof content.url === 'string' && content.url) return `${content.title ?? content.url} (${content.url})`;
  return renderSearchResultGroups(message.metadata?.search_result_groups);
};

/**
 * ChatGPT marks citations inline with private-use control runs
 * (U+E200 "cite" U+E202 turn0search0 U+E201) and reports each run's byte range
 * in metadata.content_references. The runs are UI control sequences, not
 * content, so they are stripped and each reference is anchored to the position
 * in the cleaned text where its run stood.
 */
export const stripCitationMarkers = (
  text: string,
  references: RawContentReference[] | undefined,
): { text: string; citations: UrlCitation[] } => {
  const spans = (references ?? [])
    .filter(
      reference =>
        typeof reference.start_idx === 'number' &&
        typeof reference.end_idx === 'number' &&
        reference.end_idx > reference.start_idx &&
        reference.end_idx <= text.length,
    )
    .sort((left, right) => (left.start_idx ?? 0) - (right.start_idx ?? 0));

  let cleaned = '';
  let cursor = 0;
  const citations: UrlCitation[] = [];

  for (const span of spans) {
    const start = span.start_idx as number;
    const end = span.end_idx as number;
    if (start < cursor) continue;
    cleaned += text.slice(cursor, start);
    const anchor = cleaned.length;
    cursor = end;
    const sources = span.items?.length ? span.items : span.url ? [{ url: span.url, title: span.title }] : [];
    for (const source of sources) {
      if (!source.url) continue;
      citations.push({
        type: 'url_citation',
        url: source.url,
        title: source.title ?? '',
        start_index: anchor,
        end_index: anchor,
      });
    }
  }
  cleaned += text.slice(cursor);
  // Any marker whose reference the backend did not report would otherwise leak
  // U+E200-U+E206 into output_text.
  cleaned = cleaned.replace(/[\uE200-\uE206][^\uE200-\uE206]*[\uE201\uE203]/g, '').replace(/[\uE200-\uE206]/g, '');
  return { text: cleaned, citations };
};

const truncate = (text: string): string =>
  text.length <= TOOL_OUTPUT_LIMIT
    ? text
    : `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n… [truncated ${text.length - TOOL_OUTPUT_LIMIT} characters]`;

const toSearchResults = (message: RawMessage | undefined) =>
  (message?.metadata?.search_result_groups ?? []).flatMap(group =>
    (group.entries ?? [])
      .filter(entry => entry.url)
      .map(entry => ({
        title: entry.title ?? '',
        url: entry.url as string,
        snippet: entry.snippet ?? null,
        site_name: entry.attribution ?? group.domain ?? null,
      })),
  );

const parseToolArguments = (message: RawMessage): Record<string, unknown> => {
  const raw = message.content?.text ?? extractMessageText(message);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { input: parsed };
  } catch {
    return { input: raw };
  }
};

const QUERY_KEYS = new Set(['q', 'query', 'search_query', 'prompt']);

/**
 * web.run nests the query differently per action — `{"search_query":[{"q":"…"}]}`,
 * `{"image_query":[{"q":"…"}]}`, or a bare `search("…")` call — so the first
 * query-ish string anywhere in the recorded arguments is used.
 */
const findQuery = (value: unknown, depth = 0): string | null => {
  if (depth > 4 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findQuery(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (QUERY_KEYS.has(key) && typeof entry === 'string' && entry) return entry;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const found = findQuery(entry, depth + 1);
    if (found) return found;
  }
  return null;
};

const ACTION_KEYS: Record<string, string> = {
  search_query: 'search',
  image_query: 'image_search',
  open: 'open_page',
  find: 'find_in_page',
  click: 'open_page',
  fetch: 'fetch',
  screenshot: 'screenshot',
};

const findUrl = (value: unknown, depth = 0): string | null => {
  if (depth > 4 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findUrl(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'url' || key === 'ref_id' || key === 'id') && typeof entry === 'string' && /^https?:\/\//.test(entry))
      return entry;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const found = findUrl(entry, depth + 1);
    if (found) return found;
  }
  return null;
};

/**
 * web.run bundles several action kinds under one recipient — `search_query`,
 * `image_query`, `open`, `find`, … — so the normalized action reports which one
 * was recorded instead of labelling every call a plain search with a null query.
 */
const webActionOf = (message: RawMessage): { type: string; url: string | null } => {
  const args = parseToolArguments(message);
  for (const [key, kind] of Object.entries(ACTION_KEYS))
    if (key in args) return { type: kind, url: findUrl(args[key]) };
  const raw = message.content?.text ?? '';
  const called = /(?:^|\W)(search|open_url|open|find|click|screenshot)\s*\(/.exec(raw);
  if (called?.[1]) return { type: ACTION_KEYS[called[1]] ?? called[1], url: findUrl(args) };
  return { type: 'search', url: findUrl(args) };
};

const searchQueryOf = (message: RawMessage): string | null => {
  const queries = message.metadata?.search_queries;
  if (queries?.length && typeof queries[0]?.q === 'string') return queries[0].q as string;
  const fromArguments = findQuery(parseToolArguments(message));
  if (fromArguments) return fromArguments;
  const raw = message.content?.text;
  if (typeof raw === 'string') {
    const match = /(?:search|open_url|find)\(\s*["'`]([\s\S]*?)["'`]/.exec(raw);
    if (match?.[1]) return match[1];
  }
  return null;
};

const statusOf = (message: RawMessage | undefined, hasResult: boolean): 'completed' | 'in_progress' | 'incomplete' => {
  if (!hasResult) return 'in_progress';
  if (message?.status === 'finished_successfully') return 'completed';
  if (message?.status === 'in_progress') return 'in_progress';
  return message?.status ? 'incomplete' : 'completed';
};

interface PendingMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  createdAt: number;
  model: string | null;
  texts: string[];
  citations: UrlCitation[];
  status: 'completed' | 'in_progress' | 'incomplete';
}

/**
 * Flattens the active branch into SPEC §3 Responses items.
 *
 * ChatGPT splits a single rendered assistant bubble across several nodes
 * (`channel: "commentary"` preamble then `channel: "final"` answer), so
 * consecutive assistant text nodes are merged into ONE message item joined with
 * a blank line — that keeps the item count equal to the turn count the page
 * renders, and citation offsets are re-based onto the joined text.
 */
export const mapConversationToItems = (detail: RawConversationDetail, options: MapOptions): MappedItems => {
  const items: ResponseItem[] = [];
  const omitted: OmittedCounts = { reasoning: 0, tool_calls: 0, hidden: 0, empty: 0 };
  const nodes = activeBranchNodes(detail.mapping ?? {}, detail.current_node);
  const messages = nodes.map(node => node.message).filter((message): message is RawMessage => !!message);

  let pending: PendingMessage | null = null;
  const flush = (): void => {
    if (!pending) return;
    const text = pending.texts.join('\n\n');
    if (!text) {
      omitted.empty += 1;
      pending = null;
      return;
    }
    items.push({
      id: pending.id,
      type: 'message',
      role: pending.role,
      status: pending.status,
      created_at: pending.createdAt,
      model: pending.role === 'assistant' ? pending.model : null,
      content:
        pending.role === 'user'
          ? [{ type: 'input_text', text }]
          : [{ type: 'output_text', text, annotations: pending.citations }],
    });
    pending = null;
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as RawMessage;
    const role = message.author?.role ?? '';
    const recipient = message.recipient ?? 'all';
    const contentType = message.content?.content_type ?? '';

    if (message.metadata?.is_visually_hidden_from_conversation === true) {
      flush();
      omitted.hidden += 1;
      continue;
    }

    if (role === 'assistant' && REASONING_CONTENT_TYPES.has(contentType)) {
      flush();
      const summary = extractMessageText(message);
      if (!summary) {
        omitted.empty += 1;
        continue;
      }
      if (!options.includeReasoning) {
        omitted.reasoning += 1;
        continue;
      }
      items.push({
        id: message.id ?? '',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: summary }],
        // ChatGPT records no per-message effort on stored conversations; the
        // request-side ladder is thinking_level (see list_models).
        effort: null,
      });
      continue;
    }

    // A message is "for the user" when its recipient is `all`; anything else is
    // the model invoking a tool, and the matching `role: "tool"` message that
    // follows carries that call's result.
    if (role === 'assistant' && recipient !== 'all') {
      flush();
      const result = messages
        .slice(index + 1)
        .find(candidate => candidate.author?.role === 'tool' && (candidate.author?.name ?? '') === recipient);
      if (!options.includeToolCalls) {
        omitted.tool_calls += 1;
        continue;
      }
      const status = statusOf(result, result !== undefined);
      if (WEB_SEARCH_RECIPIENTS.has(recipient)) {
        const action = webActionOf(message);
        items.push({
          id: message.id ?? '',
          type: 'web_search_call',
          status,
          // SPEC §3: query is null for non-search actions, url is null for plain
          // searches.
          action: {
            type: action.type,
            query: action.type.endsWith('search') ? searchQueryOf(message) : null,
            url: action.url,
          },
          results: toSearchResults(result),
        });
      } else {
        const output = result ? extractMessageText(result) : '';
        items.push({
          id: message.id ?? '',
          type: 'tool_call',
          name: recipient,
          status,
          arguments: parseToolArguments(message),
          output: output ? truncate(output) : null,
        });
      }
      continue;
    }

    if (role === 'tool') {
      // Normally already folded into the preceding tool_call/web_search_call
      // item, so counting it again would double-count what was filtered. Only an
      // ORPHAN result — one whose invoking message is not on this branch — is
      // genuinely being dropped.
      flush();
      const toolName = message.author?.name ?? '';
      const invoked = messages
        .slice(0, index)
        .some(candidate => candidate.author?.role === 'assistant' && (candidate.recipient ?? 'all') === toolName);
      if (!invoked) omitted.tool_calls += 1;
      continue;
    }

    const normalizedRole: 'user' | 'assistant' | 'system' =
      role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system';
    const rawText = extractMessageText(message);
    const { text, citations } = stripCitationMarkers(rawText, message.metadata?.content_references);
    if (!text) {
      // A zero-weight system placeholder carries nothing renderable at all.
      flush();
      omitted.empty += 1;
      continue;
    }

    const model = message.metadata?.model_slug ?? options.model;
    if (pending && pending.role === normalizedRole) {
      pending.texts.push(text);
      const offset = pending.texts.slice(0, -1).join('\n\n').length + (pending.texts.length > 1 ? 2 : 0);
      for (const citation of citations)
        pending.citations.push({
          ...citation,
          start_index: citation.start_index === null ? null : citation.start_index + offset,
          end_index: citation.end_index === null ? null : citation.end_index + offset,
        });
      pending.status = statusOf(message, true);
      continue;
    }

    flush();
    pending = {
      id: message.id ?? '',
      role: normalizedRole,
      createdAt: toUnixSeconds(message.create_time),
      model,
      texts: [text],
      citations,
      status: statusOf(message, true),
    };
  }
  flush();

  return { items, omitted };
};
