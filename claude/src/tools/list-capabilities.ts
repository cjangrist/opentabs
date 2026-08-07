import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getBootstrap } from '../claude-models.js';
import { capabilitiesSchema } from './normalized-schemas.js';

const unsupported = (reason: string) => ({ supported: false, reason });
const supported = { supported: true, reason: null };

export const listCapabilities = defineTool({
  name: 'list_capabilities',
  displayName: 'List Capabilities',
  description:
    'Report everything this Claude plugin can do: the live model list, every toggle with its scope, and a feature map with a reason for each unsupported feature. Derived from the live bootstrap payload on every call.',
  summary: 'What this provider supports',
  icon: 'sliders-horizontal',
  group: 'Account',
  input: z.object({}),
  output: capabilitiesSchema,
  handle: async () => {
    const bootstrap = await getBootstrap();
    const withThinking = bootstrap.models.filter(model => model.capabilities.thinking.supported);
    const withLevels = withThinking.filter(model => (model.capabilities.thinking.levels ?? []).length > 0);
    const withSearch = bootstrap.models.filter(model => model.capabilities.web_search.supported);
    const withResearch = bootstrap.models.filter(model => model.capabilities.deep_research.supported);
    const anyThinking = withThinking.length > 0;
    const anyResearch = withResearch.length > 0;

    // Union of the native effort ladders actually published for this account.
    const levels = [...new Set(withLevels.flatMap(model => model.capabilities.thinking.levels ?? []))];

    return {
      provider: 'claude',
      models: bootstrap.models,
      toggles: [
        {
          id: 'thinking',
          display_name: 'Extended thinking',
          type: 'boolean' as const,
          values: null,
          default: bootstrap.defaultThinking?.mode !== 'off',
          scope: 'per_message' as const,
          controllable: anyThinking,
          applies_to_models: withThinking.map(model => model.id),
          note: 'Sent as thinking_mode ("auto"/"extended" vs "off") on the completion request. Some models publish no "off" mode; passing thinking:false for those raises VALIDATION_ERROR.',
        },
        {
          id: 'thinking_level',
          display_name: 'Reasoning effort',
          type: 'enum' as const,
          values: levels,
          default: bootstrap.defaultThinking?.effort ?? 'high',
          scope: 'per_message' as const,
          controllable: withLevels.length > 0,
          applies_to_models: withLevels.map(model => model.id),
          note: 'Normalized minimal|low|medium|high|max maps onto these native ids by name; a level a model does not publish falls back to the nearest lower one it does.',
        },
        {
          id: 'web_search',
          display_name: 'Web search',
          type: 'boolean' as const,
          values: null,
          default: true,
          scope: 'per_message' as const,
          controllable: withSearch.length > 0,
          applies_to_models: withSearch.map(model => model.id),
          note: 'Controlled by declaring the web_search tool on the completion and by the conversation setting enabled_web_search. Claude still decides autonomously whether to search.',
        },
        {
          id: 'research',
          display_name: 'Research (deep research)',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: anyResearch,
          applies_to_models: withResearch.map(model => model.id),
          note: 'claude.ai calls this "compass" internally: create_conversation_params.compass_mode="advanced" on a new conversation, or a settings PUT on an existing one. Exposed through start_deep_research.',
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
          'claude.ai has no archive action for conversations — the row menu offers Pin, Mark as unread, Rename, Add to project and Delete only. Projects have archived_at; conversations do not.',
        ),
        projects: supported,
        project_membership: supported,
        models: supported,
        thinking: anyThinking
          ? supported
          : unsupported('No model published by this organization exposes a thinking mode.'),
        web_search:
          withSearch.length > 0 ? supported : unsupported('No model published by this organization can search.'),
        deep_research: anyResearch
          ? supported
          : unsupported('No model published by this organization has the compass (Research) capability.'),
        vision: bootstrap.models.some(model => model.capabilities.vision.supported)
          ? supported
          : unsupported('No model published by this organization accepts images.'),
        code_interpreter: bootstrap.models.some(model => model.capabilities.code_interpreter.supported)
          ? supported
          : unsupported('No model published by this organization is offered the Analysis (repl) tool.'),
      },
    };
  },
});
