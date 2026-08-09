import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  countProjectConversations,
  fetchArchivedIds,
  fetchProjectConversationPage,
  getConversationDetail,
  mapConversationDetail,
  mapConversationRow,
} from '../qwen-conversations.js';
import { pageLocalArray, walkNumberedPages } from '../qwen-pagination.js';
import {
  createProject as createProjectRecord,
  deleteProject as deleteProjectRecord,
  getProject as getProjectRecord,
  listProjects as listProjectRecords,
  mapProject,
  setChatProject,
  updateProject as updateProjectRecord,
} from '../qwen-projects.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  projectSchema,
  resolvePagination,
} from './normalized-schemas.js';

const PROJECT_NOTE =
  'Qwen calls these projects. SPEC `description` maps onto Qwen\'s `custom_instruction` — the free-text "Instructions" the project settings dialog edits — and is null when empty. Qwen-only settings (icon, memory_span) have no home in the normalized shape and are preserved untouched on update.';

/** A conversation belongs to at most one project, so membership is a single field. */
const MEMBERSHIP_NOTE =
  'POST /api/v2/projects/add_chat is the only membership primitive Qwen has: the web app\'s own "Remove from project" menu calls it with project_id: "". A chat belongs to at most one project, so adding replaces any previous membership.';

export const listProjects = defineTool({
  name: 'list_projects',
  displayName: 'List Projects',
  description:
    `List projects from GET /api/v2/projects/. ${PROJECT_NOTE} ` +
    'The endpoint returns every project in one unpaginated response, so total is a true total and pagination is applied locally. ' +
    'conversation_count is null here because counting a project means walking its whole chat list; call get_project or list_project_conversations for a real count.',
  summary: 'List projects (paginated)',
  icon: 'folder',
  group: 'Projects',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(projectSchema),
  handle: async params =>
    pageLocalArray(
      (await listProjectRecords()).map(project => mapProject(project, null)),
      resolvePagination(params),
    ),
});

export const getProject = defineTool({
  name: 'get_project',
  displayName: 'Get Project',
  description: `Read one project, including a real conversation_count walked from GET /api/v2/chats/?project_id=<id>. ${PROJECT_NOTE}`,
  summary: 'Get a project',
  icon: 'folder-open',
  group: 'Projects',
  input: z.object({ project_id: z.string().describe('Project id from list_projects.') }),
  output: projectSchema,
  handle: async params => {
    const project = await getProjectRecord(params.project_id);
    return mapProject(project, await countProjectConversations(params.project_id));
  },
});

export const listProjectConversations = defineTool({
  name: 'list_project_conversations',
  displayName: 'List Project Conversations',
  description:
    'List the conversations inside a project. Drives GET /api/v2/chats/?project_id=<id>&page=<n>, the same 1-based, fixed-60-row endpoint as list_conversations, so the same "<page>:<offset>" cursor applies and total is null.',
  summary: 'List a project’s conversations (paginated)',
  icon: 'folder-tree',
  group: 'Projects',
  input: z.object({
    project_id: z.string().describe('Project id from list_projects.'),
    ...paginationInputShape,
  }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    await getProjectRecord(params.project_id);
    const archived = await fetchArchivedIds();
    return walkNumberedPages(
      resolvePagination(params),
      page => fetchProjectConversationPage(params.project_id, page),
      mapConversationRow(archived),
    );
  },
});

export const createProject = defineTool({
  name: 'create_project',
  displayName: 'Create Project',
  description: `Create a project. ${PROJECT_NOTE} The POST answers with an id alone, so the record is read back and a verified object is returned rather than an echo of the request.`,
  summary: 'Create a project',
  icon: 'folder-plus',
  group: 'Projects',
  input: z.object({
    name: z.string().min(1).describe('Project name.'),
    description: z.string().optional().describe('Stored as Qwen’s custom_instruction ("Instructions").'),
  }),
  output: projectSchema,
  handle: async params => mapProject(await createProjectRecord(params.name, params.description), 0),
});

