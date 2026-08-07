import { orgApi, projectUrl, toUnixSeconds } from './claude-api.js';
import type { RawConversationRow } from './claude-conversations.js';
import type { NormalizedProject } from './tools/normalized-schemas.js';

export interface RawProject {
  uuid?: string;
  name?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
  docs_count?: number;
  files_count?: number;
}

export const mapProject = (raw: RawProject, conversationCount: number | null): NormalizedProject => ({
  id: raw.uuid ?? '',
  name: raw.name ?? '',
  description: raw.description || null,
  created_at: toUnixSeconds(raw.created_at),
  updated_at: toUnixSeconds(raw.updated_at),
  conversation_count: conversationCount,
  url: projectUrl(raw.uuid ?? ''),
});

interface ProjectsV2Response {
  data?: RawProject[];
  pagination?: { total?: number; limit?: number; offset?: number; has_more?: boolean };
}

/** `/projects_v2` reports a real `pagination.total`, so list_projects can return it truthfully. */
export const fetchProjectsPage = async (
  offset: number,
  limit: number,
): Promise<{ rows: RawProject[]; hasMore: boolean; total: number | null }> => {
  const page = await orgApi<ProjectsV2Response>('/projects_v2', { query: { limit, offset } });
  return {
    rows: page.data ?? [],
    hasMore: page.pagination?.has_more === true,
    total: typeof page.pagination?.total === 'number' ? page.pagination.total : null,
  };
};

interface ProjectConversationsResponse {
  data?: RawConversationRow[];
  pagination?: { total?: number; has_more?: boolean };
}

export const fetchProjectConversationsPage = async (
  projectId: string,
  offset: number,
  limit: number,
): Promise<{ rows: RawConversationRow[]; hasMore: boolean; total: number | null }> => {
  const page = await orgApi<ProjectConversationsResponse>(`/projects/${projectId}/conversations_v2`, {
    query: { limit, offset },
  });
  return {
    rows: page.data ?? [],
    hasMore: page.pagination?.has_more === true,
    total: typeof page.pagination?.total === 'number' ? page.pagination.total : null,
  };
};

export const getProjectConversationCount = async (projectId: string): Promise<number | null> =>
  (await fetchProjectConversationsPage(projectId, 0, 1)).total;
