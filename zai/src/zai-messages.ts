import { api } from './zai-api.js';
import type { RawChatDetail, RawHistoryMessage } from './zai-conversations.js';
import type { ResponseItem } from './tools/normalized-schemas.js';

// --- Raw message shapes ---
//
// `GET /api/v1/chats/<id>` returns the history *tree* but every assistant message
// in it is a stub: `{id, parentId, childrenIds, role, timestamp}` with no content
// at all. The text, reasoning and tool calls live behind
// `POST /api/v1/chats/<id>/messages/batch` — reading only the chat object is the
// exact "HTTP 200, empty answer" trap this repo keeps shipping.

export interface RawToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface RawBrowserResult {
  title?: string;
  url?: string;
  text?: string;
  site_name?: string;
  media?: unknown;
}

export interface RawToolResult {
  tool_call_id?: string;
  content?: string;
  status?: string;
  is_error?: boolean;
  browser?: { search_result?: RawBrowserResult[] };
}

export interface RawContentBlock {
  type?: string;
  /** string for `text`/`reasoning`; an array of calls for `tool_calls`. */
  content?: string | RawToolCall[];
  started_at?: number | string;
  ended_at?: number | string;
  results?: RawToolResult[];
}

export interface RawFullMessage {
  id?: string;
  chat_id?: string;
  parent_id?: string | null;
  parentId?: string | null;
  childrenIds?: string[];
  role?: string;
  content?: string | null;
  content_blocks?: RawContentBlock[];
  files?: { name?: string; type?: string; size?: number }[];
  usage?: Record<string, unknown>;
  status?: string | null;
  model?: string | null;
  model_name?: string | null;
  done?: boolean;
  error?: unknown;
  timestamp?: number;
}

interface BatchResponse {
  chat_id?: string;
  data?: Record<string, RawFullMessage>;
}

const BATCH_SIZE = 100;
const TOOL_OUTPUT_LIMIT = 8000;

/**
 * z.ai's browsing tool names, observed live across the account's chats: `search`,
 * `open`, `visit_page`, `find` and `click`. Anything whose result carries a
 * `browser` payload is treated as browsing too, so a rename upstream degrades to a
 * generic tool_call at worst instead of losing the search results.
 */
const BROWSER_TOOL_NAMES = new Set(['search', 'open', 'open_page', 'visit_page', 'find', 'click', 'mclick', 'fetch']);

const isBrowsingCall = (name: string, result: RawToolResult | undefined): boolean =>
  BROWSER_TOOL_NAMES.has(name) || result?.browser !== undefined;

export const fetchMessages = async (
  conversationId: string,
  messageIds: string[],
): Promise<Map<string, RawFullMessage>> => {
  const byId = new Map<string, RawFullMessage>();
  for (let index = 0; index < messageIds.length; index += BATCH_SIZE) {
    const chunk = messageIds.slice(index, index + BATCH_SIZE);
    const response = await api<BatchResponse>(`/v1/chats/${encodeURIComponent(conversationId)}/messages/batch`, {
      method: 'POST',
      body: { ids: chunk },
    });
    for (const [id, message] of Object.entries(response?.data ?? {})) byId.set(id, message);
  }
  return byId;
};

export interface ActivePath {
  /** History stubs along the branch the web app renders, oldest first. */
  ordered: RawHistoryMessage[];
  /** Messages on abandoned branches (edits, regenerations) the page does not show. */
  offBranch: number;
}

/**
 * Rebuilds the branch the page renders by walking parents up from `currentId`.
 *
 * z.ai keeps every regenerated/edited turn in the same map, so returning the whole
 * map would report turns the user cannot see and break the "turn count matches the
 * rendered page" bar. Off-branch messages are counted, never silently dropped.
 */
export const resolveActivePath = (detail: RawChatDetail): ActivePath => {
  const messages = detail.chat?.history?.messages ?? {};
  const all = Object.values(messages);
  const currentId = detail.chat?.history?.currentId;

  if (!currentId || !messages[currentId]) {
    // No leaf pointer: fall back to timestamp order and claim nothing is hidden.
    const ordered = [...all].sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
    return { ordered, offBranch: 0 };
  }

  const ordered: RawHistoryMessage[] = [];
  const seen = new Set<string>();
  let node: RawHistoryMessage | undefined = messages[currentId];
  while (node?.id && !seen.has(node.id)) {
    seen.add(node.id);
    ordered.unshift(node);
    node = node.parentId ? messages[node.parentId] : undefined;
  }
  return { ordered, offBranch: all.length - ordered.length };
};

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
  /** Conversation-level reasoning effort, surfaced on each reasoning item. */
  effort: string | null;
}

interface UrlCitation {
  type: 'url_citation';
  url: string;
  title: string;
  start_index: number | null;
  end_index: number | null;
}

/**
 * Search results are addressed in the answer text as `【turn0search3】`, and the
 * matching tool output carries `[ref_id=turn0search3†Title†https://…]` headers.
 */
