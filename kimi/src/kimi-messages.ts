import { toUnixSeconds } from './kimi-api.js';
import type { ResponseItem } from './tools/normalized-schemas.js';

// --- Raw ListMessages shapes ---

export interface RawSearchResult {
  id?: string;
  refIndex?: string;
  base?: {
    title?: string;
    url?: string;
    siteName?: string;
    snippet?: string;
    publishTime?: string;
  };
}

export interface RawToolContent {
  text?: string;
  searchResult?: RawSearchResult;
}

export interface RawFileMeta {
  name?: string;
  ext?: string;
  sizeBytes?: string;
  type?: string;
}

export interface RawBlock {
  id?: string;
  messageId?: string;
  createTime?: string;
  text?: { content?: string };
  think?: { content?: string };
  tool?: { toolCallId?: string; name?: string; args?: string; contents?: RawToolContent[] };
  agentMessage?: { agentId?: string; agentName?: string; content?: string };
  file?: { id?: string; meta?: RawFileMeta };
  stage?: { name?: string; status?: string };
  multiStage?: { stages?: { name?: string; status?: string }[] };
}

export interface RawMessage {
  id?: string;
  parentId?: string;
  role?: string;
  status?: string;
  scenario?: string;
  createTime?: string;
  kimiPlus?: { id?: string; name?: string };
  blocks?: RawBlock[];
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

const TOOL_OUTPUT_LIMIT = 8000;

/** Kimi's citation markers are `[^N^]`, where N is a search result's refIndex. */
const CITATION_MARKER = /\[\^(\d+)\^\]/g;

export const isWebSearchTool = (name: string): boolean => name === 'web_search';

/** Kimi's clarification tool: Deep Research declares TOOL_TYPE_ASK_USER and calls it to ask a follow-up. */
export const ASK_USER_TOOL = 'ask_user';

const messageStatus = (message: RawMessage): 'completed' | 'in_progress' | 'incomplete' => {
  if (message.status === 'MESSAGE_STATUS_GENERATING') return 'in_progress';
  if (message.status === 'MESSAGE_STATUS_COMPLETED') return 'completed';
  // MESSAGE_STATUS_UNSPECIFIED is what the chat's synthetic root message carries.
  return 'incomplete';
};

const parseToolArguments = (args: string | undefined): Record<string, unknown> => {
  if (!args) return {};
  try {
    const parsed = JSON.parse(args) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    // Kimi records tool args as a JSON string; anything else is passed through
    // verbatim rather than dropped.
    return { raw: args };
  }
};

/** Renders a tool's `contents` as text, marking any truncation instead of hiding it. */
const renderToolOutput = (contents: RawToolContent[] | undefined): string | null => {
  if (!contents || contents.length === 0) return null;
  const rendered = contents
    .map(part => {
      if (typeof part.text === 'string') return part.text;
      const base = part.searchResult?.base;
      if (base) return `${base.title ?? 'Untitled'} — ${base.url ?? ''}`.trim();
      return JSON.stringify(part);
    })
    .join('\n')
    .trim();
  if (!rendered) return null;
  if (rendered.length <= TOOL_OUTPUT_LIMIT) return rendered;
  return `${rendered.slice(0, TOOL_OUTPUT_LIMIT)}\n… [truncated ${rendered.length - TOOL_OUTPUT_LIMIT} characters]`;
};

const toSearchResults = (contents: RawToolContent[] | undefined) =>
  (contents ?? [])
    .map(part => part.searchResult)
    .filter((result): result is RawSearchResult => Boolean(result?.base?.url))
    .map(result => ({
      title: result.base?.title ?? '',
      url: result.base?.url ?? '',
      snippet: result.base?.snippet ?? null,
      site_name: result.base?.siteName ?? null,
    }));

/** The first query of a web_search call; Kimi batches several per call. */
const firstQuery = (args: Record<string, unknown>): string | null => {
  const queries = args.queries;
  if (Array.isArray(queries)) {
    const all = queries.filter((entry): entry is string => typeof entry === 'string');
    if (all.length > 0) return all.join(' | ');
  }
  return typeof args.query === 'string' ? args.query : null;
};

export interface SourceRef {
  url: string;
  title: string;
}

/**
 * Maps every `refIndex` the conversation's search results published to its
 * source. Kimi numbers citations per conversation, not per message, so the map
 * has to be built across all messages before any text is rendered.
 */
export const collectSourceRefs = (messages: RawMessage[]): Map<string, SourceRef> => {
  const refs = new Map<string, SourceRef>();
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      for (const content of block.tool?.contents ?? []) {
        const result = content.searchResult;
        const url = result?.base?.url;
        if (!result?.refIndex || !url) continue;
        if (!refs.has(result.refIndex)) refs.set(result.refIndex, { url, title: result.base?.title ?? '' });
      }
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
 * Finds every `[^N^]` marker in the assembled text and resolves it against the
 * conversation's refIndex map, so citations carry REAL offsets into the
 * output_text rather than nulls.
 */
const annotateCitations = (text: string, refs: Map<string, SourceRef>): Annotation[] => {
  const annotations: Annotation[] = [];
  for (const match of text.matchAll(CITATION_MARKER)) {
    const source = refs.get(match[1] ?? '');
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

const describeFile = (file: NonNullable<RawBlock['file']>): string => {
  const meta = file.meta ?? {};
  const size = meta.sizeBytes ? `, ${meta.sizeBytes} bytes` : '';
  return `[file "${meta.name ?? '(unnamed)'}"${meta.ext ? ` (${meta.ext})` : ''}${size}]`;
};

export interface MapOptions {
  includeReasoning: boolean;
  includeToolCalls: boolean;
  /** Conversation-level reasoning effort, surfaced on each reasoning item. */
  effort: string | null;
  model: string | null;
}

/**
 * Flattens Kimi's ordered message blocks into SPEC §3 Responses items.
 *
 * One `message` item per Kimi message keeps the item count equal to the turn
 * count the page renders; the reasoning and tool items belonging to that message
 * are emitted immediately before it, in block order. Every `text` block — and
 * every sub-agent `agentMessage`, which the transcript renders as ordinary
 * assistant prose — is concatenated into that one message, never just the first.
 *
 * `messages` must be in chronological (oldest-first) order.
 */
export const mapMessagesToItems = (messages: RawMessage[], options: MapOptions): MappedItems => {
  const items: ResponseItem[] = [];
  const omitted: OmittedCounts = { reasoning: 0, tool_calls: 0, hidden: 0, empty: 0 };
  const refs = collectSourceRefs(messages);

  for (const message of messages) {
    const blocks = message.blocks ?? [];
    const messageId = message.id ?? '';
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : 'system';
    const textParts: string[] = [];
    let hasPendingToolCall = false;
    let blockIndex = -1;

    for (const block of blocks) {
      blockIndex += 1;

      if (block.text?.content) {
        textParts.push(block.text.content);
        continue;
      }
      if (block.agentMessage?.content) {
        const name = block.agentMessage.agentName ?? 'agent';
        textParts.push(`[sub-agent ${name}]\n${block.agentMessage.content}`);
        continue;
      }
      if (block.file) {
        textParts.push(describeFile(block.file));
        continue;
      }

      if (block.think) {
        const thinking = block.think.content ?? '';
        if (!thinking) {
          omitted.empty += 1;
          continue;
        }
        if (!options.includeReasoning) {
          omitted.reasoning += 1;
          continue;
        }
        items.push({
          // Kimi stamps no id on a think block, so one is synthesized from the
          // message id and the block's ordinal position.
          id: block.id || `rs_${messageId}#${blockIndex}`,
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: thinking }],
          effort: options.effort,
        });
        continue;
      }

      if (block.tool) {
        const name = block.tool.name ?? 'unknown';
        const contents = block.tool.contents ?? [];
        const status = contents.length > 0 ? 'completed' : 'in_progress';
        if (contents.length === 0) hasPendingToolCall = true;
        if (!options.includeToolCalls) {
          omitted.tool_calls += 1;
          continue;
        }
        const args = parseToolArguments(block.tool.args);
        const id = block.tool.toolCallId || block.id || `tc_${messageId}#${blockIndex}`;
        if (isWebSearchTool(name)) {
          items.push({
            id,
            type: 'web_search_call',
            status,
            action: { type: 'search', query: firstQuery(args), url: null },
            results: toSearchResults(contents),
          });
        } else {
          items.push({
            id,
            type: 'tool_call',
            name,
            status,
            arguments: args,
            output: renderToolOutput(contents),
          });
        }
        continue;
      }

      // stage / multiStage are the UI's progress spinner and carry no
      // user-visible content — never silently dropped, just counted.
      omitted.hidden += 1;
    }

    const combined = textParts.join('\n\n');
    if (!combined) {
      // Kimi seeds every chat with a synthetic root message that has no blocks;
      // a still-generating assistant turn is also momentarily empty.
      omitted.empty += 1;
      continue;
    }

    items.push({
      id: messageId,
      type: 'message',
      role,
      status: hasPendingToolCall ? 'in_progress' : messageStatus(message),
      created_at: toUnixSeconds(message.createTime),
      model: role === 'assistant' ? options.model : null,
      content:
        role === 'user'
          ? [{ type: 'input_text', text: combined }]
          : [{ type: 'output_text', text: combined, annotations: annotateCitations(combined, refs) }],
    });
  }

  return { items, omitted };
};
