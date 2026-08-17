import { ToolError } from '@opentabs-dev/plugin-sdk';
import { callApi, deleteApi, getApi, patchApi, postApi, projectUrl, toUnixSeconds } from './copilot-api.js';
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

interface CursorCollection<TRow> {
  rows: TRow[];
  pagesFetched: number;
  complete: boolean;
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

export const fetchProjectsPage = async (
  cursor: string | undefined,
  timeout?: number,
): Promise<CursorPage<RawProject>> => {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const page = await callApi<RawPage<RawProject>>(`/projects${suffix}`, { method: 'GET', timeout });
  return { rows: (page.results ?? []).filter(row => Boolean(row.id)), next: page.next || null };
};

export const getProjectRecord = async (projectId: string): Promise<RawProject> => {
  const project = await getApi<RawProject>(`/projects/${encodeURIComponent(projectId)}`);
  if (!project.id) throw ToolError.notFound(`Copilot has no project with id "${projectId}".`, 'NOT_FOUND');
  return project;
};

export const createProjectRecord = async (name: string): Promise<RawProject & { id: string }> => {
  const project = await postApi<RawProject>('/projects', { title: name });
  if (!project.id)
    throw new ToolError('Copilot did not return an id for the new project.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return { ...project, id: project.id };
};

export const updateProjectRecord = async (projectId: string, name: string): Promise<void> => {
  await patchApi(`/projects/${encodeURIComponent(projectId)}`, { title: name });
};

export const deleteProjectRecord = async (projectId: string): Promise<void> => {
  await deleteApi(`/projects/${encodeURIComponent(projectId)}`);
};

export const fetchProjectConversationsPage = async (
  projectId: string,
  cursor: string | undefined,
  timeout?: number,
): Promise<CursorPage<RawConversation>> => {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const page = await callApi<RawPage<RawConversation>>(
    `/projects/${encodeURIComponent(projectId)}/conversations${suffix}`,
    { method: 'GET', timeout },
  );
  return { rows: (page.results ?? []).filter(row => Boolean(row.id)), next: page.next || null };
};

const collectCursorPages = async <TRow extends { id?: string }>(
  fetchPage: (cursor: string | undefined, timeout?: number) => Promise<CursorPage<TRow>>,
  deadline?: number,
): Promise<CursorCollection<TRow>> => {
  const rows: TRow[] = [];
  const seen = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;
  let complete = false;
  for (let page = 0; page < MAX_PROJECT_PAGES && (deadline === undefined || Date.now() < deadline); page += 1) {
    const timeout = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
    const result = await fetchPage(cursor, timeout);
    pagesFetched += 1;
    for (const row of result.rows) {
      const id = row.id ?? '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
    if (!result.next) {
      complete = true;
      break;
    }
    if (result.next === cursor || seenCursors.has(result.next) || result.rows.length === 0) break;
    seenCursors.add(result.next);
    cursor = result.next;
  }
  return { rows, pagesFetched, complete };
};

export const collectProjectsWithStats = (deadline?: number): Promise<CursorCollection<RawProject>> =>
  collectCursorPages(fetchProjectsPage, deadline);

const requireComplete = <TRow>(collection: CursorCollection<TRow>, resource: string): TRow[] => {
  if (!collection.complete)
    throw new ToolError(
      `Copilot's bounded ${resource} scan ended before the provider cursor was exhausted.`,
      'UPSTREAM_ERROR',
      {
        category: 'internal',
        retryable: true,
      },
    );
  return collection.rows;
};

export const collectProjects = async (): Promise<RawProject[]> =>
  requireComplete(await collectProjectsWithStats(), 'Project');

export const collectProjectConversationsWithStats = (
  projectId: string,
  deadline?: number,
): Promise<CursorCollection<RawConversation>> =>
  collectCursorPages((cursor, timeout) => fetchProjectConversationsPage(projectId, cursor, timeout), deadline);

export const collectProjectConversations = async (projectId: string): Promise<RawConversation[]> =>
  requireComplete(await collectProjectConversationsWithStats(projectId), 'Project-conversation');

export interface ProjectConversationIndex {
  conversations: Array<{ row: RawConversation; projectId: string }>;
  memberships: Map<string, string>;
  pagesFetched: number;
  complete: boolean;
}

/** Builds one bounded Project-membership index for callers that need every Project chat. */
export const collectProjectConversationIndex = async (deadline?: number): Promise<ProjectConversationIndex> => {
  const projects = await collectProjectsWithStats(deadline);
  const pages: Array<{ projectId: string; result: CursorCollection<RawConversation> } | undefined> = Array.from({
    length: projects.rows.length,
  });
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
          : { rows: [], pagesFetched: 0, complete: true },
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
    complete:
      projects.complete &&
      completedPages.length === projects.rows.length &&
      completedPages.every(page => page.result.complete),
  };
};

export const findConversationProject = async (conversationId: string, deadline?: number): Promise<string | null> => {
  const index = await collectProjectConversationIndex(deadline);
  const projectId = index.memberships.get(conversationId);
  if (projectId) return projectId;
  if (!index.complete)
    throw new ToolError(
      `Copilot's bounded Project-membership scan ended before it could prove that ${conversationId} is unfiled.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  return null;
};

export const projectContainsConversation = async (projectId: string, conversationId: string): Promise<boolean> =>
  (await collectProjectConversations(projectId)).some(conversation => conversation.id === conversationId);

export const mapProjectConversation = (row: RawConversation, projectId: string): ConversationListItem =>
  mapConversationRow(row, projectId);
