import { ToolError, defineTool, sleep } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  collectProjectConversationRows,
  getConversationRow,
  listProjectConversationRows as listMemberRows,
  mapConversationListItem,
  setConversationProject,
} from '../gemini-conversations.js';
import { pageLocalArray } from '../gemini-pagination.js';
import {
  createNotebook,
  deleteNotebook,
  getNotebook,
  listNotebooks,
  mapNotebookProject,
  updateNotebook,
} from '../gemini-projects.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  projectSchema,
  resolvePagination,
} from './normalized-schemas.js';

const NOTEBOOK_NOTE =
  'Gemini calls projects Notebooks. The normalized description maps to Notebook settings → Instructions. ' +
  'Ids are native notebooks/<uuid> resource names; bare UUIDs are accepted too.';

export const listProjects = defineTool({
  name: 'list_projects',
  displayName: 'List Projects',
  description:
    `List every Gemini Notebook through RPC CNgdBe and paginate the complete returned catalogue locally. ${NOTEBOOK_NOTE} ` +
    'conversation_count and description are null here because the catalogue omits both; get_project reads them.',
  summary: 'List Gemini Notebooks',
  icon: 'folder',
  group: 'Projects',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(projectSchema),
  handle: async params =>
    pageLocalArray(
      (await listNotebooks()).map(notebook => mapNotebookProject(notebook, null)),
      resolvePagination(params),
    ),
});

export const getProject = defineTool({
  name: 'get_project',
  displayName: 'Get Project',
  description: `Read one Gemini Notebook and count its chats by exhausting the native project-filtered MaZiqc cursor. ${NOTEBOOK_NOTE}`,
  summary: 'Get a Gemini Notebook',
  icon: 'folder-open',
  group: 'Projects',
  input: z.object({ project_id: z.string().min(1) }),
  output: projectSchema,
  handle: async params => {
    const [notebook, members] = await Promise.all([
      getNotebook(params.project_id),
      collectProjectConversationRows(params.project_id),
    ]);
    return mapNotebookProject(notebook, members.length);
  },
});

