import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModels } from '../copilot-models.js';
import { getResearchQuota } from '../copilot-research.js';
import { capabilitiesSchema } from './normalized-schemas.js';

const supported = { supported: true, reason: null };
const unsupported = (reason: string) => ({ supported: false, reason });

export const listCapabilities = defineTool({
  name: 'list_capabilities',
  displayName: 'List Capabilities',
  description:
    'Report the Copilot features and controls this adapter can prove against the current account. Models and mode ' +
    'availability come from the live composer picker, while Deep Research quota comes from the signed-in user API.',
  summary: 'What Copilot supports',
  icon: 'sliders-horizontal',
  group: 'Account',
  input: z.object({}),
  output: capabilitiesSchema,
  handle: async () => {
    const [models, researchQuota] = await Promise.all([getModels(), getResearchQuota().catch(() => null)]);
    const available = models.filter(model => model.is_available);
    const modelIds = available.map(model => model.id);
    const reasoningIds = available.filter(model => model.capabilities.thinking.supported).map(model => model.id);
    const searchIds = available.filter(model => model.capabilities.web_search.per_message).map(model => model.id);
    const researchIds = available.filter(model => model.capabilities.deep_research.supported).map(model => model.id);
    const visionIds = available.filter(model => model.capabilities.vision.supported).map(model => model.id);
    const defaultModel = available.find(model => model.is_default) ?? available[0] ?? null;

    return {
      provider: 'copilot',
      models,
      toggles: [
        {
          id: 'model',
          display_name: 'Composer mode',
          type: 'enum' as const,
          values: modelIds,
          default: defaultModel?.id ?? '',
          scope: 'per_message' as const,
          controllable: modelIds.length > 1,
          applies_to_models: null,
          note: 'Copilot exposes named modes, not the underlying Microsoft model ids.',
        },
        {
          id: 'thinking',
          display_name: 'Think deeper',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: reasoningIds.length > 0,
          applies_to_models: reasoningIds,
          note: 'thinking:true or any normalized thinking_level selects the native reasoning mode. Copilot offers no finer effort ladder.',
        },
        {
          id: 'web_search',
          display_name: 'Search',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: searchIds.length > 0,
          applies_to_models: searchIds,
          note: 'search:true selects the native Search mode. Other modes may still browse autonomously; search:false cannot prohibit that.',
        },
        {
          id: 'deep_research',
          display_name: 'Deep research',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: researchIds.length > 0,
          applies_to_models: researchIds,
          note: `Deep Research is a dedicated native task workflow. Remaining runs: ${researchQuota ?? 'unknown'}.`,
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
          'Copilot has no archive action; its chat menu offers Pin, Rename, Move to projects, and Delete.',
        ),
        projects: supported,
        project_membership: supported,
        models: supported,
        thinking:
          reasoningIds.length > 0 ? supported : unsupported('The live composer picker exposes no Think deeper mode.'),
        web_search: searchIds.length > 0 ? supported : unsupported('The live composer picker exposes no Search mode.'),
        deep_research:
          researchIds.length > 0
            ? supported
            : unsupported('The live composer picker exposes no default mode capable of launching Deep Research.'),
        vision: visionIds.length > 0 ? supported : unsupported('No live Copilot mode accepts image input.'),
        code_interpreter: unsupported('No separately controllable code-interpreter capability is exposed by Copilot.'),
      },
    };
  },
});
