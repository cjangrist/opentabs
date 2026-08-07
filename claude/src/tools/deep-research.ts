import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, orgApi, startCompletion } from '../claude-api.js';
import { buildCompletionBody, getConversationDetail } from '../claude-conversations.js';
import { readPrefs, readResearch, requireResearchTaskId, writePrefs } from '../claude-research.js';
import { followUpModel, prepareTurn } from '../claude-send.js';
import {
  DEFAULT_CLARIFICATION_ANSWER,
  deepResearchSchema,
  itemVisibilityInputShape,
  messageOptionsInputShape,
  researchStatusSchema,
  startDeepResearchInputShape,
  startDeepResearchOutputSchema,
} from './normalized-schemas.js';

const researchOutput = deepResearchSchema.extend({
  url: z.string(),
});

export const startDeepResearch = defineTool({
  name: 'start_deep_research',
  displayName: 'Start Deep Research',
  description:
    "Start Claude's Research feature on a new conversation and return immediately — the run itself takes minutes. " +
    'Research is claude.ai\'s "compass" mode: the conversation is created with compass_mode="advanced", which is exactly what the composer\'s Research toggle sets. ' +
    'research_id is the conversation UUID; poll get_deep_research with it. ' +
    'Claude sometimes replies with a clarifying question instead of launching the search; auto_answer_clarifications (default true) makes get_deep_research answer it for you and continue.',
  summary: 'Start a deep research run',
  icon: 'telescope',
  group: 'Research',
  input: z.object({
    ...startDeepResearchInputShape,
    project_id: z.string().optional().describe('Run the research inside this project.'),
    model_id: messageOptionsInputShape.model_id,
    thinking: messageOptionsInputShape.thinking,
    thinking_level: messageOptionsInputShape.thinking_level,
  }),
  output: startDeepResearchOutputSchema.extend({ url: z.string() }),
  handle: async params => {
    const prepared = await prepareTurn(
      {
        text: params.text,
        model_id: params.model_id,
        project_id: params.project_id,
        thinking: params.thinking,
        thinking_level: params.thinking_level,
        search: true,
      },
      { research: true },
    );
    writePrefs(prepared.conversationId, {
      auto: params.auto_answer_clarifications ?? true,
      answer: params.clarification_answer ?? DEFAULT_CLARIFICATION_ANSWER,
      clarifyingQuestion: null,
      autoAnswered: false,
    });
    startCompletion(prepared.conversationId, prepared.body);
    return {
      research_id: prepared.conversationId,
      conversation_id: prepared.conversationId,
      status: 'running' as const,
      url: conversationUrl(prepared.conversationId),
    };
  },
});

export const getDeepResearch = defineTool({
  name: 'get_deep_research',
  displayName: 'Get Deep Research',
  description:
    'Poll a Claude research run. Status is derived from the conversation itself: queued (no assistant turn yet), running (the launch_extended_search_task tool_use is present without its trailing answer), completed (a text block follows the task result), failed (the task result is flagged is_error), clarifying, or cancelled. ' +
    'A turn is reported as clarifying only when its message carries stop_reason (claude.ai stamps that only once the turn has ended), it contains NO launch_extended_search_task, and its text contains a question mark — so a still-streaming preamble is never mistaken for a question. ' +
    'With auto_answer_clarifications on, the question is answered automatically here and the status returns to running, with auto_answered:true and the question echoed.',
  summary: 'Poll a deep research run',
  icon: 'refresh-cw',
  group: 'Research',
  input: z.object({
    research_id: z.string().describe('Value returned by start_deep_research (the conversation UUID).'),
    ...itemVisibilityInputShape,
  }),
  output: researchOutput,
  handle: async params => {
    const prefs = readPrefs(params.research_id);
    let snapshot = await readResearch(params.research_id, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
    });

    // `autoAnswered` is the de-dup guard, not just a report field: it must be keyed
    // to the question it answered, or a SECOND clarification would park the job even
    // though auto-answering is on.
    const alreadyAnswered = prefs.autoAnswered && prefs.clarifyingQuestion === snapshot.clarifyingQuestion;

    if (snapshot.status === 'clarifying' && prefs.auto && !alreadyAnswered) {
      const detail = await getConversationDetail(params.research_id);
      startCompletion(
        params.research_id,
        buildCompletionBody({
          prompt: prefs.answer,
          model: await followUpModel(detail),
          thinking: { thinking_mode: undefined, effort: undefined },
          search: true,
          parentMessageUuid: detail.current_leaf_message_uuid,
        }),
      );
      writePrefs(params.research_id, {
        ...prefs,
        clarifyingQuestion: snapshot.clarifyingQuestion,
        autoAnswered: true,
      });
      snapshot = { ...snapshot, status: 'running' };
    } else if (snapshot.status === 'clarifying' && !alreadyAnswered) {
      writePrefs(params.research_id, {
        ...prefs,
        clarifyingQuestion: snapshot.clarifyingQuestion,
        autoAnswered: false,
      });
    }

    const stored = readPrefs(params.research_id);
    return {
      research_id: params.research_id,
      conversation_id: params.research_id,
      status: snapshot.status,
      clarifying_question: snapshot.clarifyingQuestion ?? stored.clarifyingQuestion,
      auto_answered: stored.autoAnswered,
      progress: snapshot.progress,
      items: snapshot.items,
      sources: snapshot.sources,
      error: snapshot.error,
      url: conversationUrl(params.research_id),
    };
  },
});

