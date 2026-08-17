import { api, toUnixSeconds } from './grok-api.js';
import type { ResponseItem } from './tools/normalized-schemas.js';

const LOAD_RESPONSES_BATCH = 25;
const TOOL_OUTPUT_LIMIT = 50_000;

export interface RawResponseNode {
  responseId?: string;
  sender?: string;
  parentResponseId?: string;
  threadParentId?: string;
}

export interface RawWebSearchResult {
  url?: string;
  title?: string;
  preview?: string;
  snippet?: string;
  siteName?: string;
  citeIndex?: number;
}

interface RawToolUsageCard {
  toolUsageCardId?: string;
  webSearch?: { args?: Record<string, unknown> };
  browsePage?: { args?: Record<string, unknown> };
  [key: string]: unknown;
}

interface RawToolUsageResult {
  toolUsageCardId?: string;
  webSearchResults?: { results?: RawWebSearchResult[] };
  [key: string]: unknown;
}

export interface RawStep {
  text?: string[];
  tags?: string[];
  webSearchResults?: RawWebSearchResult[];
  toolUsageCards?: RawToolUsageCard[];
  toolUsageResults?: RawToolUsageResult[];
}

export interface RawResponse {
  responseId?: string;
  message?: string;
  sender?: string;
  parentResponseId?: string;
  createTime?: string;
  partial?: boolean;
  state?: string;
  status?: string;
  error?: string;
  streamErrors?: Array<{ message?: string; severity?: string }>;
  webSearchResults?: RawWebSearchResult[];
  citedWebSearchResults?: RawWebSearchResult[];
  steps?: RawStep[];
  model?: string;
  requestMetadata?: { model?: string; mode?: string; effort?: string };
  metadata?: {
    deepsearchPreset?: string;
    request_metadata?: { model?: string; mode?: string; effort?: string };
    ui_layout?: { will_think_long?: boolean; rollout_ids?: string[] };
    uiLayout?: { willThinkLong?: boolean; rolloutIds?: string[] };
  };
  imageAttachments?: unknown[];
  generatedImageUrls?: unknown[];
  imageEditUris?: unknown[];
  fileAttachments?: unknown[];
  fileAttachmentsMetadata?: unknown[];
  fileAttachmentAssetMetadata?: unknown[];
  inputChunks?: unknown[];
  outputChunks?: unknown[];
  toolResponses?: unknown[];
}

interface RawResponseNodesPayload {
  responseNodes?: RawResponseNode[];
  inflightResponses?: RawResponse[];
}

const isHuman = (sender: string | undefined): boolean => sender?.toLowerCase() === 'human';

export const getResponseState = (conversationId: string): Promise<RawResponseNodesPayload> =>
  api(`/app-chat/conversations/${encodeURIComponent(conversationId)}/response-node`);

export const loadResponses = async (conversationId: string, responseIds: string[]): Promise<RawResponse[]> => {
  const responses: RawResponse[] = [];
  for (let offset = 0; offset < responseIds.length; offset += LOAD_RESPONSES_BATCH) {
    const batch = responseIds.slice(offset, offset + LOAD_RESPONSES_BATCH);
    const payload = await api<{ responses?: RawResponse[] }>(
      `/app-chat/conversations/${encodeURIComponent(conversationId)}/load-responses`,
      { method: 'POST', body: { responseIds: batch } },
    );
    responses.push(...(payload.responses ?? []));
  }
  return responses;
};

export const currentBranch = (allNodes: RawResponseNode[]): RawResponseNode[] => {
  const nodes = allNodes.filter(node => !node.threadParentId);
  const byId = new Map(nodes.filter(node => node.responseId).map(node => [node.responseId as string, node]));
  const tip = nodes[nodes.length - 1];
  if (!tip?.responseId) return nodes;

  const branch: RawResponseNode[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined = tip.responseId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    branch.unshift(node);
    cursor = node.parentResponseId;
  }
  return branch.length > 0 ? branch : nodes;
};

export const getTipResponseId = async (conversationId: string): Promise<string | null> => {
  const state = await getResponseState(conversationId);
  const branch = currentBranch(state.responseNodes ?? []);
  return branch[branch.length - 1]?.responseId ?? null;
};

export interface ConversationResponses {
  nodes: RawResponseNode[];
  responses: RawResponse[];
  inflight: RawResponse[];
}

