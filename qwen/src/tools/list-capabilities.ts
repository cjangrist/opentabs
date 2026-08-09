import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  CHAT_TYPE_DEEP_RESEARCH,
  CHAT_TYPE_SEARCH,
  NATIVE_RESEARCH_MODES,
  NATIVE_THINKING_LEVELS,
  THINKING_MODE_AUTO,
  getBootstrap,
} from '../qwen-models.js';
import { capabilitiesSchema } from './normalized-schemas.js';

const unsupported = (reason: string) => ({ supported: false, reason });
const supported = { supported: true, reason: null };

export const listCapabilities = defineTool({
  name: 'list_capabilities',
  displayName: 'List Capabilities',
  description:
    'Report everything this Qwen plugin can do: the live model list, every toggle with its scope, and a feature map with a reason for each unsupported feature. Derived from GET /api/models and GET /api/config on every call, never a static literal.',
  summary: 'What this provider supports',
  icon: 'sliders-horizontal',
  group: 'Account',
  input: z.object({}),
  output: capabilitiesSchema,
  handle: async () => {
    const bootstrap = await getBootstrap();
    const withThinking = bootstrap.models.filter(model => model.capabilities.thinking.supported);
    const withSearch = bootstrap.models.filter(model => model.capabilities.web_search.supported);
    const withResearch = bootstrap.models.filter(model => model.capabilities.deep_research.supported);
    const withVision = bootstrap.models.filter(model => model.capabilities.vision.supported);
    const withCode = bootstrap.models.filter(model => model.capabilities.code_interpreter.supported);
    const projectsEnabled = bootstrap.config.features?.enable_project === true;
    // Every MCP tool id any model publishes — the valid values for `tools`.
    const toolIds = [...new Set([...bootstrap.toolsByModel.values()].flat())];

    return {
      provider: 'qwen',
      models: bootstrap.models,
      toggles: [
        {
          id: 'thinking',
          display_name: 'Thinking',
          type: 'enum' as const,
          values: [...NATIVE_THINKING_LEVELS],
          default: THINKING_MODE_AUTO,
          scope: 'per_message' as const,
          controllable: withThinking.length > 0,
          applies_to_models: withThinking.map(model => model.id),
          note: "Sent as feature_config.thinking_mode on the completion. It is a closed three-value enum — Fast (off), Auto (the model decides, and Qwen's default) and Thinking (forced on). Any value outside it makes the completion endpoint HANG rather than error, so it is never derived from caller input directly. The normalized thinking boolean maps true->Thinking / false->Fast / omitted->Auto, and thinking_level maps minimal->Fast, low+medium->Auto, high+max->Thinking.",
        },
        {
          id: 'web_search',
          display_name: 'Web search',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: withSearch.length > 0,
          note: `A real control, not a hint: search routes the message as chat_type "${CHAT_TYPE_SEARCH}" instead of "t2t". A model whose meta.chat_type omits it rejects the request. Cited pages come back on the STORED message as extra.web_search_info — never in the stream — so the chat record is re-read after every completion.`,
          applies_to_models: withSearch.map(model => model.id),
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
          note: `Routed as chat_type "${CHAT_TYPE_DEEP_RESEARCH}". Exposed through start_deep_research rather than as a flag on send_message, because the run is asynchronous and always opens with a clarifying question.`,
        },
        {
          id: 'research_mode',
          display_name: 'Deep research effort',
          type: 'enum' as const,
          values: [...NATIVE_RESEARCH_MODES],
          default: 'normal',
          scope: 'per_message' as const,
          controllable: withResearch.length > 0,
          applies_to_models: withResearch.map(model => model.id),
          note: 'Sent as feature_config.research_mode and reachable through start_deep_research\'s thinking_level: minimal/low/medium -> "normal", high/max -> "advance". GET /api/config lists research_mode as the only per-feature control deep_research publishes.',
        },
        {
          id: 'tools',
          display_name: 'MCP tools',
          type: 'enum' as const,
          values: toolIds,
          default: '',
          scope: 'per_message' as const,
          controllable: toolIds.length > 0,
          applies_to_models: null,
          note: 'Passed through as feature_config.mcp. Each model publishes its own subset in info.meta.mcp; an id the chosen model does not publish is rejected.',
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
        projects: projectsEnabled
          ? supported
          : unsupported('GET /api/config reports features.enable_project: false for this account.'),
        project_membership: projectsEnabled
          ? supported
          : unsupported('GET /api/config reports features.enable_project: false for this account.'),
        models: supported,
        thinking:
          withThinking.length > 0 ? supported : unsupported('No model publishes info.meta.capabilities.thinking.'),
        web_search: withSearch.length > 0 ? supported : unsupported('No model lists "search" in info.meta.chat_type.'),
        deep_research:
          withResearch.length > 0 ? supported : unsupported('No model lists "deep_research" in info.meta.chat_type.'),
        vision:
          withVision.length > 0
            ? unsupported(
                `${withVision.length} model(s) publish capabilities.vision, but an image can only reach Qwen through file upload, which this plugin deliberately does not implement (SPEC §8).`,
              )
            : unsupported('No model publishes info.meta.capabilities.vision.'),
        code_interpreter:
          withCode.length > 0
            ? unsupported(
                `${withCode.length} model(s) publish the code-interpreter MCP tool and it can be enabled through the tools parameter, but this plugin surfaces its output only as a generic tool_call item — there is no dedicated code-execution tool.`,
              )
            : unsupported('No model publishes the code-interpreter MCP tool in info.meta.mcp.'),
      },
    };
  },
});
