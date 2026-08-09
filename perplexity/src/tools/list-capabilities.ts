import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModelCatalog } from '../perplexity-models.js';
import { capabilitiesSchema } from './normalized-schemas.js';

const unsupported = (reason: string) => ({ supported: false, reason });
const supported = { supported: true, reason: null };

export const listCapabilities = defineTool({
  name: 'list_capabilities',
  displayName: 'List Capabilities',
  description:
    'Report everything this Perplexity plugin can do: the live model list, every toggle with its scope, and a ' +
    'feature map with a reason for each unsupported feature. Derived on every call from /rest/models/config/v2, the ' +
    "account's settings and /rest/rate-limit/status — nothing here is a static literal.",
  summary: 'What this provider supports',
  icon: 'sliders-horizontal',
  group: 'Account',
  input: z.object({}),
  output: capabilitiesSchema,
  handle: async () => {
    const catalog = await getModelCatalog();
    const withThinking = catalog.models.filter(model => model.capabilities.thinking.supported);
    const withSearch = catalog.models.filter(model => model.capabilities.web_search.supported);
    const withResearch = catalog.models.filter(model => model.capabilities.deep_research.supported);
    const withCode = catalog.models.filter(model => model.capabilities.code_interpreter.supported);
    const researchAvailable = catalog.modeAvailability.research?.available !== false && withResearch.length > 0;

    return {
      provider: 'perplexity',
      models: catalog.models,
      toggles: [
        {
          id: 'thinking',
          display_name: 'Thinking',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: withThinking.length > 0,
          applies_to_models: withThinking.map(model => model.id),
          note:
            'Thinking is a MODEL on Perplexity, not a request flag: each model-picker row pairs a non-thinking id ' +
            'with a "…thinking" id and the toggle swaps between them. thinking:true on a row that has no thinking ' +
            'sibling raises VALIDATION_ERROR rather than being ignored.',
        },
        {
          id: 'thinking_level',
          display_name: 'Reasoning effort',
          type: 'enum' as const,
          values: [],
          default: '',
          scope: 'per_message' as const,
          controllable: false,
          applies_to_models: [],
          note:
            'Perplexity publishes no reasoning-effort ladder for chat models — capabilities.thinking.levels is null ' +
            'on every model — so the normalized thinking_level has nowhere to map and raises VALIDATION_ERROR.',
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
          note:
            'search:false sends the query with Perplexity\'s "writing" focus, which answers from the model alone. ' +
            'With search on, Perplexity still decides autonomously how much to search.',
        },
        {
          id: 'deep_research',
          display_name: 'Deep research',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: researchAvailable,
          applies_to_models: withResearch.map(model => model.id),
          note:
            'Selected by sending the Deep research model rather than a flag; exposed through start_deep_research. ' +
            `Live quota from /rest/rate-limit/status: ${
              catalog.modeAvailability.research
                ? `${catalog.modeAvailability.research.available ? 'available' : 'exhausted'}, ${
                    catalog.modeAvailability.research.remaining ?? 'unreported'
                  } remaining`
                : 'not reported for this account'
            }.`,
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
          withThinking.length > 0
            ? supported
            : unsupported("No model in this account's picker publishes a thinking counterpart."),
        web_search:
          withSearch.length > 0 ? supported : unsupported("No model in this account's picker can search the web."),
        deep_research: researchAvailable
          ? supported
          : unsupported(
              'Perplexity offers no Deep research model to this account, or its research quota is exhausted for ' +
                'the current window.',
            ),
        vision: unsupported(
          'Perplexity publishes no per-model vision flag, and this plugin deliberately implements no file/attachment ' +
            'handling, so there is no verified image path to claim.',
        ),
        code_interpreter:
          withCode.length > 0
            ? supported
            : unsupported("No model in this account's picker runs in a mode that executes code."),
      },
    };
  },
});
