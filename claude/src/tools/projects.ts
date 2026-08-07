import { ToolError, defineTool, stripUndefined } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, orgApi, toUnixSeconds } from '../claude-api.js';
import { getConversationDetail, moveConversations } from '../claude-conversations.js';
import { walkOffsetPages } from '../claude-pagination.js';
import {
  type RawProject,
  fetchProjectConversationsPage,
  fetchProjectsPage,
  getProjectConversationCount,
  mapProject,
} from '../claude-projects.js';
import { paginatedOutput, paginationInputShape, projectSchema, resolvePagination } from './normalized-schemas.js';

export const listProjects = defineTool({
  name: 'list_projects',
  displayName: 'List Projects',
  description:
    'List the projects in the active Claude organization. Drives /projects_v2, which reports a real pagination.total, so total is a true count. ' +
    'conversation_count is null here — claude.ai returns it only per project; call get_project for the real number.',
  summary: 'List projects (paginated)',
  icon: 'folder',
  group: 'Projects',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(projectSchema),
  handle: async params => walkOffsetPages(resolvePagination(params), fetchProjectsPage, row => mapProject(row, null)),
});

export const getProject = defineTool({
  name: 'get_project',
  displayName: 'Get Project',
  description:
    'Get one project, including its real conversation_count (read from /projects/<id>/conversations_v2, whose pagination.total is authoritative).',
  summary: 'Get a project',
  icon: 'folder-open',
  group: 'Projects',
  input: z.object({ project_id: z.string().describe('Project UUID.') }),
  output: z.object({ project: projectSchema }),
  handle: async params => {
    const raw = await orgApi<RawProject>(`/projects/${params.project_id}`);
    if (!raw?.uuid) throw ToolError.notFound(`Project ${params.project_id} was not found.`);
    return { project: mapProject(raw, await getProjectConversationCount(params.project_id)) };
  },
});

export const listProjectConversations = defineTool({
  name: 'list_project_conversations',
  displayName: 'List Project Conversations',
  description:
    'List the conversations that belong to a project. Drives /projects/<id>/conversations_v2 with a real limit/offset cursor and a true total. Use this to verify project membership after a move.',
  summary: 'List a project’s conversations (paginated)',
  icon: 'folder-tree',
  group: 'Projects',
  input: z.object({ project_id: z.string().describe('Project UUID.'), ...paginationInputShape }),
  output: paginatedOutput(
    z.object({
      id: z.string(),
      title: z.string(),
      url: z.string(),
      updated_at: z.number().int(),
    }),
  ),
  handle: async params =>
    walkOffsetPages(
      resolvePagination(params),
      (offset, limit) => fetchProjectConversationsPage(params.project_id, offset, limit),
      row => ({
        id: row.uuid ?? '',
        title: row.name ?? '',
        url: conversationUrl(row.uuid ?? ''),
        updated_at: toUnixSeconds(row.updated_at),
      }),
    ),
});