export const listProjectConversations = defineTool({
  name: 'list_project_conversations',
  displayName: 'List Project Conversations',
  description:
    'List chats in a Gemini Notebook with MaZiqc’s native opaque cursor and project filter. The returned project_id ' +
    'is the stored notebooks/<uuid> membership. Gemini hard-caps upstream pages at 100 and reports no total.',
  summary: 'List chats in a Notebook',
  icon: 'folder-tree',
  group: 'Projects',
  input: z.object({ project_id: z.string().min(1), ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    const notebook = await getNotebook(params.project_id);
    return listMemberRows(notebook.id, resolvePagination(params));
  },
});

export const createProject = defineTool({
  name: 'create_project',
  displayName: 'Create Project',
  description:
    `Create an “Organize your ideas” Gemini Notebook, then read back the stored record. ${NOTEBOOK_NOTE} ` +
    'When description is supplied, the native settings RPC stores and verifies it as Instructions.',
  summary: 'Create a Gemini Notebook',
  icon: 'folder-plus',
  group: 'Projects',
  input: z.object({
    name: z.string().trim().min(1),
    description: z.string().optional().describe('Notebook Instructions.'),
  }),
  output: projectSchema,
  handle: async params => mapNotebookProject(await createNotebook(params.name, params.description), 0),
});

export const updateProject = defineTool({
  name: 'update_project',
  displayName: 'Update Project',
  description:
    `Rename a Gemini Notebook or replace its Instructions, reading the record before and after the full settings update. ${NOTEBOOK_NOTE} ` +
    'Omitted fields are preserved rather than blanked.',
  summary: 'Update a Gemini Notebook',
  icon: 'pencil',
  group: 'Projects',
  input: z.object({
    project_id: z.string().min(1),
    name: z.string().trim().min(1).optional(),
    description: z.string().optional(),
  }),
  output: projectSchema,
  handle: async params => {
    if (params.name === undefined && params.description === undefined)
      throw ToolError.validation('Nothing to update — pass name and/or description.');
    return mapNotebookProject(await updateNotebook(params.project_id, params.name, params.description), null);
  },
});

const projectContains = async (projectId: string, conversationId: string): Promise<boolean> =>
  (await collectProjectConversationRows(projectId)).some(row => row.id === conversationId);

const SETTLE_ATTEMPTS = 4;
const SETTLE_DELAY_MS = 500;

const settleContains = async (projectId: string, conversationId: string, expected: boolean): Promise<boolean> => {
  let actual = await projectContains(projectId, conversationId);
  for (let attempt = 1; attempt < SETTLE_ATTEMPTS && actual !== expected; attempt += 1) {
    await sleep(SETTLE_DELAY_MS);
    actual = await projectContains(projectId, conversationId);
  }
  return actual;
};

export const deleteProject = defineTool({
  name: 'delete_project',
  displayName: 'Delete Project',
  description:
    'Permanently delete a Gemini Notebook. Native deletion also deletes member chats, so this refuses a non-empty ' +
    'Notebook unless detach_conversations:true; that option removes and verifies every membership first, preserving the chats.',
  summary: 'Delete a Gemini Notebook safely',
  icon: 'trash-2',
  group: 'Projects',
  input: z.object({
    project_id: z.string().min(1),
    detach_conversations: z.boolean().optional(),
  }),
  output: z.object({
    project_id: z.string(),
    deleted: z.boolean(),
    conversations_detached: z.number().int(),
  }),
  handle: async params => {
    const notebook = await getNotebook(params.project_id);
    const members = await collectProjectConversationRows(notebook.id);
    if (members.length > 0 && params.detach_conversations !== true)
      throw ToolError.validation(
        `Notebook ${notebook.id} holds ${members.length} conversation(s). Move them first, or pass detach_conversations:true to preserve them while deleting the Notebook.`,
      );
    for (const member of members) await setConversationProject(member.id, null);
    if (members.length > 0 && (await collectProjectConversationRows(notebook.id)).length > 0)
      throw new ToolError(
        `Gemini still lists chats in ${notebook.id} after detachment, so the destructive Notebook delete was not sent.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      );
    await deleteNotebook(notebook.id);
    return { project_id: notebook.id, deleted: true, conversations_detached: members.length };
  },
});

export const addConversationToProject = defineTool({
  name: 'add_conversation_to_project',
  displayName: 'Add Conversation To Project',
  description:
    'Assign a Gemini chat to a Notebook through the native bot_project_metadata field-mask update. Both resources ' +
    'are read first, then the chat row and target membership list are re-read; adding from another Notebook is a move.',
  summary: 'Add a chat to a Notebook',
  icon: 'folder-input',
  group: 'Projects',
  input: z.object({ conversation_id: z.string().min(1), project_id: z.string().min(1) }),
  output: conversationListItemSchema,
  handle: async params => {
    const [notebook, before] = await Promise.all([
      getNotebook(params.project_id),
      getConversationRow(params.conversation_id),
    ]);
    await setConversationProject(before.id, notebook.id);
    const [updated, targetContains] = await Promise.all([
      getConversationRow(before.id),
      settleContains(notebook.id, before.id, true),
    ]);
    const sourceContains =
      before.projectId && before.projectId !== notebook.id
        ? await settleContains(before.projectId, before.id, false)
        : false;
    if (updated.projectId !== notebook.id || !targetContains || sourceContains)
      throw new ToolError(
        `Gemini accepted the assignment, but ${before.id} is not verifiably in ${notebook.id}.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      );
    return mapConversationListItem(updated);
  },
});

export const removeConversationFromProject = defineTool({
  name: 'remove_conversation_from_project',
  displayName: 'Remove Conversation From Project',
  description:
    'Remove a chat from its Gemini Notebook. project_id is an optional guard: when supplied, a different stored ' +
    'membership fails before mutation. The chat row and former Notebook list are re-read after removal.',
  summary: 'Remove a chat from a Notebook',
  icon: 'folder-minus',
  group: 'Projects',
  input: z.object({ conversation_id: z.string().min(1), project_id: z.string().min(1).optional() }),
  output: conversationListItemSchema,
  handle: async params => {
    const before = await getConversationRow(params.conversation_id);
    if (!before.projectId) throw ToolError.validation(`Conversation ${before.id} is not in a Notebook.`);
    const expected = params.project_id ? (await getNotebook(params.project_id)).id : before.projectId;
    if (before.projectId !== expected)
      throw ToolError.validation(`Conversation ${before.id} is in ${before.projectId}, not ${expected}.`);
    await setConversationProject(before.id, null);
    const [updated, sourceContains] = await Promise.all([
      getConversationRow(before.id),
      settleContains(before.projectId, before.id, false),
    ]);
    if (updated.projectId !== null || sourceContains)
      throw new ToolError(
        `Gemini accepted the removal, but ${before.id} still reports membership in ${updated.projectId ?? before.projectId}.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      );
    return mapConversationListItem(updated);
  },
});

export const moveConversationToProject = defineTool({
  name: 'move_conversation_to_project',
  displayName: 'Move Conversation To Project',
  description:
    'Move a Gemini chat to another Notebook with one native assignment. The destination list must contain it and ' +
    'the prior source list must not; a same-target request is a verified no-op. from_project_id is an optional guard.',
  summary: 'Move a chat between Notebooks',
  icon: 'folder-symlink',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().min(1),
    to_project_id: z.string().min(1),
    from_project_id: z.string().min(1).optional(),
  }),
  output: z.object({
    conversation: conversationListItemSchema,
    from_project_id: z.string().nullable(),
    to_project_id: z.string(),
    verified: z.object({ target_contains: z.boolean(), source_contains: z.boolean() }),
  }),
  handle: async params => {
    const [target, before] = await Promise.all([
      getNotebook(params.to_project_id),
      getConversationRow(params.conversation_id),
    ]);
    const expectedSource = params.from_project_id ? (await getNotebook(params.from_project_id)).id : null;
    if (expectedSource && before.projectId !== expectedSource)
      throw ToolError.validation(
        `Conversation ${before.id} is in ${before.projectId ?? '(none)'}, not ${expectedSource}.`,
      );
    if (before.projectId !== target.id) await setConversationProject(before.id, target.id);
    const [updated, targetContains] = await Promise.all([
      getConversationRow(before.id),
      settleContains(target.id, before.id, true),
    ]);
    const sourceContains =
      before.projectId && before.projectId !== target.id
        ? await settleContains(before.projectId, before.id, false)
        : false;
    if (updated.projectId !== target.id || !targetContains || sourceContains)
      throw new ToolError(
        `Gemini did not verify the move of ${before.id} from ${before.projectId ?? '(none)'} to ${target.id}.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      );
    return {
      conversation: mapConversationListItem(updated),
      from_project_id: before.projectId,
      to_project_id: target.id,
      verified: { target_contains: targetContains, source_contains: sourceContains },
    };
  },
});
