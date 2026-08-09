import { ToolError, getSessionStorage, setSessionStorage } from '@opentabs-dev/plugin-sdk';
import type { RawChatDetail, RawContentPart, RawMessage, RawSearchResult } from './qwen-conversations.js';
import { resolveActivePath } from './qwen-messages.js';
import { CHAT_TYPE_DEEP_RESEARCH, SUB_CHAT_TYPE_DEEP_THINKING, SUB_CHAT_TYPE_INTERRUPT } from './qwen-models.js';
import { DEFAULT_CLARIFICATION_ANSWER, type ResearchStatus } from './tools/normalized-schemas.js';

/**
 * Qwen runs deep research as an ordinary chat whose `chat_type` is `deep_research`,
 * so there is no job resource: the conversation id is the research id. Qwen does
 * mint a native `deep_research_id`, but only once the run itself starts — it is
 * absent while the clarifying turn is outstanding, so it is surfaced as an extra
 * field rather than used as the handle.
 */

// --- Per-run preferences ---
//
// The caller's clarification preferences have to outlive the tool call that set them,
// and Qwen's chat POST is a field-level patch over a fixed key set (title, currentId,
// currentResponseIds, tags, permission) with nowhere to hang free-form state. They are
// therefore kept in the page's sessionStorage, exactly as the claude plugin does. A
// browser restart loses them and the run falls back to the SPEC §7 default
// (auto_answer_clarifications: true).

export interface ResearchPrefs {
  auto: boolean;
  answer: string;
  clarifyingQuestion: string | null;
  autoAnswered: boolean;
  /** Set by cancel_deep_research so a stopped run reports `cancelled`, not `failed`. */
  cancelRequested: boolean;
}

const DEFAULT_PREFS: ResearchPrefs = {
  auto: true,
  answer: DEFAULT_CLARIFICATION_ANSWER,
  clarifyingQuestion: null,
  autoAnswered: false,
  cancelRequested: false,
};

const prefsKey = (conversationId: string): string => `opentabs:qwen:research:${conversationId}`;

export const readPrefs = (conversationId: string): ResearchPrefs => {
  const raw = getSessionStorage(prefsKey(conversationId));
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ResearchPrefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
};

export const writePrefs = (conversationId: string, patch: Partial<ResearchPrefs>): ResearchPrefs => {
  const next = { ...readPrefs(conversationId), ...patch };
  setSessionStorage(prefsKey(conversationId), JSON.stringify(next));
  return next;
};

/** Clarifying turns Qwen labels with a sub type other than `deep_research`. */
const CLARIFYING_SUB_TYPES = new Set([SUB_CHAT_TYPE_DEEP_THINKING, SUB_CHAT_TYPE_INTERRUPT]);

const ANSWER_PHASES = new Set(['answer', 'ReportGeneration']);
const WEB_RESEARCH_PHASE = 'WebResearch';

interface RawResearchStep {
  index?: number;
  query?: string;
  researchGoal?: string;
  stage?: string;
  status?: string;
  webSites?: RawSearchResult[] | null;
}

export interface ResearchSource {
  title: string;
  url: string;
  snippet: string | null;
}

export interface ResearchSnapshot {
  detail: RawChatDetail;
  /** The newest assistant message on the rendered branch, if any. */
  assistant: RawMessage | null;
  /**
   * True when the branch leaf is a user turn — the window between posting an answer
   * and the new assistant message appearing. Without this, the *previous* assistant
   * turn is the newest one on the branch, and a clarification that has already been
   * answered reads as a finished report.
   */
  turnInFlight: boolean;
}

export const loadResearchSnapshot = (detail: RawChatDetail): ResearchSnapshot => {
  const { ordered } = resolveActivePath(detail);
  let assistant: RawMessage | null = null;
  for (const message of ordered) if (message.role === 'assistant') assistant = message;
  const leaf = ordered.at(-1);
  return { detail, assistant, turnInFlight: leaf?.role === 'user' && ordered.length > 1 };
};

export const assertResearchChat = (detail: RawChatDetail, researchId: string): void => {
  if (detail.chat_type !== CHAT_TYPE_DEEP_RESEARCH)
    throw ToolError.notFound(
      `Conversation ${researchId} is a "${detail.chat_type ?? 'unknown'}" chat, not a deep-research run. research_id is the conversation id returned by start_deep_research.`,
    );
};

const partsOf = (message: RawMessage | null): RawContentPart[] => message?.content_list ?? [];

const answerText = (message: RawMessage | null): string =>
  partsOf(message)
    .filter(part => ANSWER_PHASES.has(part.phase ?? '') && typeof part.content === 'string')
    .map(part => part.content as string)
    .join('\n\n')
    .trim();

const researchSteps = (message: RawMessage | null): RawResearchStep[] =>
  partsOf(message)
    .filter(part => part.phase === WEB_RESEARCH_PHASE && Array.isArray(part.extra?.deep_research))
    .flatMap(part => part.extra?.deep_research as RawResearchStep[]);

/**
 * The curated citation table Qwen attaches to the finished report. It is
 * deliberately preferred over the raw `webSites` of each step: a run reads hundreds
 * of pages and cites a hundred, and the references are what the `[[n]]` markers in
 * the report point at.
 */
