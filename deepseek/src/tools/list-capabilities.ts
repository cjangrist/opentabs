import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModelCatalog } from '../deepseek-models.js';
import { capabilitiesSchema } from './normalized-schemas.js';

const unsupported = (reason: string) => ({ supported: false, reason });
const supported = { supported: true, reason: null };

const NO_PROJECTS_REASON =
  'DeepSeek has no projects, folders or spaces. The site bundle declares every endpoint it can reach and none of them mention a project, ' +
  'collection or folder (the full set is chat_session/{create,delete,delete_all,fetch_page,update_pinned,update_title}, ' +
  'chat/{completion,continue,create_pow_challenge,edit_message,history_messages,message_feedback,regenerate,resume_stream,stop_stream}, ' +
  'client/settings, index/{prepare,query}, share/*, file/*, users/*), and the sidebar offers no such affordance.';

const NO_DEEP_RESEARCH_REASON =
  'DeepSeek ships no Deep Research mode. The composer offers exactly two toggles — DeepThink and Search — the mode picker offers exactly ' +
  'Instant / Expert / Vision, and no research or task endpoint exists in the site bundle. Search runs inline inside a normal completion ' +
  'and returns within one turn, so it is exposed as search:true on send_message rather than as a job.';

const NO_ARCHIVE_REASON =
  'DeepSeek has no archive concept for chats. The session payload carries only `pinned`, the sidebar row menu offers Rename / Pin / Delete only, ' +
  'and the only session-state endpoints are chat_session/update_pinned, update_title and delete. Use star_conversation or delete_conversation.';

export const listCapabilities = defineTool({
  name: 'list_capabilities',
  displayName: 'List Capabilities',
  description:
    'Report everything this DeepSeek plugin can do: the live mode list, every toggle with its scope, and a feature map with a reason for each unsupported feature. Derived from the live GET /client/settings?scope=model payload on every call.',
  summary: 'What this provider supports',
  icon: 'sliders-horizontal',
  group: 'Account',
  input: z.object({}),
  output: capabilitiesSchema,
  handle: async () => {
    const catalog = await getModelCatalog();
    const withThinking = catalog.models.filter(model => model.capabilities.thinking.supported);
    const withSearch = catalog.models.filter(model => model.capabilities.web_search.supported);
    const withVision = catalog.models.filter(model => model.capabilities.vision.supported);

    return {
      provider: 'deepseek',
      models: catalog.models,
      toggles: [
        {
          id: 'thinking',
          display_name: 'DeepThink',
          type: 'boolean' as const,
          values: null,
          // The composer starts with DeepThink off; the SPA remembers the last
          // choice in localStorage but every request carries the flag explicitly.
          default: false,
          scope: 'per_message' as const,
          controllable: withThinking.length > 0,
          applies_to_models: withThinking.map(model => model.id),
          note: 'Sent as thinking_enabled on POST /chat/completion. There is NO effort ladder — thinking_level raises VALIDATION_ERROR.',
        },
        {
          id: 'web_search',
          display_name: 'Search',
          type: 'boolean' as const,
          values: null,
          default: false,
          scope: 'per_message' as const,
          controllable: withSearch.length > 0,
          applies_to_models: withSearch.map(model => model.id),
          note:
            'Sent as search_enabled on POST /chat/completion. Only modes whose settings payload carries a search_feature offer it; ' +
            'the others hide the Search button and answer with a "Search is unavailable" tip, so search:true on them raises VALIDATION_ERROR. ' +
            'With it on, DeepSeek still decides autonomously whether to query.',
        },
        {
          id: 'model',
          display_name: 'Mode',
          type: 'enum' as const,
          values: catalog.models.map(model => model.id),
          default: catalog.defaultModelId,
          // Chosen once, when the chat is created, and immutable afterwards —
          // DeepSeek's own tooltip is "To switch modes, please start a new chat".
          scope: 'account' as const,
          controllable: true,
          applies_to_models: null,
          note: 'Fixed for the life of a conversation: settable on create_conversation, rejected with VALIDATION_ERROR on send_message when it differs.',
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
        archive_conversation: unsupported(NO_ARCHIVE_REASON),
        projects: unsupported(NO_PROJECTS_REASON),
        project_membership: unsupported(NO_PROJECTS_REASON),
        models: supported,
        thinking:
          withThinking.length > 0
            ? supported
            : unsupported('No mode published for this account offers the DeepThink toggle.'),
        web_search:
          withSearch.length > 0
            ? supported
            : unsupported('No mode published for this account offers the Search toggle.'),
        deep_research: unsupported(NO_DEEP_RESEARCH_REASON),
        vision: withVision.length > 0 ? supported : unsupported('No mode published for this account reads images.'),
        code_interpreter: unsupported(
          'DeepSeek runs no code interpreter. Assistant turns carry only REQUEST / RESPONSE / THINK / SEARCH / TOOL_SEARCH / TOOL_OPEN / TOOL_FIND / FILE / TIP fragments — ' +
            'the tool fragments are all web browsing — and the composer offers no code or sandbox affordance.',
        ),
      },
    };
  },
});
