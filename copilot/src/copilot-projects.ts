import { ToolError } from '@opentabs-dev/plugin-sdk';
import { deleteApi, getApi, patchApi, postApi, projectUrl, toUnixSeconds } from './copilot-api.js';
import { mapConversationRow, type RawConversation } from './copilot-conversations.js';
import type { CursorPage } from './copilot-pagination.js';
import type { ConversationListItem, NormalizedProject } from './tools/normalized-schemas.js';

const MAX_PROJECT_PAGES = 200;

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

export const collectProjects = async (): Promise<RawProject[]> => {
  const projects: RawProject[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
    const result = await fetchProjectsPage(cursor);
    for (const project of result.rows) {
      const id = project.id ?? '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      projects.push(project);
    }
    if (!result.next || result.next === cursor || result.rows.length === 0) break;
    cursor = result.next;
  }
  return projects;
};

export const collectProjectConversations = async (projectId: string): Promise<RawConversation[]> => {
  const conversations: RawConversation[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
    const result = await fetchProjectConversationsPage(projectId, cursor);
    for (const conversation of result.rows) {
      const id = conversation.id ?? '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      conversations.push(conversation);
    }
    if (!result.next || result.next === cursor || result.rows.length === 0) break;
    cursor = result.next;
  }
  return conversations;
};

export const findConversationProject = async (conversationId: string): Promise<string | null> => {
  const projects = await collectProjects();
  for (const project of projects) {
    if (!project.id) continue;
    const members = await collectProjectConversations(project.id);
    if (members.some(member => member.id === conversationId)) return project.id;
  }
  return null;
};

export const projectContainsConversation = async (projectId: string, conversationId: string): Promise<boolean> =>
  (await collectProjectConversations(projectId)).some(conversation => conversation.id === conversationId);

export const mapProjectConversation = (row: RawConversation, projectId: string): ConversationListItem =>
  mapConversationRow(row, projectId);
