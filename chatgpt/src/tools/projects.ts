import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl } from '../chatgpt-api.js';
import { getConversationDetail, patchConversation } from '../chatgpt-conversations.js';
import { walkCursorPages } from '../chatgpt-pagination.js';
import {
  PROJECT_CONVERSATIONS_MAX_LIMIT,
  assertProjectId,
  createProjectGizmo,
  deleteProjectGizmo,
  fetchProjectConversationPage,
  fetchProjectPage,
  getProjectGizmo,
  mapProject,
  updateProjectGizmo,
} from '../chatgpt-projects.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  projectSchema,
  resolvePagination,
} from './normalized-schemas.js';

const PROJECTS_NOTE =
  'ChatGPT calls projects "snorlax" gizmos internally and prefixes their ids "g-p-". ' +
  'The sidebar endpoint paginates by opaque cursor and reports no total, so total is null.';

export const listProjects = defineTool({
  name: 'list_projects',
  displayName: 'List Projects',
  description: `List your ChatGPT projects. ${PROJECTS_NOTE} conversation_count is null: the list endpoint reports no membership count — call list_project_conversations for that.`,
  summary: 'List your ChatGPT projects',
  icon: 'folder',
  group: 'Projects',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(projectSchema),
  handle: async params =>
    walkCursorPages(resolvePagination(params), fetchProjectPage, row => mapProject(row.gizmo, row.conversationCount)),
});

export const getProject = defineTool({
  name: 'get_project',
  displayName: 'Get Project',
  description: `Read one ChatGPT project. ${PROJECTS_NOTE}`,
  summary: 'Get a project',
  icon: 'folder-open',
  group: 'Projects',
  input: z.object({ project_id: z.string().describe('Project id from list_projects (starts with "g-p-").') }),
  output: z.object({ project: projectSchema }),
  handle: async params => ({ project: mapProject(await getProjectGizmo(params.project_id), null) }),
});