const REF_HEADER_PATTERN = /\[ref_id=([^\]†]+)†([^\]†]*)†([^\]]*)\]/g;
const CITATION_MARKER_PATTERN = /【([^】]+)】/g;

interface RefTarget {
  title: string;
  url: string;
}

const collectRefTargets = (blocks: RawContentBlock[]): Map<string, RefTarget> => {
  const targets = new Map<string, RefTarget>();
  for (const block of blocks) {
    for (const result of block.results ?? []) {
      const text = typeof result.content === 'string' ? result.content : '';
      REF_HEADER_PATTERN.lastIndex = 0;
      let match = REF_HEADER_PATTERN.exec(text);
      while (match) {
        const [, ref, title, url] = match;
        if (ref && url) targets.set(ref.trim(), { title: (title ?? '').trim(), url: url.trim() });
        match = REF_HEADER_PATTERN.exec(text);
      }
    }
  }
  return targets;
};

/** Resolves `【…】` markers in the already-joined text to annotations with real offsets. */
const resolveCitations = (text: string, targets: Map<string, RefTarget>): UrlCitation[] => {
  if (targets.size === 0) return [];
  const annotations: UrlCitation[] = [];
  CITATION_MARKER_PATTERN.lastIndex = 0;
  let match = CITATION_MARKER_PATTERN.exec(text);
  while (match) {
    const target = targets.get((match[1] ?? '').trim());
    if (target)
      annotations.push({
        type: 'url_citation',
        url: target.url,
        title: target.title,
        start_index: match.index,
        end_index: match.index + match[0].length,
      });
    match = CITATION_MARKER_PATTERN.exec(text);
  }
  return annotations;
};

const parseToolArguments = (raw: string | undefined): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw };
  }
};

const renderToolOutput = (result: RawToolResult | undefined): string | null => {
  const text = typeof result?.content === 'string' ? result.content.trim() : '';
  if (!text) return null;
  if (text.length <= TOOL_OUTPUT_LIMIT) return text;
  return `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n… [truncated ${text.length - TOOL_OUTPUT_LIMIT} characters]`;
};

const toSearchResults = (result: RawToolResult | undefined) =>
  (result?.browser?.search_result ?? [])
    .filter(entry => entry.url)
    .map(entry => ({
      title: entry.title ?? '',
      url: entry.url ?? '',
      snippet: entry.text ?? null,
      site_name: entry.site_name ?? null,
    }));

/**
 * z.ai's `search` tool has shipped two argument shapes and both are live on this
 * account: `{search_query:[{q}]}` and `{queries:[string]}`. A call issues several
 * queries at once, so they are joined rather than reduced to the first — dropping
 * the rest would understate what the model actually searched for.
 */
const extractQuery = (args: Record<string, unknown>): string | null => {
  const fromObjects = Array.isArray(args.search_query)
    ? args.search_query
        .map(entry => (entry && typeof entry === 'object' ? (entry as { q?: unknown }).q : undefined))
        .filter((value): value is string => typeof value === 'string')
    : [];
  const fromStrings = Array.isArray(args.queries)
    ? args.queries.filter((value): value is string => typeof value === 'string')
    : [];
  const collected = [...fromObjects, ...fromStrings];
  if (collected.length > 0) return collected.join(' | ');
  if (typeof args.query === 'string') return args.query;
  if (typeof args.q === 'string') return args.q;
  if (typeof args.pattern === 'string') return args.pattern;
  return null;
};

/**
 * Only a real URL belongs in `action.url`. z.ai's `click` tool takes an opaque
 * link ref (e.g. "v2.9.4"), and reporting that as a URL would hand callers a string
 * that looks navigable and is not.
 */
const extractUrl = (args: Record<string, unknown>): string | null => {
  for (const candidate of [args.url, args.href, args.link]) {
    if (typeof candidate === 'string' && /^(https?:\/\/|\/)/.test(candidate)) return candidate;
  }
  return null;
};

const describeFiles = (message: RawFullMessage): string[] =>
  (message.files ?? []).map(file => `[file ${file.name ? `"${file.name}"` : '(unnamed)'}]`);

const toStatus = (message: RawFullMessage): 'completed' | 'in_progress' | 'incomplete' => {
  if (message.error) return 'incomplete';
  if (message.role !== 'assistant') return 'completed';
  return message.done === true ? 'completed' : 'in_progress';
};

/**
 * Flattens z.ai's ordered `content_blocks` into SPEC §3 Responses items.
 *
 * Every `text` block is joined with a blank line — an assistant turn that used
 * tools emits several, and returning only the first would truncate the answer to
 * its opening paragraph. Reasoning and tool items for a message are emitted
 * immediately before it, in block order, so one `message` item per turn keeps the
 * item count equal to what the page renders.
 */
