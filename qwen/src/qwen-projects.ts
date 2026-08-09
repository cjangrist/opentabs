import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api, projectUrl, requireArray } from './qwen-api.js';
import type { NormalizedProject } from './tools/normalized-schemas.js';

const PROJECTS_PATH = '/v2/projects/';

/**
 * Qwen's project object. `custom_instruction` is the free-text "Instructions" field
 * the project settings dialog edits, which is what SPEC §5 calls `description`.
 * `icon` and `memory_span` are Qwen-only settings the normalized shape has no home
 * for; they are preserved on update rather than reset.
 */
export interface RawProject {
  id?: string;
  name?: string;
  custom_instruction?: string | null;
  icon?: string | null;
  memory_span?: string | null;
  created_at?: number;
  updated_at?: number;
}

/** The icon Qwen's own "New Project" dialog defaults to. */
const DEFAULT_PROJECT_ICON = 'icon=icon-line-folder-01&style=character-primary-text';
const DEFAULT_MEMORY_SPAN = 'default';

export const listProjects = async (): Promise<RawProject[]> =>
  requireArray(await api<RawProject[]>(PROJECTS_PATH), PROJECTS_PATH);

export const getProject = async (projectId: string): Promise<RawProject> => {
  const project = await api<RawProject>(`${PROJECTS_PATH}${encodeURIComponent(projectId)}`);
  if (!project?.id) throw ToolError.notFound(`Qwen has no project ${projectId} (or it belongs to another account).`);
  return project;
};

/**
 * Creates a project. The POST answers with `{id}` alone, so the record is read back
 * to return a complete, verified object rather than echoing the request.
 */
export const createProject = async (name: string, description: string | undefined): Promise<RawProject> => {
  const created = await api<{ id?: string }>(PROJECTS_PATH, {
    method: 'POST',
    body: {
      name,
      custom_instruction: description ?? '',
      memory_span: DEFAULT_MEMORY_SPAN,
      icon: DEFAULT_PROJECT_ICON,
      files: [],
    },
  });
  if (!created?.id)
    throw new ToolError(`Qwen accepted the project "${name}" but returned no id.`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return getProject(created.id);
};

/**
 * Updates a project. The PUT answers `{status:true}` rather than the record, and it
 * replaces the fields it is given, so the current values are read first and every
 * untouched field is re-sent — otherwise renaming a project would blank its
 * instructions.
 */
export const updateProject = async (
  projectId: string,
  name: string | undefined,
  description: string | undefined,
): Promise<RawProject> => {
  const current = await getProject(projectId);
  await api<unknown>(`${PROJECTS_PATH}${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    body: {
      name: name ?? current.name ?? '',
      custom_instruction: description ?? current.custom_instruction ?? '',
      memory_span: current.memory_span ?? DEFAULT_MEMORY_SPAN,
      icon: current.icon ?? DEFAULT_PROJECT_ICON,
    },
  });
  return getProject(projectId);
};

export const deleteProject = async (projectId: string): Promise<void> => {
  await getProject(projectId);
  await api<unknown>(`${PROJECTS_PATH}${encodeURIComponent(projectId)}`, { method: 'DELETE' });
};

/**
 * Moves chats into a project, or out of every project when `projectId` is empty.
 *
 * `POST /api/v2/projects/add_chat` is the only membership primitive Qwen has: the
 * web app's "Remove from project" menu calls exactly this with `project_id: ""`.
 * A chat belongs to at most one project, so adding replaces any previous membership.
 */
export const setChatProject = async (conversationIds: string[], projectId: string): Promise<void> => {
  await api<unknown>(`${PROJECTS_PATH}add_chat`, {
    method: 'POST',
    body: { chat_ids: conversationIds, project_id: projectId },
  });
};

export const mapProject = (project: RawProject, conversationCount: number | null): NormalizedProject => ({
  id: project.id ?? '',
  name: project.name ?? '',
  description: project.custom_instruction ? project.custom_instruction : null,
  created_at: project.created_at ?? 0,
  updated_at: project.updated_at ?? 0,
  conversation_count: conversationCount,
  url: projectUrl(project.id ?? ''),
});
