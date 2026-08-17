import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { DEEP_SEARCH_WORKSPACE_ID } from '../grok-api.js';
import { getModels } from '../grok-models.js';
import { getProjectRecord } from '../grok-projects.js';
import { capabilitiesSchema } from './normalized-schemas.js';

const supported = { supported: true, reason: null };
const unsupported = (reason: string) => ({ supported: false, reason });

export const listCapabilities = defineTool({
  name: 'list_capabilities',
  displayName: 'List Capabilities',
  description:
    "Report Grok features from the live mode picker and native API. Deep research is proved by reading Grok's current read-only DeepSearch template, not inferred from marketing copy or an old button.",
  summary: 'What Grok supports',
  icon: 'sliders-horizontal',
  group: 'Account',
  input: z.object({}),
  output: capabilitiesSchema,
  handle: async () => {
    const [models, deepSearchTemplate] = await Promise.all([
      getModels(),
      getProjectRecord(DEEP_SEARCH_WORKSPACE_ID).catch(() => null),
    ]);
    const available = models.filter(model => model.is_available);
    const modelIds = available.map(model => model.id);
    const thinkingIds = available.filter(model => model.capabilities.thinking.supported).map(model => model.id);
    const searchIds = available.filter(model => model.capabilities.web_search.supported).map(model => model.id);
    const visionIds = available.filter(model => model.capabilities.vision.supported).map(model => model.id);
    const codeIds = available.filter(model => model.capabilities.code_interpreter.supported).map(model => model.id);
    const researchIds = available.filter(model => model.capabilities.deep_research.supported).map(model => model.id);
    const defaultModel = available.find(model => model.is_default) ?? available[0] ?? null;
    const deepResearchAvailable =
      deepSearchTemplate?.isReadonly === true &&
      deepSearchTemplate.preferredModel !== undefined &&
      researchIds.includes(deepSearchTemplate.preferredModel);

    return {
      provider: 'grok',
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
          note: 'Exact ids from the live Grok mode picker.',
        },
        {
          id: 'thinking',
          display_name: 'Reasoning mode',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: thinkingIds.length > 0,
          applies_to_models: thinkingIds,
          note: 'thinking:true or any normalized thinking_level selects Expert. Grok exposes no finer per-message effort ladder.',
        },
        {
          id: 'web_search',
          display_name: 'Web and X search',
          type: 'boolean' as const,
          values: null,
          default: true,
          scope: 'per_message' as const,
          controllable: searchIds.length > 0,
          applies_to_models: searchIds,
          note: 'search:false sends Grok’s native disable_web_search and disable_x_search session flags. search:true enables the tools, but Grok still decides when to invoke them.',
        },
        {
          id: 'deep_research',
          display_name: deepSearchTemplate?.name ?? 'DeepSearch',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: deepResearchAvailable,
          applies_to_models: researchIds,
          note: deepResearchAvailable
            ? "Runs through Grok's native read-only DeepSearch Project template and is polled by conversation id."
            : 'The native DeepSearch template or its preferred mode is unavailable.',
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
          'Grok offers Star and reversible Delete, but no distinct archive state or archive action.',
        ),
        projects: supported,
        project_membership: supported,
        models: supported,
        thinking: thinkingIds.length > 0 ? supported : unsupported('No available live mode supports reasoning.'),
        web_search: searchIds.length > 0 ? supported : unsupported('No available live mode supports web search.'),
        deep_research: deepResearchAvailable
          ? supported
          : unsupported("Grok's native DeepSearch template or its Expert mode is unavailable."),
        vision:
          visionIds.length > 0
            ? unsupported(
                'The live composer accepts images, but file upload is deliberately out of scope in SPEC §8, so this adapter cannot send one.',
              )
            : unsupported('No available live mode accepts image input.'),
        code_interpreter:
          codeIds.length > 0
            ? supported
            : unsupported(
                'No available live Grok mode emitted a native code-execution tool record during adapter verification.',
              ),
      },
    };
  },
});