export const mapMessagesToItems = (
  ordered: RawHistoryMessage[],
  full: Map<string, RawFullMessage>,
  offBranch: number,
  options: MapOptions,
): MappedItems => {
  const items: ResponseItem[] = [];
  const omitted: OmittedCounts = { reasoning: 0, tool_calls: 0, hidden: offBranch, empty: 0 };

  for (const stub of ordered) {
    const messageId = stub.id ?? '';
    const message = full.get(messageId) ?? {};
    const role = message.role ?? stub.role ?? 'assistant';
    const normalizedRole = role === 'user' ? 'user' : role === 'system' ? 'system' : 'assistant';
    const blocks = message.content_blocks ?? [];
    const resultsById = new Map<string, RawToolResult>();
    for (const block of blocks) {
      for (const result of block.results ?? []) {
        if (result.tool_call_id) resultsById.set(result.tool_call_id, result);
      }
    }

    let pendingToolCall = false;
    let blockIndex = -1;
    // Held locally so a turn that renders nothing is counted once, as one dropped
    // turn, instead of once per empty block *and* again for the turn.
    let emptyBlocks = 0;
    const textParts: string[] = [];

    for (const block of blocks) {
      blockIndex += 1;

      if (block.type === 'text') {
        if (typeof block.content === 'string' && block.content) textParts.push(block.content);
        else emptyBlocks += 1;
        continue;
      }

      if (block.type === 'reasoning') {
        const thought = typeof block.content === 'string' ? block.content : '';
        if (!thought) {
          emptyBlocks += 1;
          continue;
        }
        if (!options.includeReasoning) {
          omitted.reasoning += 1;
          continue;
        }
        items.push({
          // Reasoning blocks carry no id of their own, so one is synthesized from
          // the message id and the block's position.
          id: `rs_${messageId}#${blockIndex}`,
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: thought }],
          effort: options.effort,
        });
        continue;
      }

      if (block.type === 'tool_calls') {
        const calls = Array.isArray(block.content) ? block.content : [];
        for (const [callIndex, call] of calls.entries()) {
          const result = call.id ? resultsById.get(call.id) : undefined;
          if (!result) pendingToolCall = true;
          if (!options.includeToolCalls) {
            omitted.tool_calls += 1;
            continue;
          }
          const status = result ? (result.is_error === true ? 'incomplete' : 'completed') : 'in_progress';
          const name = call.function?.name ?? 'unknown';
          const args = parseToolArguments(call.function?.arguments);
          // The call index matters: one block can carry several calls, and z.ai does
          // not always stamp an id on each, which would otherwise collide.
          const id = call.id ?? `${messageId}#${blockIndex}#${callIndex}`;
          if (isBrowsingCall(name, result)) {
            items.push({
              id,
              type: 'web_search_call',
              status,
              action: { type: name, query: extractQuery(args), url: extractUrl(args) },
              results: toSearchResults(result),
            });
          } else {
            items.push({ id, type: 'tool_call', name, status, arguments: args, output: renderToolOutput(result) });
          }
        }
        continue;
      }

      // Any block kind z.ai adds later: no renderable content here, but never
      // silently discarded.
      omitted.hidden += 1;
    }

    // Assistant turns keep their text in content_blocks and leave `content` null;
    // user turns are the reverse. Fall back rather than emit an empty turn.
    if (textParts.length === 0 && typeof message.content === 'string' && message.content)
      textParts.push(message.content);
    if (textParts.length === 0 && typeof stub.content === 'string' && stub.content) textParts.push(stub.content);

    const joined = [...textParts, ...describeFiles(message)].filter(Boolean).join('\n\n');
    if (!joined) {
      omitted.empty += 1;
      continue;
    }
    omitted.empty += emptyBlocks;

    const annotations = normalizedRole === 'assistant' ? resolveCitations(joined, collectRefTargets(blocks)) : [];
    const status = toStatus({ ...message, role: normalizedRole });

    items.push({
      id: messageId,
      type: 'message',
      role: normalizedRole,
      status: pendingToolCall && normalizedRole === 'assistant' ? 'in_progress' : status,
      created_at: message.timestamp ?? stub.timestamp ?? 0,
      model: normalizedRole === 'assistant' ? (message.model ?? message.model_name ?? null) : null,
      content:
        normalizedRole === 'user'
          ? [{ type: 'input_text', text: joined }]
          : [{ type: 'output_text', text: joined, annotations }],
    });
  }

  return { items, omitted };
};

/** Reads a conversation and maps it in one step; shared by get/create/send/research. */
export const loadConversationItems = async (
  detail: RawChatDetail,
  options: MapOptions,
): Promise<MappedItems & { detail: RawChatDetail }> => {
  const { ordered, offBranch } = resolveActivePath(detail);
  const ids = ordered.map(message => message.id ?? '').filter(Boolean);
  const full = ids.length > 0 ? await fetchMessages(detail.id ?? '', ids) : new Map<string, RawFullMessage>();
  return { ...mapMessagesToItems(ordered, full, offBranch, options), detail };
};
