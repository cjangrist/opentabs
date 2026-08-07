import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api, projectUrl, toUnixSeconds } from './chatgpt-api.js';
import type { CursorPage } from './chatgpt-pagination.js';
import type { NormalizedProject } from './tools/normalized-schemas.js';

// chatgpt.com calls projects "snorlax" gizmos internally. Their ids are prefixed
// `g-p-`, which is what separates a project from an ordinary GPT (`g-`).

export interface RawGizmo {
  id?: string;
  display?: { name?: string; description?: string };
  created_at?: string;
  updated_at?: string;
  instructions?: string;
  vanity_metrics?: { num_conversations?: number | null };
}

interface RawSidebarItem {
  gizmo?: { gizmo?: RawGizmo; conversations?: unknown[] } | RawGizmo;
  conversations?: unknown[];
}

interface RawSidebarResponse {
  items?: RawSidebarItem[];
  cursor?: string | null;
}

interface RawGizmoResponse {
  gizmo?: RawGizmo;
  resource?: { gizmo?: RawGizmo };
}

const PROJECT_ID_PREFIX = 'g-p-';

/** Both gizmo endpoints reject limit > 50 with a 422; SPEC's ceiling is 200. */
export const PROJECT_CONVERSATIONS_MAX_LIMIT = 50;

export const assertProjectId = (projectId: string): string => {
  if (!projectId.startsWith(PROJECT_ID_PREFIX))
    throw ToolError.validation(
      `"${projectId}" is not a ChatGPT project id — projects are prefixed "${PROJECT_ID_PREFIX}". Use list_projects.`,
    );
  return projectId;
};

/** The sidebar nests the gizmo one or two levels deep depending on the endpoint. */
const unwrapGizmo = (item: RawSidebarItem | RawGizmoResponse): RawGizmo | undefined => {
  const candidate = (item as RawSidebarItem).gizmo ?? (item as RawGizmoResponse).resource?.gizmo;
  if (!candidate) return undefined;
  const nested = (candidate as { gizmo?: RawGizmo }).gizmo;
  return nested ?? (candidate as RawGizmo);
};

export const mapProject = (gizmo: RawGizmo, conversationCount: number | null): NormalizedProject => ({
  id: gizmo.id ?? '',
  name: gizmo.display?.name ?? '',
  description: gizmo.display?.description || null,
  created_at: toUnixSeconds(gizmo.created_at),
  updated_at: toUnixSeconds(gizmo.updated_at),
  conversation_count: conversationCount,
  url: projectUrl(gizmo.id ?? ''),
});

export interface ProjectRow {
  gizmo: RawGizmo;
  conversationCount: number | null;
}

/**
 * One page of the projects sidebar. `conversations_per_gizmo: 0` keeps the
 * payload small; the endpoint then reports no membership count at all, so
 * `conversation_count` is null rather than a guess.
 */
export const fetchProjectPage = async (cursor: string | undefined, limit: number): Promise<CursorPage<ProjectRow>> => {
  const data = await api<RawSidebarResponse>('/gizmos/snorlax/sidebar', {
    query: {
      owned_only: true,
      conversations_per_gizmo: 0,
      limit: Math.min(limit, PROJECT_CONVERSATIONS_MAX_LIMIT),
      cursor,
    },
  });
  return {
    rows: (data.items ?? [])
      .map((item): ProjectRow | null => {
        const gizmo = unwrapGizmo(item);
        return gizmo ? { gizmo, conversationCount: null } : null;
      })
      .filter((row): row is ProjectRow => row !== null),
    cursor: data.cursor,
  };
};

export const getProjectGizmo = async (projectId: string): Promise<RawGizmo> => {
  const data = await api<RawGizmoResponse>(`/gizmos/${assertProjectId(projectId)}`);
  const gizmo = unwrapGizmo(data);
  if (!gizmo?.id) throw ToolError.notFound(`Project ${projectId} was not found on chatgpt.com.`);
  return gizmo;
};

interface RawProjectConversations {
  items?: { id?: string; conversation_id?: string; title?: string }[];
  cursor?: string | null;
}

export const fetchProjectConversationPage = async (
  projectId: string,
  cursor: string | undefined,
  limit: number,
): Promise<CursorPage<{ id?: string; conversation_id?: string; title?: string }>> => {
  const data = await api<RawProjectConversations>(`/gizmos/${assertProjectId(projectId)}/conversations`, {
    query: { limit: Math.min(limit, PROJECT_CONVERSATIONS_MAX_LIMIT), cursor },
  });
  return { rows: data.items ?? [], cursor: data.cursor };
};

/** POST /projects is the only route that produces a `g-p-` project; POST /gizmos makes a GPT. */
export const createProjectGizmo = async (name: string, instructions: string): Promise<RawGizmo> => {
  const data = await api<RawGizmoResponse>('/projects', { method: 'POST', body: { name, instructions } });
  const gizmo = unwrapGizmo(data);
  if (!gizmo?.id)
    throw new ToolError('ChatGPT accepted the project but returned no gizmo id.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return gizmo;
};

/** PATCH /projects/<id> rejects a partial body — every field must be resent. */
export const updateProjectGizmo = async (
  projectId: string,
  patch: { name: string; instructions: string; emoji: string | null; theme: string | null },
): Promise<RawGizmo> => {
  const data = await api<RawGizmoResponse>(`/projects/${assertProjectId(projectId)}`, { method: 'PATCH', body: patch });
  return unwrapGizmo(data) ?? (await getProjectGizmo(projectId));
};

export const deleteProjectGizmo = async (projectId: string): Promise<void> => {
  await api<{ deleted?: boolean }>(`/gizmos/${assertProjectId(projectId)}`, { method: 'DELETE' });
};
