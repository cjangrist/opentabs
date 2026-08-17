import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { DEFAULT_NATIVE_THINKING_LEVEL, NATIVE_THINKING_LEVELS, getModels } from '../gemini-models.js';
import { getResearchAvailability } from '../gemini-research.js';
import { capabilitiesSchema } from './normalized-schemas.js';

const unsupported = (reason: string) => ({ supported: false, reason });
const supported = { supported: true, reason: null };

const NO_PROJECTS_REASON =
  'gemini.google.com has no container this plugin can drive. Gems (/gems/view, RPC CNgdBe) list only the premade ' +
  'Google gems for this account and carry no conversation membership — the chat row menu offers Share, Pin, Rename, ' +
  'Add to notebook and Delete, with no gem action — and the conversation list rows (RPC MaZiqc) contain no gem or ' +
  'notebook id, so a move could not be verified from either side. Notebooks do accept a chat ("Move Chat" dialog), ' +
  'but their listing and mutation never appear on the /_/BardChatUi/data/batchexecute transport: capturing every ' +
  'XHR across a full page load of /app, /notebooks/view and /gems/view produced no request carrying a notebook id, ' +
  'and the ids are absent from the server-rendered HTML too.';

export const listCapabilities = defineTool({
  name: 'list_capabilities',
  displayName: 'List Capabilities',
  description:
    'Report everything this Gemini plugin can do: the live mode list, every toggle with its scope, and a feature map ' +
    'with a reason for each unsupported feature. Derived from the live bootstrap payload on every call, never a ' +
    'static literal.',
  summary: 'What this provider supports',
  icon: 'sliders-horizontal',
  group: 'Account',
  input: z.object({}),
  output: capabilitiesSchema,
  handle: async () => {
    const [models, researchAvailability] = await Promise.all([
      getModels(),
      getResearchAvailability().catch(() => ({ available: false, resetAt: null, recognized: false })),
    ]);
    const withThinking = models.filter(model => model.capabilities.thinking.supported);
    const withVision = models.filter(model => model.capabilities.vision.supported);
    const withCode = models.filter(model => model.capabilities.code_interpreter.supported);
    const withResearch = models.filter(model => model.capabilities.deep_research.supported);
    const defaultModel = models.find(model => model.is_default) ?? null;

    return {
      provider: 'gemini',
      models,
      toggles: [
        {
          id: 'thinking',
          display_name: 'Extended thinking',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: withThinking.length > 0,
          applies_to_models: withThinking.map(model => model.id),
          note:
            'The mode picker renders "Extended thinking" as a fourth row pinned to the most capable mode. Sent as ' +
            'slot 15 of the x-goog-ext-525001261-jspb header (1 = standard, 2 = extended); the transcript then ' +
            'labels the turn "<mode> Extended".',
        },
        {
          id: 'thinking_level',
          display_name: 'Reasoning effort',
          type: 'enum' as const,
          values: [...NATIVE_THINKING_LEVELS],
          default: DEFAULT_NATIVE_THINKING_LEVEL,
          scope: 'per_message' as const,
          controllable: withThinking.length > 0,
          applies_to_models: withThinking.map(model => model.id),
          note:
            'Gemini publishes two depths. The normalized ladder collapses onto them: minimal|low request standard ' +
            'thinking, medium|high|max request Extended thinking. Omitting both controls sends standard, which is ' +
            'why the default reported here is "standard" and not "extended".',
        },
        {
          id: 'model',
          display_name: 'Mode',
          type: 'enum' as const,
          values: models.map(model => model.id),
          default: defaultModel?.id ?? models[0]?.id ?? '',
          scope: 'per_message' as const,
          controllable: models.length > 1,
          applies_to_models: null,
          note: 'Selected per request via slot 4 of the x-goog-ext-525001261-jspb header, not by an account setting.',
        },
        {
          id: 'web_search',
          display_name: 'Web search',
          type: 'boolean' as const,
          values: null,
          default: true,
          scope: 'account' as const,
          controllable: false,
          applies_to_models: null,
          note:
            'Gemini browses autonomously and its composer exposes no per-message web-search switch. Passing search to send_message raises VALIDATION_ERROR ' +
            'rather than pretending to control it.',
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
          note:
            'The Upload & tools menu exposes a native Deep research chip. It is driven through start_deep_research ' +
            `rather than a send_message flag. Native quota is ${
              !researchAvailability.recognized
                ? 'unknown because its availability payload was unavailable or unrecognized'
                : researchAvailability.available
                  ? 'available'
                  : `exhausted${
                      researchAvailability.resetAt
                        ? ` until ${new Date(researchAvailability.resetAt * 1000).toISOString()}`
                        : ''
                    }`
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
        archive_conversation: unsupported(
          'gemini.google.com has no archive action — the chat row menu offers Share, Pin, Rename, Add to notebook and Delete only.',
        ),
        projects: unsupported(NO_PROJECTS_REASON),
        project_membership: unsupported(NO_PROJECTS_REASON),
        models: supported,
        thinking:
          withThinking.length > 0
            ? supported
            : unsupported('No mode published to this account offers the Extended thinking picker entry.'),
        web_search: supported,
        deep_research:
          withResearch.length === 0
            ? unsupported('No mode available to this account can start the native Deep research workflow.')
            : !researchAvailability.recognized
              ? unsupported(
                  'Gemini Deep Research is implemented, but native quota availability could not be determined because MyzX6c failed or published an unrecognized payload.',
                )
              : researchAvailability.available
                ? supported
                : unsupported(
                    `Gemini reports this account's Deep Research usage limit is exhausted${
                      researchAvailability.resetAt
                        ? ` until ${new Date(researchAvailability.resetAt * 1000).toISOString()}`
                        : ''
                    }.`,
                  ),
        vision:
          withVision.length > 0
            ? supported
            : unsupported('No mode published to this account declares the image-input capability id.'),
        code_interpreter:
          withCode.length > 0
            ? supported
            : unsupported('No mode published to this account declares the code-execution capability id.'),
      },
    };
  },
});