export const createProject = defineTool({
  name: 'create_project',
  displayName: 'Create Project',
  description: 'Create a project in the active Claude organization.',
  summary: 'Create a project',
  icon: 'folder-plus',
  group: 'Projects',
  input: z.object({
    name: z.string().min(1).describe('Project name.'),
    description: z
      .string()
      .optional()
      .describe('Project description. claude.ai requires the field; omitting it sends "".'),
  }),
  output: z.object({ project: projectSchema }),
  handle: async params => {
    const raw = await orgApi<RawProject>('/projects', {
      method: 'POST',
      // claude.ai rejects a create without `description` ("description: Field required").
      body: { name: params.name, description: params.description ?? '' },
    });
    if (!raw?.uuid)
      throw new ToolError('Claude accepted the create but returned no project.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return { project: mapProject(raw, 0) };
  },
});

export const updateProject = defineTool({
  name: 'update_project',
  displayName: 'Update Project',
  description: 'Rename a project or change its description. Omitted fields are left unchanged.',
  summary: 'Update a project',
  icon: 'folder-pen',
  group: 'Projects',
  input: z.object({
    project_id: z.string().describe('Project UUID.'),
    name: z.string().optional().describe('New name.'),
    description: z.string().optional().describe('New description.'),
  }),
  output: z.object({ project: projectSchema }),
  handle: async params => {
    if (params.name === undefined && params.description === undefined)
      throw ToolError.validation('Pass name and/or description — claude.ai rejects an update with no fields.');
    const raw = await orgApi<RawProject>(`/projects/${params.project_id}`, {
      method: 'PUT',
      body: stripUndefined({ name: params.name, description: params.description }),
    });
    if (!raw?.uuid)
      throw new ToolError('Claude accepted the update but returned no project.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return { project: mapProject(raw, await getProjectConversationCount(params.project_id)) };
  },
});

export const deleteProject = defineTool({
  name: 'delete_project',
  displayName: 'Delete Project',
  description:
    'Permanently delete a project. WARNING: claude.ai deletes the conversations inside the project along with it — move them out first (move_conversation_to_project with to_project_id: null) if you want to keep them.',
  summary: 'Delete a project',
  icon: 'folder-x',
  group: 'Projects',
  input: z.object({ project_id: z.string().describe('Project UUID.') }),
  output: z.object({ deleted: z.boolean(), project_id: z.string() }),
  handle: async params => {
    await orgApi(`/projects/${params.project_id}`, { method: 'DELETE' });
    return { deleted: true, project_id: params.project_id };
  },
});

const membershipOutput = z.object({
  conversation_id: z.string(),
  project_id: z.string().nullable().describe('The project the conversation now belongs to, re-read after the change.'),
  verified: z.boolean().describe('True once the conversation was re-read and its membership matched the request.'),
});

/** Re-reads the conversation so membership is proven, not assumed. */
const applyMembership = async (conversationId: string, projectId: string | null) => {
  await moveConversations([conversationId], projectId);
  const detail = await getConversationDetail(conversationId);
  const actual = detail.project_uuid ?? null;
  if (actual !== projectId)
    throw new ToolError(
      `Claude reported the move succeeded but the conversation still reports project_uuid ${String(actual)} (expected ${String(projectId)}).`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  return { conversation_id: conversationId, project_id: actual, verified: true };
};

export const addConversationToProject = defineTool({
  name: 'add_conversation_to_project',
  displayName: 'Add Conversation To Project',
  description:
    "Put a conversation into a project. Uses /chat_conversations/move_many, claude.ai's only membership primitive — its HTTP 200 body carries a `failed` list, which is inspected. The conversation is re-read afterwards to prove the membership.",
  summary: 'Add a conversation to a project',
  icon: 'folder-input',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().describe('Conversation UUID.'),
    project_id: z.string().describe('Target project UUID.'),
  }),
  output: membershipOutput,
  handle: async params => applyMembership(params.conversation_id, params.project_id),
});

export const removeConversationFromProject = defineTool({
  name: 'remove_conversation_from_project',
  displayName: 'Remove Conversation From Project',
  description:
    'Take a conversation out of its project and back into the ungrouped list. project_id is optional and only used as a guard: when given, the call fails if the conversation is not currently in that project.',
  summary: 'Remove a conversation from its project',
  icon: 'folder-minus',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().describe('Conversation UUID.'),
    project_id: z
      .string()
      .optional()
      .describe('Expected current project UUID. When given, the removal only proceeds if it matches.'),
  }),
  output: membershipOutput,
  handle: async params => {
    if (params.project_id) {
      const detail = await getConversationDetail(params.conversation_id);
      if ((detail.project_uuid ?? null) !== params.project_id)
        throw ToolError.validation(
          `Conversation ${params.conversation_id} is not in project ${params.project_id} (it is in ${String(detail.project_uuid ?? 'no project')}).`,
        );
    }
    return applyMembership(params.conversation_id, null);
  },
});

export const moveConversationToProject = defineTool({
  name: 'move_conversation_to_project',
  displayName: 'Move Conversation To Project',
  description:
    'Move a conversation between projects. Pass to_project_id: null to move it out of every project. ' +
    'from_project_id is an optional guard: when given, the move only proceeds if the conversation is currently in it. ' +
    'Both sides are verified afterwards — the source project must no longer list the conversation and the target must.',
  summary: 'Move a conversation to another project',
  icon: 'folder-symlink',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().describe('Conversation UUID.'),
    to_project_id: z.string().nullable().describe('Target project UUID, or null to remove from all projects.'),
    from_project_id: z.string().optional().describe('Expected current project UUID, checked before moving.'),
  }),
  output: membershipOutput.extend({
    source_still_lists_it: z
      .boolean()
      .nullable()
      .describe(
        'False once the source project no longer lists the conversation. Null when from_project_id was omitted.',
      ),
    target_lists_it: z.boolean().nullable().describe('True once the target project lists it. Null for a removal.'),
  }),
  handle: async params => {
    const before = await getConversationDetail(params.conversation_id);
    const currentProject = before.project_uuid ?? null;
    if (params.from_project_id && currentProject !== params.from_project_id)
      throw ToolError.validation(
        `Conversation ${params.conversation_id} is not in project ${params.from_project_id} (it is in ${String(currentProject ?? 'no project')}).`,
      );

    const result = await applyMembership(params.conversation_id, params.to_project_id);

    const source = params.from_project_id ?? currentProject;
    const sourceStillListsIt =
      source && source !== params.to_project_id
        ? (await fetchProjectConversationsPage(source, 0, 200)).rows.some(row => row.uuid === params.conversation_id)
        : null;
    const targetListsIt = params.to_project_id
      ? (await fetchProjectConversationsPage(params.to_project_id, 0, 200)).rows.some(
          row => row.uuid === params.conversation_id,
        )
      : null;

    if (sourceStillListsIt === true)
      throw new ToolError(
        `Conversation ${params.conversation_id} still appears in project ${String(source)} after the move.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: false },
      );
    if (params.to_project_id && targetListsIt !== true)
      throw new ToolError(
        `Conversation ${params.conversation_id} does not appear in project ${params.to_project_id} after the move.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: false },
      );

    return { ...result, source_still_lists_it: sourceStillListsIt, target_lists_it: targetListsIt };
  },
});
