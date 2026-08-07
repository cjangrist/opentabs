import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { DEEP_RESEARCH_SERVER, WEB_SEARCH_SERVER, getBootstrap } from '../zai-models.js';
import { capabilitiesSchema } from './normalized-schemas.js';

const unsupported = (reason: string) => ({ supported: false, reason });
const supported = { supported: true, reason: null };

export const listCapabilities = defineTool({
  name: 'list_capabilities',
  displayName: 'List Capabilities',
  description:
    'Report everything this z.ai plugin can do: the live model list, every toggle with its scope, and a feature map with a reason for each unsupported feature. Derived from GET /api/models and GET /api/config on every call, never a static literal.',
  summary: 'What this provider supports',
  icon: 'sliders-horizontal',
  group: 'Account',
  input: z.object({}),
  output: capabilitiesSchema,
  handle: async () => {
    const bootstrap = await getBootstrap();
    const withThinking = bootstrap.models.filter(model => model.capabilities.thinking.supported);
    const withLevels = withThinking.filter(model => model.capabilities.thinking.levels !== null);
    const withSearch = bootstrap.models.filter(model => model.capabilities.web_search.supported);
    const withResearch = bootstrap.models.filter(model => model.capabilities.deep_research.supported);
    const withVision = bootstrap.models.filter(model => model.capabilities.vision.supported);
    const codeInterpreterEnabled = bootstrap.config.features?.enable_code_interpreter === true;

    // Union of the native effort ladders the account's visible models publish.
    const levels = [...new Set(withLevels.flatMap(model => model.capabilities.thinking.levels ?? []))];
    // Every MCP server any visible model offers — the valid values for `tools`.
    const toolServers = [...new Set([...bootstrap.serversByModel.values()].flat())];

    return {
      provider: 'zai',
      models: bootstrap.models,
      toggles: [
        {
          id: 'thinking',
          display_name: 'Deep Think',
          type: 'boolean' as const,
          values: null,
          default: true,
          scope: 'per_message' as const,
          controllable: withThinking.length > 0,
          applies_to_models: withThinking.map(model => model.id),
          note: 'Sent as features.enable_thinking on the completion and stored as chat.enable_thinking. Defaults on for every model that has it, matching the composer.',
        },
        {
          id: 'thinking_level',
          display_name: 'Deep Think effort',
          type: 'enum' as const,
          values: levels,
          default: 'max',
          scope: 'per_message' as const,
          controllable: withLevels.length > 0,
          applies_to_models: withLevels.map(model => model.id),
          note: 'z.ai\'s picker offers exactly two rungs, High and Max, defaulting to Max. The normalized ladder maps minimal/low/medium/high onto "high" and max onto "max". Models without info.meta.capabilities.reasoning_effort reject thinking_level with VALIDATION_ERROR instead of ignoring it.',
        },
        {
          id: 'web_search',
          display_name: 'Web search',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: withSearch.length > 0,
          applies_to_models: withSearch.map(model => model.id),
          note: `Sent as features.auto_web_search plus the ${WEB_SEARCH_SERVER} MCP server. features.web_search itself is vestigial — z.ai's own client pins it to false. The model still decides autonomously whether to issue a query, so this enables searching rather than forcing it.`,
        },
        {
          id: 'deep_research',
          display_name: 'Deep research',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: withResearch.length > 0,
          applies_to_models: withResearch.map(model => model.id),
          note: `Enabled by adding the ${DEEP_RESEARCH_SERVER} MCP server to the completion. Exposed through start_deep_research rather than as a flag on send_message.`,
        },
        {
          id: 'tools',
          display_name: 'MCP servers',
          type: 'enum' as const,
          values: toolServers,
          default: '',
          scope: 'per_message' as const,
          controllable: toolServers.length > 0,
          applies_to_models: null,
          note: "Passed through as the completion's mcp_servers array. Each model publishes its own subset in info.meta.mcpServerIds; a server the chosen model does not publish is rejected.",
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
        archive_conversation: supported,
        projects: supported,
        project_membership: supported,
        models: supported,
        thinking:
          withThinking.length > 0 ? supported : unsupported('No visible model publishes info.meta.capabilities.think.'),
        web_search:
          withSearch.length > 0
            ? supported
            : unsupported('No visible model publishes info.meta.capabilities.web_search.'),
        deep_research:
          withResearch.length > 0
            ? supported
            : unsupported(`No visible model publishes the ${DEEP_RESEARCH_SERVER} MCP server.`),
        vision:
          withVision.length > 0
            ? unsupported(
                `${withVision
                  .map(model => model.id)
                  .join(
                    ', ',
                  )} publishes vision:true, but an image can only reach z.ai through file upload, which this plugin deliberately does not implement (SPEC §8).`,
              )
            : unsupported('No visible model publishes info.meta.capabilities.vision.'),
        code_interpreter: codeInterpreterEnabled
          ? supported
          : unsupported('GET /api/config reports features.enable_code_interpreter: false for this account.'),
      },
    };
  },
});