export const answerDeepResearch = defineTool({
  name: 'answer_deep_research',
  displayName: 'Answer Deep Research',
  description:
    'Answer the clarifying question a parked research run is waiting on, resuming it. Only valid while get_deep_research reports status "clarifying".',
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
    const snapshot = await readResearch(params.research_id, { includeReasoning: false, includeToolCalls: false });
    if (snapshot.status !== 'clarifying')
      throw ToolError.validation(
        `Research ${params.research_id} is not waiting on a clarification (status: ${snapshot.status}). Use send_message to add an ordinary follow-up.`,
      );
    const detail = await getConversationDetail(params.research_id);
    startCompletion(
      params.research_id,
      buildCompletionBody({
        prompt: params.text,
        model: await followUpModel(detail),
        thinking: { thinking_mode: undefined, effort: undefined },
        search: true,
        parentMessageUuid: detail.current_leaf_message_uuid,
      }),
    );
    const prefs = readPrefs(params.research_id);
    writePrefs(params.research_id, { ...prefs, clarifyingQuestion: snapshot.clarifyingQuestion, autoAnswered: false });
    return {
      research_id: params.research_id,
      conversation_id: params.research_id,
      status: 'running' as const,
      answered_question: snapshot.clarifyingQuestion,
    };
  },
});

export const cancelDeepResearch = defineTool({
  name: 'cancel_deep_research',
  displayName: 'Cancel Deep Research',
  description:
    'Stop a running Claude research task. Posts to /chat_conversations/<id>/task/<task_id>/stop, the endpoint the claude.ai Stop button uses; the task id is read out of the launch_extended_search_task result, so a run that has not launched yet cannot be cancelled. A stopped run leaves no marker in the conversation — it simply ends with stop_reason set and no report — so the cancellation is recorded and get_deep_research reports `cancelled` rather than `failed` for that shape.',
  summary: 'Cancel a deep research run',
  icon: 'square',
  group: 'Research',
  input: z.object({ research_id: z.string().describe('Value returned by start_deep_research.') }),
  output: z.object({
    research_id: z.string(),
    conversation_id: z.string(),
    status: researchStatusSchema,
    task_id: z.string(),
  }),
  handle: async params => {
    const snapshot = await readResearch(params.research_id, { includeReasoning: false, includeToolCalls: false });
    const taskId = requireResearchTaskId(snapshot);
    await orgApi(`/chat_conversations/${params.research_id}/task/${taskId}/stop`, { method: 'POST' });
    // The conversation gains no "cancelled" marker — a stopped run just ends with
    // stop_reason set and no report — so record the intent for get_deep_research.
    writePrefs(params.research_id, { ...readPrefs(params.research_id), cancelRequested: true });
    return {
      research_id: params.research_id,
      conversation_id: params.research_id,
      status: 'cancelled' as const,
      task_id: taskId,
    };
  },
});
