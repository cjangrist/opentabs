import { toUnixSeconds } from './perplexity-api.js';
import type { ResponseItem } from './tools/normalized-schemas.js';

// --- Raw thread shapes ---

export interface RawWebResult {
  name?: string;
  url?: string;
  snippet?: string;
  meta_data?: { domain_name?: string; citation_domain_name?: string };
}

interface RawMarkdownBlock {
  answer?: string;
}

interface RawPlanGoal {
  id?: string;
  description?: string;
  final?: boolean;
}

export interface RawStep {
  uuid?: string;
  step_type?: string;
  initial_query_content?: { query?: string };
  search_web_content?: { goal_id?: string; queries?: { engine?: string; query?: string }[] };
  web_results_content?: { goal_id?: string; web_results?: RawWebResult[] };
  thought_content?: { goal_id?: string; thought?: string; web_results?: RawWebResult[] };
  get_url_content_content?: { goal_id?: string; pages?: { url?: string }[] };
  code_content?: {
    goal_id?: string;
    script?: string;
    language?: string;
    output?: string;
    stdout?: string;
    stderr?: string;
    error?: string;
    status?: string;
  };
  research_clarifying_questions_content?: {
    uuid?: string;
    title?: string;
    questions?: { question_text?: string; options?: string[] }[];
    answers?: { question?: string; answer?: string }[];
    auto_skip_seconds?: number;
  };
  research_answer_content?: { title?: string; url?: string; file_name?: string; summary?: string; answer?: string };
  read_tool_content?: Record<string, unknown>;
  attachment_content?: Record<string, unknown>;
}

export interface RawPlanBlock {
  progress?: string;
  goals?: RawPlanGoal[];
  steps?: RawStep[];
  final?: boolean;
  pct_complete?: number;
  eta_seconds_remaining?: number;
}

export interface RawBlock {
  intended_usage?: string;
  markdown_block?: RawMarkdownBlock;
  plan_block?: RawPlanBlock;
  web_result_block?: { web_results?: RawWebResult[] };
}

