import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getConversationDetail, mapConversationDetail, setConversationFolder } from '../zai-conversations.js';
import {
  createFolder,
  deleteFolder,
  getFolder,
  listFolderChats,
  listFolders,
  mapFolder,
  renameFolder,
} from '../zai-folders.js';
import { pageLocalArray } from '../zai-pagination.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  projectSchema,
  resolvePagination,
} from './normalized-schemas.js';

const FOLDER_NOTE =
  'z.ai calls these folders. They have a name only — no description field exists anywhere in the API or the UI, so description is always null and passing one raises VALIDATION_ERROR rather than being silently dropped.';

export const listProjects = defineTool({
  name: 'list_projects',
  displayName: 'List Projects',
  description:
    `List folders from GET /api/v1/folders/. ${FOLDER_NOTE} ` +
    'The endpoint returns every folder in one unpaginated response, so total is a true total and pagination is applied locally. ' +
    'conversation_count is null here because the only way to count a folder is to download its chats in full; call get_project or list_project_conversations for a real count.',
  summary: 'List folders (paginated)',
  icon: 'folder',
  group: 'Projects',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(projectSchema),
  handle: async params =>
    pageLocalArray(
      (await listFolders()).map(folder => mapFolder(folder, null)),
      resolvePagination(params),
    ),
});

export const getProject = defineTool({
  name: 'get_project',
  displayName: 'Get Project',
  description: `Read one folder, including a real conversation_count from GET /api/v1/chats/folder/<id>. ${FOLDER_NOTE}`,
  summary: 'Get a folder',
  icon: 'folder-open',
  group: 'Projects',
  input: z.object({ project_id: z.string().describe('Folder id from list_projects.') }),
  output: projectSchema,
  handle: async params => {
    const folder = await getFolder(params.project_id);
    return mapFolder(folder, (await listFolderChats(params.project_id)).length);
  },
});

export const listProjectConversations = defineTool({
  name: 'list_project_conversations',
  displayName: 'List Project Conversations',
  description:
    'List the conversations inside a folder. GET /api/v1/chats/folder/<id> returns every member as a full chat object in one unpaginated response, so total is a true total, pagination is applied locally, and project_id / is_archived / is_starred / model_id are all read straight off the object rather than enriched.',
  summary: 'List a folder’s conversations (paginated)',
  icon: 'folder-tree',
  group: 'Projects',
  input: z.object({
    project_id: z.string().describe('Folder id from list_projects.'),
    ...paginationInputShape,
  }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    await getFolder(params.project_id);
    const chats = await listFolderChats(params.project_id);
    return pageLocalArray(chats.map(mapConversationDetail), resolvePagination(params));
  },
});

const rejectDescription = (description: string | undefined): void => {
  if (description !== undefined)
    throw ToolError.validation(
      'z.ai folders have no description field — see list_capabilities().features.projects and the tool description.',
    );
};

export const createProject = defineTool({
  name: 'create_project',
  displayName: 'Create Project',
  description: `Create a folder. ${FOLDER_NOTE}`,
  summary: 'Create a folder',
  icon: 'folder-plus',
  group: 'Projects',
  input: z.object({
    name: z.string().min(1).describe('Folder name.'),
    description: z.string().optional().describe('Not supported by z.ai — passing this raises VALIDATION_ERROR.'),
  }),
  output: projectSchema,
  handle: async params => {
    rejectDescription(params.description);
    return mapFolder(await createFolder(params.name), 0);
  },
});

export const updateProject = defineTool({
  name: 'update_project',
  displayName: 'Update Project',
  description: `Rename a folder. ${FOLDER_NOTE}`,
  summary: 'Rename a folder',
  icon: 'pencil',
  group: 'Projects',
  input: z.object({
    project_id: z.string().describe('Folder id from list_projects.'),
    name: z.string().min(1).optional().describe('New folder name.'),
    description: z.string().optional().describe('Not supported by z.ai — passing this raises VALIDATION_ERROR.'),
  }),
  output: projectSchema,
  handle: async params => {
    rejectDescription(params.description);
    if (!params.name) throw ToolError.validation('Nothing to update — pass name.');
    return mapFolder(await renameFolder(params.project_id, params.name), null);
  },
});

export const deleteProject = defineTool({
  name: 'delete_project',
  displayName: 'Delete Project',
  description:
    'Delete a folder. WARNING: verified live — z.ai CASCADES this, permanently deleting every conversation inside the folder, not just the folder. There is no trash. ' +
    'A non-empty folder is therefore refused with VALIDATION_ERROR unless delete_conversations: true is passed explicitly; move the conversations out first if you want to keep them.',
  summary: 'Delete a folder',
  icon: 'trash-2',
  group: 'Projects',
  input: z.object({
    project_id: z.string().describe('Folder id from list_projects.'),
    delete_conversations: z
      .boolean()
      .optional()
      .describe('Acknowledge that every conversation in the folder will be permanently deleted with it.'),
  }),
  output: z.object({
    deleted: z.boolean(),
    project_id: z.string(),
    conversations_deleted: z
      .number()
      .int()
      .describe('Conversations destroyed by the cascade. Zero when the folder was already empty.'),
  }),
  handle: async params => {
    await getFolder(params.project_id);
    const members = await listFolderChats(params.project_id);
    if (members.length > 0 && params.delete_conversations !== true)
      throw ToolError.validation(
        `Folder ${params.project_id} still holds ${members.length} conversation(s), and z.ai deletes them along with the folder. ` +
          'Move them out with move_conversation_to_project / remove_conversation_from_project, or pass delete_conversations: true to destroy them.',
      );
    await deleteFolder(params.project_id);
    return { deleted: true, project_id: params.project_id, conversations_deleted: members.length };
  },
});

