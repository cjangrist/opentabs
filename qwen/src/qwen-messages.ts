import type { RawChatDetail, RawContentPart, RawMessage, RawSearchResult } from './qwen-conversations.js';
import type { ResponseItem } from './tools/normalized-schemas.js';

// --- Phase classification ---
//
// An assistant turn is an ordered `content_list` of parts, each labelled with a
// `phase`. The phases below are the ones the site bundle's own phase enum declares;
// anything Qwen adds later falls through to a labelled tool_call rather than
// disappearing.

/** Report/answer text. The site groups ReportGeneration with ANSWER, so both are joined. */
const ANSWER_PHASES = new Set(['answer', 'ReportGeneration']);

/**
 * The model's own process narrative. `think` and `thinking_summary` are ordinary
 * reasoning; `ResearchPlanning` / `ResearchNotice` / `DeepThinking` are the
 * deep-research equivalents.
 */
const REASONING_PHASES = new Set(['think', 'thinking_summary', 'DeepThinking', 'ResearchPlanning', 'ResearchNotice']);

/** Phases that carry browsing results. */
const SEARCH_PHASES = new Set(['web_search', 'WebResearch', 'image_search', 'web_search_image', 'web_extractor']);

/** Stream keep-alives and terminators; Qwen's own client drops these (`handle(){return null}`). */
const IGNORED_PHASES = new Set(['KeepAlive', 'finished', 'InterruptReceived']);

const TOOL_OUTPUT_LIMIT = 8000;

/**
 * Qwen cites sources inline as `[[7]]`, and several at once as `[[55,113]]`. The
 * number is 1-based into the turn's own source list — `extra.web_search_info` for a
 * web-search turn, `extra.deep_research.references[].index_number` for a research
 * report.
 */
const CITATION_MARKER_PATTERN = /\[\[([\d\s,]+)\]\]/g;

interface UrlCitation {
  type: 'url_citation';
  url: string;
  title: string;
  start_index: number | null;
  end_index: number | null;
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
}

export interface ActivePath {
  /** Messages along the branch the web app renders, oldest first. */
  ordered: RawMessage[];
  /** Messages on abandoned branches (edits, regenerations) the page does not show. */
  offBranch: number;
}

/**
 * Rebuilds the branch the page renders by walking parents up from `currentId`.
 *
 * Qwen keeps every regenerated and edited turn in the same map, so returning the
 * whole map would report turns the user cannot see and break the "turn count matches
 * the rendered page" bar. Off-branch messages are counted, never silently dropped.
 */
export const resolveActivePath = (detail: RawChatDetail): ActivePath => {
  const messages = detail.chat?.history?.messages ?? {};
  const all = Object.values(messages);
  const currentId = detail.chat?.history?.currentId ?? detail.currentId;

  if (!currentId || !messages[currentId]) {
    // No leaf pointer: fall back to the flat array the older shape carries, else to
    // timestamp order, and claim nothing is hidden.
    const flat = detail.chat?.messages;
    if (Array.isArray(flat) && flat.length > 0) return { ordered: flat, offBranch: 0 };
    const ordered = [...all].sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
    return { ordered, offBranch: 0 };
  }

  // Collected leaf-first and reversed once rather than `unshift`-ed, which would
  // shift the whole array on every step and make rebuilding an n-message branch
  // quadratic. Deep-research threads are exactly the long ones.
  const ordered: RawMessage[] = [];
  const seen = new Set<string>();
  let node: RawMessage | undefined = messages[currentId];
  while (node?.id && !seen.has(node.id)) {
    seen.add(node.id);
    ordered.push(node);
    node = node.parentId ? messages[node.parentId] : undefined;
  }
  ordered.reverse();
  return { ordered, offBranch: all.length - ordered.length };
};

const partText = (part: RawContentPart): string => (typeof part.content === 'string' ? part.content : '');

/**
 * Reads a reasoning part. Qwen's default `thinking_format` is "summary": the part's
 * own `content` is empty and the text lives in `extra.summary_thought` as a growing
 * list of steps, each with a matching title in `summary_title`. Models on the raw
 * format put the text in `content` instead, so both are read.
 */
const reasoningText = (part: RawContentPart): string => {
  const direct = partText(part);
  if (direct) return direct;
  const titles = part.extra?.summary_title?.content ?? [];
  const thoughts = part.extra?.summary_thought?.content ?? [];
  return thoughts
    .map((thought, index) => {
      const title = titles[index];
      return title ? `${title}\n${thought}` : thought;
    })
    .join('\n\n');
};