export interface RawEntry {
  backend_uuid?: string;
  context_uuid?: string;
  uuid?: string;
  read_write_token?: string;
  thread_url_slug?: string;
  thread_title?: string;
  query_str?: string;
  display_model?: string;
  mode?: string;
  status?: string;
  entry_created_datetime?: string;
  updated_datetime?: string;
  blocks?: RawBlock[];
  related_query_items?: { text?: string }[];
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

type ItemStatus = 'completed' | 'in_progress' | 'incomplete';

export const entryStatus = (status: string | undefined): ItemStatus => {
  const value = (status ?? '').toUpperCase();
  if (value === 'COMPLETED' || value === 'SUCCESS') return 'completed';
  if (value.includes('FAIL') || value.includes('ERROR') || value.includes('CANCEL')) return 'incomplete';
  return 'in_progress';
};

const truncate = (text: string): string =>
  text.length <= TOOL_OUTPUT_LIMIT
    ? text
    : `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n… [truncated ${text.length - TOOL_OUTPUT_LIMIT} characters]`;

const mapResults = (results: RawWebResult[] | undefined) =>
  (results ?? []).map(result => ({
    title: result.name ?? '',
    url: result.url ?? '',
    snippet: result.snippet ?? null,
    site_name: result.meta_data?.domain_name ?? result.meta_data?.citation_domain_name ?? null,
  }));

/**
 * An entry carries the same answer twice: `ask_text` is the rendered answer the
 * page shows, and `ask_text_<n>_markdown` are the schematized sections it was
 * assembled from. `ask_text` is preferred because it is exactly the joined text
 * (verified live: the numbered sections of a 21-section answer sum to `ask_text`
 * to the separator). When it is missing — a turn still streaming — EVERY
 * numbered section is joined in index order; reading only the last would return
 * a fragment of the answer.
 */
export const extractAnswerText = (blocks: RawBlock[]): string => {
  const rendered = blocks.find(block => block.intended_usage === 'ask_text')?.markdown_block?.answer;
  if (rendered) return rendered;
  const numbered = blocks
    .map(block => ({ block, match: /^ask_text_(\d+)_markdown$/.exec(block.intended_usage ?? '') }))
    .filter((entry): entry is { block: RawBlock; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .map(entry => entry.block.markdown_block?.answer ?? '')
    .filter(Boolean);
  if (numbered.length > 0) return numbered.join('\n');
  return blocks.find(block => block.markdown_block?.answer)?.markdown_block?.answer ?? '';
};

export const extractSources = (blocks: RawBlock[]): RawWebResult[] =>
  blocks.find(block => block.web_result_block)?.web_result_block?.web_results ?? [];

export const extractSteps = (blocks: RawBlock[]): RawStep[] =>
  blocks.find(block => block.intended_usage === 'pro_search_steps')?.plan_block?.steps ?? [];

export const extractPlan = (blocks: RawBlock[]): RawPlanBlock | null =>
  blocks.find(block => block.intended_usage === 'plan')?.plan_block ?? null;

/**
 * Perplexity cites with numbered `[n]` markers that index into the entry's
 * web_results list, so every marker resolves to a real URL at a real offset in
 * the answer text. Markers pointing past the end of the source list are left
 * alone rather than annotated against the wrong page.
 */
const citationAnnotations = (text: string, sources: RawWebResult[]) => {
  const annotations: {
    type: 'url_citation';
    url: string;
    title: string;
    start_index: number | null;
    end_index: number | null;
  }[] = [];
  for (const match of text.matchAll(/\[(\d{1,3})\]/g)) {
    const index = Number(match[1]) - 1;
    const source = sources[index];
    if (!source?.url || match.index === undefined) continue;
    annotations.push({
      type: 'url_citation',
      url: source.url,
      title: source.name ?? '',
      start_index: match.index,
      end_index: match.index + match[0].length,
    });
  }
  return annotations;
};

const renderCodeOutput = (code: NonNullable<RawStep['code_content']>): string | null => {
  const parts = [
    code.output ? `output:\n${code.output}` : '',
    code.stdout ? `stdout:\n${code.stdout}` : '',
    code.stderr ? `stderr:\n${code.stderr}` : '',
    code.error ? `error:\n${code.error}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? truncate(parts.join('\n\n')) : null;
};

export interface MapOptions {
  includeReasoning: boolean;
  includeToolCalls: boolean;
}

interface StepMapping {
  items: ResponseItem[];
  reasoningDropped: number;
  toolCallsDropped: number;
  hidden: number;
}

/**
 * Flattens one entry's `pro_search_steps` into SPEC §3 items.
 *
 * SEARCH_WEB and SEARCH_RESULTS are two separate steps joined by `goal_id`, so
 * results are attached to the search that produced them instead of being emitted
 * as a second, query-less item.
 */
const mapSteps = (steps: RawStep[], entryId: string, options: MapOptions, turnStatus: ItemStatus): StepMapping => {
  const items: ResponseItem[] = [];
  let reasoningDropped = 0;
  let toolCallsDropped = 0;
  let hidden = 0;

  const resultsByGoal = new Map<string, RawWebResult[]>();
  for (const step of steps) {
    if (step.step_type !== 'SEARCH_RESULTS') continue;
    const goal = step.web_results_content?.goal_id ?? '';
    resultsByGoal.set(goal, [...(resultsByGoal.get(goal) ?? []), ...(step.web_results_content?.web_results ?? [])]);
  }

  let index = -1;
  for (const step of steps) {
    index += 1;
    const stepId = step.uuid || `${entryId}#${index}`;
    const type = step.step_type ?? '';

    // The user's own prompt; emitted once as the user message instead.
    if (type === 'INITIAL_QUERY') continue;
    // Results are folded into their SEARCH_WEB step above.
    if (type === 'SEARCH_RESULTS') continue;

    if (type === 'THOUGHT') {
      const thought = step.thought_content?.thought ?? '';
      if (!thought) {
        hidden += 1;
        continue;
      }
      if (!options.includeReasoning) {
        reasoningDropped += 1;
        continue;
      }
      // Perplexity records no effort/level on a thought — reasoning is a model
      // choice here, not a graded setting.
      items.push({ id: stepId, type: 'reasoning', summary: [{ type: 'summary_text', text: thought }], effort: null });
      continue;
    }

    if (type === 'SEARCH_WEB') {
      if (!options.includeToolCalls) {
        toolCallsDropped += 1;
        continue;
      }
      const goal = step.search_web_content?.goal_id ?? '';
      const results = mapResults(resultsByGoal.get(goal));
      const queries = (step.search_web_content?.queries ?? []).map(query => query.query ?? '').filter(Boolean);
      // A search that matched nothing is still a finished search: the only honest
      // "in progress" signal is the turn itself still streaming. Keying off an
      // empty result list would mark every zero-hit memory lookup as pending.
      items.push({
        id: stepId,
        type: 'web_search_call',
        status: turnStatus === 'in_progress' ? 'in_progress' : 'completed',
        action: { type: 'search', query: queries.join(' | ') || null, url: null },
        results,
      });
      continue;
    }

    if (type === 'GET_URL_CONTENT') {
      if (!options.includeToolCalls) {
        toolCallsDropped += 1;
        continue;
      }
      const pages = (step.get_url_content_content?.pages ?? []).map(page => page.url ?? '').filter(Boolean);
      items.push({
        id: stepId,
        type: 'web_search_call',
        status: 'completed',
        action: { type: 'open_page', query: null, url: pages[0] ?? null },
        results: pages.map(url => ({ title: '', url, snippet: null, site_name: null })),
      });
      continue;
    }

    if (type === 'CODE') {
      if (!options.includeToolCalls) {
        toolCallsDropped += 1;
        continue;
      }
      const code = step.code_content ?? {};
      items.push({
        id: stepId,
        type: 'tool_call',
        name: 'code_interpreter',
        status: code.error ? 'incomplete' : code.status === 'success' ? 'completed' : 'in_progress',
        arguments: { language: code.language ?? '', script: code.script ?? '' },
        output: renderCodeOutput(code),
      });
      continue;
    }

    if (type === 'RESEARCH_CLARIFYING_QUESTIONS') {
      if (!options.includeToolCalls) {
        toolCallsDropped += 1;
        continue;
      }
      const content = step.research_clarifying_questions_content ?? {};
      const answers = content.answers ?? [];
      items.push({
        id: stepId,
        type: 'tool_call',
        name: 'research_clarifying_questions',
        // An unanswered question on a FINISHED run is one Perplexity skipped on
        // its own 60-second timer, not one still waiting for input.
        status: answers.length > 0 ? 'completed' : turnStatus === 'in_progress' ? 'in_progress' : 'incomplete',
        arguments: {
          title: content.title ?? '',
          questions: (content.questions ?? []).map(question => question.question_text ?? ''),
        },
        output:
          answers.length > 0
            ? truncate(answers.map(a => `${a.question ?? ''}: ${a.answer ?? ''}`).join('\n'))
            : null,
      });
      continue;
    }

    if (type === 'RESEARCH_ANSWER') {
      if (!options.includeToolCalls) {
        toolCallsDropped += 1;
        continue;
      }
      const content = step.research_answer_content ?? {};
      items.push({
        id: stepId,
        type: 'tool_call',
        name: 'research_answer',
        status: 'completed',
        arguments: { title: content.title ?? '', file_name: content.file_name ?? '' },
        output: truncate(content.answer || content.summary || content.url || '') || null,
      });
      continue;
    }

    // Any other step Perplexity adds later still becomes a tool_call rather than
    // vanishing; its own payload key is the argument set.
    if (!options.includeToolCalls) {
      toolCallsDropped += 1;
      continue;
    }
    const payloadKey = Object.keys(step).find(key => key.endsWith('_content'));
    items.push({
      id: stepId,
      type: 'tool_call',
      name: type.toLowerCase() || 'unknown',
      status: 'completed',
      arguments: payloadKey ? ((step as Record<string, unknown>)[payloadKey] as Record<string, unknown>) : {},
      output: null,
    });
  }

  return { items, reasoningDropped, toolCallsDropped, hidden };
};

/**
 * Maps Perplexity thread entries onto SPEC §3 items.
 *
 * Each entry is one prompt and one answer, so it becomes a `user` message, the
 * steps it ran, and an `assistant` message — in that order. An entry that
 * carries no prompt is NOT paired with the next entry's answer: the two halves
 * are counted in `omitted.empty` instead, because padding would manufacture a
 * turn that never happened.
 */
export const mapEntriesToItems = (entries: RawEntry[], options: MapOptions): MappedItems => {
  const items: ResponseItem[] = [];
  const omitted: OmittedCounts = { reasoning: 0, tool_calls: 0, hidden: 0, empty: 0 };

  for (const entry of entries) {
    const blocks = entry.blocks ?? [];
    const entryId = entry.backend_uuid ?? entry.uuid ?? '';
    const createdAt = toUnixSeconds(entry.entry_created_datetime ?? entry.updated_datetime);
    const status = entryStatus(entry.status);

    const prompt = entry.query_str ?? '';
    if (prompt)
      items.push({
        id: `${entryId}:query`,
        type: 'message',
        role: 'user',
        status: 'completed',
        created_at: createdAt,
        model: null,
        content: [{ type: 'input_text', text: prompt }],
      });
    else omitted.empty += 1;

    const mapped = mapSteps(extractSteps(blocks), entryId, options, status);
    items.push(...mapped.items);
    omitted.reasoning += mapped.reasoningDropped;
    omitted.tool_calls += mapped.toolCallsDropped;
    omitted.hidden += mapped.hidden;

    const answer = extractAnswerText(blocks);
    if (!answer) {
      omitted.empty += 1;
      continue;
    }
    items.push({
      id: entryId,
      type: 'message',
      role: 'assistant',
      status,
      created_at: toUnixSeconds(entry.updated_datetime ?? entry.entry_created_datetime),
      model: entry.display_model || null,
      content: [
        { type: 'output_text', text: answer, annotations: citationAnnotations(answer, extractSources(blocks)) },
      ],
    });
  }

  return { items, omitted };
};
