import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { NATIVE_THINKING_LEVELS, getModels } from '../gemini-models.js';
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
    const models = await getModels();
    const withThinking = models.filter(model => model.capabilities.thinking.supported);
    const withVision = models.filter(model => model.capabilities.vision.supported);
    const withCode = models.filter(model => model.capabilities.code_interpreter.supported);
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
          default: 'extended',
          scope: 'per_message' as const,
          controllable: withThinking.length > 0,
          applies_to_models: withThinking.map(model => model.id),
          note:
            'Gemini publishes exactly one depth, so the normalized ladder collapses onto on/off: minimal|low request ' +
            'standard thinking, medium|high|max request Extended thinking.',
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
            'Gemini browses autonomously and its composer exposes no web-search switch (the tools menu offers only ' +
            'Canvas, Guided learning and media generation). Passing search to send_message raises VALIDATION_ERROR ' +
            'rather than pretending to control it.',
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
        deep_research: supported,
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
