import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl } from '../qwen-api.js';
import { getConversationDetail } from '../qwen-conversations.js';
import { mapConversation } from '../qwen-messages.js';
import { SUB_CHAT_TYPE_DEEP_RESEARCH, toResearchMode } from '../qwen-models.js';
import {
  type ResearchSnapshot,
  assertResearchChat,
  describeResearch,
  loadResearchSnapshot,
  nativeResearchId,
  readPrefs,
  writePrefs,
} from '../qwen-research.js';
import { DEEP_RESEARCH_TURN, prepareTurn, startTurn } from '../qwen-send.js';
import {
  DEFAULT_CLARIFICATION_ANSWER,
  itemVisibilityInputShape,
  researchProgressSchema,
  researchSourceSchema,
  researchStatusSchema,
  responseItemSchema,
  startDeepResearchInputShape,
  startDeepResearchOutputSchema,
  thinkingLevelSchema,
} from './normalized-schemas.js';

const RESEARCH_ID_NOTE =
  'Qwen runs deep research as an ordinary chat whose chat_type is "deep_research", so there is no job resource: research_id IS the conversation id. Qwen does mint a native deep_research_id, but only once the run itself starts — it is absent while the clarifying turn is outstanding — so it is reported as native_research_id rather than used as the handle.';

const CLARIFICATION_NOTE =
  'Clarification detection is STRUCTURAL, not textual: Qwen labels every turn with a sub_chat_type, and a clarifying turn is exactly one whose sub type is "deep_thinking" (the sub type a research chat opens with) or "interrupt" (a mid-run follow-up). The real run carries sub_chat_type "deep_research" and emits ResearchNotice / ResearchPlanning / WebResearch phases, so a finished report can never be parked as clarifying. Qwen asks a clarifying question on essentially every run.';

const researchOutputSchema = z.object({
  research_id: z.string(),
  conversation_id: z.string(),
  native_research_id: z.string().nullable().describe('Qwen’s own deep_research_id, once the run has started.'),
  url: z.string(),
  status: researchStatusSchema,
  clarifying_question: z.string().nullable(),
  auto_answered: z.boolean(),
  progress: researchProgressSchema,
  items: z.array(responseItemSchema),
  sources: z.array(researchSourceSchema),
  error: z.string().nullable(),
});

const loadSnapshot = async (researchId: string): Promise<ResearchSnapshot> => {
  const detail = await getConversationDetail(researchId);
  assertResearchChat(detail, researchId);
  return loadResearchSnapshot(detail);
};

const buildReport = (
  snapshot: ResearchSnapshot,
  researchId: string,
  params: { include_reasoning?: boolean; include_tool_calls?: boolean },
) => {
  const report = describeResearch(snapshot);
  const prefs = readPrefs(researchId);
  const mapped = mapConversation(snapshot.detail, {
    includeReasoning: params.include_reasoning ?? false,
    includeToolCalls: params.include_tool_calls ?? false,
  });
  return {
    research_id: researchId,
    conversation_id: researchId,
    native_research_id: nativeResearchId(snapshot.assistant),
    url: conversationUrl(researchId),
    status: report.status,
    // The stored question outlives the turn that asked it, so a run that was
    // auto-answered still reports what it was asked rather than null.
    clarifying_question: report.clarifying_question ?? prefs.clarifyingQuestion,
    auto_answered: prefs.autoAnswered,
    progress: report.progress,
    items: mapped.items,
    sources: report.sources,
    error: report.error,
  };
};

