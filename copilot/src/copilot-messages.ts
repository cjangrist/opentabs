import type { GatewayCitation, GatewayRun } from './copilot-api.js';
import { toUnixSeconds } from './copilot-api.js';
import type { ResponseItem } from './tools/normalized-schemas.js';

export interface RawContentPart {
  type?: string;
  text?: string;
  title?: string;
  url?: string;
  publisher?: string | null;
  snippet?: string | null;
  position?: number;
  partId?: string;
  parentPartId?: string;
  fileName?: string;
  contentType?: string;
  attachmentId?: string;
  thumbnailUrl?: string;
  prompt?: string | null;
  card?: { type?: string; [key: string]: unknown };
  task?: { id?: string; type?: string; status?: string; title?: string | null; [key: string]: unknown };
  query?: string;
  results?: Array<{ title?: string; url?: string; snippet?: string | null; iconUrl?: string | null }>;
  [key: string]: unknown;
}

export interface RawMessage {
  id?: string;
  author?: { type?: string };
  createdAt?: string;
  mode?: string | null;
  streamingState?: string;
  content?: RawContentPart[];
}

export interface OmittedLedger {
  reasoning: number;
  tool_calls: number;
  hidden: number;
  empty: number;
}

interface Visibility {
  includeReasoning: boolean;
  includeToolCalls: boolean;
}

const emptyLedger = (): OmittedLedger => ({ reasoning: 0, tool_calls: 0, hidden: 0, empty: 0 });

const roleOf = (message: RawMessage): 'user' | 'assistant' | 'system' => {
  if (message.author?.type === 'human' || message.author?.type === 'groupParticipant') return 'user';
  if (message.author?.type === 'ai') return 'assistant';
  return 'system';
};

const uniqueCitations = (citations: GatewayCitation[]): GatewayCitation[] => {
  const seen = new Set<string>();
  return citations.filter(citation => {
    if (!citation.url || seen.has(citation.url)) return false;
    seen.add(citation.url);
    return true;
  });
};

const hostnameOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const annotationOf = (citation: GatewayCitation, textLength: number) => {
  const position = citation.position;
  const validPosition = position !== null && position >= 0 && position <= textLength ? position : null;
  return {
    type: 'url_citation' as const,
    url: citation.url,
    title: citation.title,
    start_index: validPosition,
    end_index: validPosition,
  };
};

const citationsOf = (parts: RawContentPart[]): GatewayCitation[] =>
  uniqueCitations(
    parts
      .filter(part => part.type === 'citation' && typeof part.url === 'string' && part.url.length > 0)
      .map(part => ({
        title: part.title ?? '',
        url: part.url ?? '',
        publisher: part.publisher ?? null,
        snippet: part.snippet ?? null,
        position: Number.isInteger(part.position) ? (part.position as number) : null,
      })),
  );

const placeholderOf = (part: RawContentPart): string | null => {
  switch (part.type) {
    case 'image':
      return `[image ${part.fileName ?? part.thumbnailUrl ?? part.url ?? part.partId ?? 'attachment'}]`;
    case 'document':
      return `[document ${part.fileName ?? part.attachmentId ?? 'attachment'}${part.contentType ? ` ${part.contentType}` : ''}]`;
    case 'card':
      return `[card ${part.card?.type ?? 'unknown'}]`;
    case 'deleted':
      return '[deleted content]';
    default:
      return null;
  }
};

const toolItemOf = (messageId: string, part: RawContentPart, index: number): ResponseItem | null => {
  const id = part.partId ?? `${messageId}:tool:${index}`;
  if (part.type === 'webSearch' && part.query) {
    return {
      id,
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', query: part.query, url: null },
      results: (part.results ?? [])
        .filter(result => Boolean(result.url))
        .map(result => ({
          title: result.title ?? '',
          url: result.url ?? '',
          snippet: result.snippet ?? null,
          site_name: hostnameOf(result.url),
        })),
    };
  }
  if (part.type === 'task' && part.task) {
    return {
      id,
      type: 'tool_call',
      name: part.task.type ?? 'task',
      status: ['failed', 'cancelled', 'canceled'].includes(part.task.status ?? '')
        ? 'incomplete'
        : ['running', 'pending'].includes(part.task.status ?? '')
          ? 'in_progress'
          : 'completed',
      arguments: { task_id: part.task.id ?? null, title: part.task.title ?? null },
      output: part.task.status ?? null,
    };
  }
  if (part.type && ['shellCommandExecution', 'computerUse', 'textFile'].includes(part.type)) {
    return {
      id,
      type: 'tool_call',
      name: part.type,
      status: 'completed',
      arguments: {},
      output: typeof part.text === 'string' ? part.text : null,
    };
  }
  return null;
};