const referenceSources = (message: RawMessage | null): ResearchSource[] => {
  const byUrl = new Map<string, ResearchSource>();
  for (const part of partsOf(message)) {
    const research = part.extra?.deep_research as { references?: RawSearchResult[] } | undefined;
    for (const reference of research?.references ?? []) {
      if (!reference.url || byUrl.has(reference.url)) continue;
      byUrl.set(reference.url, {
        title: reference.title ?? '',
        url: reference.url,
        snippet: reference.description ?? reference.snippet ?? null,
      });
    }
  }
  return [...byUrl.values()];
};

/** Pages read while the run is still in flight, before the reference table exists. */
const stepSources = (message: RawMessage | null): ResearchSource[] => {
  const byUrl = new Map<string, ResearchSource>();
  for (const step of researchSteps(message)) {
    for (const site of step.webSites ?? []) {
      if (!site.url || byUrl.has(site.url)) continue;
      byUrl.set(site.url, {
        title: site.title ?? '',
        url: site.url,
        snippet: site.snippet ?? site.description ?? null,
      });
    }
  }
  return [...byUrl.values()];
};

export const collectSources = (message: RawMessage | null): ResearchSource[] => {
  const references = referenceSources(message);
  return references.length > 0 ? references : stepSources(message);
};

/** Qwen marks a finished research step with a status ending in "Finished". */
const isStepFinished = (step: RawResearchStep): boolean => /finished$/i.test(step.status ?? '');

export const nativeResearchId = (message: RawMessage | null): string | null => {
  const info = message?.extra?.deep_research_info as { deep_research_id?: string } | undefined;
  return info?.deep_research_id ?? null;
};

export interface ResearchStatusReport {
  status: ResearchStatus;
  clarifying_question: string | null;
  progress: { steps_completed: number; current_step: string | null; sources_found: number };
  sources: ResearchSource[];
  error: string | null;
}

/**
 * Classifies a research run from its message tree alone.
 *
 * Detection is structural, not textual: Qwen labels every turn with a `sub_chat_type`,
 * and a clarifying turn is exactly one whose sub type is `deep_thinking` (the sub
 * type a research chat opens with) or `interrupt` (a mid-run follow-up). The real run
 * carries `deep_research` and emits ResearchNotice / ResearchPlanning / WebResearch
 * phases, so a finished 119-source report can never be parked as `clarifying`, which
 * SPEC §7 calls out as the worse failure.
 */
export const describeResearch = (snapshot: ResearchSnapshot): ResearchStatusReport => {
  const assistant = snapshot.assistant;
  const steps = researchSteps(assistant);
  const sources = collectSources(assistant);
  const lastStep = steps.at(-1);
  const progress = {
    steps_completed: steps.filter(isStepFinished).length,
    current_step: lastStep?.query ?? lastStep?.stage ?? null,
    sources_found: sources.length,
  };
  const cancelled = readPrefs(snapshot.detail.id ?? '').cancelRequested === true;

  if (!assistant) return { status: 'queued', clarifying_question: null, progress, sources, error: null };

  // A user turn at the leaf means an answer has been posted and the next assistant
  // message has not landed yet. Checked before `error` as well as before `completed`:
  // a run whose previous turn failed and has since been answered is being retried.
  if (snapshot.turnInFlight) return { status: 'running', clarifying_question: null, progress, sources, error: null };

  // Qwen stamps `is_stop: true` on a turn ended by the stop button, which is exactly
  // what cancel_deep_research drives. This is the authoritative signal and beats the
  // sessionStorage flag: it is recorded server side, so the run still reports
  // `cancelled` after a browser restart, and it never mislabels a genuine failure.
  if (assistant.is_stop === true)
    return { status: 'cancelled', clarifying_question: null, progress, sources, error: null };

  if (assistant.status === 'error')
    return {
      status: 'failed',
      clarifying_question: null,
      progress,
      sources,
      error: `Qwen marked the research turn as failed${assistant.content ? `: ${assistant.content.slice(0, 300)}` : '.'}`,
    };

  const finished = assistant.done === true;
  const clarifying = CLARIFYING_SUB_TYPES.has(assistant.sub_chat_type ?? '');

  if (!finished)
    return {
      // The window between cancel_deep_research returning and Qwen flushing is_stop
      // to the record: report the caller's intent rather than "running".
      status: cancelled ? 'cancelled' : 'running',
      clarifying_question: clarifying ? answerText(assistant) || null : null,
      progress,
      sources,
      error: null,
    };

  if (clarifying)
    return { status: 'clarifying', clarifying_question: answerText(assistant) || null, progress, sources, error: null };

  // A finished report is a finished report: Qwen did not flag it stopped, so a stale
  // cancel intent must not relabel real output as `cancelled`.
  return { status: 'completed', clarifying_question: null, progress, sources, error: null };
};

/** Assistant messages of the newest turn that are still generating. */
export const inFlightResponseIds = (detail: RawChatDetail): string[] => {
  const messages = detail.chat?.history?.messages ?? {};
  const candidates = detail.chat?.history?.currentResponseIds ?? detail.currentResponseIds ?? Object.keys(messages);
  return candidates.filter(id => {
    const message = messages[id];
    return message?.role === 'assistant' && message.done !== true;
  });
};

/** The clarifying question of the newest turn, or null when it is not asking one. */
export const clarifyingQuestionOf = (snapshot: ResearchSnapshot): string | null => {
  const report = describeResearch(snapshot);
  return report.status === 'clarifying' ? report.clarifying_question : null;
};