export const startDeepResearch = defineTool({
  name: 'start_deep_research',
  displayName: 'Start Deep Research',
  description:
    `Kick off a deep-research run and return immediately without waiting for it — the completion stream is left running in the page and the run persists server side. ${RESEARCH_ID_NOTE} ` +
    'The run is a completion routed as chat_type "deep_research"; model_id must be one whose meta.chat_type lists deep_research (see list_models capabilities.deep_research) or the call raises VALIDATION_ERROR listing the models that qualify. ' +
    'thinking_level here picks the research EFFORT, not a reasoning mode: minimal/low/medium map to Qwen\'s "normal" research_mode and high/max to "advance". Qwen disables the ordinary reasoning toggle for deep_research chats, so `thinking` is rejected rather than ignored. ' +
    `auto_answer_clarifications and clarification_answer are stored per run in the page's sessionStorage and honoured by get_deep_research. ${CLARIFICATION_NOTE} ` +
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
    project_id: z.string().optional().describe('Project id to create the research conversation inside.'),
    thinking_level: thinkingLevelSchema
      .optional()
      .describe('Research effort: minimal/low/medium -> research_mode "normal", high/max -> "advance".'),
  }),
  output: startDeepResearchOutputSchema.extend({ url: z.string() }),
  handle: async params => {
    const prepared = await prepareTurn(
      { text: params.text, model_id: params.model_id, project_id: params.project_id },
      { ...DEEP_RESEARCH_TURN, researchMode: toResearchMode(params.thinking_level) },
    );
    writePrefs(prepared.conversationId, {
      auto: params.auto_answer_clarifications !== false,
      answer: params.clarification_answer ?? DEFAULT_CLARIFICATION_ANSWER,
      autoAnswered: false,
      clarifyingQuestion: null,
    });
    startTurn(prepared);
    return {
      research_id: prepared.conversationId,
      conversation_id: prepared.conversationId,
      url: conversationUrl(prepared.conversationId),
      status: 'running' as const,
    };
  },
});

export const getDeepResearch = defineTool({
  name: 'get_deep_research',
  displayName: 'Get Deep Research',
  description:
    `Poll a deep-research run. ${RESEARCH_ID_NOTE} ${CLARIFICATION_NOTE} ` +
    'With auto_answer_clarifications at its default (true) a detected question is answered here automatically and the run continues — status returns to running, auto_answered is true and clarifying_question still echoes what was asked. With it false the run parks in status "clarifying" until answer_deep_research is called. ' +
    "progress.steps_completed counts research steps Qwen marked finished, current_step is the newest step's query, and sources are de-duplicated by URL — preferring the curated extra.deep_research.references table the finished report carries, and falling back to the pages each in-flight step read.",
  summary: 'Poll a deep-research run',
  icon: 'refresh-cw',
  group: 'Deep Research',
  input: z.object({
    research_id: z.string().describe('The conversation id returned by start_deep_research.'),
    ...itemVisibilityInputShape,
  }),
  output: researchOutputSchema,
  handle: async params => {
    const snapshot = await loadSnapshot(params.research_id);
    const report = describeResearch(snapshot);
    const prefs = readPrefs(params.research_id);

    if (report.status === 'clarifying' && prefs.auto && !prefs.autoAnswered) {
      writePrefs(params.research_id, { autoAnswered: true, clarifyingQuestion: report.clarifying_question });
      const prepared = await prepareTurn(
        { text: prefs.answer, model_id: snapshot.detail.chat?.models?.[0] ?? snapshot.detail.models?.[0] },
        {
          conversationId: params.research_id,
          ...DEEP_RESEARCH_TURN,
          subChatType: SUB_CHAT_TYPE_DEEP_RESEARCH,
        },
      );
      startTurn(prepared);
      const after = await loadSnapshot(params.research_id);
      return {
        ...buildReport(after, params.research_id, params),
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
  description:
    `Supply the answer to a clarifying question and resume the run. ${RESEARCH_ID_NOTE} ` +
    'Only valid while get_deep_research reports status "clarifying"; calling it otherwise raises VALIDATION_ERROR so a finished report is never derailed by a stray follow-up. The answer is sent as a deep_research turn on the same conversation, which is what starts the actual research pipeline.',
  summary: 'Answer a clarifying question',
  icon: 'message-circle-reply',
  group: 'Deep Research',
  input: z.object({
    research_id: z.string().describe('The conversation id returned by start_deep_research.'),
    text: z.string().min(1).describe('The answer to the clarifying question.'),
  }),
  output: startDeepResearchOutputSchema.extend({ url: z.string(), clarifying_question: z.string().nullable() }),
  handle: async params => {
    const snapshot = await loadSnapshot(params.research_id);
    const report = describeResearch(snapshot);
    if (report.status !== 'clarifying')
      throw ToolError.validation(
        `Research ${params.research_id} is "${report.status}", not "clarifying" — there is no question to answer.`,
      );
    writePrefs(params.research_id, { clarifyingQuestion: report.clarifying_question });
    const prepared = await prepareTurn(
      { text: params.text, model_id: snapshot.detail.chat?.models?.[0] ?? snapshot.detail.models?.[0] },
      { conversationId: params.research_id, ...DEEP_RESEARCH_TURN, subChatType: SUB_CHAT_TYPE_DEEP_RESEARCH },
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
