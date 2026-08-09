import { ToolError } from '@opentabs-dev/plugin-sdk';
import { type RpcFrame, asArray, asString, callRpcFrame, toConversationId, tupleToUnixSeconds } from './gemini-api.js';
import type { ResponseItem } from './tools/normalized-schemas.js';

const RPC_GET_CONVERSATION = 'hNvQHb';
const END_OF_LIST_DETAIL = 1096;

/** Gemini caps a transcript page at this many turns however many are requested. */
export const MAX_TURN_PAGE = 100;
/** Ceiling on the walk so a pathological conversation cannot blow the 25s tool budget. */
const MAX_TURN_PAGES = 20;

export interface GeminiTurn {
  conversationId: string;
  responseId: string;
  /** `[conversationId, responseId, responseChoiceId]` — the context a reply must quote. */
  context: [string, string, string] | null;
  promptText: string;
  promptModelId: string | null;
  createdAt: number;
  responseChoiceId: string | null;
  responseText: string;
  thoughts: string[];
  modelId: string | null;
  modelDisplayName: string | null;
  /** Numeric-keyed extension map on the selected candidate, when Gemini attached one. */
  extensions: Record<string, unknown> | null;
}

const readExtensions = (candidate: unknown[]): Record<string, unknown> | null => {
  const slot = asArray(candidate[12])[0];
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return null;
  return slot as Record<string, unknown>;
};

/** Joins every string in a nested array — Gemini splits long answers across blocks. */
const collectStrings = (value: unknown): string[] => {
  if (typeof value === 'string') return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap(collectStrings);
};

const mapTurn = (raw: unknown): GeminiTurn | null => {
  if (!Array.isArray(raw)) return null;
  const head = asArray(raw[0]);
  const conversationId = asString(head[0]);
  const responseId = asString(head[1]);
  if (!conversationId || !responseId) return null;

  const contextRaw = asArray(raw[1]);
  const context =
    asString(contextRaw[0]) && asString(contextRaw[1]) && asString(contextRaw[2])
      ? ([contextRaw[0], contextRaw[1], contextRaw[2]] as [string, string, string])
      : null;

  const promptTuple = asArray(raw[2]);
  const responseBlock = asArray(raw[3]);
  const candidates = asArray(responseBlock[0]);
  const selectedId = asString(responseBlock[3]);
  const candidate =
    (candidates.find(entry => Array.isArray(entry) && asString(entry[0]) === selectedId) as unknown[] | undefined) ??
    (candidates[0] as unknown[] | undefined);

  return {
    conversationId,
    responseId,
    context,
    promptText: collectStrings(asArray(promptTuple[0])[0]).join('\n\n'),
    promptModelId: asString(promptTuple[4]),
    createdAt: tupleToUnixSeconds(raw[4]),
    responseChoiceId: candidate ? asString(candidate[0]) : null,
    responseText: candidate ? collectStrings(candidate[1]).join('\n\n') : '',
    thoughts: candidate ? collectStrings(asArray(candidate[37])[0]) : [],
    modelId: asString(responseBlock[17]) ?? asString(responseBlock[14]) ?? asString(promptTuple[4]),
    modelDisplayName: asString(responseBlock[21]),
    extensions: candidate ? readExtensions(candidate) : null,
  };
};

export interface ConversationTurns {
  turns: GeminiTurn[];
  /** True when the walk stopped at MAX_TURN_PAGES rather than at the end of the transcript. */
  truncated: boolean;
}

const isEndOfList = (frame: RpcFrame<unknown>): boolean =>
  frame.data === null && frame.errorInfo.includes(END_OF_LIST_DETAIL);

/**
 * Walks `hNvQHb` from the newest turn backwards and returns the transcript in
 * chronological order. The RPC's third argument is an opaque continuation token and
 * its second is a page size capped at {@link MAX_TURN_PAGE}.
 */
/** Reads just the newest turn — used to thread a reply and to poll for a result. */
export const getLatestTurn = async (conversationId: string): Promise<GeminiTurn | null> => {
  const frame = await callRpcFrame<unknown[]>(RPC_GET_CONVERSATION, [
    toConversationId(conversationId),
    1,
    null,
    1,
    [0],
    [4],
    null,
    1,
  ]);
  if (frame.data === null) return null;
  const turns = asArray(frame.data[0])
    .map(mapTurn)
    .filter((turn): turn is GeminiTurn => turn !== null);
  return turns[0] ?? null;
};

export const getConversationTurns = async (conversationId: string): Promise<ConversationTurns> => {
  const id = toConversationId(conversationId);
  const collected: GeminiTurn[] = [];
  let token: string | null = null;
  let truncated = false;

  for (let page = 0; page < MAX_TURN_PAGES; page += 1) {
    const frame: RpcFrame<unknown[]> = await callRpcFrame<unknown[]>(RPC_GET_CONVERSATION, [
      id,
      MAX_TURN_PAGE,
      token,
      1,
      [0],
      [4],
      null,
      1,
    ]);
    if (isEndOfList(frame)) break;
    if (frame.data === null) {
      if (page === 0)
        throw new ToolError(
          `Gemini has no conversation ${id} (status ${frame.statusCode ?? 'unknown'}).`,
          'NOT_FOUND',
          { category: 'not_found' },
        );
      break;
    }
    const turns = asArray(frame.data[0])
      .map(mapTurn)
      .filter((turn): turn is GeminiTurn => turn !== null);
    collected.push(...turns);
    token = asString(frame.data[1]);
    if (!token || turns.length === 0) break;
    if (page === MAX_TURN_PAGES - 1) truncated = true;
  }

  return { turns: collected.reverse(), truncated };
};

