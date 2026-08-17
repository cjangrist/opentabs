import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { answerResearch, cancelResearch, readResearch, researchUrl, startResearch } from '../grok-research.js';
import {
  deepResearchSchema,
  itemVisibilityInputShape,
  researchStatusSchema,
  startDeepResearchInputShape,
  startDeepResearchOutputSchema,
} from './normalized-schemas.js';

const STRUCTURE_NOTE =
  "research_id is the native Grok conversation id created from Grok's read-only global DeepSearch Project. Status " +
  'comes from native inflight response records, report content comes from stored response nodes, and sources come ' +
  'from structured search fields; report text is never scanned heuristically. The identity remains recoverable after ' +
  'adapter state loss because the conversation itself carries DeepSearch Project membership.';

export const startDeepResearch = defineTool({
  name: 'start_deep_research',
  displayName: 'Start Deep Research',
  description:
    "Start Grok's native DeepSearch template and return after its conversation/response ids exist; it does not wait " +
    `for the report. ${STRUCTURE_NOTE} Grok launches research directly with no clarification gate, so normalized ` +
    'clarification options are accepted but do not fabricate a follow-up. project_id additionally files the owned ' +
    'research conversation in a verified writable Project when Grok supports the combined context.',
  summary: 'Start Grok DeepSearch',
  icon: 'telescope',
  group: 'Deep Research',
  input: z.object({
    ...startDeepResearchInputShape,
    model_id: z.string().optional().describe('Omit, or pass expert; native DeepSearch requires Expert mode.'),
    project_id: z.string().trim().min(1).optional(),
  }),
  output: startDeepResearchOutputSchema.extend({ url: z.string() }),
  handle: async params => {
    const snapshot = await startResearch({
      text: params.text,
      modelId: params.model_id,
      projectId: params.project_id,
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
    `Poll Grok DeepSearch. ${STRUCTURE_NOTE} The report preserves all stored text, de-duplicates citations by URL, ` +
    'and can expose native reasoning summaries, web searches, page opens, and other structured tool cards. Grok has no clarification step, so clarifying_question is null and auto_answered is false.',
  summary: 'Poll Grok DeepSearch',
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
    'Answer a provider clarification when one is pending. Grok currently launches DeepSearch directly, so this conservatively raises VALIDATION_ERROR without sending an ordinary chat message.',
  summary: 'Answer a research clarification',
  icon: 'message-circle-reply',
  group: 'Deep Research',
  input: z.object({ research_id: z.string().trim().min(1), text: z.string().trim().min(1) }),
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
    "Cancel queued/running Grok DeepSearch through the conversation's native stop-inflight endpoint, close the retained gateway, and poll structural inflight state until it settles. Terminal completed/failed truth wins if the race already ended.",
  summary: 'Cancel Grok DeepSearch',
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