export const getConversationResponses = async (conversationId: string): Promise<ConversationResponses> => {
  const state = await getResponseState(conversationId);
  const nodes = currentBranch(state.responseNodes ?? []);
  const ids = nodes.flatMap(node => (node.responseId ? [node.responseId] : []));
  const stored = ids.length > 0 ? await loadResponses(conversationId, ids) : [];
  const inflight = state.inflightResponses ?? [];
  const byId = new Map<string, RawResponse>();
  for (const response of [...stored, ...inflight]) {
    if (response.responseId) byId.set(response.responseId, response);
  }
  const responses = ids.flatMap(id => {
    const response = byId.get(id);
    return response ? [response] : [];
  });
  const branchIds = new Set(ids);
  for (const response of inflight) {
    if (!response.responseId || !branchIds.has(response.responseId)) responses.push(response);
  }
  return { nodes, responses, inflight };
};

const itemStatus = (response: RawResponse): 'completed' | 'in_progress' | 'incomplete' => {
  if (response.error || (response.streamErrors ?? []).some(error => error.severity?.toLowerCase() === 'fatal'))
    return 'incomplete';
  if (response.partial === true) return 'incomplete';
  if (['streaming', 'optimistic', 'reconnecting', 'running'].includes(response.state ?? response.status ?? ''))
    return 'in_progress';
  return 'completed';
};

const hostname = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const mapSearchResult = (result: RawWebSearchResult) => ({
  title: result.title ?? '',
  url: result.url ?? '',
  snippet: result.snippet ?? result.preview ?? null,
  site_name: result.siteName ?? (result.url ? hostname(result.url) : null),
});

const allSearchResults = (response: RawResponse): RawWebSearchResult[] => {
  const results = [
    ...(response.citedWebSearchResults ?? []),
    ...(response.webSearchResults ?? []),
    ...(response.steps ?? []).flatMap(step => [
      ...(step.webSearchResults ?? []),
      ...(step.toolUsageResults ?? []).flatMap(result => result.webSearchResults?.results ?? []),
    ]),
  ];
  const seen = new Set<string>();
  return results.filter(result => {
    if (!result.url || seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
};

const attachmentLabel = (kind: string, value: unknown): string => {
  if (typeof value === 'string') return `[${kind} ${value}]`;
  if (!value || typeof value !== 'object') return `[${kind}]`;
  const record = value as Record<string, unknown>;
  const label = [record.fileName, record.name, record.title, record.url, record.fileMetadataId, record.id].find(
    candidate => typeof candidate === 'string' && candidate.length > 0,
  );
  return label ? `[${kind} ${label}]` : `[${kind}]`;
};

const responseText = (response: RawResponse): string => {
  const parts: string[] = [];
  if (response.message) parts.push(response.message);
  for (const image of response.imageAttachments ?? []) parts.push(attachmentLabel('image', image));
  for (const image of response.generatedImageUrls ?? []) parts.push(attachmentLabel('generated image', image));
  for (const image of response.imageEditUris ?? []) parts.push(attachmentLabel('edited image', image));
  const files = [
    ...(response.fileAttachments ?? []),
    ...(response.fileAttachmentsMetadata ?? []),
    ...(response.fileAttachmentAssetMetadata ?? []),
  ];
  for (const file of files) parts.push(attachmentLabel('file', file));
  return parts.filter(Boolean).join('\n\n');
};

const effortOf = (response: RawResponse): string | null =>
  response.requestMetadata?.effort ?? response.metadata?.request_metadata?.effort ?? null;

const modelOf = (response: RawResponse): string | null =>
  response.requestMetadata?.model ??
  response.requestMetadata?.mode ??
  response.metadata?.request_metadata?.model ??
  response.metadata?.request_metadata?.mode ??
  response.model ??
  null;

const snakeCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

const safeObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const renderOutput = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  if (rendered.length <= TOOL_OUTPUT_LIMIT) return rendered;
  return `${rendered.slice(0, TOOL_OUTPUT_LIMIT)}\n[truncated ${rendered.length - TOOL_OUTPUT_LIMIT} characters]`;
};

const toolCardEntries = (card: RawToolUsageCard): Array<[string, unknown]> =>
  Object.entries(card).filter(([key]) => key !== 'toolUsageCardId');

const mapToolItems = (response: RawResponse): ResponseItem[] => {
  const items: ResponseItem[] = [];
  let sawStructuredCard = false;
  for (const [stepIndex, step] of (response.steps ?? []).entries()) {
    const results = new Map(
      (step.toolUsageResults ?? [])
        .filter(result => result.toolUsageCardId)
        .map(result => [result.toolUsageCardId as string, result]),
    );
    for (const [cardIndex, card] of (step.toolUsageCards ?? []).entries()) {
      sawStructuredCard = true;
      const cardId = card.toolUsageCardId ?? `${response.responseId ?? 'response'}:tool:${stepIndex}:${cardIndex}`;
      const entries = toolCardEntries(card);
      for (const [entryIndex, [rawName, rawCall]] of entries.entries()) {
        const id = entryIndex === 0 ? cardId : `${cardId}:${entryIndex}`;
        const call = safeObject(rawCall);
        const args = safeObject(call.args);
        const result = results.get(card.toolUsageCardId ?? '');
        const searchResults = result?.webSearchResults?.results ?? [];
        if (rawName === 'webSearch' || rawName === 'browsePage') {
          items.push({
            id,
            type: 'web_search_call',
            status: result ? 'completed' : itemStatus(response),
            action: {
              type: rawName === 'webSearch' ? 'search' : 'open_page',
              query: rawName === 'webSearch' && typeof args.query === 'string' ? args.query : null,
              url: rawName === 'browsePage' && typeof args.url === 'string' ? args.url : null,
            },
            results: searchResults.filter(candidate => Boolean(candidate.url)).map(mapSearchResult),
          });
          continue;
        }
        const rawResult = result
          ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'toolUsageCardId'))
          : undefined;
        items.push({
          id,
          type: 'tool_call',
          name: snakeCase(rawName),
          status: result ? 'completed' : itemStatus(response),
          arguments: args,
          output: renderOutput(rawResult),
        });
      }
    }
  }

  const sources = allSearchResults(response);
  if (!sawStructuredCard && sources.length > 0) {
    items.push({
      id: `${response.responseId ?? 'response'}:search`,
      type: 'web_search_call',
      status: itemStatus(response),
      action: { type: 'search', query: null, url: null },
      results: sources.map(mapSearchResult),
    });
  }
  return items;
};

