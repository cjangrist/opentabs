import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl } from '../perplexity-api.js';
import { getModelCatalog, resolveModelId } from '../perplexity-models.js';
import { resolveCollection } from '../perplexity-projects.js';
import {
  type Clarification,
  findClarification,
  readPrefs,
  readResearch,
  submitClarification,
  terminateResearch,
  writePrefs,
} from '../perplexity-research.js';
import { extractSteps } from '../perplexity-messages.js';
import { fetchThreadPage } from '../perplexity-conversations.js';
import { prepareTurn, resolveStartedThread, runAsk } from '../perplexity-send.js';
import {
  deepResearchSchema,
  itemVisibilityInputShape,
  startDeepResearchInputShape,
  startDeepResearchOutputSchema,
} from './normalized-schemas.js';

const RESEARCH_ID_NOTE =
  'Perplexity gives a research run no identity of its own — it is an ordinary thread driven by the Deep research ' +
  'model — so research_id IS the thread slug and is interchangeable with conversation_id.';

const CLARIFICATION_NOTE =
  'Clarification detection is structural, not heuristic: a Perplexity research run emits a dedicated ' +
  'RESEARCH_CLARIFYING_QUESTIONS step carrying the question list, the tool uuid to answer against, and an `answers` ' +
  'array that fills in once resolved. A run is reported as clarifying ONLY while such a step exists with an empty ' +
  '`answers`, so a completed run can never be parked by mistake. Perplexity also auto-skips the question itself ' +
  'after ~60s, which fills `answers` the same way.';

const researchModel = async (modelId: string | undefined): Promise<string> => {
  const catalog = await getModelCatalog();
  if (modelId) return resolveModelId(catalog, modelId);
  const fallback = catalog.researchModelId;
  if (!fallback)
    throw new ToolError('Perplexity published no Deep research model for this account.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  const availability = catalog.modeAvailability.research;
  if (availability && !availability.available)
    throw new ToolError(
      `This Perplexity account has no Deep research runs left (${availability.remaining ?? 0} remaining in the ` +
        'current window). Wait for the window to refill or upgrade the plan.',
      'RATE_LIMIT',
      { category: 'rate_limit', retryable: true },
    );
  return fallback;
};

export const startDeepResearch = defineTool({
  name: 'start_deep_research',
  displayName: 'Start Deep Research',
  description:
    'Start a Perplexity Deep research run. Returns as soon as the thread exists — it does NOT block for the whole ' +
    `run, which takes minutes. Poll get_deep_research. ${RESEARCH_ID_NOTE} ${CLARIFICATION_NOTE} With ` +
    'auto_answer_clarifications true (default) the question is answered automatically on the next get_deep_research ' +
    'call, which still reports auto_answered:true and echoes the question.',
  summary: 'Start a Perplexity Deep research run',
  icon: 'telescope',
  group: 'Deep Research',
  input: z.object({
    ...startDeepResearchInputShape,
    model_id: z
      .string()
      .optional()
      .describe("Research model id. Defaults to the account's Deep research model from list_models."),
    project_id: z.string().optional().describe('Space uuid or slug to file the run into.'),
  }),
  output: startDeepResearchOutputSchema,
  handle: async params => {
    const model = await researchModel(params.model_id);
    const collectionUuid = params.project_id ? (await resolveCollection(params.project_id)).uuid : undefined;
    const prepared = await prepareTurn({ text: params.text, search: true }, { collectionUuid, modelOverride: model });

    // A research run holds the SSE connection open for minutes. Start it and let
    // it run in the page — the work is persisted server-side and read back from
    // the thread, which is what SPEC §7's "must return promptly" requires.
    void runAsk(prepared.options).catch(() => {
      // get_deep_research reports the real outcome from the thread.
    });

    const started = await resolveStartedThread(prepared.options.frontendUuid, prepared.options.frontendContextUuid, 6);
    if (!started)
      throw new ToolError(
        'Perplexity accepted the research query but the thread had not appeared in the Library within the tool ' +
          'budget. It is still running — call list_conversations to find it.',
        'TIMEOUT',
        { category: 'timeout', retryable: true },
      );

    writePrefs(started.conversationId, {
      auto: params.auto_answer_clarifications ?? true,
      answer: params.clarification_answer ?? 'Include everything.',
      clarifyingQuestion: null,
      autoAnswered: false,
    });

    return { research_id: started.conversationId, conversation_id: started.conversationId, status: 'running' as const };
  },
});

export const getDeepResearch = defineTool({
  name: 'get_deep_research',
  displayName: 'Get Deep Research',
  description:
    `Poll a Perplexity Deep research run. ${RESEARCH_ID_NOTE} ${CLARIFICATION_NOTE} When the run started with ` +
    'auto_answer_clarifications true, this call submits the stored answer the moment it sees a pending question and ' +
    'reports auto_answered:true; with it false the run parks in status "clarifying" until answer_deep_research. ' +
    "progress.steps_completed counts the run's recorded steps and progress.current_step is its latest goal.",
  summary: 'Poll a Perplexity Deep research run',
  icon: 'activity',
  group: 'Deep Research',
  input: z.object({
    research_id: z.string().min(1).describe('Thread slug returned by start_deep_research.'),
    ...itemVisibilityInputShape,
  }),
  output: deepResearchSchema.extend({ url: z.string() }),
  handle: async params => {
    const snapshot = await readResearch(params.research_id, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
    });
    return {
      research_id: params.research_id,
      conversation_id: snapshot.conversationId,
      status: snapshot.status,
      clarifying_question: snapshot.clarifyingQuestion,
      auto_answered: snapshot.autoAnswered,
      progress: snapshot.progress,
      items: snapshot.items,
      sources: snapshot.sources,
      error: snapshot.error,
      url: conversationUrl(snapshot.conversationId),
    };
  },
});

