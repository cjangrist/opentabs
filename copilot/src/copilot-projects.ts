import { ToolError } from '@opentabs-dev/plugin-sdk';
import { deleteApi, getApi, patchApi, postApi, projectUrl, toUnixSeconds } from './copilot-api.js';
import { mapConversationRow, type RawConversation } from './copilot-conversations.js';
import type { CursorPage } from './copilot-pagination.js';
import type { ConversationListItem, NormalizedProject } from './tools/normalized-schemas.js';

const MAX_PROJECT_PAGES = 200;
const PROJECT_SCAN_CONCURRENCY = 5;

export interface RawProject {
  id?: string;
  title?: string | null;
  updatedAt?: string;
}

interface RawPage<T> {
  results?: T[];
  next?: string | null;
}

export const mapProject = (project: RawProject, conversationCount: number | null): NormalizedProject => ({
  id: project.id ?? '',
  name: project.title ?? '',
  // The native create/edit UI and project payload expose title only.
  description: null,
  created_at: 0,
  updated_at: toUnixSeconds(project.updatedAt),
  conversation_count: conversationCount,
  url: projectUrl(project.id ?? ''),
});

export const fetchProjectsPage = async (cursor: string | undefined): Promise<CursorPage<RawProject>> => {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const page = await getApi<RawPage<RawProject>>(`/projects${suffix}`);
  return { rows: (page.results ?? []).filter(row => Boolean(row.id)), next: page.next || null };
};

export const getProjectRecord = async (projectId: string): Promise<RawProject> => {
  const project = await getApi<RawProject>(`/projects/${encodeURIComponent(projectId)}`);
  if (!project.id) throw ToolError.notFound(`Copilot has no project with id "${projectId}".`, 'NOT_FOUND');
  return project;
};

export const createProjectRecord = async (name: string): Promise<RawProject> => {
  const project = await postApi<RawProject>('/projects', { title: name });
  if (!project.id)
    throw new ToolError('Copilot did not return an id for the new project.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return project;
};

export const updateProjectRecord = async (projectId: string, name: string): Promise<RawProject> => {
  await patchApi(`/projects/${encodeURIComponent(projectId)}`, { title: name });
  return getProjectRecord(projectId);
};

export const deleteProjectRecord = async (projectId: string): Promise<void> => {
  await deleteApi(`/projects/${encodeURIComponent(projectId)}`);
};

export const fetchProjectConversationsPage = async (
  projectId: string,
  cursor: string | undefined,
): Promise<CursorPage<RawConversation>> => {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const page = await getApi<RawPage<RawConversation>>(
    `/projects/${encodeURIComponent(projectId)}/conversations${suffix}`,
  );
  return { rows: (page.results ?? []).filter(row => Boolean(row.id)), next: page.next || null };
};

export const collectProjectsWithStats = async (
  deadline?: number,
): Promise<{ rows: RawProject[]; pagesFetched: number }> => {
  const projects: RawProject[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;
  for (let page = 0; page < MAX_PROJECT_PAGES && (deadline === undefined || Date.now() < deadline); page += 1) {
    const result = await fetchProjectsPage(cursor);
    pagesFetched += 1;
    for (const project of result.rows) {
      const id = project.id ?? '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      projects.push(project);
    }
    if (!result.next || result.next === cursor || result.rows.length === 0) break;
    cursor = result.next;
  }
  return { rows: projects, pagesFetched };
};

export const collectProjects = async (): Promise<RawProject[]> => (await collectProjectsWithStats()).rows;

export const collectProjectConversationsWithStats = async (
  projectId: string,
  deadline?: number,
): Promise<{ rows: RawConversation[]; pagesFetched: number }> => {
  const conversations: RawConversation[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;
  for (let page = 0; page < MAX_PROJECT_PAGES && (deadline === undefined || Date.now() < deadline); page += 1) {
    const result = await fetchProjectConversationsPage(projectId, cursor);
    pagesFetched += 1;
    for (const conversation of result.rows) {
      const id = conversation.id ?? '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      conversations.push(conversation);
    }
    if (!result.next || result.next === cursor || result.rows.length === 0) break;
    cursor = result.next;
  }
  return { rows: conversations, pagesFetched };
};

export const collectProjectConversations = async (projectId: string): Promise<RawConversation[]> =>
  (await collectProjectConversationsWithStats(projectId)).rows;

export interface ProjectConversationIndex {
  conversations: Array<{ row: RawConversation; projectId: string }>;
  memberships: Map<string, string>;
  pagesFetched: number;
}

/** Builds one bounded Project-membership index for callers that need every Project chat. */
export const collectProjectConversationIndex = async (deadline?: number): Promise<ProjectConversationIndex> => {
  const projects = await collectProjectsWithStats(deadline);
  const pages: Array<{ projectId: string; result: { rows: RawConversation[]; pagesFetched: number } } | undefined> =
    Array.from({ length: projects.rows.length });
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(PROJECT_SCAN_CONCURRENCY, projects.rows.length) }, async () => {
    while (nextIndex < projects.rows.length && (deadline === undefined || Date.now() < deadline)) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const projectId = projects.rows[currentIndex]?.id ?? '';
      pages[currentIndex] = {
        projectId,
        result: projectId
          ? await collectProjectConversationsWithStats(projectId, deadline)
          : { rows: [], pagesFetched: 0 },
      };
    }
  });
  await Promise.all(workers);
  const completedPages = pages.filter(page => page !== undefined);
  const conversations = completedPages.flatMap(page =>
    page.result.rows.flatMap(row => (row.id ? [{ row, projectId: page.projectId }] : [])),
  );
  return {
    conversations,
    memberships: new Map(conversations.map(({ row, projectId }) => [row.id ?? '', projectId])),
    pagesFetched: projects.pagesFetched + completedPages.reduce((total, page) => total + page.result.pagesFetched, 0),
  };
};

export const findConversationProject = async (conversationId: string, deadline?: number): Promise<string | null> =>
  (await collectProjectConversationIndex(deadline)).memberships.get(conversationId) ?? null;

export const projectContainsConversation = async (projectId: string, conversationId: string): Promise<boolean> =>
  (await collectProjectConversations(projectId)).some(conversation => conversation.id === conversationId);

export const mapProjectConversation = (row: RawConversation, projectId: string): ConversationListItem =>
  mapConversationRow(row, projectId);
