import { ToolError, defineTool, sleep } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getConversationMetadata, mapConversationRow, setConversationProject } from '../copilot-conversations.js';
import { walkCursorPages } from '../copilot-pagination.js';
import {
  collectProjectConversations,
  collectProjects,
  createProjectRecord,
  deleteProjectRecord,
  fetchProjectConversationsPage,
  fetchProjectsPage,
  findConversationProject,
  getProjectRecord,
  mapProject,
  mapProjectConversation,
  projectContainsConversation,
  updateProjectRecord,
} from '../copilot-projects.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  projectSchema,
  resolvePagination,
} from './normalized-schemas.js';

const SETTLE_ATTEMPTS = 8;
const SETTLE_DELAY_MS = 400;
const DESCRIPTION_UNSUPPORTED =
  'Copilot Projects expose only a title; the native create/edit UI and API publish no description field.';

const settleContains = async (projectId: string, conversationId: string, expected: boolean): Promise<boolean> => {
  let actual = await projectContainsConversation(projectId, conversationId);
  for (let attempt = 1; attempt < SETTLE_ATTEMPTS && actual !== expected; attempt += 1) {
    await sleep(SETTLE_DELAY_MS);
    actual = await projectContainsConversation(projectId, conversationId);
  }
  return actual;
};

export const listProjects = defineTool({
  name: 'list_projects',
  displayName: 'List Projects',
  description:
    "List Copilot Projects through the site's native opaque cursor. The provider chooses its own page size, so the " +
    'normalized cursor preserves intra-page position when limit cuts a page. List rows omit description, creation ' +
    'time, and chat count; those fields are null/0 and get_project computes conversation_count.',
  summary: 'List Copilot Projects',
  icon: 'folder',
  group: 'Projects',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(projectSchema),
  handle: params => walkCursorPages(resolvePagination(params), fetchProjectsPage, project => mapProject(project, null)),
});

export const getProject = defineTool({
  name: 'get_project',
  displayName: 'Get Project',
  description:
    'Read one Copilot Project and exhaust its native conversation cursor to return an exact conversation_count. The provider exposes title only, so description is null and created_at is 0.',
  summary: 'Get a Copilot Project',
  icon: 'folder-open',
  group: 'Projects',
  input: z.object({ project_id: z.string().trim().min(1) }),
  output: projectSchema,
  handle: async params => {
    const [project, conversations] = await Promise.all([
      getProjectRecord(params.project_id),
      collectProjectConversations(params.project_id),
    ]);
    return mapProject(project, conversations.length);
  },
});

