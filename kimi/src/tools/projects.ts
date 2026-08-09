import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { conversationUrl, toUnixSeconds } from '../kimi-api.js';
import { fetchProjectChatsPage } from '../kimi-conversations.js';
import { walkTokenPages } from '../kimi-pagination.js';
import {
  createProject as createProjectRpc,
  deleteProject as deleteProjectRpc,
  fetchProjectsPage,
  getProject as getProjectRpc,
  mapProject,
  updateProject as updateProjectRpc,
} from '../kimi-projects.js';
import { paginatedOutput, paginationInputShape, projectSchema, resolvePagination } from './normalized-schemas.js';

/** Kimi reports no per-project chat count, so it is counted by walking the project's chats. */
const PROJECT_COUNT_SCAN_LIMIT = 100;
const PROJECT_COUNT_SCAN_MAX = 1000;

const countProjectConversations = async (projectId: string): Promise<number | null> => {
  let pageToken: string | undefined;
  let counted = 0;
  for (let page = 0; page * PROJECT_COUNT_SCAN_LIMIT < PROJECT_COUNT_SCAN_MAX; page += 1) {
    const result = await fetchProjectChatsPage(projectId, pageToken, PROJECT_COUNT_SCAN_LIMIT);
    counted += result.rows.length;
    if (!result.nextPageToken || result.rows.length === 0) return counted;
    pageToken = result.nextPageToken;
  }
  // More members than the scan budget: a number here would be a lie.
  return null;
};

export const listProjects = defineTool({
  name: 'list_projects',
  displayName: 'List Projects',
  description:
    'List the account’s Kimi projects. Drives ProjectService/ListProjects with its real pageToken cursor. ' +
    'total IS a true count: Kimi reports projectCountUsed alongside every page. ' +
    'conversation_count is null here — Kimi publishes no per-project count, and counting it for every row would mean a request per project; call get_project for a real number. ' +
    'The upstream endpoint rejects a page size above 100.',
  summary: 'List projects (paginated)',
  icon: 'folder',
  group: 'Projects',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(projectSchema),
  handle: async params => walkTokenPages(resolvePagination(params), fetchProjectsPage, raw => mapProject(raw, null)),
});

export const getProject = defineTool({
  name: 'get_project',
  displayName: 'Get Project',
  description:
    'Get one Kimi project, including a real conversation_count obtained by walking ChatService/ListChats for that project — Kimi publishes no count field of its own. ' +
    'conversation_count is null if the project holds more members than the scan budget.',
  summary: 'Get a project',
  icon: 'folder-open',
  group: 'Projects',
  input: z.object({ project_id: z.string().describe('Kimi project id.') }),
  output: z.object({ project: projectSchema }),
  handle: async params => {
    const raw = await getProjectRpc(params.project_id);
    return { project: mapProject(raw, await countProjectConversations(params.project_id)) };
  },
});

export const listProjectConversations = defineTool({
  name: 'list_project_conversations',
  displayName: 'List Project Conversations',
  description:
    'List the conversations that belong to a Kimi project, via ChatService/ListChats filtered by projectId, with its real pageToken cursor. ' +
    'Use this to verify project membership. Kimi reports no count, so total is null. ' +
    'NOTE: ListChats hands back a page token even on its LAST page, so has_more can be true for one final request that comes back empty — ' +
    'the cursor is still safe to follow, it just costs one extra call to learn the list is exhausted.',
  summary: 'List a project’s conversations (paginated)',
  icon: 'folder-tree',
  group: 'Projects',
  input: z.object({ project_id: z.string().describe('Kimi project id.'), ...paginationInputShape }),
  output: paginatedOutput(
    z.object({
      id: z.string(),
      title: z.string(),
      url: z.string(),
      updated_at: z.number().int(),
    }),
  ),
  handle: async params =>
    walkTokenPages(
      resolvePagination(params),
      (pageToken, pageSize) => fetchProjectChatsPage(params.project_id, pageToken, pageSize),
      chat => ({
        id: chat.id ?? '',
        title: chat.name ?? '',
        url: conversationUrl(chat.id ?? ''),
        updated_at: toUnixSeconds(chat.updateTime),
      }),
    ),
});

export const createProject = defineTool({
  name: 'create_project',
  displayName: 'Create Project',
  description:
    'Create a Kimi project. Kimi’s project payload has no description field — the create form asks for a name only — so passing `description` raises VALIDATION_ERROR rather than silently dropping it, and the created project reports description: null.',
  summary: 'Create a project',
  icon: 'folder-plus',
  group: 'Projects',
  input: z.object({
    name: z.string().min(1).describe('Project name.'),
    description: z
      .string()
      .optional()
      .describe('Accepted for cross-provider shape parity only — Kimi stores no project description and REJECTS this.'),
  }),
  output: z.object({ project: projectSchema }),
  handle: async params => {
    // Declared so a caller following the normalized §5 shape gets a loud error
    // instead of zod stripping the field and the project appearing without it.
    if (params.description !== undefined)
      throw ToolError.validation(
        'Kimi projects have no description — the create form asks for a name only, and the project payload carries no such field. Omit description.',
      );
    return { project: mapProject(await createProjectRpc(params.name), 0) };
  },
});

export const updateProject = defineTool({
  name: 'update_project',
  displayName: 'Update Project',
  description:
    'Rename a Kimi project. Sends ProjectService/UpdateProject with update_mask "name", so nothing else on the project is touched. ' +
    'Kimi projects carry no description, so passing `description` raises VALIDATION_ERROR rather than being silently dropped.',
  summary: 'Rename a project',
  icon: 'folder-pen',
  group: 'Projects',
  input: z.object({
    project_id: z.string().describe('Kimi project id.'),
    name: z.string().min(1).describe('New project name.'),
    description: z
      .string()
      .optional()
      .describe('Accepted for cross-provider shape parity only — Kimi stores no project description and REJECTS this.'),
  }),
  output: z.object({ project: projectSchema }),
  handle: async params => {
    if (params.description !== undefined)
      throw ToolError.validation('Kimi projects have no description field — omit description.');
    await updateProjectRpc(params.project_id, params.name);
    const raw = await getProjectRpc(params.project_id);
    return { project: mapProject(raw, await countProjectConversations(params.project_id)) };
  },
});

export const deleteProject = defineTool({
  name: 'delete_project',
  displayName: 'Delete Project',
  description:
    'Permanently delete a Kimi project. WARNING: the conversations filed inside it go with it, and Kimi offers no way to move them out first ' +
    '(see list_capabilities().features.project_membership).',
  summary: 'Delete a project',
  icon: 'folder-x',
  group: 'Projects',
  input: z.object({ project_id: z.string().describe('Kimi project id.') }),
  output: z.object({ deleted: z.boolean(), project_id: z.string() }),
  handle: async params => {
    await deleteProjectRpc(params.project_id);
    return { deleted: true, project_id: params.project_id };
  },
});