export interface MappedItems {
  items: ResponseItem[];
  omitted: { reasoning: number; tool_calls: number; hidden: number; empty: number };
}

export const mapResponsesToItems = (
  responses: RawResponse[],
  visibility: { includeReasoning: boolean; includeToolCalls: boolean },
): MappedItems => {
  const items: ResponseItem[] = [];
  const omitted = { reasoning: 0, tool_calls: 0, hidden: 0, empty: 0 };

  for (const response of responses) {
    const responseId = response.responseId ?? `response:${items.length}`;
    const status = itemStatus(response);
    const text = responseText(response);
    if (isHuman(response.sender)) {
      if (text) {
        items.push({
          id: responseId,
          type: 'message',
          role: 'user',
          status,
          created_at: toUnixSeconds(response.createTime),
          model: null,
          content: [{ type: 'input_text', text }],
        });
      } else {
        omitted.empty += 1;
      }
      continue;
    }

    for (const [stepIndex, step] of (response.steps ?? []).entries()) {
      const tags = step.tags ?? [];
      if (!tags.includes('header') && !tags.includes('summary')) continue;
      const summary = (step.text ?? []).filter(Boolean).join('\n');
      if (!summary) {
        omitted.empty += 1;
        continue;
      }
      const reasoning: ResponseItem = {
        id: `${responseId}:reasoning:${stepIndex}`,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: summary }],
        effort: effortOf(response),
      };
      if (visibility.includeReasoning) items.push(reasoning);
      else omitted.reasoning += 1;
    }

    const toolItems = mapToolItems(response);
    if (visibility.includeToolCalls) items.push(...toolItems);
    else omitted.tool_calls += toolItems.length;

    if (text) {
      const citations = allSearchResults(response).map(result => ({
        type: 'url_citation' as const,
        url: result.url ?? '',
        title: result.title ?? '',
        start_index: null,
        end_index: null,
      }));
      items.push({
        id: responseId,
        type: 'message',
        role: 'assistant',
        status,
        created_at: toUnixSeconds(response.createTime),
        model: modelOf(response),
        content: [{ type: 'output_text', text, annotations: citations }],
      });
    } else if (toolItems.length === 0 && !(response.steps ?? []).some(step => (step.text ?? []).some(Boolean))) {
      omitted.empty += 1;
    }
  }

  return { items, omitted };
};

export const responseSources = (response: RawResponse) =>
  allSearchResults(response).map(result => ({
    title: result.title ?? '',
    url: result.url ?? '',
    snippet: result.snippet ?? result.preview ?? null,
  }));

export const latestAssistantResponse = (responses: RawResponse[]): RawResponse | null =>
  [...responses].reverse().find(response => !isHuman(response.sender)) ?? null;
