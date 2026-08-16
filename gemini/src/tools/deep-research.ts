import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl } from '../gemini-api.js';
import { answerResearch, cancelResearch, readResearch, startResearch } from '../gemini-research.js';
import {
  deepResearchSchema,
  itemVisibilityInputShape,
  researchStatusSchema,
  startDeepResearchInputShape,
  startDeepResearchOutputSchema,
} from './normalized-schemas.js';

const RESEARCH_ID_NOTE =
  'Gemini publishes only the placeholder task id "agency-placeholder-task-id", so research_id IS the ' +
  'conversation id and is interchangeable with conversation_id.';

const STRUCTURAL_NOTE =
  'Status is structural: extension key 56 is the generated plan, key 58 is the research task, candidate slot 30 ' +
  'is the final Markdown report, and a successful cancel is bound to that task response for this session. The report text ' +
  'is never scanned for question marks or status words. Gemini asks for native plan confirmation rather than a ' +
  'free-form clarification: auto_answer_clarifications controls that confirmation, and answer_deep_research ' +
  'confirms a parked plan without sending an ordinary message. Gemini publishes no verified terminal failure marker, ' +
  'so failed is not fabricated from inactivity; error is reserved for an ambiguous confirmation transport result.';

export const startDeepResearch = defineTool({
  name: 'start_deep_research',
  displayName: 'Start Deep Research',
  description:
    'Create a native Gemini Deep Research plan and return the handle, not the final report. By default the tool also ' +
    'sends the native 98-slot "Start research" confirmation and returns queued; when automatic confirmation is false ' +
    `it parks at clarifying until answer_deep_research confirms the plan. ${RESEARCH_ID_NOTE} ${STRUCTURAL_NOTE}`,
  summary: 'Start Gemini Deep Research',
  icon: 'telescope',
  group: 'Deep Research',
  input: z.object({
    ...startDeepResearchInputShape,
    auto_answer_clarifications: z
      .boolean()
      .optional()
      .describe('Confirm the generated native research plan automatically (default true). False parks the run.'),
    clarification_answer: z
      .string()
      .optional()
      .describe(
        'Accepted for normalized compatibility. Gemini has no free-form clarification channel; its plan confirmation is the fixed native "Start research" turn.',
      ),
    model_id: z.string().optional().describe('Mode id from list_models. Defaults to the currently selected mode.'),
    project_id: z
      .string()
      .optional()
      .describe('Not supported until Gemini Notebook membership is exposed; passing it raises VALIDATION_ERROR.'),
  }),
  output: startDeepResearchOutputSchema.extend({ url: z.string() }),
  handle: async params => {
    const started = await startResearch({
      text: params.text,
      modelId: params.model_id,
      projectId: params.project_id,
      autoAnswer: params.auto_answer_clarifications !== false,
    });
    return {
      research_id: started.researchId,
      conversation_id: started.researchId,
      url: conversationUrl(started.researchId),
      status: started.status,
    };
  },
});

export const getDeepResearch = defineTool({
  name: 'get_deep_research',
  displayName: 'Get Deep Research',
  description:
    `Poll a Gemini Deep Research run. ${RESEARCH_ID_NOTE} ${STRUCTURAL_NOTE} ` +
    'progress counts narration steps and every distinct page read; once candidate slot 30 appears, sources switches ' +
    'to the curated report citations and items contains the full final Markdown rather than the short start acknowledgement.',
  summary: 'Poll Gemini Deep Research',
  icon: 'activity',
  group: 'Deep Research',
  input: z.object({
    research_id: z.string().min(1).describe('Conversation id returned by start_deep_research.'),
    ...itemVisibilityInputShape,
  }),
  output: deepResearchSchema.extend({ url: z.string() }),
  handle: async params => {
    const snapshot = await readResearch(params.research_id, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
    });
    return {
      research_id: snapshot.researchId,
      conversation_id: snapshot.conversationId,
      url: snapshot.url,
      status: snapshot.status,
      clarifying_question: snapshot.clarifyingQuestion,
      auto_answered: snapshot.autoAnswered,
      progress: snapshot.progress,
      items: snapshot.items,
      sources: snapshot.sources,
      error: snapshot.error,
    };
  },
});

export const answerDeepResearch = defineTool({
  name: 'answer_deep_research',
  displayName: 'Answer Deep Research',
  description:
    'Confirm a Gemini research plan parked by start_deep_research with auto_answer_clarifications:false. The supplied ' +
    'non-empty text is the caller acknowledgement; Gemini accepts only its native "Start research" continuation, so ' +
    'the adapter sends that exact control turn instead of an ordinary message that could derail the task.',
  summary: 'Answer a research clarification',
  icon: 'message-circle-reply',
  group: 'Deep Research',
  input: z.object({
    research_id: z.string().min(1),
    text: z.string().min(1).describe('Answer to the clarifying question.'),
  }),
  output: startDeepResearchOutputSchema.extend({ url: z.string(), clarifying_question: z.string().nullable() }),
  handle: async params => {
    const snapshot = await answerResearch(params.research_id);
    return {
      research_id: snapshot.researchId,
      conversation_id: snapshot.conversationId,
      url: snapshot.url,
      status: snapshot.status,
      clarifying_question: snapshot.clarifyingQuestion,
    };
  },
});

export const cancelDeepResearch = defineTool({
  name: 'cancel_deep_research',
  displayName: 'Cancel Deep Research',
  description:
    `Cancel a running Gemini Deep Research task with RPC NkpXw, exactly what the native Stop confirmation sends. ${RESEARCH_ID_NOTE} ` +
    'Gemini leaves the persisted task record in its running shape after cancellation, so the successful intent is ' +
    'latched against that response id in sessionStorage; a newer task in the same conversation is not mislabeled, ' +
    'and a report that nevertheless finishes still wins and reports completed.',
  summary: 'Cancel Gemini Deep Research',
  icon: 'square',
  group: 'Deep Research',
  input: z.object({ research_id: z.string().min(1) }),
  output: z.object({
    research_id: z.string(),
    conversation_id: z.string(),
    url: z.string(),
    status: researchStatusSchema,
    cancelled: z.boolean(),
  }),
  handle: async params => {
    const snapshot = await cancelResearch(params.research_id);
    return {
      research_id: snapshot.researchId,
      conversation_id: snapshot.conversationId,
      url: snapshot.url,
      status: snapshot.status,
      cancelled: true,
    };
  },
});