const currentClarification = async (researchId: string): Promise<Clarification> => {
  const page = await fetchThreadPage(researchId, 1);
  const entry = page.entries[page.entries.length - 1];
  const clarification = findClarification(extractSteps(entry?.blocks ?? []));
  if (!clarification)
    throw ToolError.validation(
      `Perplexity research run "${researchId}" has no clarifying question to answer. Call get_deep_research first.`,
    );
  if (clarification.answered)
    throw ToolError.validation(
      `The clarifying question on run "${researchId}" has already been answered (or Perplexity auto-skipped it).`,
    );
  return clarification;
};

export const answerDeepResearch = defineTool({
  name: 'answer_deep_research',
  displayName: 'Answer Deep Research',
  description:
    'Answer the clarifying question a parked Perplexity research run is waiting on and let it continue. The same ' +
    'text is submitted for every question in the card, which is how Perplexity models a free-text answer.',
  summary: 'Answer a research clarification',
  icon: 'message-circle-question',
  group: 'Deep Research',
  input: z.object({
    research_id: z.string().min(1),
    text: z.string().min(1).describe('The answer to supply.'),
  }),
  output: z.object({ research_id: z.string(), answered: z.boolean(), questions: z.array(z.string()) }),
  handle: async params => {
    const clarification = await currentClarification(params.research_id);
    await submitClarification(clarification, params.text);
    const prefs = readPrefs(params.research_id);
    writePrefs(params.research_id, { ...prefs, autoAnswered: false });
    return { research_id: params.research_id, answered: true, questions: clarification.questions };
  },
});

export const cancelDeepResearch = defineTool({
  name: 'cancel_deep_research',
  displayName: 'Cancel Deep Research',
  description:
    'Stop an in-flight Perplexity research run. This is the same call the Stop button issues; whatever the run had ' +
    'already produced stays in the thread, and get_deep_research then reports status "cancelled".',
  summary: 'Cancel a Perplexity research run',
  icon: 'square',
  group: 'Deep Research',
  input: z.object({ research_id: z.string().min(1) }),
  output: z.object({ research_id: z.string(), cancelled: z.boolean() }),
  handle: async params => {
    const model = await researchModel(undefined);
    await terminateResearch(params.research_id, model);
    const prefs = readPrefs(params.research_id);
    writePrefs(params.research_id, { ...prefs, cancelRequested: true });
    return { research_id: params.research_id, cancelled: true };
  },
});