export const updateProject = defineTool({
  name: 'update_project',
  displayName: 'Update Project',
  description:
    `Rename a project or change its instructions. ${PROJECT_NOTE} ` +
    'Qwen’s PUT replaces the fields it is given and answers {status:true} rather than the record, so the current values are read first and every untouched field is re-sent — renaming a project therefore cannot blank its instructions — and the stored record is read back afterwards.',
  summary: 'Update a project',
  icon: 'pencil',
  group: 'Projects',
  input: z.object({
    project_id: z.string().describe('Project id from list_projects.'),
    name: z.string().min(1).optional().describe('New project name.'),
    description: z.string().optional().describe('New custom_instruction ("Instructions").'),
  }),
  output: projectSchema,
  handle: async params => {
    if (params.name === undefined && params.description === undefined)
      throw ToolError.validation('Nothing to update — pass name and/or description.');
    return mapProject(await updateProjectRecord(params.project_id, params.name, params.description), null);
  },
});

export const deleteProject = defineTool({
  name: 'delete_project',
  displayName: 'Delete Project',
  description:
    'Delete a project through DELETE /api/v2/projects/<id>. The project is read first so a missing id raises NOT_FOUND. ' +
    'A project that still holds conversations is refused with VALIDATION_ERROR unless detach_conversations: true is passed, in which case every member is moved out of the project first (project_id: "") and the conversations themselves are kept.',
  summary: 'Delete a project',
  icon: 'trash-2',
  group: 'Projects',
  input: z.object({
    project_id: z.string().describe('Project id from list_projects.'),
    detach_conversations: z
      .boolean()
      .optional()
      .describe('Move every conversation out of the project before deleting it, instead of refusing.'),
  }),
  output: z.object({
    deleted: z.boolean(),
    project_id: z.string(),
    conversations_detached: z.number().int().describe('Conversations moved out before the delete.'),
  }),
  handle: async params => {
    await getProjectRecord(params.project_id);
    const members = await collectProjectChatIds(params.project_id);
    if (members.length > 0 && params.detach_conversations !== true)
      throw ToolError.validation(
        `Project ${params.project_id} still holds ${members.length} conversation(s). Move them out with move_conversation_to_project / remove_conversation_from_project, or pass detach_conversations: true to detach them automatically.`,
      );
    if (members.length > 0) await setChatProject(members, '');
    await deleteProjectRecord(params.project_id);
    return { deleted: true, project_id: params.project_id, conversations_detached: members.length };
  },
});

const MAX_MEMBER_PAGES = 50;

const collectProjectChatIds = async (projectId: string): Promise<string[]> => {
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_MEMBER_PAGES; page += 1) {
    const rows = await fetchProjectConversationPage(projectId, page);
    const fresh = rows.filter(row => row.id && !seen.has(row.id));
    for (const row of fresh) seen.add(row.id ?? '');
    if (rows.length === 0 || fresh.length === 0) break;
  }
  return [...seen];
};

export const addConversationToProject = defineTool({
  name: 'add_conversation_to_project',
  displayName: 'Add Conversation To Project',
  description: `Put a conversation into a project. ${MEMBERSHIP_NOTE} Both ids are read first, so a bad one raises NOT_FOUND before anything is changed, and the conversation is re-read afterwards so the returned project_id is the stored one.`,
  summary: 'Add a conversation to a project',
  icon: 'folder-input',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().describe('Chat UUID.'),
    project_id: z.string().describe('Project id from list_projects.'),
  }),
  output: conversationListItemSchema,
  handle: async params => {
    await getProjectRecord(params.project_id);
    await getConversationDetail(params.conversation_id);
    await setChatProject([params.conversation_id], params.project_id);
    return mapConversationDetail(await getConversationDetail(params.conversation_id));
  },
});

