import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
import { api, projectUrl, toUnixSeconds } from './grok-api.js';
import {
  collectConversations,
  conversationProjectIds,
  fetchConversationsPage,
  getConversationMetadata,
  mapConversation,
  type RawConversation,
} from './grok-conversations.js';
import type { CursorPage } from './grok-pagination.js';
import type { ConversationListItem, NormalizedProject } from './tools/normalized-schemas.js';

const UPSTREAM_PAGE_SIZE = 100;
const VERIFY_ATTEMPTS = 10;
const VERIFY_DELAY_MS = 400;

export interface RawWorkspace {
  workspaceId?: string;
  name?: string;
  icon?: string;
  customPersonality?: string;
  preferredModel?: string;
  createTime?: string;
  lastUseTime?: string;
  isPublic?: boolean;
  isReadonly?: boolean;
  accessLevel?: string;
  conversationsCreatedCount?: number;
  kind?: string;
}

interface RawWorkspacePage {
  workspaces?: RawWorkspace[];
  nextPageToken?: string;
}

export const mapProject = (workspace: RawWorkspace, conversationCount: number | null): NormalizedProject => ({
  id: workspace.workspaceId ?? '',
  name: workspace.name ?? '',
  description: workspace.customPersonality ?? null,
  created_at: toUnixSeconds(workspace.createTime),
  updated_at: toUnixSeconds(workspace.lastUseTime ?? workspace.createTime),
  conversation_count: conversationCount,
  url: projectUrl(workspace.workspaceId ?? ''),
});

export const fetchProjectsPage = async (cursor: string | undefined): Promise<CursorPage<RawWorkspace>> => {
  const payload = await api<RawWorkspacePage>('/workspaces', {
    query: {
      kind: 'WORKSPACE_KIND_UNSPECIFIED',
      pageSize: UPSTREAM_PAGE_SIZE,
      pageToken: cursor,
      orderBy: 'ORDER_BY_LAST_USE_TIME',
    },
  });
  return {
    rows: (payload.workspaces ?? []).filter(workspace => Boolean(workspace.workspaceId)),
    next: payload.nextPageToken || null,
  };
};

export const getProjectRecord = async (projectId: string): Promise<RawWorkspace> => {
  const workspace = await api<RawWorkspace>(`/workspaces/${encodeURIComponent(projectId)}`);
  if (!workspace.workspaceId)
    throw new ToolError(`Grok has no Project with id "${projectId}".`, 'NOT_FOUND', {
      category: 'not_found',
      retryable: false,
    });
  return workspace;
};

export const fetchProjectConversationsPage = (
  projectId: string,
  cursor: string | undefined,
): Promise<CursorPage<RawConversation>> => fetchConversationsPage(cursor, { projectId });

export const collectProjectConversations = async (
  projectId: string,
): Promise<{ rows: RawConversation[]; pagesFetched: number; complete: boolean }> => {
  await getProjectRecord(projectId);
  return collectConversations({ projectId });
};

export const createProjectRecord = (name: string, description?: string): Promise<RawWorkspace> =>
  api('/workspaces', {
    method: 'POST',
    body: {
      name,
      kind: 'WORKSPACE_KIND_UNSPECIFIED',
      ...(description !== undefined ? { customPersonality: description } : {}),
    },
  });

export const updateProjectRecord = (
  projectId: string,
  changes: { name?: string; description?: string },
): Promise<RawWorkspace> =>
  api(`/workspaces/${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    body: {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.description !== undefined ? { customPersonality: changes.description } : {}),
    },
  });

export const deleteProjectRecord = (projectId: string): Promise<void> =>
  api(`/workspaces/${encodeURIComponent(projectId)}`, { method: 'DELETE' });

export const addConversationToProjectRecord = (conversationId: string, projectId: string): Promise<void> =>
  api(`/workspaces/${encodeURIComponent(projectId)}/conversations`, {
    method: 'POST',
    body: { conversationId },
  });

export const removeConversationFromProjectRecord = (conversationId: string, projectId: string): Promise<void> =>
  api(`/workspaces/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  });

export const projectContainsConversation = async (projectId: string, conversationId: string): Promise<boolean> => {
  const conversation = await getConversationMetadata(conversationId);
  return conversationProjectIds(conversation).includes(projectId);
};

export const settleProjectMembership = async (
  projectId: string,
  conversationId: string,
  expected: boolean,
): Promise<boolean> => {
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    const actual = await projectContainsConversation(projectId, conversationId);
    if (actual === expected) return true;
    if (attempt < VERIFY_ATTEMPTS - 1) await sleep(VERIFY_DELAY_MS);
  }
  return false;
};

export const addConversationToProject = async (
  conversationId: string,
  projectId: string,
): Promise<ConversationListItem> => {
  await Promise.all([getConversationMetadata(conversationId), getProjectRecord(projectId)]);
  await addConversationToProjectRecord(conversationId, projectId);
  if (!(await settleProjectMembership(projectId, conversationId, true)))
    throw new ToolError(
      `Grok did not verify assignment of conversation ${conversationId} to Project ${projectId}.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  return mapConversation(await getConversationMetadata(conversationId), projectId);
};
