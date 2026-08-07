import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl } from '../zai-api.js';
import { loadConversationItems } from '../zai-messages.js';
import { DEEP_RESEARCH_SERVER } from '../zai-models.js';
import {
  RESEARCH_STATE_KEY,
  type ResearchSnapshot,
  describeResearch,
  loadResearchSnapshot,
  writeResearchState,
} from '../zai-research.js';
import { prepareTurn, startTurn } from '../zai-send.js';
import {
  DEFAULT_CLARIFICATION_ANSWER,
  itemVisibilityInputShape,
  researchProgressSchema,
  researchSourceSchema,
  researchStatusSchema,
  responseItemSchema,
  startDeepResearchInputShape,
  startDeepResearchOutputSchema,
} from './normalized-schemas.js';

const RESEARCH_ID_NOTE =
  'z.ai runs deep research as a normal chat with the `deep-research` MCP server attached — there is no job resource, so research_id IS the conversation id.';

const CLARIFICATION_NOTE =
  'A clarifying question is detected only when the assistant turn finished, issued zero tool calls, wrote under 1500 characters and contains a question mark — a real run emits tool calls immediately, so a finished report can never be parked as clarifying.';

/**
 * Resuming a run must reuse the model that started it. Falling back to the account
 * default would pick GLM-5.2, which publishes no `deep-research` server, so the
 * resume would be rejected as "does not offer deep research" — on a run that is
 * already in flight.
 */
const researchModelOf = (detail: { chat?: { models?: string[] } }): string | undefined => detail.chat?.models?.[0];

const researchOutputSchema = z.object({
  research_id: z.string(),
  conversation_id: z.string(),
  url: z.string(),
  status: researchStatusSchema,
  clarifying_question: z.string().nullable(),
  auto_answered: z.boolean(),
  progress: researchProgressSchema,
  items: z.array(responseItemSchema),
  sources: z.array(researchSourceSchema),
  error: z.string().nullable(),
});

export const startDeepResearch = defineTool({
  name: 'start_deep_research',
  displayName: 'Start Deep Research',
  description:
    `Kick off a deep-research run and return immediately without waiting for it. ${RESEARCH_ID_NOTE} ` +
    `The run is a completion carrying the ${DEEP_RESEARCH_SERVER} MCP server; model_id must be one whose capabilities.deep_research is true (see list_models) or the call raises VALIDATION_ERROR listing the models that qualify. ` +
    `auto_answer_clarifications and clarification_answer are stored in the chat's own chat.extra.${RESEARCH_STATE_KEY}, so they survive a page reload and are honoured by get_deep_research. ` +
    'Poll get_deep_research for status, progress, items and sources.',
  summary: 'Start a deep-research run',
  icon: 'telescope',
  group: 'Deep Research',
  input: z.object({
    ...startDeepResearchInputShape,
    model_id: z
      .string()
      .optional()
      .describe('Model id from list_models with capabilities.deep_research.supported. Validated before any request.'),
    project_id: z.string().optional().describe('Folder id to create the research conversation inside.'),
  }),
  output: startDeepResearchOutputSchema.extend({ url: z.string() }),
  handle: async params => {
    const prepared = await prepareTurn(
      { text: params.text, model_id: params.model_id, project_id: params.project_id },
      {
        research: true,
        extra: {
          [RESEARCH_STATE_KEY]: {
            auto_answer_clarifications: params.auto_answer_clarifications !== false,
            clarification_answer: params.clarification_answer ?? DEFAULT_CLARIFICATION_ANSWER,
            auto_answered: false,
            clarifying_question: null,
          },
        },
      },
    );
    startTurn(prepared);
    return {
      research_id: prepared.conversationId,
      conversation_id: prepared.conversationId,
      url: conversationUrl(prepared.conversationId),
      status: 'running' as const,
    };
  },
});