export const removeConversationFromProject = defineTool({
  name: 'remove_conversation_from_project',
  displayName: 'Remove Conversation From Project',
  description: `Take a conversation out of its project (project_id: ""). ${MEMBERSHIP_NOTE} project_id is optional and used only as a guard: when given and the conversation is in a different project, the call fails instead of silently detaching it.`,
  summary: 'Remove a conversation from its project',
  icon: 'folder-minus',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().describe('Chat UUID.'),
    project_id: z.string().optional().describe('Project the conversation is expected to be in.'),
  }),
  output: conversationListItemSchema,
  handle: async params => {
    const before = await getConversationDetail(params.conversation_id);
    if (params.project_id && (before.project_id || null) !== params.project_id)
      throw ToolError.validation(
        `Conversation ${params.conversation_id} is in project ${before.project_id || '(none)'}, not ${params.project_id}.`,
      );
    await setChatProject([params.conversation_id], '');
    return mapConversationDetail(await getConversationDetail(params.conversation_id));
  },
});

export const moveConversationToProject = defineTool({
  name: 'move_conversation_to_project',
  displayName: 'Move Conversation To Project',
  description:
    'Move a conversation from one project to another and verify BOTH sides afterwards by re-reading each project’s chat list: the destination must list it and the source must not. A membership that did not actually change raises UPSTREAM_ERROR rather than reporting success. ' +
    'Moving into the project the conversation already occupies is a verified no-op rather than an error.',
  summary: 'Move a conversation between projects',
  icon: 'folder-symlink',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().describe('Chat UUID.'),
    to_project_id: z.string().describe('Destination project id.'),
    from_project_id: z.string().optional().describe('Project the conversation is expected to be in before the move.'),
  }),
  output: z.object({
    conversation: conversationListItemSchema,
    from_project_id: z.string().nullable(),
    to_project_id: z.string(),
    verified: z.object({
      target_contains: z.boolean().describe('Re-read of the destination project lists this conversation.'),
      source_contains: z.boolean().describe('Re-read of the source project still lists it — must be false.'),
    }),
  }),
  handle: async params => {
    await getProjectRecord(params.to_project_id);
    const before = await getConversationDetail(params.conversation_id);
    const source = before.project_id || null;
    if (params.from_project_id && source !== params.from_project_id)
      throw ToolError.validation(
        `Conversation ${params.conversation_id} is in project ${source ?? '(none)'}, not ${params.from_project_id}.`,
      );

    // Source and destination being the same project would make the both-sides check
    // below read a correct no-op as a failed move, so it is verified and returned
    // instead of raising an error that a retry could never clear.
    if (source === params.to_project_id) {
      const present = (await collectProjectChatIds(params.to_project_id)).includes(params.conversation_id);
      if (!present)
        throw new ToolError(
          `Conversation ${params.conversation_id} reports project ${source} but that project does not list it.`,
          'UPSTREAM_ERROR',
          { category: 'internal', retryable: false },
        );
      return {
        conversation: mapConversationDetail(before),
        from_project_id: source,
        to_project_id: params.to_project_id,
        verified: { target_contains: true, source_contains: false },
      };
    }

    await setChatProject([params.conversation_id], params.to_project_id);

    const targetContains = (await collectProjectChatIds(params.to_project_id)).includes(params.conversation_id);
    const sourceContains = source ? (await collectProjectChatIds(source)).includes(params.conversation_id) : false;
    if (!targetContains || sourceContains)
      throw new ToolError(
        `Qwen accepted the move but membership did not change as expected (target_contains=${targetContains}, source_contains=${sourceContains}).`,
        'UPSTREAM_ERROR',
        // Retrying cannot fix a membership upstream refused to change.
        { category: 'internal', retryable: false },
      );

    return {
      conversation: mapConversationDetail(await getConversationDetail(params.conversation_id)),
      from_project_id: source,
      to_project_id: params.to_project_id,
      verified: { target_contains: targetContains, source_contains: sourceContains },
    };
  },
});
