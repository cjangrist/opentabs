import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchThreadPage, fetchThreadTip } from '../perplexity-conversations.js';
import { walkOffsetPages } from '../perplexity-pagination.js';
import {
  createCollection,
  deleteCollection,
  editCollection,
  fetchProjectThreadsPage,
  fetchProjectsPage,
  getCollection,
  mapCollection,
  mapProjectThread,
  moveThreadToCollection,
  removeThreadFromCollection,
  resolveCollection,
} from '../perplexity-projects.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  projectSchema,
  resolvePagination,
} from './normalized-schemas.js';

const SPACE_NOTES =
  'Perplexity calls these Spaces in the product, Projects in the URL and "collections" in the API — all the same ' +
  'object. project_id accepts either the Space uuid or its slug. created_at is 0: Perplexity reports no creation ' +
  'time for a Space anywhere in its REST surface. total is null — the list endpoint marks "there is more" on the ' +
  'first row instead of reporting a count.';

export const listProjects = defineTool({
  name: 'list_projects',
  displayName: 'List Projects',
  description: `List the Perplexity Spaces this account owns or contributes to. ${SPACE_NOTES}`,
  summary: 'List Perplexity Spaces',
  icon: 'folder',
  group: 'Projects',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(projectSchema),
  handle: async params =>
    walkOffsetPages(resolvePagination(params), (offset, limit) => fetchProjectsPage(offset, limit), mapCollection),
});

export const getProject = defineTool({
  name: 'get_project',
  displayName: 'Get Project',
  description: `Read one Perplexity Space. ${SPACE_NOTES}`,
  summary: 'Get a Perplexity Space',
  icon: 'folder-open',
  group: 'Projects',
  input: z.object({ project_id: z.string().min(1).describe('Space uuid or slug.') }),
  output: projectSchema,
  handle: async params => getCollection(await resolveCollection(params.project_id)),
});

export const listProjectConversations = defineTool({
  name: 'list_project_conversations',
  displayName: 'List Project Conversations',
  description:
    'List the threads filed in a Perplexity Space. This is the membership view used to prove a move from the ' +
    `target side. ${SPACE_NOTES} is_archived / is_starred are false here — the Space thread list does not report them.`,
  summary: 'List threads in a Space',
  icon: 'folder-tree',
  group: 'Projects',
  input: z.object({ project_id: z.string().min(1).describe('Space uuid or slug.'), ...paginationInputShape }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    const ref = await resolveCollection(params.project_id);
    return walkOffsetPages(
      resolvePagination(params),
      (offset, limit) => fetchProjectThreadsPage(ref.slug, offset, limit),
      thread => mapProjectThread(thread, ref.uuid),
    );
  },
});

export const createProject = defineTool({
  name: 'create_project',
  displayName: 'Create Project',
  description: `Create a Perplexity Space. ${SPACE_NOTES}`,
  summary: 'Create a Perplexity Space',
  icon: 'folder-plus',
  group: 'Projects',
  input: z.object({
    name: z.string().min(1).describe('Space title.'),
    description: z.string().optional().describe('Optional description shown under the title.'),
  }),
  output: projectSchema,
  handle: async params => createCollection(params.name, params.description),
});

export const updateProject = defineTool({
  name: 'update_project',
  displayName: 'Update Project',
  description: `Rename a Perplexity Space or change its description. ${SPACE_NOTES}`,
  summary: 'Update a Perplexity Space',
  icon: 'pencil',
  group: 'Projects',
  input: z.object({
    project_id: z.string().min(1).describe('Space uuid or slug.'),
    name: z.string().optional(),
    description: z.string().optional(),
  }),
  output: projectSchema,
  handle: async params =>
    editCollection(await resolveCollection(params.project_id), { title: params.name, description: params.description }),
});

export const deleteProject = defineTool({
  name: 'delete_project',
  displayName: 'Delete Project',
  description:
    'Delete a Perplexity Space. Threads filed in it are not deleted — they return to the ungrouped Library. ' +
    'This cannot be undone.',
  summary: 'Delete a Perplexity Space',
  icon: 'trash-2',
  group: 'Projects',
  input: z.object({ project_id: z.string().min(1).describe('Space uuid or slug.') }),
  output: z.object({ project_id: z.string(), deleted: z.boolean() }),
  handle: async params => {
    const ref = await resolveCollection(params.project_id);
    await deleteCollection(ref);
    return { project_id: ref.uuid, deleted: true };
  },
});

/**
 * Membership is keyed on the thread's CONTEXT uuid, not the slug the rest of the
 * surface uses, so every membership tool resolves the thread first.
 */