export const addConversationToProject = defineTool({
  name: 'add_conversation_to_project',
  displayName: 'Add Conversation To Project',
  description:
    'Put a conversation into a folder via POST /api/v1/chats/<id>/folder. A chat belongs to at most one folder, so this replaces any previous membership.',
  summary: 'Add a conversation to a folder',
  icon: 'folder-input',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().describe('Chat UUID.'),
    project_id: z.string().describe('Folder id from list_projects.'),
  }),
  output: conversationListItemSchema,
  handle: async params => {
    await getFolder(params.project_id);
    await getConversationDetail(params.conversation_id);
    await setConversationFolder(params.conversation_id, params.project_id);
    return mapConversationDetail(await getConversationDetail(params.conversation_id));
  },
});

export const removeConversationFromProject = defineTool({
  name: 'remove_conversation_from_project',
  displayName: 'Remove Conversation From Project',
  description:
    'Take a conversation out of its folder (folder_id: null). project_id is optional and only used as a guard: when given and the conversation is in a different folder, the call fails instead of silently detaching it.',
  summary: 'Remove a conversation from its folder',
  icon: 'folder-minus',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().describe('Chat UUID.'),
    project_id: z.string().optional().describe('Folder the conversation is expected to be in.'),
  }),
  output: conversationListItemSchema,
  handle: async params => {
    const before = await getConversationDetail(params.conversation_id);
    if (params.project_id && (before.folder_id ?? null) !== params.project_id)
      throw ToolError.validation(
        `Conversation ${params.conversation_id} is in folder ${before.folder_id ?? '(none)'}, not ${params.project_id}.`,
      );
    await setConversationFolder(params.conversation_id, null);
    return mapConversationDetail(await getConversationDetail(params.conversation_id));
  },
});

export const moveConversationToProject = defineTool({
  name: 'move_conversation_to_project',
  displayName: 'Move Conversation To Project',
  description:
    'Move a conversation from one folder to another and verify both sides afterwards: the target folder must list it and the source folder must not. A membership that did not actually change raises UPSTREAM_ERROR rather than reporting success.',
  summary: 'Move a conversation between folders',
  icon: 'folder-symlink',
  group: 'Projects',
  input: z.object({
    conversation_id: z.string().describe('Chat UUID.'),
    to_project_id: z.string().describe('Destination folder id.'),
    from_project_id: z.string().optional().describe('Folder the conversation is expected to be in before the move.'),
  }),
  output: z.object({
    conversation: conversationListItemSchema,
    from_project_id: z.string().nullable(),
    to_project_id: z.string(),
    verified: z.object({
      target_contains: z.boolean().describe('Re-read of the destination folder lists this conversation.'),
      source_contains: z.boolean().describe('Re-read of the source folder still lists it — must be false.'),
    }),
  }),
  handle: async params => {
    await getFolder(params.to_project_id);
    const before = await getConversationDetail(params.conversation_id);
    const source = before.folder_id ?? null;
    if (params.from_project_id && source !== params.from_project_id)
      throw ToolError.validation(
        `Conversation ${params.conversation_id} is in folder ${source ?? '(none)'}, not ${params.from_project_id}.`,
      );

    // Moving into the folder it already occupies is a no-op, and the both-sides check
    // below would read it as a failed move (source and target are the same folder, so
    // both "contain" it). Verify and return instead of raising a retryable error that
    // could never succeed on retry — add_conversation_to_project is idempotent here too.
    if (source === params.to_project_id) {
      const members = (await listFolderChats(params.to_project_id)).map(chat => chat.id);
      const present = members.includes(params.conversation_id);
      if (!present)
        throw new ToolError(
          `Conversation ${params.conversation_id} reports folder ${source} but that folder does not list it.`,
          'UPSTREAM_ERROR',
          { category: 'internal', retryable: false },
        );
      return {
        conversation: mapConversationDetail(before),
        from_project_id: source,
        to_project_id: params.to_project_id,
        verified: { target_contains: true, source_contains: false },
      };
    }

    await setConversationFolder(params.conversation_id, params.to_project_id);

    const targetIds = (await listFolderChats(params.to_project_id)).map(chat => chat.id);
    const sourceIds = source ? (await listFolderChats(source)).map(chat => chat.id) : [];
    const targetContains = targetIds.includes(params.conversation_id);
    const sourceContains = sourceIds.includes(params.conversation_id);
    if (!targetContains || sourceContains)
      throw new ToolError(
        `z.ai accepted the move but membership did not change as expected (target_contains=${targetContains}, source_contains=${sourceContains}).`,
        'UPSTREAM_ERROR',
        // Retrying cannot fix a membership that upstream refused to change.
        { category: 'internal', retryable: false },
      );

    return {
      conversation: mapConversationDetail(await getConversationDetail(params.conversation_id)),
      from_project_id: source,
      to_project_id: params.to_project_id,
      verified: { target_contains: targetContains, source_contains: sourceContains },
    };
  },
});