export const listProjectConversations = defineTool({
  name: 'list_project_conversations',
  displayName: 'List Project Conversations',
  description:
    "List a Copilot Project's chats through its native opaque cursor. Each normalized row carries the verified project_id; Copilot reports no total.",
  summary: 'List chats in a Copilot Project',
  icon: 'folder-tree',
  group: 'Projects',
  input: z.object({ project_id: z.string().trim().min(1), ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    const project = await getProjectRecord(params.project_id);
    const projectId = project.id ?? params.project_id;
    return walkCursorPages(
      resolvePagination(params),
      cursor => fetchProjectConversationsPage(projectId, cursor),
      row => mapProjectConversation(row, projectId),
    );
  },
});

export const createProject = defineTool({
  name: 'create_project',
  displayName: 'Create Project',
  description: `Create a native Copilot Project and read it back. ${DESCRIPTION_UNSUPPORTED} Passing description raises VALIDATION_ERROR rather than discarding it.`,
  summary: 'Create a Copilot Project',
  icon: 'folder-plus',
  group: 'Projects',
  input: z.object({ name: z.string().trim().min(1), description: z.string().optional() }),
  output: projectSchema,
  handle: async params => {
    if (params.description !== undefined) throw ToolError.validation(DESCRIPTION_UNSUPPORTED, 'VALIDATION_ERROR');
    const created = await createProjectRecord(params.name);
    const stored = await getProjectRecord(created.id ?? '');
    if (stored.title !== params.name)
      throw new ToolError('Copilot created a Project but did not store the requested title.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return mapProject(stored, 0);
  },
});

export const updateProject = defineTool({
  name: 'update_project',
  displayName: 'Update Project',
  description: `Rename a Copilot Project and verify the stored title. ${DESCRIPTION_UNSUPPORTED} Omitted fields are preserved.`,
  summary: 'Update a Copilot Project',
  icon: 'pencil',
  group: 'Projects',
  input: z.object({
    project_id: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
  }),
  output: projectSchema,
  handle: async params => {
    if (params.description !== undefined) throw ToolError.validation(DESCRIPTION_UNSUPPORTED, 'VALIDATION_ERROR');
    if (params.name === undefined) throw ToolError.validation('Nothing to update — pass name.', 'VALIDATION_ERROR');
    await getProjectRecord(params.project_id);
    const updated = await updateProjectRecord(params.project_id, params.name);
    if (updated.title !== params.name)
      throw new ToolError('Copilot accepted the Project rename but did not persist it.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return mapProject(updated, (await collectProjectConversations(params.project_id)).length);
  },
});

export const deleteProject = defineTool({
  name: 'delete_project',
  displayName: 'Delete Project',
  description:
    'Permanently delete an empty Copilot Project. Non-empty Projects are always refused because Copilot exposes no ' +
    'detach-to-Recents operation and native deletion may also delete member chats. detach_conversations is retained ' +
    'for normalized input compatibility but cannot override that safety gate.',
  summary: 'Delete a Copilot Project safely',
  icon: 'trash-2',
  group: 'Projects',
  input: z.object({
    project_id: z.string().trim().min(1),
    detach_conversations: z.boolean().optional(),
  }),
  output: z.object({
    project_id: z.string(),
    deleted: z.boolean(),
    conversations_detached: z.number().int(),
  }),
  handle: async params => {
    const project = await getProjectRecord(params.project_id);
    const projectId = project.id ?? params.project_id;
    const members = await collectProjectConversations(projectId);
    if (members.length > 0)
      throw ToolError.validation(
        `Project ${projectId} holds ${members.length} conversation(s). Move or delete them first; Copilot has no detach-to-Recents operation, so deletion was not sent.`,
        'VALIDATION_ERROR',
      );
    await deleteProjectRecord(projectId);
    const stillListed = (await collectProjects()).some(candidate => candidate.id === projectId);
    if (stillListed)
      throw new ToolError(`Copilot still lists Project ${projectId} after deletion.`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return { project_id: projectId, deleted: true, conversations_detached: members.length };
  },
});

export const addConversationToProject = defineTool({
  name: 'add_conversation_to_project',
  displayName: 'Add Conversation To Project',
  description:
    'Assign a Copilot chat to a Project with the native projectId PATCH. Both resources are read first; target membership and removal from any prior source are verified afterward.',
  summary: 'Add a chat to a Copilot Project',
  icon: 'folder-input',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().trim().min(1),
    project_id: z.string().trim().min(1),
  }),
  output: conversationListItemSchema,
  handle: async params => {
    const [target, conversation, sourceId] = await Promise.all([
      getProjectRecord(params.project_id),
      getConversationMetadata(params.conversation_id),
      findConversationProject(params.conversation_id),
    ]);
    const targetId = target.id ?? params.project_id;
    if (sourceId !== targetId) await setConversationProject(params.conversation_id, targetId);
    const [targetContains, sourceContains] = await Promise.all([
      settleContains(targetId, params.conversation_id, true),
      sourceId && sourceId !== targetId ? settleContains(sourceId, params.conversation_id, false) : false,
    ]);
    if (!targetContains || sourceContains)
      throw new ToolError(
        `Copilot did not verify assignment of ${params.conversation_id} to ${targetId}.`,
        'UPSTREAM_ERROR',
        {
          category: 'internal',
          retryable: true,
        },
      );
    return mapConversationRow(await getConversationMetadata(conversation.id ?? params.conversation_id), targetId);
  },
});

export const removeConversationFromProject = defineTool({
  name: 'remove_conversation_from_project',
  displayName: 'Remove Conversation From Project',
  description:
    'Validate the current Project membership, then report UNSUPPORTED without mutation. Copilot can move a chat to ' +
    'another Project but has no native detach-to-Recents operation: the UI exposes only Rename/Delete, and its API acknowledges projectId:null without changing membership.',
  summary: 'Explain Copilot Project removal limits',
  icon: 'folder-minus',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().trim().min(1),
    project_id: z.string().trim().min(1).optional(),
  }),
  output: conversationListItemSchema,
  handle: async params => {
    const [, sourceId] = await Promise.all([
      getConversationMetadata(params.conversation_id),
      findConversationProject(params.conversation_id),
    ]);
    if (!sourceId) throw ToolError.validation(`Conversation ${params.conversation_id} is not in a Project.`);
    if (params.project_id) {
      const guard = await getProjectRecord(params.project_id);
      if (sourceId !== guard.id)
        throw ToolError.validation(`Conversation ${params.conversation_id} is in ${sourceId}, not ${guard.id}.`);
    }
    throw new ToolError(
      `Copilot cannot detach ${params.conversation_id} from Project ${sourceId}. Move it to another Project or delete it.`,
      'UNSUPPORTED',
      { category: 'validation', retryable: false },
    );
  },
});

export const moveConversationToProject = defineTool({
  name: 'move_conversation_to_project',
  displayName: 'Move Conversation To Project',
  description:
    'Move a Copilot chat to another Project with one native assignment. The destination must contain it and the prior source must not; from_project_id is an optional guard.',
  summary: 'Move a chat between Copilot Projects',
  icon: 'folder-symlink',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().trim().min(1),
    to_project_id: z.string().trim().min(1),
    from_project_id: z.string().trim().min(1).optional(),
  }),
  output: z.object({
    conversation: conversationListItemSchema,
    from_project_id: z.string().nullable(),
    to_project_id: z.string(),
    verified: z.object({ target_contains: z.boolean(), source_contains: z.boolean() }),
  }),
  handle: async params => {
    const [target, conversation, sourceId] = await Promise.all([
      getProjectRecord(params.to_project_id),
      getConversationMetadata(params.conversation_id),
      findConversationProject(params.conversation_id),
    ]);
    const targetId = target.id ?? params.to_project_id;
    if (params.from_project_id) {
      const guard = await getProjectRecord(params.from_project_id);
      if (sourceId !== guard.id)
        throw ToolError.validation(
          `Conversation ${params.conversation_id} is in ${sourceId ?? '(none)'}, not ${guard.id}.`,
        );
    }
    if (sourceId !== targetId) await setConversationProject(params.conversation_id, targetId);
    const [targetContains, sourceContains] = await Promise.all([
      settleContains(targetId, params.conversation_id, true),
      sourceId && sourceId !== targetId ? settleContains(sourceId, params.conversation_id, false) : false,
    ]);
    if (!targetContains || sourceContains)
      throw new ToolError(
        `Copilot did not verify the move of ${params.conversation_id} from ${sourceId ?? '(none)'} to ${targetId}.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      );
    return {
      conversation: mapConversationRow(
        await getConversationMetadata(conversation.id ?? params.conversation_id),
        targetId,
      ),
      from_project_id: sourceId,
      to_project_id: targetId,
      verified: { target_contains: targetContains, source_contains: sourceContains },
    };
  },
});