const normalizeSource = (result: RawSearchResult) => ({
  title: result.title ?? '',
  url: result.url ?? '',
  snippet: result.snippet ?? result.description ?? null,
  site_name: result.hostname ?? result.website ?? null,
});

/** Deep-research steps, each a planned query with the pages it read. */
interface RawResearchStep {
  index?: number;
  query?: string;
  researchGoal?: string;
  stage?: string;
  status?: string;
  webSites?: RawSearchResult[] | null;
}

/**
 * Pulls the cited pages out of one part. A plain web search carries them on
 * `extra.web_search_info` (older messages put the array in `content` instead); a
 * deep-research step carries `extra.deep_research` as an array of steps, each with
 * its own `webSites`.
 */
const partSources = (part: RawContentPart): RawSearchResult[] => {
  const fromExtra = part.extra?.web_search_info;
  if (Array.isArray(fromExtra)) return fromExtra;
  if (Array.isArray(part.content)) return part.content as RawSearchResult[];
  const research = part.extra?.deep_research;
  if (Array.isArray(research))
    return (research as RawResearchStep[]).flatMap(step => (Array.isArray(step.webSites) ? step.webSites : []));
  return [];
};

/** The 1-based reference table a turn's `[[n]]` markers point into. */
const collectReferences = (parts: RawContentPart[]): Map<number, RawSearchResult> => {
  const byIndex = new Map<number, RawSearchResult>();
  for (const part of parts) {
    const research = part.extra?.deep_research as { references?: RawSearchResult[] } | undefined;
    for (const reference of research?.references ?? []) {
      if (typeof reference.index_number === 'number') byIndex.set(reference.index_number, reference);
    }
  }
  // Web-search turns publish no index_number: position in web_search_info is the index.
  if (byIndex.size === 0) {
    let index = 0;
    for (const part of parts) {
      if (!SEARCH_PHASES.has(part.phase ?? '')) continue;
      for (const source of partSources(part)) {
        index += 1;
        byIndex.set(index, source);
      }
    }
  }
  return byIndex;
};

/** Resolves `[[n]]` / `[[n,m]]` markers in the joined text to annotations with real offsets. */
const resolveCitations = (text: string, references: Map<number, RawSearchResult>): UrlCitation[] => {
  if (references.size === 0) return [];
  const annotations: UrlCitation[] = [];
  CITATION_MARKER_PATTERN.lastIndex = 0;
  let match = CITATION_MARKER_PATTERN.exec(text);
  while (match) {
    for (const token of (match[1] ?? '').split(',')) {
      const reference = references.get(Number(token.trim()));
      if (!reference?.url) continue;
      annotations.push({
        type: 'url_citation',
        url: reference.url,
        title: reference.title ?? '',
        start_index: match.index,
        end_index: match.index + match[0].length,
      });
    }
    match = CITATION_MARKER_PATTERN.exec(text);
  }
  return annotations;
};

const renderToolOutput = (part: RawContentPart): string | null => {
  const text = partText(part).trim() || (part.content === undefined ? '' : JSON.stringify(part.content));
  if (!text) return null;
  if (text.length <= TOOL_OUTPUT_LIMIT) return text;
  return `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n… [truncated ${text.length - TOOL_OUTPUT_LIMIT} characters]`;
};

const partStatus = (part: RawContentPart): 'completed' | 'in_progress' | 'incomplete' => {
  if (part.status === 'error' || part.status === 'failed') return 'incomplete';
  if (part.status === 'finished') return 'completed';
  return 'in_progress';
};

const messageStatus = (message: RawMessage): 'completed' | 'in_progress' | 'incomplete' => {
  if (message.status === 'error') return 'incomplete';
  if (message.role !== 'assistant') return 'completed';
  if (message.done === true) return 'completed';
  const parts = message.content_list ?? [];
  return parts.length > 0 && parts.every(part => part.status === 'finished') ? 'completed' : 'in_progress';
};

const describeFiles = (message: RawMessage): string[] =>
  (message.files ?? []).map(file => `[file ${file.name ? `"${file.name}"` : '(unnamed)'}]`);

