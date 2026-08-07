import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api, projectUrl } from './zai-api.js';
import type { RawChatDetail, RawFolder } from './zai-conversations.js';
import type { NormalizedProject } from './tools/normalized-schemas.js';

const FOLDERS_PATH = '/v1/folders/';

export const listFolders = async (): Promise<RawFolder[]> => {
  const folders = await api<RawFolder[]>(FOLDERS_PATH);
  return Array.isArray(folders) ? folders : [];
};

/**
 * z.ai exposes no single-folder GET, so a folder is resolved out of the full list.
 * The list is one small request and always complete, so this is cheaper than the
 * per-id endpoint would be anyway.
 */
export const getFolder = async (folderId: string): Promise<RawFolder> => {
  const folder = (await listFolders()).find(entry => entry.id === folderId);
  if (!folder) throw ToolError.notFound(`z.ai has no folder ${folderId} (or it belongs to another account).`);
  return folder;
};

export const listFolderChats = async (folderId: string): Promise<RawChatDetail[]> => {
  const chats = await api<RawChatDetail[]>(`/v1/chats/folder/${encodeURIComponent(folderId)}`);
  return Array.isArray(chats) ? chats : [];
};

export const createFolder = async (name: string): Promise<RawFolder> => {
  await api<unknown>(FOLDERS_PATH, { method: 'POST', body: { name } });
  // The create response is the folder, but z.ai has been observed to return it
  // without `id` populated on some deployments; re-reading the list is definitive.
  const created = (await listFolders())
    .filter(folder => folder.name === name)
    .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0))[0];
  if (!created?.id)
    throw new ToolError(`z.ai accepted the folder "${name}" but it is not in /api/v1/folders/.`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return created;
};

export const renameFolder = async (folderId: string, name: string): Promise<RawFolder> => {
  await getFolder(folderId);
  await api<unknown>(`${FOLDERS_PATH}${encodeURIComponent(folderId)}/update`, { method: 'POST', body: { name } });
  return getFolder(folderId);
};

export const deleteFolder = async (folderId: string): Promise<void> => {
  await getFolder(folderId);
  await api<unknown>(`${FOLDERS_PATH}${encodeURIComponent(folderId)}`, { method: 'DELETE' });
};

export const mapFolder = (folder: RawFolder, conversationCount: number | null): NormalizedProject => ({
  id: folder.id ?? '',
  name: folder.name ?? '',
  // z.ai folders carry a free-form `meta` but the UI offers no description field.
  description: null,
  created_at: folder.created_at ?? 0,
  updated_at: folder.updated_at ?? 0,
  conversation_count: conversationCount,
  url: projectUrl(folder.id ?? ''),
});
