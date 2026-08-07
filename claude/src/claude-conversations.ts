import { ToolError } from '@opentabs-dev/plugin-sdk';
import { orgApi, toUnixSeconds } from './claude-api.js';
import type { RawConversationDetail } from './claude-messages.js';
import type { ThinkingSelection } from './claude-models.js';
import { conversationUrl } from './claude-api.js';
import type { ConversationListItem } from './tools/normalized-schemas.js';

// --- List rows ---

export interface RawConversationRow {
  uuid?: string;
  name?: string;
  summary?: string;
  model?: string;
  created_at?: string;
  updated_at?: string;
  is_starred?: boolean;
  project_uuid?: string | null;
}

/**
 * claude.ai has no archive action for conversations — the row menu offers only
 * Pin / Mark as unread / Rename / Add to project / Delete — so is_archived is
 * always false. Projects, unlike conversations, do have archived_at.
 */
export const mapConversationRow = (row: RawConversationRow): ConversationListItem => ({
  id: row.uuid ?? '',
  title: row.name ?? '',
  url: conversationUrl(row.uuid ?? ''),
  created_at: toUnixSeconds(row.created_at),
  updated_at: toUnixSeconds(row.updated_at),
  project_id: row.project_uuid ?? null,
  model_id: row.model || null,
  is_archived: false,
  is_starred: row.is_starred ?? false,
});

interface ConversationsV2Response {
  data?: RawConversationRow[];
  has_more?: boolean;
}

/**
 * `/chat_conversations_v2` is the endpoint claude.ai's own sidebar drives. It takes
 * `limit` + `offset` and returns `{data, has_more}` — no total, which is why
 * list_conversations reports `total: null`.
 */
export const fetchConversationsPage = async (
  offset: number,
  limit: number,
): Promise<{ rows: RawConversationRow[]; hasMore: boolean; total: number | null }> => {
  const page = await orgApi<ConversationsV2Response>('/chat_conversations_v2', {
    query: { limit, offset, consistency: 'eventual' },
  });
  return { rows: page.data ?? [], hasMore: page.has_more === true, total: null };
};

// --- Detail ---

/**
 * `render_all_tools=true` is not optional. Without it claude.ai flattens every
 * tool_use block into a text block reading "This block is not supported on your
 * current device yet." — 21 of them in one real assistant turn — which lands
 * straight in the assistant's message text. `consistency=strong` makes the read
 * see a write we just issued.
 */
export const getConversationDetail = async (conversationId: string): Promise<RawConversationDetail> => {
  const detail = await orgApi<RawConversationDetail>(`/chat_conversations/${conversationId}`, {
    query: { tree: 'True', rendering_mode: 'messages', render_all_tools: 'true', consistency: 'strong' },
  });
  if (!detail?.uuid) throw ToolError.notFound(`Conversation ${conversationId} was not found.`);
  return detail;
};

export const conversationEffort = (detail: RawConversationDetail): string | null => {
  const value = detail.settings?.effort_level;
  return typeof value === 'string' ? value : null;
};

// --- Completion bodies ---

/**
 * The three built-in tools claude.ai always declares. The web app additionally
 * sends every connected MCP connector and UI widget; we deliberately do not, so a
 * tool call issued through this plugin can never reach the user's private
 * connectors. `web_search` is dropped when `search: false`.
 */
const builtinTools = (search: boolean): { type: string; name: string }[] => [
  ...(search ? [{ type: 'web_search_v0', name: 'web_search' }] : []),
  { type: 'artifacts_v0', name: 'artifacts' },
  { type: 'repl_v0', name: 'repl' },
];

export interface CompletionBodyOptions {
  prompt: string;
  model: string;
  thinking: ThinkingSelection;
  search: boolean;
  research: boolean;
  parentMessageUuid?: string;
  isNewConversation: boolean;
}

export const buildCompletionBody = (options: CompletionBodyOptions): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    prompt: options.prompt,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: 'en-US',
    model: options.model,
    tools: builtinTools(options.search),
    attachments: [],
    files: [],
    sync_sources: [],
    rendering_mode: 'messages',
  };
  if (options.parentMessageUuid) body.parent_message_uuid = options.parentMessageUuid;
  if (options.thinking.thinking_mode !== undefined) body.thinking_mode = options.thinking.thinking_mode;
  if (options.thinking.effort !== undefined) body.effort = options.thinking.effort;
  if (options.isNewConversation) {
    // Posting a completion to a fresh uuid with create_conversation_params is how
    // claude.ai itself creates a conversation — one request, not two.
    body.create_conversation_params = {
      name: '',
      model: options.model,
      include_conversation_preferences: true,
      paprika_mode: null,
      compass_mode: options.research ? 'advanced' : null,
      tool_search_mode: 'off',
      is_temporary: false,
      enabled_imagine: true,
    };
  }
  return body;
};

/**
 * claude.ai names a new conversation with a separate call right after the first
 * completion. Without it the conversation stays `name: ""` and the sidebar shows
 * "Untitled", so a conversation created through this plugin would look different
 * from one created in the UI. Fire-and-forget: a missing title is cosmetic and
 * must not consume the tool's time budget.
 */
export const requestGeneratedTitle = (conversationId: string, firstMessage: string): void => {
  void orgApi(`/chat_conversations/${conversationId}/title`, {
    method: 'POST',
    body: { message_content: firstMessage, recent_titles: [] },
  }).catch(() => {
    // Title generation is best-effort; rename_conversation is always available.
  });
};

/**
 * Research and web search are conversation settings, not completion fields, once
 * the conversation exists. This is exactly the PUT the composer's Research toggle
 * issues: `{"settings":{"compass_mode":"advanced"}}`.
 */
export const applyConversationSettings = async (
  conversationId: string,
  settings: Record<string, unknown>,
): Promise<void> => {
  if (Object.keys(settings).length === 0) return;
  await orgApi(`/chat_conversations/${conversationId}`, {
    method: 'PUT',
    query: { rendering_mode: 'raw' },
    body: { settings },
  });
};

// --- Project membership ---

interface MoveManyResponse {
  moved?: string[];
  failed?: { conversation_uuid?: string; error?: string }[] | string[];
}

/**
 * `move_many` is claude.ai's single membership primitive: it adds, moves and (with
 * project_uuid: null) removes. `PUT /chat_conversations/<id> {project_uuid: null}`
 * is rejected with "must update at least one field", so there is no other path.
 *
 * It answers HTTP 200 with `{moved, failed}` — a partial failure is invisible in
 * the status code, so `failed` must be inspected (SPEC §0).
 */
export const moveConversations = async (conversationIds: string[], projectId: string | null): Promise<void> => {
  // An empty string is not "no project": claude.ai treats it as a removal, which
  // silently unfiles the conversation while the caller believes the move failed.
  if (projectId === '')
    throw ToolError.validation('project_id must be a project UUID or null — "" is not a valid target.');
  if (conversationIds.some(id => !id)) throw ToolError.validation('conversation_id must be a conversation UUID.');

  const result = await orgApi<MoveManyResponse>('/chat_conversations/move_many', {
    method: 'POST',
    body: { conversation_uuids: conversationIds, project_uuid: projectId },
  });
  const failed = result?.failed ?? [];
  if (failed.length > 0)
    throw new ToolError(
      `Claude refused to move ${failed.length} conversation(s): ${JSON.stringify(failed).slice(0, 300)}`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  const moved = result?.moved ?? [];
  if (moved.length !== conversationIds.length)
    throw new ToolError(
      `Claude moved ${moved.length} of ${conversationIds.length} conversation(s) and reported no failures — the move_many response shape may have changed.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
};