export const mapMessagesToItems = (
  messages: RawMessage[],
  visibility: Visibility,
): { items: ResponseItem[]; omitted: OmittedLedger } => {
  const items: ResponseItem[] = [];
  const omitted = emptyLedger();

  for (const [messageIndex, message] of messages.entries()) {
    const messageId = message.id ?? `message:${messageIndex}`;
    const parts = message.content ?? [];
    const sideItems: ResponseItem[] = [];
    const rendered: string[] = [];

    for (const [partIndex, part] of parts.entries()) {
      if (part.type === 'text') {
        if (part.text) rendered.push(part.text);
        else omitted.empty += 1;
        continue;
      }
      if (part.type === 'chainOfThought') {
        if (!part.text) {
          omitted.empty += 1;
          continue;
        }
        const reasoning: ResponseItem = {
          id: part.partId ?? `${messageId}:reasoning:${partIndex}`,
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: part.text }],
          effort: message.mode ?? null,
        };
        if (visibility.includeReasoning) sideItems.push(reasoning);
        else omitted.reasoning += 1;
        continue;
      }
      const tool = toolItemOf(messageId, part, partIndex);
      if (tool) {
        if (visibility.includeToolCalls) sideItems.push(tool);
        else omitted.tool_calls += 1;
        continue;
      }
      const placeholder = placeholderOf(part);
      if (placeholder) rendered.push(placeholder);
      else if (part.type !== 'citation') omitted.hidden += 1;
    }

    items.push(...sideItems);
    const text = rendered.join('\n\n');
    if (!text) {
      if (sideItems.length === 0) omitted.empty += 1;
      continue;
    }
    const role = roleOf(message);
    const citations = citationsOf(parts);
    items.push({
      id: messageId,
      type: 'message',
      role,
      status: message.streamingState === 'streaming' ? 'in_progress' : 'completed',
      created_at: toUnixSeconds(message.createdAt),
      model: role === 'assistant' ? (message.mode ?? null) : null,
      content: [
        role === 'assistant'
          ? {
              type: 'output_text',
              text,
              annotations: citations.map(citation => annotationOf(citation, text.length)),
            }
          : { type: 'input_text', text },
      ],
    });
  }

  return { items, omitted };
};

export const mapGatewayRunToItems = (
  run: GatewayRun,
  visibility: Visibility,
): { items: ResponseItem[]; omitted: OmittedLedger } => {
  const omitted = emptyLedger();
  const now = Math.floor(Date.now() / 1000);
  const items: ResponseItem[] = [
    {
      id: run.parentMessageId || `${run.conversationId}:user`,
      type: 'message',
      role: 'user',
      status: 'completed',
      created_at: now,
      model: null,
      content: [{ type: 'input_text', text: run.prompt }],
    },
  ];

  for (const reasoning of run.reasoning) {
    if (!reasoning.text) {
      omitted.empty += 1;
      continue;
    }
    if (visibility.includeReasoning)
      items.push({
        id: reasoning.id,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: reasoning.text }],
        effort: run.modelId,
      });
    else omitted.reasoning += 1;
  }

  for (const search of run.searches) {
    const results = uniqueCitations(search.results);
    const item: ResponseItem =
      search.type === 'webSearch'
        ? {
            id: search.id,
            type: 'web_search_call',
            status: search.completed ? 'completed' : 'in_progress',
            action: { type: 'search', query: search.query, url: search.url },
            results: results.map(result => ({
              title: result.title,
              url: result.url,
              snippet: result.snippet,
              site_name: result.publisher,
            })),
          }
        : {
            id: search.id,
            type: 'tool_call',
            name: search.type,
            status: search.completed ? 'completed' : 'in_progress',
            arguments: { query: search.query, url: search.url },
            output: null,
          };
    if (visibility.includeToolCalls) items.push(item);
    else omitted.tool_calls += 1;
  }

  if (run.text) {
    const citations = uniqueCitations(run.citations);
    items.push({
      id: run.messageId || `${run.conversationId}:assistant`,
      type: 'message',
      role: 'assistant',
      status: run.done ? 'completed' : 'in_progress',
      created_at: now,
      model: run.modelId,
      content: [
        {
          type: 'output_text',
          text: run.text,
          annotations: citations.map(citation => annotationOf(citation, run.text.length)),
        },
      ],
    });
  }
  return { items, omitted };
};
