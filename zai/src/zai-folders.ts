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

/**
 * Creates a folder and identifies it by *id diff*, not by name.
 *
 * z.ai allows duplicate folder names and exposes no single-folder GET, so matching
 * on name — even with a `created_at` tiebreak — can hand back a pre-existing folder
 * and report success. Snapshotting the ids first makes the new one unambiguous, and
 * the POST response's own id is preferred whenever it carries one.
 */
export const createFolder = async (name: string): Promise<RawFolder> => {
  const before = new Set((await listFolders()).map(folder => folder.id).filter(Boolean));
  const posted = await api<RawFolder>(FOLDERS_PATH, { method: 'POST', body: { name } });
  const after = await listFolders();
  const created = posted?.id
    ? after.find(folder => folder.id === posted.id)
    : after.find(folder => folder.id && !before.has(folder.id) && folder.name === name);
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