/**
 * Flattens Qwen's ordered `content_list` into SPEC §3 Responses items.
 *
 * Every answer part is joined with a blank line — a turn that searched and then
 * answered emits several, and returning only the first would truncate the reply to
 * its opening paragraph. Reasoning and tool items for a message are emitted
 * immediately before it, in part order, so one `message` item per turn keeps the
 * item count equal to what the page renders.
 */
export const mapMessagesToItems = (ordered: RawMessage[], offBranch: number, options: MapOptions): MappedItems => {
  const items: ResponseItem[] = [];
  const omitted: OmittedCounts = { reasoning: 0, tool_calls: 0, hidden: offBranch, empty: 0 };

  for (const message of ordered) {
    const messageId = message.id ?? '';
    const role = message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant';
    const parts = message.content_list ?? [];
    const references = collectReferences(parts);
    const textParts: string[] = [];
    let emptyParts = 0;
    let pending = false;
    let partIndex = -1;

    for (const part of parts) {
      partIndex += 1;
      const phase = part.phase ?? 'answer';
      if (IGNORED_PHASES.has(phase)) continue;
      if (part.status !== undefined && part.status !== 'finished') pending = true;

      if (ANSWER_PHASES.has(phase)) {
        const text = partText(part);
        if (text) textParts.push(text);
        else emptyParts += 1;
        continue;
      }

      if (REASONING_PHASES.has(phase)) {
        const thought = reasoningText(part);
        if (!thought) {
          emptyParts += 1;
          continue;
        }
        if (!options.includeReasoning) {
          omitted.reasoning += 1;
          continue;
        }
        items.push({
          // Content parts carry no id of their own, so one is synthesized from the
          // message id and the part's position.
          id: `rs_${messageId}#${partIndex}`,
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: thought }],
          // Qwen records the reasoning setting on the message, not the part.
          effort: message.feature_config?.thinking_mode ?? null,
        });
        continue;
      }

      if (SEARCH_PHASES.has(phase)) {
        if (!options.includeToolCalls) {
          omitted.tool_calls += 1;
          continue;
        }
        const steps = Array.isArray(part.extra?.deep_research) ? (part.extra.deep_research as RawResearchStep[]) : null;
        items.push({
          id: `ws_${messageId}#${partIndex}`,
          type: 'web_search_call',
          status: partStatus(part),
          action: {
            type: phase,
            query: steps
              ? steps
                  .map(step => step.query ?? '')
                  .filter(Boolean)
                  .join(' | ') || null
              : null,
            url: null,
          },
          results: partSources(part)
            .filter(source => source.url)
            .map(normalizeSource),
        });
        continue;
      }

      // Any phase Qwen adds later — code_interpreter, image generation, PdfMdGen, …
      // Never silently discarded: it becomes a labelled tool_call.
      if (!options.includeToolCalls) {
        omitted.tool_calls += 1;
        continue;
      }
      items.push({
        id: `tc_${messageId}#${partIndex}`,
        type: 'tool_call',
        name: phase,
        status: partStatus(part),
        arguments: (part.extra ?? {}) as Record<string, unknown>,
        output: renderToolOutput(part),
      });
    }

    // Assistant turns keep their text in content_list and leave `content` empty; user
    // turns are the reverse. Fall back rather than emit an empty turn.
    if (textParts.length === 0 && typeof message.content === 'string' && message.content)
      textParts.push(message.content);

    const joined = [...textParts, ...describeFiles(message)].filter(Boolean).join('\n\n');
    if (!joined) {
      omitted.empty += 1;
      continue;
    }
    omitted.empty += emptyParts;

    items.push({
      id: messageId,
      type: 'message',
      role,
      status: pending && role === 'assistant' ? 'in_progress' : messageStatus(message),
      created_at: message.timestamp ?? 0,
      model: role === 'assistant' ? (message.model ?? message.models?.[0] ?? null) : null,
      content:
        role === 'user'
          ? [{ type: 'input_text', text: joined }]
          : [{ type: 'output_text', text: joined, annotations: resolveCitations(joined, references) }],
    });
  }

  return { items, omitted };
};

/** Reads a conversation and maps it in one step; shared by get/create/send/research. */
export const mapConversation = (detail: RawChatDetail, options: MapOptions): MappedItems => {
  const { ordered, offBranch } = resolveActivePath(detail);
  return mapMessagesToItems(ordered, offBranch, options);
};