export const listProjectConversations = defineTool({
  name: 'list_project_conversations',
  displayName: 'List Project Conversations',
  description:
    "List the conversations that belong to a ChatGPT project. Paginated by the endpoint's own opaque cursor; " +
    'total is null because it reports no count. This is the read that proves a move from the target side.',
  summary: "List a project's conversations",
  icon: 'folder-tree',
  group: 'Projects',
  input: z.object({
    project_id: z.string().describe('Project id from list_projects (starts with "g-p-").'),
    ...paginationInputShape,
  }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params =>
    walkCursorPages(
      resolvePagination(params),
      (cursor, limit) => fetchProjectConversationPage(params.project_id, cursor, limit),
      row => {
        const id = row.id ?? row.conversation_id ?? '';
        return {
          id,
          title: row.title ?? '',
          url: conversationUrl(id),
          created_at: 0,
          updated_at: 0,
          project_id: params.project_id,
          model_id: null,
          is_archived: false,
          is_starred: false,
        };
      },
    ),
});

export const createProject = defineTool({
  name: 'create_project',
  displayName: 'Create Project',
  description:
    'Create a ChatGPT project. Sent as POST /backend-api/projects — POST /backend-api/gizmos looks similar but ' +
    'produces an ordinary GPT that never appears in the projects list. ' +
    "ChatGPT projects have no free-text description field of their own: `description` is stored as the project's " +
    'custom instructions, which is what the UI shows under "Instructions".',
  summary: 'Create a project',
  icon: 'folder-plus',
  group: 'Projects',
  input: z.object({
    name: z.string().min(1).describe('Project name.'),
    description: z.string().optional().describe("Stored as the project's instructions."),
  }),
  output: z.object({ project: projectSchema }),
  handle: async params => ({
    project: mapProject(await createProjectGizmo(params.name, params.description ?? ''), 0),
  }),
});

export const updateProject = defineTool({
  name: 'update_project',
  displayName: 'Update Project',
  description:
    'Rename a ChatGPT project or replace its instructions. PATCH /backend-api/projects/<id> rejects a partial body, ' +
    'so the current name/instructions/emoji/theme are read first and any field you omit is resent unchanged.',
  summary: 'Update a project',
  icon: 'folder-cog',
  group: 'Projects',
  input: z.object({
    project_id: z.string().describe('Project id from list_projects (starts with "g-p-").'),
    name: z.string().optional().describe('New name. Omit to keep the current one.'),
    description: z.string().optional().describe('New instructions. Omit to keep the current ones.'),
  }),
  output: z.object({ project: projectSchema }),
  handle: async params => {
    const current = await getProjectGizmo(params.project_id);
    const updated = await updateProjectGizmo(params.project_id, {
      name: params.name ?? current.display?.name ?? '',
      instructions: params.description ?? current.instructions ?? '',
      emoji: null,
      theme: null,
    });
    return { project: mapProject(updated, null) };
  },
});

export const deleteProject = defineTool({
  name: 'delete_project',
  displayName: 'Delete Project',
  description:
    'Delete a ChatGPT project (DELETE /backend-api/gizmos/<id>). WARNING: verified live — deleting a project also ' +
    'deletes every conversation still inside it, which then answers "Conversation has been deleted". Move anything ' +
    'you want to keep out first with move_conversation_to_project or remove_conversation_from_project. Irreversible.',
  summary: 'Delete a project',
  icon: 'folder-x',
  group: 'Projects',
  input: z.object({ project_id: z.string().describe('Project id from list_projects (starts with "g-p-").') }),
  output: z.object({ project_id: z.string(), success: z.literal(true) }),
  handle: async params => {
    await deleteProjectGizmo(params.project_id);
    return { project_id: params.project_id, success: true as const };
  },
});

/**
 * Detaching needs empty strings: PATCH /backend-api/conversation/<id> answers 200
 * to `{gizmo_id: null}` but leaves membership untouched. Verified live — only ""
 * actually clears it.
 */
const DETACH_PATCH = { gizmo_id: '', conversation_template_id: '' };

const membershipOutput = z.object({
  conversation_id: z.string(),
  project_id: z.string().nullable().describe('The project the conversation belongs to after the call, or null.'),
  success: z.literal(true),
});

/** Reads membership back from the conversation itself rather than trusting the write's 200. */
const confirmMembership = async (conversationId: string, expected: string | null): Promise<string | null> => {
  const detail = await getConversationDetail(conversationId);
  const actual = detail.gizmo_id ?? null;
  if (actual !== expected)
    throw new ToolError(
      `ChatGPT accepted the change but conversation ${conversationId} still reports project ${actual ?? 'none'} instead of ${expected ?? 'none'}.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  return actual;
};

export const addConversationToProject = defineTool({
  name: 'add_conversation_to_project',
  displayName: 'Add Conversation To Project',
  description:
    'Put an existing conversation into a project. Sent as PATCH /backend-api/conversation/<id> ' +
    '{gizmo_id, conversation_template_id}; membership is then re-read from the conversation before returning.',
  summary: 'Add a conversation to a project',
  icon: 'folder-input',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().describe('Conversation UUID.'),
    project_id: z.string().describe('Project id from list_projects (starts with "g-p-").'),
  }),
  output: membershipOutput,
  handle: async params => {
    const projectId = assertProjectId(params.project_id);
    await patchConversation(params.conversation_id, {
      gizmo_id: projectId,
      conversation_template_id: projectId,
    });
    return {
      conversation_id: params.conversation_id,
      project_id: await confirmMembership(params.conversation_id, projectId),
      success: true as const,
    };
  },
});

export const removeConversationFromProject = defineTool({
  name: 'remove_conversation_from_project',
  displayName: 'Remove Conversation From Project',
  description:
    'Take a conversation out of its project and return it to the ungrouped chat list. project_id is optional and ' +
    'only used as a guard: when given and the conversation is in a different project, the call fails instead of ' +
    'silently detaching it.',
  summary: 'Remove a conversation from its project',
  icon: 'folder-minus',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().describe('Conversation UUID.'),
    project_id: z.string().optional().describe('Expected current project; the call fails if it does not match.'),
  }),
  output: membershipOutput,
  handle: async params => {
    const detail = await getConversationDetail(params.conversation_id);
    const current = detail.gizmo_id ?? null;
    if (params.project_id && current !== params.project_id)
      throw ToolError.validation(
        `Conversation ${params.conversation_id} is in project ${current ?? 'none'}, not ${params.project_id}.`,
      );
    await patchConversation(params.conversation_id, DETACH_PATCH);
    return {
      conversation_id: params.conversation_id,
      project_id: await confirmMembership(params.conversation_id, null),
      success: true as const,
    };
  },
});

export const moveConversationToProject = defineTool({
  name: 'move_conversation_to_project',
  displayName: 'Move Conversation To Project',
  description:
    'Move a conversation from one project to another. ChatGPT stores membership as a single field on the ' +
    'conversation, so the move is one PATCH — there is no window where it belongs to both. from_project_id is ' +
    'optional and only used as a guard. Both sides are verified afterwards: the source no longer lists it and the ' +
    'conversation reports the target.',
  summary: 'Move a conversation between projects',
  icon: 'folder-symlink',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().describe('Conversation UUID.'),
    to_project_id: z.string().describe('Target project id (starts with "g-p-").'),
    from_project_id: z.string().optional().describe('Expected current project; the call fails if it does not match.'),
  }),
  output: membershipOutput.extend({
    source_still_lists_it: z.boolean().describe('Re-read of the source project; must be false for a clean move.'),
  }),
  handle: async params => {
    const target = assertProjectId(params.to_project_id);
    const detail = await getConversationDetail(params.conversation_id);
    const current = detail.gizmo_id ?? null;
    if (params.from_project_id && current !== params.from_project_id)
      throw ToolError.validation(
        `Conversation ${params.conversation_id} is in project ${current ?? 'none'}, not ${params.from_project_id}.`,
      );

    await patchConversation(params.conversation_id, { gizmo_id: target, conversation_template_id: target });
    const projectId = await confirmMembership(params.conversation_id, target);

    let sourceStillListsIt = false;
    if (current && current !== target) {
      const page = await fetchProjectConversationPage(current, undefined, PROJECT_CONVERSATIONS_MAX_LIMIT);
      sourceStillListsIt = page.rows.some(row => (row.id ?? row.conversation_id) === params.conversation_id);
      if (sourceStillListsIt)
        throw new ToolError(
          `Conversation ${params.conversation_id} now reports project ${target} but source project ${current} still lists it.`,
          'UPSTREAM_ERROR',
          { category: 'internal', retryable: true },
        );
    }
    return {
      conversation_id: params.conversation_id,
      project_id: projectId,
      source_still_lists_it: sourceStillListsIt,
      success: true as const,
    };
  },
});
