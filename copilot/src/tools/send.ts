import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { runCompletion } from '../copilot-completions.js';
import { getProjectRecord } from '../copilot-projects.js';
import { resolveConversationId } from './conversations.js';
import {
  itemVisibilityInputShape,
  messageOptionsInputShape,
  omittedSchema,
  responseItemSchema,
} from './normalized-schemas.js';

const MODE_NOTE =
  'Copilot exposes mutually-exclusive composer modes, not underlying model ids. thinking:true or ANY normalized ' +
  'thinking_level selects Think deeper because Copilot offers no effort ladder; search:true selects Search. ' +
  'Conflicting model_id/toggle combinations raise VALIDATION_ERROR. search:false avoids Search mode but cannot stop ' +
  'another mode from browsing autonomously. A non-empty tools allowlist is unsupported and rejected.';

const BUDGET_NOTE =
  'The gateway remains connected after the tool returns. This waits up to 18 seconds: completed means the native ' +
  'done frame arrived; in_progress means generation continues and get_conversation should be polled.';

const outputShape = {
  conversation_id: z.string(),
  message_id: z.string(),
  status: z.enum(['completed', 'in_progress']),
  url: z.string(),
  model: z.string().describe('Native Copilot mode actually sent.'),
  items: z.array(responseItemSchema).describe('Normalized items for this generated turn only.'),
  omitted: omittedSchema.describe('Filtered content counts for this generated turn only.'),
};

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description:
    `Create an empty native Copilot chat, send its first prompt, and return normalized turn items. ${MODE_NOTE} ${BUDGET_NOTE} ` +
    'project_id creates the chat directly inside a verified Copilot Project.',
  summary: 'Start a Copilot chat',
  icon: 'message-square-plus',
  group: 'Conversations',
  input: z.object({
    text: z.string().trim().min(1),
    project_id: z.string().trim().min(1).optional(),
    ...messageOptionsInputShape,
    ...itemVisibilityInputShape,
  }),
  output: z.object(outputShape),
  handle: async params => {
    if (params.project_id) await getProjectRecord(params.project_id);
    return runCompletion({
      text: params.text,
      modelId: params.model_id,
      thinking: params.thinking,
      thinkingLevel: params.thinking_level,
      search: params.search,
      tools: params.tools,
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
      projectId: params.project_id,
    });
  },
});

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description: `Continue an existing Copilot chat. Omit conversation_id to use the chat open in the active tab. ${MODE_NOTE} ${BUDGET_NOTE}`,
  summary: 'Send a Copilot message',
  icon: 'send',
  group: 'Conversations',
  input: z.object({
    text: z.string().trim().min(1),
    conversation_id: z.string().trim().min(1).optional(),
    ...messageOptionsInputShape,
    ...itemVisibilityInputShape,
  }),
  output: z.object(outputShape),
  handle: params =>
    runCompletion(
      {
        text: params.text,
        modelId: params.model_id,
        thinking: params.thinking,
        thinkingLevel: params.thinking_level,
        search: params.search,
        tools: params.tools,
        includeReasoning: params.include_reasoning ?? false,
        includeToolCalls: params.include_tool_calls ?? false,
      },
      resolveConversationId(params.conversation_id),
    ),
});
