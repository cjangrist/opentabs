import { ToolError } from '@opentabs-dev/plugin-sdk';
import { callRpc, projectUrl, toUnixSeconds } from './kimi-api.js';
import type { TokenPage } from './kimi-pagination.js';
import type { NormalizedProject } from './tools/normalized-schemas.js';

export interface RawProject {
  id?: string;
  name?: string;
  description?: string;
  createTime?: string;
  updateTime?: string;
  availability?: string;
}

interface ListProjectsResponse {
  projects?: RawProject[];
  nextPageToken?: string;
  /** A real count of the account's projects — reported as `total` truthfully. */
  projectCountUsed?: string;
  projectCountLimit?: string;
}

/**
 * Kimi's project payload carries no description field — the create form asks for
 * a name only — so `description` is always null rather than a fabricated "".
 */
export const mapProject = (raw: RawProject, conversationCount: number | null): NormalizedProject => ({
  id: raw.id ?? '',
  name: raw.name ?? '',
  description: raw.description || null,
  created_at: toUnixSeconds(raw.createTime),
  updated_at: toUnixSeconds(raw.updateTime),
  conversation_count: conversationCount,
  url: projectUrl(raw.id ?? ''),
});

/** `ListProjects` reports `projectCountUsed`, a genuine total across all pages. */
export const fetchProjectsPage = async (
  pageToken: string | undefined,
  pageSize: number,
): Promise<TokenPage<RawProject>> => {
  const body: Record<string, unknown> = { pageSize };
  if (pageToken) body.pageToken = pageToken;
  const page = await callRpc<ListProjectsResponse>('kimi.gateway.project.v1.ProjectService/ListProjects', body);
  const total = Number(page.projectCountUsed);
  return {
    rows: page.projects ?? [],
    nextPageToken: page.nextPageToken || null,
    total: Number.isInteger(total) ? total : null,
  };
};

export const getProject = async (projectId: string): Promise<RawProject> => {
  const data = await callRpc<{ project?: RawProject }>('kimi.gateway.project.v1.ProjectService/GetProject', {
    projectId,
  });
  if (!data.project?.id) throw ToolError.notFound(`Kimi project ${projectId} was not found.`);
  return data.project;
};

export const createProject = async (name: string): Promise<RawProject> => {
  const data = await callRpc<{ project?: RawProject }>('kimi.gateway.project.v1.ProjectService/CreateProject', {
    name,
  });
  if (!data.project?.id)
    throw new ToolError('Kimi accepted the create but returned no project.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return data.project;
};

/**
 * Unlike `UpdateChat`, `UpdateProject` genuinely requires an `update_mask` and
 * rejects a call without one, so only the named fields are touched.
 */
export const updateProject = async (projectId: string, name: string): Promise<RawProject> => {
  const data = await callRpc<{ project?: RawProject }>('kimi.gateway.project.v1.ProjectService/UpdateProject', {
    project: { id: projectId, name },
    updateMask: 'name',
  });
  if (!data.project?.id)
    throw new ToolError('Kimi accepted the update but returned no project.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return data.project;
};

export const deleteProject = async (projectId: string): Promise<void> => {
  await callRpc('kimi.gateway.project.v1.ProjectService/DeleteProject', { projectId });
};
