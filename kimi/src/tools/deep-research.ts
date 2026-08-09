import { ToolError, defineTool, sleep } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, openConnectStream } from '../kimi-api.js';
import { getModelCatalog } from '../kimi-models.js';
import {
  ASK_USER_STATUS,
  cancelChat,
  mergeState,
  readResearch,
  readState,
  readStreamIncrementally,
  writeState,
} from '../kimi-research.js';
import { CHAT_METHOD, prepareTurn } from '../kimi-send.js';
import {
  DEFAULT_CLARIFICATION_ANSWER,
  deepResearchSchema,
  itemVisibilityInputShape,
  messageOptionsInputShape,
  researchStatusSchema,
  startDeepResearchInputShape,
  startDeepResearchOutputSchema,
} from './normalized-schemas.js';

const CHAT_ID_POLL_INTERVAL_MS = 400;
const CHAT_ID_POLL_ATTEMPTS = 30;

const researchOutput = deepResearchSchema.extend({ url: z.string() });

/** Starts the run and returns as soon as Kimi has minted the chat id. */
const launchResearch = async (
  payload: Record<string, unknown>,
  seed: { auto: boolean; answer: string },
): Promise<string> => {
  const response = await openConnectStream(CHAT_METHOD, payload);
  let resolvedId: string | null = null;
  const handle = readStreamIncrementally(response, seed, chatId => {
    resolvedId = chatId;
  });

  for (let attempt = 0; attempt < CHAT_ID_POLL_ATTEMPTS && !resolvedId; attempt += 1) {
    if (handle.finished && handle.error)
      throw new ToolError(`Kimi deep research failed to start: ${handle.error}`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    await sleep(CHAT_ID_POLL_INTERVAL_MS);
  }

  if (!resolvedId)
    throw new ToolError(
      'Kimi did not return a chat id for the research run within 12s. The Chat stream may have been rejected — check https://www.kimi.com for a concurrency limit.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  return resolvedId;
};

/**
 * Deep Research runs only on the agentic scenario, and this account's DEFAULT
 * model is Instant, which is not on it — so falling through to the ordinary
 * default would reject every call that omitted model_id. Prefer the default only
 * when it is actually research-capable.
 */
const researchModelId = (catalog: Awaited<ReturnType<typeof getModelCatalog>>, requested?: string): string => {
  if (requested) return requested;
  const capable = catalog.models.filter(model => model.capabilities.deep_research.supported);
  const preferred = capable.find(model => model.id === catalog.defaultModelId) ?? capable[0];
  if (!preferred)
    throw ToolError.validation(
      'No model published for this Kimi account can run Deep Research — see list_capabilities().features.deep_research.',
    );
  return preferred.id;
};

export const startDeepResearch = defineTool({
  name: 'start_deep_research',
  displayName: 'Start Deep Research',
  description:
    'Start a Kimi Deep Research run on a NEW conversation and return as soon as the chat id exists — the run itself takes minutes. ' +
    'Deep Research is Kimi\'s "deep-researcher" kimiPlus on the agentic K3 stack, with the TOOL_TYPE_ASK_USER tool declared; this is exactly what the kimi.com /deep-research composer sends. ' +
    'Kimi has no separate research job id, so research_id IS the conversation id — poll get_deep_research with it. ' +
    'The Chat stream is read incrementally and keeps running in the page after this returns, which is what makes the clarifying question recoverable at all: ' +
    'while a run is parked the assistant message has zero persisted blocks, so the question exists only on that open stream. ' +
    'Kimi limits how many chats may generate at once; exceeding it arrives as an in-stream resource_exhausted frame under HTTP 200 and is raised as RATE_LIMIT.',
  summary: 'Start a deep research run',
  icon: 'telescope',
  group: 'Research',
  input: z.object({
    ...startDeepResearchInputShape,
    project_id: z.string().optional().describe('File the research conversation into this Kimi project.'),
    model_id: messageOptionsInputShape.model_id.describe(
      'Model id from list_models. Must be a Deep-Research-capable model (K3 / K3 Swarm). Omit to pick one automatically — the account default (Instant) cannot run research.',
    ),
    thinking_level: messageOptionsInputShape.thinking_level,
  }),
  output: startDeepResearchOutputSchema.extend({ url: z.string() }),
  handle: async params => {
    const catalog = await getModelCatalog();
    const prepared = await prepareTurn(
      {
        text: params.text,
        model_id: researchModelId(catalog, params.model_id),
        project_id: params.project_id,
        thinking: true,
        thinking_level: params.thinking_level,
        search: true,
      },
      { deepResearch: true },
    );
    const seed = {
      auto: params.auto_answer_clarifications ?? true,
      answer: params.clarification_answer ?? DEFAULT_CLARIFICATION_ANSWER,
    };
    const conversationId = await launchResearch(prepared.payload, seed);
    return {
      research_id: conversationId,
      conversation_id: conversationId,
      status: 'running' as const,
      url: conversationUrl(conversationId),
    };
  },
});

export const getDeepResearch = defineTool({
  name: 'get_deep_research',
  displayName: 'Get Deep Research',
  description:
    'Poll a Kimi deep research run. Status comes straight from Kimi’s own chat status, so no text heuristic is involved: ' +
    'STATUS_ASK_USER_QUESTION → clarifying, STATUS_GENERATING → running, STATUS_COMPLETED → completed; cancelled and failed are recorded by this plugin. ' +
    'That status is set only when Kimi actually calls its ask_user tool, so a run still streaming its opening preamble can never be mistaken for a question. ' +
    'With auto_answer_clarifications on (the default), the question is answered here automatically and the status returns to running, with auto_answered:true and the question echoed. ' +
    'clarifying_question is read from the live stream captured by start_deep_research; it is null when this browser session never saw the run start.',
  summary: 'Poll a deep research run',
  icon: 'refresh-cw',
  group: 'Research',
  input: z.object({
    research_id: z.string().describe('Value returned by start_deep_research (the conversation id).'),
    ...itemVisibilityInputShape,
  }),
  output: researchOutput,
  handle: async params => {
    const catalog = await getModelCatalog();
    let snapshot = await readResearch(params.research_id, catalog, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
    });
    const state = readState(params.research_id);

    // The de-dup guard must be keyed to the QUESTION that was answered, not to a
    // bare "we answered once" flag: polling twice while the run is still parked
    // would otherwise send the same answer again, and a genuinely SECOND
    // clarification would be ignored. Kimi does ask more than once — the trail-shoe
    // run here parked a second time after its first answer.
    const question = state.clarifyingQuestion;
    const alreadyAnswered = question !== null && state.autoAnsweredQuestion === question;

    if (snapshot.status === 'clarifying' && state.auto && !alreadyAnswered) {
      await answerResearch(params.research_id, state.answer, catalog);
      mergeState(params.research_id, { autoAnswered: true, autoAnsweredQuestion: question });
      snapshot = { ...snapshot, status: 'running' };
    }

    const stored = readState(params.research_id);
    return {
      research_id: params.research_id,
      conversation_id: params.research_id,
      status: snapshot.status,
      clarifying_question: stored.clarifyingQuestion,
      auto_answered: stored.autoAnswered,
      progress: snapshot.progress,
      items: snapshot.items,
      sources: snapshot.sources,
      error: snapshot.error,
      url: conversationUrl(params.research_id),
    };
  },
});

/** Sends the clarification answer on the parked conversation, resuming the run. */
const answerResearch = async (
  conversationId: string,
  text: string,
  catalog: Awaited<ReturnType<typeof getModelCatalog>>,
): Promise<void> => {
  const prepared = await prepareTurn(
    { text, model_id: catalog.models.find(model => model.capabilities.deep_research.supported)?.id, thinking: true },
    { conversationId, deepResearch: true },
  );
  const response = await openConnectStream(CHAT_METHOD, prepared.payload);
  readStreamIncrementally(response, { auto: readState(conversationId).auto, answer: text }, () => {
    // The chat id is already known; the reader keeps the run alive in the page.
  });
};

export const answerDeepResearch = defineTool({
  name: 'answer_deep_research',
  displayName: 'Answer Deep Research',
  description:
    'Answer the clarifying question a parked Kimi research run is waiting on, resuming it. Only valid while get_deep_research reports status "clarifying" ' +
    '(Kimi’s own STATUS_ASK_USER_QUESTION).',
  summary: 'Answer a research clarification',
  icon: 'message-circle-question',
  group: 'Research',
  input: z.object({
    research_id: z.string().describe('Value returned by start_deep_research.'),
    text: z.string().min(1).describe('Answer to send.'),
  }),
  output: z.object({
    research_id: z.string(),
    conversation_id: z.string(),
    status: researchStatusSchema,
    answered_question: z.string().nullable(),
  }),
  handle: async params => {
    const catalog = await getModelCatalog();
    const snapshot = await readResearch(params.research_id, catalog, {
      includeReasoning: false,
      includeToolCalls: false,
    });
    if (snapshot.status !== 'clarifying')
      throw ToolError.validation(
        `Research ${params.research_id} is not waiting on a clarification (status: ${snapshot.status}). Use send_message to add an ordinary follow-up.`,
      );
    const question = readState(params.research_id).clarifyingQuestion;
    await answerResearch(params.research_id, params.text, catalog);
    mergeState(params.research_id, { autoAnswered: false });
    return {
      research_id: params.research_id,
      conversation_id: params.research_id,
      status: 'running' as const,
      answered_question: question,
    };
  },
});

export const cancelDeepResearch = defineTool({
  name: 'cancel_deep_research',
  displayName: 'Cancel Deep Research',
  description:
    'Stop a running Kimi research run via ChatService/CancelChat, which takes the chat id AND the id of the message being generated. ' +
    'Kimi leaves a stopped run looking exactly like a finished one (STATUS_COMPLETED), so the cancellation is recorded here and get_deep_research reports `cancelled` for it. ' +
    'Because that label comes from a recorded intent rather than from Kimi, this refuses to act on a run that is not still live — cancelling a finished run would silently relabel it.',
  summary: 'Cancel a deep research run',
  icon: 'square',
  group: 'Research',
  input: z.object({ research_id: z.string().describe('Value returned by start_deep_research.') }),
  output: z.object({
    research_id: z.string(),
    conversation_id: z.string(),
    status: researchStatusSchema,
    message_id: z.string(),
  }),
  handle: async params => {
    const catalog = await getModelCatalog();
    const snapshot = await readResearch(params.research_id, catalog, {
      includeReasoning: false,
      includeToolCalls: false,
    });
    // Kimi leaves a stopped run looking exactly like a finished one
    // (STATUS_COMPLETED), so `cancelled` is reported from a recorded intent. That
    // recording is only truthful if the run was genuinely still live — otherwise
    // cancelling an already-finished run would silently relabel it.
    if (snapshot.status !== 'running' && snapshot.status !== 'queued' && snapshot.status !== 'clarifying')
      throw ToolError.validation(
        `Research ${params.research_id} is not running (status: ${snapshot.status}), so there is nothing to cancel.`,
      );
    if (!snapshot.assistantMessageId)
      throw ToolError.notFound(
        `Research ${params.research_id} has no assistant message yet, so there is nothing for Kimi to cancel.`,
      );
    await cancelChat(params.research_id, snapshot.assistantMessageId);
    writeState(params.research_id, { ...readState(params.research_id), cancelRequested: true });
    return {
      research_id: params.research_id,
      conversation_id: params.research_id,
      status: 'cancelled' as const,
      message_id: snapshot.assistantMessageId,
    };
  },
});

export { ASK_USER_STATUS };