const buildReport = async (
  snapshot: ResearchSnapshot,
  researchId: string,
  params: { include_reasoning?: boolean; include_tool_calls?: boolean },
) => {
  const report = describeResearch(snapshot);
  const mapped = await loadConversationItems(snapshot.detail, {
    includeReasoning: params.include_reasoning ?? false,
    includeToolCalls: params.include_tool_calls ?? false,
    effort: snapshot.detail.chat?.reasoning_effort ?? null,
  });
  return {
    research_id: researchId,
    conversation_id: researchId,
    url: conversationUrl(researchId),
    status: report.status,
    clarifying_question: report.clarifying_question,
    auto_answered: report.auto_answered,
    progress: report.progress,
    items: mapped.items,
    sources: report.sources,
    error: report.error,
  };
};

export const getDeepResearch = defineTool({
  name: 'get_deep_research',
  displayName: 'Get Deep Research',
  description:
    `Poll a deep-research run. ${RESEARCH_ID_NOTE} ${CLARIFICATION_NOTE} ` +
    'With auto_answer_clarifications at its default (true) a detected question is answered here automatically and the run continues — status returns to running, auto_answered is true and clarifying_question still echoes what was asked. With it false the run parks in status "clarifying" until answer_deep_research is called. ' +
    'progress.steps_completed counts completed tool calls; sources are de-duplicated by URL.',
  summary: 'Poll a deep-research run',
  icon: 'refresh-cw',
  group: 'Deep Research',
  input: z.object({
    research_id: z.string().describe('The conversation id returned by start_deep_research.'),
    ...itemVisibilityInputShape,
  }),
  output: researchOutputSchema,
  handle: async params => {
    const snapshot = await loadResearchSnapshot(params.research_id);
    const report = describeResearch(snapshot);
    const state = snapshot.state;

    // Auto-answer path: reply once, record what was asked, and report the run as
    // running again rather than hiding the question from the caller.
    if (
      report.clarifying_question &&
      state?.auto_answer_clarifications === true &&
      state.auto_answered === false &&
      report.status === 'completed'
    ) {
      await writeResearchState(params.research_id, {
        auto_answered: true,
        clarifying_question: report.clarifying_question,
      });
      const prepared = await prepareTurn(
        { text: state.clarification_answer, model_id: researchModelOf(snapshot.detail) },
        { conversationId: params.research_id, research: true },
      );
      startTurn(prepared);
      const after = await loadResearchSnapshot(params.research_id);
      const built = await buildReport(after, params.research_id, params);
      return {
        ...built,
        status: 'running' as const,
        auto_answered: true,
        clarifying_question: report.clarifying_question,
      };
    }

    return buildReport(snapshot, params.research_id, params);
  },
});

export const answerDeepResearch = defineTool({
  name: 'answer_deep_research',
  displayName: 'Answer Deep Research',
  description: `Supply the answer to a clarifying question and resume the run. ${RESEARCH_ID_NOTE} Only valid while get_deep_research reports status "clarifying"; calling it otherwise raises VALIDATION_ERROR so a finished report is never derailed by a stray follow-up.`,
  summary: 'Answer a clarifying question',
  icon: 'message-circle-reply',
  group: 'Deep Research',
  input: z.object({
    research_id: z.string().describe('The conversation id returned by start_deep_research.'),
    text: z.string().min(1).describe('The answer to the clarifying question.'),
  }),
  output: startDeepResearchOutputSchema.extend({ url: z.string(), clarifying_question: z.string().nullable() }),
  handle: async params => {
    const snapshot = await loadResearchSnapshot(params.research_id);
    const report = describeResearch(snapshot);
    if (report.status !== 'clarifying')
      throw ToolError.validation(
        `Research ${params.research_id} is "${report.status}", not "clarifying" — there is no question to answer.`,
      );
    await writeResearchState(params.research_id, { clarifying_question: report.clarifying_question });
    const prepared = await prepareTurn(
      { text: params.text, model_id: researchModelOf(snapshot.detail) },
      { conversationId: params.research_id, research: true },
    );
    startTurn(prepared);
    return {
      research_id: params.research_id,
      conversation_id: params.research_id,
      url: conversationUrl(params.research_id),
      status: 'running' as const,
      clarifying_question: report.clarifying_question,
    };
  },
});
