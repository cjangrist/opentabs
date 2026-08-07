import { toUnixSeconds } from './claude-api.js';
import type { ResponseItem } from './tools/normalized-schemas.js';

// --- Raw claude.ai conversation shapes ---

export interface RawCitation {
  uuid?: string;
  title?: string;
  url?: string;
  metadata?: { site_name?: string; site_domain?: string };
  start_index?: number;
  end_index?: number;
}

export interface RawToolResultContent {
  type?: string;
  title?: string;
  url?: string;
  text?: string;
  metadata?: { site_name?: string; site_domain?: string };
}

export interface RawBlock {
  type?: string;
  // text
  text?: string;
  citations?: RawCitation[];
  // thinking
  thinking?: string;
  hidden?: boolean;
  thinking_hidden?: boolean;
  // tool_use
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result
  tool_use_id?: string;
  content?: RawToolResultContent[];
  is_error?: boolean;
}

export interface RawMessage {
  uuid?: string;
  text?: string;
  content?: RawBlock[];
  sender?: string;
  index?: number;
  created_at?: string;
  attachments?: { file_name?: string; file_type?: string }[];
  files?: { file_name?: string }[];
  parent_message_uuid?: string;
}

export interface RawConversationDetail {
  uuid?: string;
  name?: string;
  summary?: string;
  model?: string;
  created_at?: string;
  updated_at?: string;
  is_starred?: boolean;
  project_uuid?: string | null;
  current_leaf_message_uuid?: string;
  settings?: Record<string, unknown>;
  chat_messages?: RawMessage[];
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

const isWebSearchTool = (name: string): boolean => name === 'web_search' || name.endsWith(':web_search');

/** Renders a tool_result payload as text, marking any truncation instead of hiding it. */
const renderToolOutput = (content: RawToolResultContent[] | undefined): string | null => {
  if (!content || content.length === 0) return null;
  const rendered = content
    .map(part => {
      if (part.type === 'knowledge') return `${part.title ?? 'Untitled'} — ${part.url ?? ''}`.trim();
      if (typeof part.text === 'string') return part.text;
      return JSON.stringify(part);
    })
    .join('\n')
    .trim();
  if (!rendered) return null;
  if (rendered.length <= TOOL_OUTPUT_LIMIT) return rendered;
  return `${rendered.slice(0, TOOL_OUTPUT_LIMIT)}\n… [truncated ${rendered.length - TOOL_OUTPUT_LIMIT} characters]`;
};

const toSearchResults = (content: RawToolResultContent[] | undefined) =>
  (content ?? [])
    .filter(part => part.type === 'knowledge' && part.url)
    .map(part => ({
      title: part.title ?? '',
      url: part.url ?? '',
      snippet: part.text ?? null,
      site_name: part.metadata?.site_name ?? part.metadata?.site_domain ?? null,
    }));

/**
 * Joins every text block of a message into one part and re-bases each citation's
 * indices onto the joined string. Reading only the first block truncated every
 * assistant turn that used a tool to its opening sentence.
 */
const joinTextBlocks = (
  blocks: RawBlock[],
): {
  text: string;
  annotations: {
    type: 'url_citation';
    url: string;
    title: string;
    start_index: number | null;
    end_index: number | null;
  }[];
} => {
  const separator = '\n\n';
  const parts: string[] = [];
  const annotations: {
    type: 'url_citation';
    url: string;
    title: string;
    start_index: number | null;
    end_index: number | null;
  }[] = [];
  let offset = 0;

  for (const block of blocks) {
    const text = block.text ?? '';
    if (!text) continue;
    for (const citation of block.citations ?? []) {
      if (!citation.url) continue;
      annotations.push({
        type: 'url_citation',
        url: citation.url,
        title: citation.title ?? '',
        start_index: typeof citation.start_index === 'number' ? citation.start_index + offset : null,
        end_index: typeof citation.end_index === 'number' ? citation.end_index + offset : null,
      });
    }
    parts.push(text);
    offset += text.length + separator.length;
  }

  return { text: parts.join(separator), annotations };
};

const describeAttachments = (message: RawMessage): string[] => [
  ...(message.attachments ?? []).map(a => `[attachment ${a.file_name ? `"${a.file_name}"` : '(unnamed)'}]`),
  ...(message.files ?? []).map(f => `[file ${f.file_name ? `"${f.file_name}"` : '(unnamed)'}]`),
];

export interface MapOptions {
  includeReasoning: boolean;
  includeToolCalls: boolean;
  /** Conversation-level reasoning effort, surfaced on each reasoning item. */
  effort: string | null;
  model: string | null;
}

/**
 * Flattens claude.ai's ordered content blocks into SPEC §3 Responses items.
 *
 * One `message` item per claude message keeps the item count equal to the turn
 * count the page renders; reasoning and tool items for that message are emitted
 * immediately before it, in block order.
 */
export const mapMessagesToItems = (messages: RawMessage[], options: MapOptions): MappedItems => {
  const items: ResponseItem[] = [];
  const omitted: OmittedCounts = { reasoning: 0, tool_calls: 0, hidden: 0, empty: 0 };

  for (const message of messages) {
    const blocks = message.content ?? [];
    const messageId = message.uuid ?? '';
    const role = message.sender === 'assistant' ? 'assistant' : message.sender === 'human' ? 'user' : 'system';
    const resultsByUseId = new Map<string, RawBlock>();
    for (const block of blocks) {
      if (block.type === 'tool_result' && block.tool_use_id) resultsByUseId.set(block.tool_use_id, block);
    }

    let hasPendingToolCall = false;
    let blockIndex = -1;

    for (const block of blocks) {
      blockIndex += 1;
      if (block.type === 'text') continue;
      if (block.type === 'tool_result') continue;

      if (block.type === 'thinking') {
        if (block.hidden === true || block.thinking_hidden === true || !block.thinking) {
          omitted.hidden += 1;
          continue;
        }
        if (!options.includeReasoning) {
          omitted.reasoning += 1;
          continue;
        }
        items.push({
          id: `rs_${messageId}#${blockIndex}`,
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: block.thinking }],
          effort: options.effort,
        });
        continue;
      }

      if (block.type === 'tool_use') {
        const result = block.id ? resultsByUseId.get(block.id) : undefined;
        if (!result) hasPendingToolCall = true;
        if (!options.includeToolCalls) {
          omitted.tool_calls += 1;
          continue;
        }
        const status = result ? (result.is_error === true ? 'incomplete' : 'completed') : 'in_progress';
        const name = block.name ?? 'unknown';
        if (isWebSearchTool(name)) {
          items.push({
            id: block.id ?? `ws_${messageId}#${blockIndex}`,
            type: 'web_search_call',
            status,
            action: {
              type: 'search',
              query: typeof block.input?.query === 'string' ? block.input.query : null,
              url: typeof block.input?.url === 'string' ? block.input.url : null,
            },
            results: toSearchResults(result?.content),
          });
        } else {
          items.push({
            id: block.id ?? `tc_${messageId}#${blockIndex}`,
            type: 'tool_call',
            name,
            status,
            arguments: block.input ?? {},
            output: renderToolOutput(result?.content),
          });
        }
        continue;
      }

      // token_budget and anything else claude.ai adds later: no user-visible
      // content, but never silently dropped.
      omitted.hidden += 1;
    }

    const textBlocks = blocks.filter(block => block.type === 'text');
    const { text, annotations } = joinTextBlocks(textBlocks);
    const placeholders = describeAttachments(message);
    const combined = [text, ...placeholders].filter(Boolean).join('\n\n');

    if (!combined) {
      omitted.empty += 1;
      continue;
    }

    items.push({
      id: messageId,
      type: 'message',
      role,
      status: hasPendingToolCall ? 'in_progress' : 'completed',
      created_at: toUnixSeconds(message.created_at),
      model: role === 'assistant' ? options.model : null,
      content:
        role === 'user'
          ? [{ type: 'input_text', text: combined }]
          : [{ type: 'output_text', text: combined, annotations }],
    });
  }

  return { items, omitted };
};
