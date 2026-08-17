import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { runCompletion } from '../grok-completions.js';
import { resolveConversationId } from './conversations.js';
import {
  itemVisibilityInputShape,
  messageOptionsInputShape,
  omittedSchema,
  responseItemSchema,
} from './normalized-schemas.js';

const MODE_NOTE =
  'Grok exposes composer modes rather than underlying model ids. thinking:true or ANY normalized thinking_level ' +
  'selects Expert because Grok offers no effort ladder. search:false sends native disable_web_search and ' +
  'disable_x_search flags; search:true permits but does not force search. Conflicting model/toggle combinations are ' +
  'rejected before sending, and a non-empty tools allowlist is unsupported.';
const BUDGET_NOTE =
  'This waits up to 18 seconds. completed means Grok persisted the reply; in_progress means generation continues ' +
  'and get_conversation should be polled. The gateway remains connected after an in-progress return.';

const outputShape = {
  conversation_id: z.string(),
  message_id: z.string(),
  status: z.enum(['completed', 'in_progress']),
  url: z.string(),
  model: z.string().describe('Native Grok mode actually sent.'),
  title: z.string(),
  items: z.array(responseItemSchema).describe('Normalized items for this generated turn only.'),
  omitted: omittedSchema.describe('Filtered content counts for this generated turn only.'),
};

export const createConversation = defineTool({
  name: 'create_conversation',
  displayName: 'Create Conversation',
  description:
    `Start a native Grok chat with its first prompt and return normalized turn items. ${MODE_NOTE} ${BUDGET_NOTE} ` +
    'project_id creates the chat through a verified native Project context.',
  summary: 'Start a Grok chat',
  icon: 'message-square-plus',
  group: 'Conversations',
  input: z.object({
    text: z.string().trim().min(1),
    project_id: z.string().trim().min(1).optional(),
    ...messageOptionsInputShape,
    ...itemVisibilityInputShape,
  }),
  output: z.object(outputShape),
  handle: params =>
    runCompletion({
      text: params.text,
      projectId: params.project_id,
      modelId: params.model_id,
      thinking: params.thinking,
      thinkingLevel: params.thinking_level,
      search: params.search,
      tools: params.tools,
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
    }),
});

export const sendMessage = defineTool({
  name: 'send_message',
  displayName: 'Send Message',
  description: `Continue an existing Grok chat. Omit conversation_id to use the active tab. ${MODE_NOTE} ${BUDGET_NOTE}`,
  summary: 'Send a Grok message',
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
    runCompletion({
      text: params.text,
      conversationId: resolveConversationId(params.conversation_id),
      modelId: params.model_id,
      thinking: params.thinking,
      thinkingLevel: params.thinking_level,
      search: params.search,
      tools: params.tools,
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
    }),
});
