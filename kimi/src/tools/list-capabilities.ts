import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { EFFORT_NONE, getModelCatalog } from '../kimi-models.js';
import { capabilitiesSchema } from './normalized-schemas.js';

const unsupported = (reason: string) => ({ supported: false, reason });
const supported = { supported: true, reason: null };

export const listCapabilities = defineTool({
  name: 'list_capabilities',
  displayName: 'List Capabilities',
  description:
    'Report everything this Kimi plugin can do: the live model list, every toggle with its scope, and a feature map with a reason for each unsupported feature. Derived from the live GetAvailableModels payload on every call.',
  summary: 'What this provider supports',
  icon: 'sliders-horizontal',
  group: 'Account',
  input: z.object({}),
  output: capabilitiesSchema,
  handle: async () => {
    const catalog = await getModelCatalog();
    const withThinking = catalog.models.filter(model => model.capabilities.thinking.supported);
    const withResearch = catalog.models.filter(model => model.capabilities.deep_research.supported);
    const withCode = catalog.models.filter(model => model.capabilities.code_interpreter.supported);
    const withVision = catalog.models.filter(model => model.capabilities.vision.supported);
    const canDisableThinking = catalog.models.filter(model =>
      (catalog.runtimeById[model.id]?.efforts ?? []).includes(EFFORT_NONE),
    );

    // Union of the native reasoning-effort ladders this account actually publishes.
    const levels = [...new Set(withThinking.flatMap(model => model.capabilities.thinking.levels ?? []))];
    const defaultModel = catalog.defaultModelId ? catalog.runtimeById[catalog.defaultModelId] : undefined;

    return {
      provider: 'kimi',
      models: catalog.models,
      toggles: [
        {
          id: 'thinking',
          display_name: 'Thinking',
          type: 'boolean' as const,
          values: null,
          default: (defaultModel?.defaultEffort ?? EFFORT_NONE) !== EFFORT_NONE,
          scope: 'per_message' as const,
          controllable: withThinking.length > 0,
          applies_to_models: withThinking.map(model => model.id),
          note:
            'Sent as options.thinking plus options.reasoning_effort on the Chat request. thinking:false sends REASONING_EFFORT_NONE and is ' +
            `rejected for a model whose picker has no "off" rung (models that do offer one: ${canDisableThinking.map(model => model.id).join(', ') || 'none'}).`,
        },
        {
          id: 'thinking_level',
          display_name: 'Thinking effort',
          type: 'enum' as const,
          values: levels,
          default: defaultModel?.defaultEffort ?? EFFORT_NONE,
          scope: 'per_message' as const,
          controllable: levels.length > 0,
          applies_to_models: withThinking.map(model => model.id),
          note: 'Normalized minimal|low|medium|high|max maps onto these native ids by name; a level a model does not publish falls back to the nearest lower one it does.',
        },
        {
          id: 'web_search',
          display_name: 'Web search',
          type: 'boolean' as const,
          values: null,
          default: true,
          scope: 'per_message' as const,
          controllable: true,
          applies_to_models: null,
          note: 'Declared as the TOOL_TYPE_SEARCH tool on the Chat request and defaults on, matching the composer. Kimi still decides autonomously whether to query.',
        },
        {
          id: 'deep_research',
          display_name: 'Deep Research',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: withResearch.length > 0,
          applies_to_models: withResearch.map(model => model.id),
          note: 'Kimi\'s "deep-researcher" kimiPlus plus the TOOL_TYPE_ASK_USER tool, on the agentic scenario. Exposed through start_deep_research, not as a flag on send_message.',
        },
      ],
      features: {
        list_conversations: supported,
        get_conversation: supported,
        create_conversation: supported,
        send_message: supported,
        search_conversations: supported,
        rename_conversation: supported,
        delete_conversation: supported,
        archive_conversation: unsupported(
          'Kimi has no archive concept for chats: the chat payload carries no archived flag, the sidebar row menu offers Delete only, and no Archive RPC exists on ChatService (every plausible name answers HTTP 404).',
        ),
        projects: supported,
        project_membership: unsupported(
          'Kimi can only file a conversation into a project when the conversation is CREATED (Chat request field project_id — use create_conversation(project_id)). ' +
            'There is no move/add/remove operation for an existing chat: ProjectService exposes no membership method (all candidates answer HTTP 404), and ChatService/UpdateChat accepts a projectId and silently ignores it (HTTP 200, membership unchanged — verified live). The kimi.com UI offers no such affordance either.',
        ),
        models: supported,
        thinking:
          withThinking.length > 0
            ? supported
            : unsupported('No model published for this account exposes a reasoning-effort ladder.'),
        web_search: supported,
        deep_research:
          withResearch.length > 0
            ? supported
            : unsupported('No model published for this account runs on the agentic scenario Deep Research needs.'),
        vision: withVision.length > 0 ? supported : unsupported('No model published for this account accepts images.'),
        code_interpreter:
          withCode.length > 0
            ? supported
            : unsupported('No model published for this account is offered the agentic shell / file tools.'),
      },
    };
  },
});
