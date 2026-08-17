import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { resolveConversationId } from '../gemini-api.js';
import { runCompletion } from '../gemini-completions.js';
import { getNotebook } from '../gemini-projects.js';
import {
  itemVisibilityInputShape,
  messageOptionsInputShape,
  omittedSchema,
  responseItemSchema,
} from './normalized-schemas.js';

const THINKING_NOTE =
  'thinking / thinking_level map onto Gemini\'s "Extended thinking" picker entry — a per-message toggle on the most ' +
  'capable mode, NOT a separate model. Gemini publishes one depth, so minimal|low request standard thinking and ' +
  'medium|high|max request Extended thinking; asking for it on a mode without it raises VALIDATION_ERROR.';

const SEARCH_NOTE =
  'search and a non-empty tools are rejected with VALIDATION_ERROR: Gemini browses autonomously and exposes neither ' +
  'a web-search switch nor a per-message tool list.';

const BUDGET_NOTE =
  'Gemini persists a turn only when generation FINISHES, so this waits ~18s and polls the transcript. ' +
  'status "completed" means the answer is stored; "in_progress" means it was still generating when the tool ' +
  'returned — poll get_conversation, and note such a run is not guaranteed to land.';

const rejectUnsupported = (search: boolean | undefined, tools: string[] | undefined): void => {
  if (search !== undefined)
    throw ToolError.validation(
      'Gemini exposes no per-message web-search toggle — it browses autonomously. Omit search. See list_capabilities: the web_search toggle is reported with controllable:false.',
    );
  if (tools !== undefined && tools.length > 0)
    throw ToolError.validation(
      `Gemini's send RPC accepts no per-message tool list, so tools=${JSON.stringify(tools)} cannot be honoured. Omit it.`,
    );
};

const outputShape = {
  conversation_id: z.string(),
  message_id: z
    .string()
    .describe("Gemini's response-choice id (rc_…), or the response id when the stream was still running."),
  status: z.enum(['completed', 'in_progress']),
  url: z.string(),
  model: z.string().describe('The mode id actually used.'),
  items: z.array(responseItemSchema).describe('SPEC §3 items for this turn only — the prompt and the reply.'),
  omitted: omittedSchema.describe('Counts for this turn only, since only this turn was generated.'),
};

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description:
    'Start a Gemini chat and return normalized first-turn items. project_id files it in a verified Notebook and ' +
    'discovers the id from that Notebook’s history. ' +
    THINKING_NOTE +
    ' ' +
    SEARCH_NOTE +
    ' ' +
    BUDGET_NOTE,
  summary: 'Start a Gemini chat',
  icon: 'message-square-plus',
  group: 'Conversations',
  input: z.object({
    text: z.string().min(1).describe('The first prompt.'),
    project_id: z.string().trim().min(1).optional().describe('Gemini Notebook id from list_projects for the new chat.'),
    ...messageOptionsInputShape,
    ...itemVisibilityInputShape,
  }),
  output: z.object(outputShape),
  handle: async params => {
    rejectUnsupported(params.search, params.tools);
    const projectId = params.project_id ? (await getNotebook(params.project_id)).id : undefined;
    return runCompletion({
      text: params.text,
      modelId: params.model_id,
      thinking: params.thinking,
      thinkingLevel: params.thinking_level,
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
      projectId,
    });
  },
});

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description:
    'Send a follow-up message in an existing Gemini chat. Omit conversation_id to use the chat open in the active ' +
    'gemini.google.com tab. The reply is threaded onto the latest turn read live from the transcript. ' +
    THINKING_NOTE +
    ' ' +
    SEARCH_NOTE +
    ' ' +
    BUDGET_NOTE,
  summary: 'Send a Gemini message',
  icon: 'send',
  group: 'Conversations',
  input: z.object({
    text: z.string().min(1).describe('The message to send.'),
    conversation_id: z.string().optional().describe('Conversation id. Omit to use the active gemini.google.com tab.'),
    ...messageOptionsInputShape,
    ...itemVisibilityInputShape,
  }),
  output: z.object(outputShape),
  handle: async params => {
    rejectUnsupported(params.search, params.tools);
    const conversationId = resolveConversationId(params.conversation_id);
    return runCompletion(
      {
        text: params.text,
        modelId: params.model_id,
        thinking: params.thinking,
        thinkingLevel: params.thinking_level,
        includeReasoning: params.include_reasoning ?? false,
        includeToolCalls: params.include_tool_calls ?? false,
      },
      conversationId,
    );
  },
});
