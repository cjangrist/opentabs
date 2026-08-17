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
  'research_id is an ordinary top-level Grok conversation id. Status comes from native inflight response records, ' +
  'report content comes from stored response nodes, and sources come from structured search fields; report text is ' +
  "never scanned heuristically. OpenTabs' exact appended instruction identifies recovered research conversations.";

export const startDeepResearch = defineTool({
  name: 'start_deep_research',
  displayName: 'Start Deep Research',
  description:
    `Start prompt-driven Grok research as an ordinary top-level conversation and return after its ids exist. ${STRUCTURE_NOTE} ` +
    'Grok has no dedicated research mode/workspace or clarification gate. Every request selects Expert and appends an ' +
    'instruction to perform in-depth research, write one Markdown artifact, and present it for download; callers do not need to add it.',
  summary: 'Start Grok research',
  icon: 'telescope',
  group: 'Deep Research',
  input: z.object({
    ...startDeepResearchInputShape,
  }),
  output: startDeepResearchOutputSchema.extend({ url: z.string() }),
  handle: async params => {
    const snapshot = await startResearch({
      text: params.text,
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
    'Poll prompt-driven Grok research in an ordinary top-level conversation. Status uses native inflight records; ' +
    'content, sources, reasoning, searches, and tool cards come from stored structured responses, never heuristic text scanning. ' +
    'The appended instruction makes the id recoverable. Set download_files:true after completion to save the native file and receive its filename. ' +
    'A missing artifact triggers up to three native regenerations, then one focused same-conversation attachment repair. ' +
    'A newer native file from an OpenTabs-marked same-conversation revision is adopted while preserving original research sources. ' +
    'Grok has no clarification step: clarifying_question is null and auto_answered is false.',
  summary: 'Poll Grok research',
  icon: 'activity',
  group: 'Deep Research',
  input: z.object({
    research_id: z.string().trim().min(1),
    ...itemVisibilityInputShape,
    download_files: z
      .boolean()
      .optional()
      .describe(
        "Download completed Markdown/file artifacts to the browser's configured default download directory and return their filenames. No download is attempted while research is still running.",
      ),
  }),
  output: deepResearchSchema.extend({
    url: z.string(),
    downloaded_filenames: z.array(z.string()).describe('Native artifact filenames newly saved by this poll.'),
  }),
  handle: async params => {
    const snapshot = await readResearch(params.research_id, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
      downloadFiles: params.download_files ?? false,
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
      downloaded_filenames: snapshot.downloadedFilenames,
    };
  },
});

export const answerDeepResearch = defineTool({
  name: 'answer_deep_research',
  displayName: 'Answer Deep Research',
  description:
    'Answer a provider clarification when one is pending. Grok prompt-driven research has no native clarification gate, so this raises UNSUPPORTED without sending an ordinary chat message.',
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
    "Cancel queued/running Grok research through the conversation's native stop-inflight endpoint, close the retained gateway, and poll structural inflight state until it settles. Terminal completed/failed truth wins if the race already ended.",
  summary: 'Cancel Grok research',
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
