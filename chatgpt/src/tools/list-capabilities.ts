import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModelCatalog } from '../chatgpt-models.js';
import { getDeepResearchAvailability } from '../chatgpt-system-hints.js';
import { capabilitiesSchema } from './normalized-schemas.js';

const unsupported = (reason: string) => ({ supported: false, reason });
const supported = { supported: true, reason: null };

export const listCapabilities = defineTool({
  name: 'list_capabilities',
  displayName: 'List Capabilities',
  description:
    'Report everything this ChatGPT plugin can do: the live model list, every toggle with its scope, and a feature ' +
    'map with a reason for each unsupported feature. Derived on every call from /backend-api/models and ' +
    '/backend-api/system_hints — nothing here is a static literal.',
  summary: 'What this provider supports',
  icon: 'sliders-horizontal',
  group: 'Account',
  input: z.object({}),
  output: capabilitiesSchema,
  handle: async () => {
    const [catalog, research] = await Promise.all([getModelCatalog(), getDeepResearchAvailability()]);
    const thinkingModels = catalog.models.filter(model => model.capabilities.thinking.supported);
    const searchModels = catalog.models.filter(model => model.capabilities.web_search.supported);
    const visionModels = catalog.models.filter(model => model.capabilities.vision.supported);
    const codeModels = catalog.models.filter(model => model.capabilities.code_interpreter.supported);
    const nativeLevels = [...new Set(thinkingModels.flatMap(model => model.capabilities.thinking.levels ?? []))];
    const defaultModel = catalog.models.find(model => model.is_default);

    return {
      provider: 'chatgpt',
      models: catalog.models,
      toggles: [
        {
          id: 'model',
          display_name: 'Model',
          type: 'enum' as const,
          values: catalog.models.map(model => model.id),
          default: catalog.defaultModelSlug,
          scope: 'per_message' as const,
          controllable: catalog.models.length > 0,
          applies_to_models: null,
          note: `Selected by driving the composer picker: version row (${catalog.pickerVersions
            .map(version => version.label)
            .join(
              ' / ',
            )}) then effort row. POST /backend-api/f/conversation is blocked by OpenAI Sentinel, so the model cannot be set through the API.`,
        },
        {
          id: 'thinking',
          display_name: 'Thinking',
          type: 'boolean' as const,
          values: null,
          default: defaultModel?.capabilities.thinking.supported ?? false,
          scope: 'per_message' as const,
          controllable: thinkingModels.length > 0,
          applies_to_models: thinkingModels.map(model => model.id),
          note: 'On chatgpt.com thinking is a model LANE, not a switch: thinking:true selects an intelligence preset backed by a -thinking model. thinking:false on a thinking model raises VALIDATION_ERROR rather than being ignored.',
        },
        {
          id: 'thinking_level',
          display_name: 'Reasoning effort',
          type: 'enum' as const,
          values: nativeLevels,
          default: 'standard',
          scope: 'per_message' as const,
          controllable: nativeLevels.length > 0,
          applies_to_models: thinkingModels.map(model => model.id),
          note: 'Native ids, coarsest first. Normalized minimal/low→min, medium→standard, high→extended, max→max; a level a model does not publish falls back to the nearest lower one it does.',
        },
        {
          id: 'web_search',
          display_name: 'Web search',
          type: 'boolean' as const,
          values: null,
          default: true,
          scope: 'per_message' as const,
          controllable: false,
          applies_to_models: searchModels.map(model => model.id),
          note: 'ChatGPT decides autonomously whether to search; the composer exposes no per-message switch that survives a send, so passing `search` raises VALIDATION_ERROR instead of pretending to control it.',
        },
        {
          id: 'deep_research',
          display_name: research.label ?? 'Deep research',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: false,
          applies_to_models: null,
          note: research.supported
            ? 'Published by /backend-api/system_hints?mode=plugins as plugin:connector_openai_deep_research, but not reachable from a plugin: the only request field that selects it (system_hints on POST /backend-api/f/conversation) sits behind OpenAI Sentinel, and the composer "+" menu that offers it is an HTML `interestfor` popover that opens only on a real user gesture. Start a research run in the browser; get_conversation then reads it back as normalized items.'
            : 'Not published for this account by /backend-api/system_hints?mode=plugins.',
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
          thinkingModels.length > 0
            ? supported
            : unsupported('The live picker publishes no model with a reasoning-effort ladder for this account.'),
        web_search:
          searchModels.length > 0
            ? supported
            : unsupported('No model the picker offers has the search tool enabled for this account.'),
        // The plugin cannot START a research run — see the deep_research toggle
        // note — so the SPEC §7 tools are omitted rather than stubbed.
        deep_research: unsupported(
          research.supported
            ? 'chatgpt.com publishes the Deep research plugin, but a plugin cannot start a run: system_hints on POST /backend-api/f/conversation is behind OpenAI Sentinel (403 "Unusual activity has been detected from your device"), and the composer "+" menu that offers it is an HTML `interestfor` popover that ignores scripted and CDP-injected clicks alike. A run started in the browser is still readable through get_conversation.'
            : '/backend-api/system_hints?mode=plugins does not publish the Deep research plugin for this account.',
        ),
        vision:
          visionModels.length > 0
            ? supported
            : unsupported('No model the picker offers accepts image attachments for this account.'),
        code_interpreter:
          codeModels.length > 0
            ? supported
            : unsupported('No model the picker offers has the python tool enabled for this account.'),
      },
    };
  },
});