// --- SPEC §3 mapping ---

export interface Omitted {
  reasoning: number;
  tool_calls: number;
  hidden: number;
  empty: number;
}

export interface MapOptions {
  includeReasoning: boolean;
  includeToolCalls: boolean;
}

export interface MappedItems {
  items: ResponseItem[];
  omitted: Omitted;
}

/** Research extension slot 58: `[taskId, [ … [title, null, steps[]] … ]]`. */
const RESEARCH_TASK_KEY = '58';

interface ResearchSource {
  title: string;
  url: string;
  snippet: string | null;
}

/**
 * A research step is `[…, [1, null, [faviconUrl, url, title, …]]]` for a visited
 * source and `[…, …, [heading, body]]` for a narration step. Only the first shape
 * carries a URL, so anything else is skipped rather than guessed at.
 */
const collectResearchSources = (value: unknown, into: ResearchSource[]): void => {
  if (!Array.isArray(value)) return;
  const candidate = value as unknown[];
  if (
    candidate.length >= 3 &&
    typeof candidate[0] === 'string' &&
    typeof candidate[1] === 'string' &&
    candidate[1].startsWith('http')
  ) {
    into.push({
      title: typeof candidate[2] === 'string' ? candidate[2] : candidate[1],
      url: candidate[1],
      snippet: null,
    });
    return;
  }
  for (const child of candidate) collectResearchSources(child, into);
};

export const researchSourcesOfTurn = (turn: GeminiTurn): ResearchSource[] => {
  const task = turn.extensions?.[RESEARCH_TASK_KEY];
  if (!task) return [];
  const sources: ResearchSource[] = [];
  collectResearchSources(task, sources);
  const seen = new Set<string>();
  const unique: ResearchSource[] = [];
  for (const source of sources) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    unique.push(source);
  }
  return unique;
};

/** Narration headings Gemini emits while a research run is executing. */
export const researchStepsOfTurn = (turn: GeminiTurn): string[] => {
  const task = turn.extensions?.[RESEARCH_TASK_KEY];
  if (!Array.isArray(task)) return [];
  const steps: string[] = [];
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    const pair = value as unknown[];
    if (
      pair.length === 2 &&
      typeof pair[0] === 'string' &&
      typeof pair[1] === 'string' &&
      !pair[0].startsWith('http')
    ) {
      steps.push(pair[0]);
      return;
    }
    for (const child of pair) walk(child);
  };
  walk(task);
  return steps;
};

export const mapTurnsToItems = (turns: GeminiTurn[], options: MapOptions): MappedItems => {
  const items: ResponseItem[] = [];
  const omitted: Omitted = { reasoning: 0, tool_calls: 0, hidden: 0, empty: 0 };

  for (const turn of turns) {
    // Prompt and response are read from the SAME turn record, so they can never be
    // paired by index across two independently-resolved arrays — the misalignment
    // that a padded DOM scrape used to invent.
    if (turn.promptText)
      items.push({
        id: turn.responseId,
        type: 'message',
        role: 'user',
        status: 'completed',
        created_at: turn.createdAt,
        model: null,
        content: [{ type: 'input_text', text: turn.promptText }],
      });
    else omitted.empty += 1;

    if (turn.thoughts.length > 0) {
      if (options.includeReasoning)
        items.push({
          id: `${turn.responseId}:reasoning`,
          type: 'reasoning',
          summary: turn.thoughts.map(text => ({ type: 'summary_text' as const, text })),
          // Gemini labels an extended-thinking turn "<mode> Extended" and publishes
          // no other effort id, so that suffix is the native level or null.
          effort: turn.modelDisplayName?.endsWith('Extended') ? 'extended' : null,
        });
      else omitted.reasoning += 1;
    }

    const sources = researchSourcesOfTurn(turn);
    if (sources.length > 0) {
      if (options.includeToolCalls)
        items.push({
          id: `${turn.responseId}:research`,
          type: 'web_search_call',
          status: 'completed',
          action: { type: 'research', query: turn.promptText || null, url: null },
          results: sources.map(source => ({
            title: source.title,
            url: source.url,
            snippet: source.snippet,
            site_name: null,
          })),
        });
      else omitted.tool_calls += 1;
    }

    if (turn.responseText)
      items.push({
        id: turn.responseChoiceId ?? `${turn.responseId}:response`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        created_at: turn.createdAt,
        model: turn.modelId,
        // Gemini's transcript RPC carries no citation offsets, so annotations is
        // always empty rather than fabricated — see the get_conversation description.
        content: [{ type: 'output_text', text: turn.responseText, annotations: [] }],
      });
    else omitted.empty += 1;
  }

  return { items, omitted };
};
