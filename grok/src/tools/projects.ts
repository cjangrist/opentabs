import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getConversationMetadata, getConversationProjectId, mapConversation } from '../grok-conversations.js';
import { walkCursorPages } from '../grok-pagination.js';
import {
  addConversationToProject,
  addConversationToProjectRecord,
  collectProjectConversations,
  createProjectRecord,
  deleteProjectRecord,
  fetchProjectConversationsPage,
  fetchProjectsPage,
  getProjectRecord,
  mapProject,
  projectContainsConversation,
  removeConversationFromProjectRecord,
  settleProjectMembership,
  updateProjectRecord,
} from '../grok-projects.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  projectSchema,
  resolvePagination,
} from './normalized-schemas.js';

const writableProject = async (projectId: string) => {
  const project = await getProjectRecord(projectId);
  if (project.isReadonly === true)
    throw new ToolError(`Grok Project ${projectId} is read-only.`, 'UNSUPPORTED', {
      category: 'validation',
      retryable: false,
    });
  return project;
};

const requirePersistedProject = async (projectId: string, expected: { name?: string; description?: string }) => {
  const stored = await getProjectRecord(projectId);
  if (expected.name !== undefined && stored.name !== expected.name)
    throw new ToolError(`Grok did not persist Project name ${JSON.stringify(expected.name)}.`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  if (expected.description !== undefined && (stored.customPersonality ?? '') !== expected.description)
    throw new ToolError('Grok did not persist the requested Project description.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return stored;
};

export const listProjects = defineTool({
  name: 'list_projects',
  displayName: 'List Projects',
  description:
    "List the account's native Grok Projects through their opaque cursor. List rows do not carry a trustworthy exact member count, so conversation_count is null until get_project exhausts the member cursor.",
  summary: 'List Grok Projects',
  icon: 'folder',
  group: 'Projects',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(projectSchema),
  handle: params => walkCursorPages(resolvePagination(params), fetchProjectsPage, row => mapProject(row, null)),
});

export const getProject = defineTool({
  name: 'get_project',
  displayName: 'Get Project',
  description: 'Read one native Grok Project and exhaust its conversation cursor for an exact conversation_count.',
  summary: 'Get a Grok Project',
  icon: 'folder-open',
  group: 'Projects',
  input: z.object({ project_id: z.string().trim().min(1) }),
  output: projectSchema,
  handle: async params => {
    const [project, members] = await Promise.all([
      getProjectRecord(params.project_id),
      collectProjectConversations(params.project_id),
    ]);
    if (!members.complete)
      throw new ToolError('The bounded Project scan could not prove an exact conversation count.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return mapProject(project, members.rows.length);
  },
});

export const listProjectConversations = defineTool({
  name: 'list_project_conversations',
  displayName: 'List Project Conversations',
  description:
    "List a Grok Project's chats through the native workspaceId-filtered cursor. Every returned row carries the verified project_id.",
  summary: 'List chats in a Grok Project',
  icon: 'folder-tree',
  group: 'Projects',
  input: z.object({ project_id: z.string().trim().min(1), ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    const project = await getProjectRecord(params.project_id);
    const projectId = project.workspaceId ?? params.project_id;
    return walkCursorPages(
      resolvePagination(params),
      cursor => fetchProjectConversationsPage(projectId, cursor),
      row => mapConversation(row, projectId),
    );
  },
});

export const createProject = defineTool({
  name: 'create_project',
  displayName: 'Create Project',
  description: 'Create a native Grok Project, then read it back and verify its name and optional description.',
  summary: 'Create a Grok Project',
  icon: 'folder-plus',
  group: 'Projects',
  input: z.object({ name: z.string().trim().min(1), description: z.string().optional() }),
  output: projectSchema,
  handle: async params => {
    const created = await createProjectRecord(params.name, params.description);
    if (!created.workspaceId)
      throw new ToolError('Grok created a Project without returning its id.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return mapProject(
      await requirePersistedProject(created.workspaceId, {
        name: params.name,
        ...(params.description !== undefined ? { description: params.description } : {}),
      }),
      0,
    );
  },
});

export const updateProject = defineTool({
  name: 'update_project',
  displayName: 'Update Project',
  description:
    'Update a writable native Grok Project and verify every requested field. Omitted fields are preserved; an empty description clears it.',
  summary: 'Update a Grok Project',
  icon: 'pencil',
  group: 'Projects',
  input: z.object({
    project_id: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
  }),
  output: projectSchema,
  handle: async params => {
    if (params.name === undefined && params.description === undefined)
      throw ToolError.validation('Nothing to update — pass name and/or description.', 'VALIDATION_ERROR');
    await writableProject(params.project_id);
    await updateProjectRecord(params.project_id, { name: params.name, description: params.description });
    const [stored, members] = await Promise.all([
      requirePersistedProject(params.project_id, {
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.description !== undefined ? { description: params.description } : {}),
      }),
      collectProjectConversations(params.project_id),
    ]);
    return mapProject(stored, members.complete ? members.rows.length : null);
  },
});

export const deleteProject = defineTool({
  name: 'delete_project',
  displayName: 'Delete Project',
  description:
    'Delete a writable Grok Project. Non-empty Projects are refused unless detach_conversations:true; when enabled, every member is detached and verified before deletion. Member chats are never deleted.',
  summary: 'Delete a Grok Project safely',
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
    const project = await writableProject(params.project_id);
    const projectId = project.workspaceId ?? params.project_id;
    const members = await collectProjectConversations(projectId);
    if (!members.complete)
      throw new ToolError('The bounded Project scan could not prove its complete membership.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    if (members.rows.length > 0 && params.detach_conversations !== true)
      throw ToolError.validation(
        `Project ${projectId} holds ${members.rows.length} conversation(s). Pass detach_conversations:true to detach them without deleting them.`,
        'VALIDATION_ERROR',
      );
    for (const member of members.rows) {
      const conversationId = member.conversationId;
      if (!conversationId) continue;
      await removeConversationFromProjectRecord(conversationId, projectId);
      if (await settleProjectMembership(projectId, conversationId, false))
        throw new ToolError(`Grok did not verify detachment of ${conversationId}.`, 'UPSTREAM_ERROR', {
          category: 'internal',
          retryable: true,
        });
    }
    await deleteProjectRecord(projectId);
    try {
      await getProjectRecord(projectId);
    } catch (error) {
      if (error instanceof ToolError && error.code === 'NOT_FOUND')
        return { project_id: projectId, deleted: true, conversations_detached: members.rows.length };
      throw error;
    }
    throw new ToolError(`Grok still returns Project ${projectId} after deletion.`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  },
});

export const addConversationToProjectTool = defineTool({
  name: 'add_conversation_to_project',
  displayName: 'Add Conversation To Project',
  description:
    'Add a Grok chat to a writable Project through the native membership endpoint and verify the target contains it.',
  summary: 'Add a chat to a Grok Project',
  icon: 'folder-input',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().trim().min(1),
    project_id: z.string().trim().min(1),
  }),
  output: conversationListItemSchema,
  handle: async params => {
    await writableProject(params.project_id);
    return addConversationToProject(params.conversation_id, params.project_id);
  },
});

export const removeConversationFromProject = defineTool({
  name: 'remove_conversation_from_project',
  displayName: 'Remove Conversation From Project',
  description:
    'Detach a Grok chat from its native Project without deleting the chat. project_id is an optional guard; membership absence is verified afterward.',
  summary: 'Remove a chat from a Grok Project',
  icon: 'folder-minus',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().trim().min(1),
    project_id: z.string().trim().min(1).optional(),
  }),
  output: conversationListItemSchema,
  handle: async params => {
    const [conversation, sourceId] = await Promise.all([
      getConversationMetadata(params.conversation_id),
      getConversationProjectId(params.conversation_id),
    ]);
    if (!sourceId) throw ToolError.validation(`Conversation ${params.conversation_id} is not in a Project.`);
    if (params.project_id && sourceId !== params.project_id)
      throw ToolError.validation(`Conversation ${params.conversation_id} is in ${sourceId}, not ${params.project_id}.`);
    await writableProject(sourceId);
    await removeConversationFromProjectRecord(params.conversation_id, sourceId);
    if (await settleProjectMembership(sourceId, params.conversation_id, false))
      throw new ToolError(`Grok did not verify detachment from Project ${sourceId}.`, 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return mapConversation(await getConversationMetadata(conversation.conversationId ?? params.conversation_id), null);
  },
});

export const moveConversationToProject = defineTool({
  name: 'move_conversation_to_project',
  displayName: 'Move Conversation To Project',
  description:
    'Move a Grok chat between native Projects. The target assignment and prior-source removal are both verified; from_project_id is an optional safety guard.',
  summary: 'Move a chat between Grok Projects',
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
    const [sourceId] = await Promise.all([
      getConversationProjectId(params.conversation_id),
      getConversationMetadata(params.conversation_id),
      writableProject(params.to_project_id),
    ]);
    if (params.from_project_id && sourceId !== params.from_project_id)
      throw ToolError.validation(
        `Conversation ${params.conversation_id} is in ${sourceId ?? '(none)'}, not ${params.from_project_id}.`,
      );
    if (sourceId && sourceId !== params.to_project_id) await writableProject(sourceId);
    if (sourceId !== params.to_project_id) {
      await addConversationToProjectRecord(params.conversation_id, params.to_project_id);
      if (sourceId && (await projectContainsConversation(sourceId, params.conversation_id)))
        await removeConversationFromProjectRecord(params.conversation_id, sourceId);
    }
    const targetContains = await settleProjectMembership(params.to_project_id, params.conversation_id, true);
    const sourceContains =
      sourceId && sourceId !== params.to_project_id
        ? await settleProjectMembership(sourceId, params.conversation_id, false)
        : false;
    if (!targetContains || sourceContains)
      throw new ToolError('Grok did not verify the complete Project move.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return {
      conversation: mapConversation(await getConversationMetadata(params.conversation_id), params.to_project_id),
      from_project_id: sourceId,
      to_project_id: params.to_project_id,
      verified: { target_contains: targetContains, source_contains: sourceContains },
    };
  },
});
