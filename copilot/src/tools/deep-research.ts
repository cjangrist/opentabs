import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { answerResearch, cancelResearch, readResearch, researchUrl, startResearch } from '../copilot-research.js';
import {
  deepResearchSchema,
  itemVisibilityInputShape,
  researchStatusSchema,
  startDeepResearchInputShape,
  startDeepResearchOutputSchema,
} from './normalized-schemas.js';

const STRUCTURE_NOTE =
  "research_id is Copilot's native Task id, distinct from conversation_id. Status, progress, report, and sources " +
  'come from /tasks/{id}; no report text is scanned heuristically. The task-to-conversation mapping is stored only ' +
  'as a cache and is recoverable by walking native research histories after adapter/session state loss.';

export const startDeepResearch = defineTool({
  name: 'start_deep_research',
  displayName: 'Start Deep Research',
  description:
    "Start Copilot's native Deep Research mode and return as soon as the gateway publishes its Task id; it does not " +
    `wait for the report. ${STRUCTURE_NOTE} Copilot launches research directly and has no native clarification gate, ` +
    'so auto_answer_clarifications and clarification_answer are accepted for normalized compatibility but never ' +
    'fabricate a follow-up. project_id creates the owning conversation inside a verified Project. Native remaining ' +
    'quota is checked before any conversation is created.',
  summary: 'Start Copilot Deep Research',
  icon: 'telescope',
  group: 'Deep Research',
  input: z.object({
    ...startDeepResearchInputShape,
    model_id: z
      .string()
      .optional()
      .describe('Omit, or pass smart as a compatibility value; Copilot always uses its dedicated research mode.'),
    project_id: z.string().trim().min(1).optional(),
  }),
  output: startDeepResearchOutputSchema.extend({ url: z.string() }),
  handle: async params => {
    const snapshot = await startResearch({
      text: params.text,
      modelId: params.model_id,
      projectId: params.project_id,
      autoAnswer: params.auto_answer_clarifications !== false,
    });
    return {
      research_id: snapshot.researchId,
      conversation_id: snapshot.conversationId,
      url: researchUrl(snapshot.researchId),
      status: snapshot.status,
    };
  },
});

export const getDeepResearch = defineTool({
  name: 'get_deep_research',
  displayName: 'Get Deep Research',
  description:
    `Poll a Copilot Deep Research Task. ${STRUCTURE_NOTE} The completed report is one assistant message with native ` +
    'citation offsets, sources are de-duplicated by URL, and optional chain-of-thought/query events become normalized ' +
    'reasoning/web_search_call items. Copilot has no clarification step, so clarifying_question is null and auto_answered is false.',
  summary: 'Poll Copilot Deep Research',
  icon: 'activity',
  group: 'Deep Research',
  input: z.object({
    research_id: z.string().trim().min(1),
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
      url: researchUrl(snapshot.researchId),
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
    'Answer a provider clarification when one is pending. Copilot currently launches Deep Research directly, so a ' +
    'normal Task has no clarification and this tool conservatively raises VALIDATION_ERROR rather than sending an ordinary chat message.',
  summary: 'Answer a research clarification',
  icon: 'message-circle-reply',
  group: 'Deep Research',
  input: z.object({
    research_id: z.string().trim().min(1),
    text: z.string().trim().min(1),
  }),
  output: startDeepResearchOutputSchema.extend({ url: z.string(), clarifying_question: z.string().nullable() }),
  handle: async params => {
    const snapshot = await answerResearch(params.research_id, params.text);
    return {
      research_id: snapshot.researchId,
      conversation_id: snapshot.conversationId,
      url: researchUrl(snapshot.researchId),
      status: snapshot.status,
      clarifying_question: snapshot.clarifyingQuestion,
    };
  },
});

export const cancelDeepResearch = defineTool({
  name: 'cancel_deep_research',
  displayName: 'Cancel Deep Research',
  description:
    "Cancel a queued/running Copilot Task with the gateway's native cancelTask command, then poll /tasks/{id} until " +
    'its structural status is cancelled. If the task reached completed or failed first, the terminal truth wins and cancelled is false.',
  summary: 'Cancel Copilot Deep Research',
  icon: 'square',
  group: 'Deep Research',
  input: z.object({ research_id: z.string().trim().min(1) }),
  output: z.object({
    research_id: z.string(),
    conversation_id: z.string(),
    url: z.string(),
    status: researchStatusSchema,
    cancelled: z.boolean(),
  }),
  handle: async params => {
    const result = await cancelResearch(params.research_id);
    return {
      research_id: result.snapshot.researchId,
      conversation_id: result.snapshot.conversationId,
      url: researchUrl(result.snapshot.researchId),
      status: result.snapshot.status,
      cancelled: result.cancelled,
    };
  },
});