const membershipTargets = async (conversationId: string, projectId: string) => {
  const [tip, ref] = await Promise.all([fetchThreadTip(conversationId), resolveCollection(projectId)]);
  if (!tip.contextUuid)
    throw new ToolError(
      `Perplexity thread "${conversationId}" reported no context uuid, which Space membership is keyed on.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  return { tip, ref };
};

/**
 * The thread's own `thread_metadata.collection_info` is the single source of
 * truth for which Space it is in — unlike a membership listing, it cannot be
 * fooled by a thread sitting past the first page of a busy Space.
 */
const currentProjectId = async (conversationId: string): Promise<string | null> =>
  (await fetchThreadPage(conversationId, 1)).projectId;

export const addConversationToProject = defineTool({
  name: 'add_conversation_to_project',
  displayName: 'Add Conversation To Project',
  description:
    'File a Perplexity thread into a Space. Perplexity has a single membership primitive (batch_move_threads), so ' +
    'adding a thread that already belongs to another Space moves it.',
  summary: 'Add a thread to a Space',
  icon: 'folder-input',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().min(1).describe('Thread slug.'),
    project_id: z.string().min(1).describe('Space uuid or slug.'),
  }),
  output: z.object({ conversation_id: z.string(), project_id: z.string() }),
  handle: async params => {
    const { tip, ref } = await membershipTargets(params.conversation_id, params.project_id);
    await moveThreadToCollection(tip.contextUuid, ref.uuid);
    return { conversation_id: tip.conversationId, project_id: ref.uuid };
  },
});

export const removeConversationFromProject = defineTool({
  name: 'remove_conversation_from_project',
  displayName: 'Remove Conversation From Project',
  description:
    'Remove a Perplexity thread from a Space, returning it to the ungrouped Library. Perplexity names the Space ' +
    'the thread is leaving, so project_id may be omitted and is then read from the thread itself.',
  summary: 'Remove a thread from a Space',
  icon: 'folder-minus',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().min(1).describe('Thread slug.'),
    project_id: z
      .string()
      .optional()
      .describe('Space the thread currently belongs to (uuid or slug). Omit to use the thread\'s current Space.'),
  }),
  output: z.object({ conversation_id: z.string(), project_id: z.string(), removed: z.boolean() }),
  handle: async params => {
    const owning = params.project_id ?? (await currentProjectId(params.conversation_id));
    if (!owning)
      throw ToolError.validation(
        `Perplexity thread "${params.conversation_id}" is not filed in any Space, so there is nothing to remove it from.`,
      );
    const { tip, ref } = await membershipTargets(params.conversation_id, owning);
    await removeThreadFromCollection(tip.contextUuid, ref.uuid);
    return { conversation_id: tip.conversationId, project_id: ref.uuid, removed: true };
  },
});

export const moveConversationToProject = defineTool({
  name: 'move_conversation_to_project',
  displayName: 'Move Conversation To Project',
  description:
    'Move a Perplexity thread into a Space, verifying both sides afterwards: the target Space must list the thread ' +
    'and, when from_project_id is given, the source must no longer list it. A verification failure raises rather ' +
    'than reporting a move that did not happen.',
  summary: 'Move a thread between Spaces',
  icon: 'folder-symlink',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().min(1).describe('Thread slug.'),
    to_project_id: z.string().min(1).describe('Destination Space uuid or slug.'),
    from_project_id: z.string().optional().describe('Source Space, checked for removal after the move.'),
  }),
  output: z.object({
    conversation_id: z.string(),
    to_project_id: z.string(),
    from_project_id: z.string().nullable(),
    verified_in_target: z.boolean(),
    verified_absent_from_source: z.boolean().nullable(),
  }),
  handle: async params => {
    const { tip, ref } = await membershipTargets(params.conversation_id, params.to_project_id);
    const source = params.from_project_id ? await resolveCollection(params.from_project_id) : null;
    await moveThreadToCollection(tip.contextUuid, ref.uuid);

    // Verify against the thread's own collection_info rather than a membership
    // listing: a Space with more than one page of threads would hide a
    // successfully moved conversation past row 50 and report a false negative.
    const owning = await currentProjectId(tip.conversationId);
    const inTarget = owning === ref.uuid;
    const absentFromSource = source ? owning !== source.uuid : null;
    if (!inTarget)
      throw new ToolError(
        `Perplexity accepted the move but thread "${tip.conversationId}" reports Space "${owning ?? 'none'}" ` +
          `rather than "${ref.uuid}".`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: false },
      );
    if (absentFromSource === false)
      throw new ToolError(
        `Perplexity moved thread "${tip.conversationId}" but it still reports Space "${source?.uuid}".`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: false },
      );

    return {
      conversation_id: tip.conversationId,
      to_project_id: ref.uuid,
      from_project_id: source?.uuid ?? null,
      verified_in_target: inTarget,
      verified_absent_from_source: absentFromSource,
    };
  },
});
