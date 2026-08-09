import { ToolError, getSessionStorage, setSessionStorage } from '@opentabs-dev/plugin-sdk';
import { api } from './perplexity-api.js';
import { fetchThreadPage } from './perplexity-conversations.js';
import {
  type RawEntry,
  type RawStep,
  entryStatus,
  extractPlan,
  extractSources,
  extractSteps,
  mapEntriesToItems,
} from './perplexity-messages.js';
import { DEFAULT_CLARIFICATION_ANSWER, type ResearchStatus, type ResponseItem } from './tools/normalized-schemas.js';

// --- Per-job preferences ---
// Kept in the page's sessionStorage so get_deep_research knows whether the caller
// asked for auto-answered clarifications. A browser restart loses it and the job
// falls back to the SPEC default (auto_answer_clarifications: true).

export interface ResearchPrefs {
  auto: boolean;
  answer: string;
  clarifyingQuestion: string | null;
  autoAnswered: boolean;
  /** Set by cancel_deep_research so a stopped run reports `cancelled`, not `failed`. */
  cancelRequested?: boolean;
}

const DEFAULT_PREFS: ResearchPrefs = {
  auto: true,
  answer: DEFAULT_CLARIFICATION_ANSWER,
  clarifyingQuestion: null,
  autoAnswered: false,
};

const prefsKey = (researchId: string): string => `opentabs:perplexity:research:${researchId}`;

export const readPrefs = (researchId: string): ResearchPrefs => {
  const raw = getSessionStorage(prefsKey(researchId));
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ResearchPrefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
};

export const writePrefs = (researchId: string, prefs: ResearchPrefs): void => {
  setSessionStorage(prefsKey(researchId), JSON.stringify(prefs));
};

// --- Clarification ---

export interface Clarification {
  toolUuid: string;
  title: string;
  questions: string[];
  answered: boolean;
}

/**
 * Detecting "is this a clarifying question?", conservatively.
 *
 * Perplexity does not phrase clarifications as prose that has to be guessed at:
 * the research run emits a dedicated `RESEARCH_CLARIFYING_QUESTIONS` step whose
 * content carries the question list, the tool uuid to answer against, and an
 * `answers` array that fills in once the question has been resolved. A run is
 * therefore treated as clarifying ONLY when such a step exists AND its `answers`
 * array is still empty — a structural signal, so a completed run can never be
 * parked by mistake. (Perplexity also auto-skips the question itself after
 * `auto_skip_seconds`, which likewise fills `answers`.)
 */
export const findClarification = (steps: RawStep[]): Clarification | null => {
  for (const step of steps) {
    if (step.step_type !== 'RESEARCH_CLARIFYING_QUESTIONS') continue;
    const content = step.research_clarifying_questions_content;
    if (!content?.uuid) continue;
    return {
      toolUuid: content.uuid,
      title: content.title ?? '',
      questions: (content.questions ?? []).map(question => question.question_text ?? '').filter(Boolean),
      answered: (content.answers ?? []).length > 0,
    };
  }
  return null;
};

export const describeClarification = (clarification: Clarification): string =>
  [clarification.title, ...clarification.questions].filter(Boolean).join('\n');

/**
 * Submits answers to a research clarification. This is the exact call the
 * question card issues; `submit_type` distinguishes a real answer from the
 * card's own 60-second timeout skip.
 */
export const submitClarification = async (clarification: Clarification, answer: string): Promise<void> => {
  await api('/sse/handle_perplexity_research_clarifying_answers', {
    method: 'POST',
    body: {
      result: {
        tool_uuid: clarification.toolUuid,
        answers: clarification.questions.map(question => ({ question, answer })),
        submit_type: 'USER_SUBMITTED',
      },
    },
    timeout: 30_000,
  });
};

// --- Reading a run ---

export interface ResearchSnapshot {
  status: ResearchStatus;
  clarifyingQuestion: string | null;
  autoAnswered: boolean;
  progress: { steps_completed: number; current_step: string | null; sources_found: number };
  items: ResponseItem[];
  sources: { title: string; url: string; snippet: string | null }[];
  error: string | null;
  conversationId: string;
}

const latestEntry = (entries: RawEntry[]): RawEntry | undefined => entries[entries.length - 1];

export const readResearch = async (
  researchId: string,
  options: { includeReasoning: boolean; includeToolCalls: boolean },
): Promise<ResearchSnapshot> => {
  const page = await fetchThreadPage(researchId, 1);
  const entry = latestEntry(page.entries);
  const blocks = entry?.blocks ?? [];
  const steps = extractSteps(blocks);
  const plan = extractPlan(blocks);
  const sources = extractSources(blocks);
  const prefs = readPrefs(researchId);

  const clarification = findClarification(steps);
  const pendingClarification = clarification !== null && !clarification.answered;
  if (clarification && !prefs.clarifyingQuestion) {
    prefs.clarifyingQuestion = describeClarification(clarification);
    writePrefs(researchId, prefs);
  }

  // Auto-answer on read: the question can appear seconds after start_deep_research
  // has already returned, so this is the only place it can be caught without
  // blocking the start call (SPEC §7 requires start to return promptly).
  let autoAnswered = prefs.autoAnswered;
  if (pendingClarification && prefs.auto && clarification) {
    await submitClarification(clarification, prefs.answer);
    autoAnswered = true;
    writePrefs(researchId, { ...prefs, autoAnswered: true });
  }

  const itemStatus = entryStatus(entry?.status);
  let status: ResearchStatus;
  if (prefs.cancelRequested) status = 'cancelled';
  else if (itemStatus === 'incomplete') status = 'failed';
  else if (itemStatus === 'completed') status = 'completed';
  else if (pendingClarification && !prefs.auto) status = 'clarifying';
  else if (steps.length === 0) status = 'queued';
  else status = 'running';

  const goals = plan?.goals ?? [];
  const mapped = mapEntriesToItems(entry ? [entry] : [], options);

  return {
    status,
    clarifyingQuestion: prefs.clarifyingQuestion,
    autoAnswered,
    progress: {
      steps_completed: steps.length,
      current_step: goals[goals.length - 1]?.description ?? null,
      sources_found: sources.length,
    },
    items: mapped.items,
    sources: sources.map(source => ({
      title: source.name ?? '',
      url: source.url ?? '',
      snippet: source.snippet ?? null,
    })),
    error: status === 'failed' ? `Perplexity reported entry status "${entry?.status ?? 'unknown'}".` : null,
    conversationId: entry?.thread_url_slug || researchId,
  };
};

/** Stops an in-flight run. Perplexity's own Stop button issues exactly this call. */
export const terminateResearch = async (researchId: string, modelId: string): Promise<void> => {
  const page = await fetchThreadPage(researchId, 1);
  const entry = latestEntry(page.entries);
  if (!entry?.backend_uuid) throw ToolError.notFound(`Perplexity thread "${researchId}" has no entry to cancel.`);
  await api('/sse/perplexity_terminate', {
    method: 'POST',
    body: {
      entry_uuid: entry.backend_uuid,
      context_uuid: entry.context_uuid,
      model_preference: modelId,
      terminate_requested_at_ms: Date.now(),
    },
    timeout: 20_000,
  });
};
