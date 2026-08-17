import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
import { asArray, asString, callRpc, notebookUrl, toNotebookResource, tupleToUnixSeconds } from './gemini-api.js';
import type { NormalizedProject } from './tools/normalized-schemas.js';

// RPC ids captured from the Notebooks UI on gemini.google.com (2026-08).
const RPC_LIST_NOTEBOOKS = 'CNgdBe';
const RPC_GET_NOTEBOOK = 'HcT8bb';
const RPC_CREATE_NOTEBOOK = 'oMH3Zd';
const RPC_UPDATE_NOTEBOOK = 'kHv0Vd';
const RPC_DELETE_NOTEBOOK = 'Nwkn9';

export interface GeminiNotebook {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  sourceCount: number;
  pinned: boolean;
}

/**
 * Notebook rows are `[resourceName, notebookMetadata, instructions, …]`.
 * The nested metadata tuple is shared by the list and get RPCs; fields the list
 * omits (notably instructions) remain null rather than being guessed.
 */
const mapNotebook = (value: unknown): GeminiNotebook | null => {
  const row = asArray(value);
  const id = asString(row[0]);
  if (!id?.startsWith('notebooks/')) return null;
  const notebook = asArray(row[1]);
  const metadata = asArray(notebook[14]);
  const instructions = asArray(row[2]);
  const createdAt = tupleToUnixSeconds(metadata[4]);
  return {
    id,
    name: typeof notebook[0] === 'string' ? notebook[0] : '',
    description: asString(instructions[0]),
    // Native metadata orders the last mutation tuple before the creation tuple.
    createdAt,
    updatedAt: Math.max(createdAt, tupleToUnixSeconds(metadata[1])),
    sourceCount: typeof metadata[2] === 'number' ? metadata[2] : 0,
    pinned: metadata[8] === true || metadata[8] === 1,
  };
};

/** CNgdBe returns the complete notebook catalogue; `[2]` selects notebooks. */
export const listNotebooks = async (): Promise<GeminiNotebook[]> => {
  const data = await callRpc<unknown[]>(RPC_LIST_NOTEBOOKS, [2, ['en'], 0, null, [2]]);
  return asArray(data[2])
    .map(mapNotebook)
    .filter((notebook): notebook is GeminiNotebook => notebook !== null);
};

export const getNotebook = async (projectId: string): Promise<GeminiNotebook> => {
  const resource = toNotebookResource(projectId);
  const data = await callRpc<unknown[]>(RPC_GET_NOTEBOOK, [resource]);
  const notebook = mapNotebook(asArray(data)[0]);
  if (!notebook)
    throw new ToolError(`Gemini returned no notebook record for ${resource}.`, 'NOT_FOUND', {
      category: 'not_found',
    });
  return notebook;
};

/** The create shape is the site's "Organize your ideas" notebook template. */
export const createNotebook = async (name: string, description: string | undefined): Promise<GeminiNotebook> => {
  const before = new Set((await listNotebooks()).map(notebook => notebook.id));
  const createShape: unknown[] = new Array(17).fill(null);
  createShape[0] = name;
  createShape[1] = '';
  createShape[8] = 0;
  createShape[10] = 1;
  createShape[16] = [2, null, null, null, 1];
  const data = await callRpc<unknown[]>(RPC_CREATE_NOTEBOOK, [createShape]);
  const findResource = (value: unknown): string | null => {
    if (typeof value === 'string' && value.startsWith('notebooks/')) return value;
    if (!Array.isArray(value)) return null;
    for (const child of value) {
      const resource = findResource(child);
      if (resource) return resource;
    }
    return null;
  };
  let resource = findResource(data);
  for (let attempt = 0; !resource && attempt < 4; attempt += 1) {
    if (attempt > 0) await sleep(500);
    const candidates = (await listNotebooks()).filter(notebook => !before.has(notebook.id) && notebook.name === name);
    if (candidates.length === 1) resource = candidates[0]?.id ?? null;
    if (candidates.length > 1)
      throw new ToolError(
        `Gemini created multiple notebooks named "${name}" (${candidates.map(notebook => notebook.id).join(', ')}), so the new one is ambiguous.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: false },
      );
  }
  if (!resource)
    throw new ToolError(`Gemini accepted notebook "${name}" but returned no resource name.`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return description === undefined ? getNotebook(resource) : updateNotebook(resource, undefined, description);
};

/**
 * kHv0Vd is a full settings update rather than a field-mask patch. Read the
 * current record first, then resend every stable setting from the native
 * "Organize your ideas" form so a rename cannot erase the instructions.
 */
export const updateNotebook = async (
  projectId: string,
  name: string | undefined,
  description: string | undefined,
): Promise<GeminiNotebook> => {
  const current = await getNotebook(projectId);
  const settings: unknown[] = new Array(19).fill(null);
  settings[0] = name ?? current.name;
  settings[1] = '';
  settings[2] = description ?? current.description ?? '';
  settings[8] = 0;
  settings[9] = 0;
  settings[10] = 1;
  settings[12] = [null, null, 0, 1, 0];
  settings[15] = 0;
  settings[16] = [2, null, null, null, 1];
  settings[18] = [null, null, null, null, null, null, 1, 0, 0];
  await callRpc(RPC_UPDATE_NOTEBOOK, [current.id, settings]);
  return getNotebook(current.id);
};

export const deleteNotebook = async (projectId: string): Promise<void> => {
  const current = await getNotebook(projectId);
  await callRpc(RPC_DELETE_NOTEBOOK, [current.id]);
};

export const mapNotebookProject = (notebook: GeminiNotebook, conversationCount: number | null): NormalizedProject => ({
  id: notebook.id,
  name: notebook.name,
  description: notebook.description,
  created_at: notebook.createdAt,
  updated_at: notebook.updatedAt,
  conversation_count: conversationCount,
  url: notebookUrl(notebook.id),
});
