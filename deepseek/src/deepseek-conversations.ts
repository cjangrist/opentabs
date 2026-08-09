import { ToolError } from '@opentabs-dev/plugin-sdk';
import { conversationUrl, getApi, postApi, toUnixSeconds } from './deepseek-api.js';
import type { RawChatMessage, RawChatSession } from './deepseek-messages.js';
import type { KeysetPage, KeysetPosition } from './deepseek-pagination.js';
import type { ConversationListItem } from './tools/normalized-schemas.js';

export interface SessionRow {
  id: string;
  pinned: boolean;
  updatedAt: number;
  title: string;
  modelType: string;
}

interface FetchPageResponse {
  chat_sessions?: RawChatSession[];
  has_more?: boolean;
}

const toSessionRow = (session: RawChatSession): SessionRow => ({
  id: session.id ?? '',
  pinned: session.pinned === true,
  updatedAt: session.updated_at ?? 0,
  title: session.title ?? '',
  modelType: session.model_type ?? '',
});

/**
 * One page of `GET /chat_session/fetch_page`, the endpoint the sidebar itself
 * drives. The cursor is a keyset over `(pinned, updated_at)`, which is why the
 * position rather than a token is passed in.
 */
export const fetchConversationsPage = async (
  position: KeysetPosition | undefined,
  count: number,
): Promise<KeysetPage<SessionRow>> => {
  const query =
    position === undefined
      ? `count=${count}`
      : `count=${count}&lte_cursor.pinned=${position.pinned}&lte_cursor.updated_at=${position.updatedAt}`;

  const page = await getApi<FetchPageResponse>(`/chat_session/fetch_page?${query}`);
  return {
    rows: (page.chat_sessions ?? []).filter(session => Boolean(session.id)).map(toSessionRow),
    exhausted: page.has_more !== true,
  };
};

export const mapSessionRow = (row: SessionRow): ConversationListItem => ({
  id: row.id,
  title: row.title,
  url: conversationUrl(row.id),
  // fetch_page carries no creation time — only updated_at. get_conversation
  // resolves the real one from history_messages' chat_session.inserted_at.
  created_at: 0,
  updated_at: toUnixSeconds(row.updatedAt),
  // DeepSeek has no projects, folders or spaces of any kind.
  project_id: null,
  model_id: row.modelType || null,
  // DeepSeek has no archive concept; pinning is the only per-chat flag.
  is_archived: false,
  is_starred: row.pinned,
});

// --- Conversation detail ---

interface HistoryMessagesResponse {
  chat_session?: RawChatSession;
  chat_messages?: RawChatMessage[];
  cache_control?: string;
}

export interface ConversationHistory {
  session: RawChatSession;
  messages: RawChatMessage[];
}

/**
 * Reads a conversation's full message tree.
 *
 * `GET /chat/history_messages` has NO server-side paging parameter — verified
 * live: `limit`, `count` and `page_size` are all ignored and return the
 * byte-identical body. The SPA's own `cache_version` / `cache_reset_at` query
 * fields are deliberately omitted so the response is always a complete
 * `cache_control: "REPLACE"` payload rather than an incremental delta.
 */
export const getConversationHistory = async (conversationId: string): Promise<ConversationHistory> => {
  const history = await getApi<HistoryMessagesResponse | null>(
    `/chat/history_messages?chat_session_id=${encodeURIComponent(conversationId)}`,
    { allowNullData: true },
  );
  if (!history?.chat_session?.id)
    throw ToolError.notFound(`DeepSeek has no conversation with id "${conversationId}".`, 'NOT_FOUND');
  return { session: history.chat_session, messages: history.chat_messages ?? [] };
};

/** The id a follow-up must thread onto: the live leaf of the message tree. */
export const latestMessageId = (history: ConversationHistory): number | null => {
  const current = history.session.current_message_id;
  if (typeof current === 'number') return current;
  const ids = history.messages.map(message => message.message_id).filter((id): id is number => typeof id === 'number');
  return ids.length > 0 ? Math.max(...ids) : null;
};

// --- Mutations ---

interface CreateSessionResponse {
  chat_session?: { id?: string };
}

export const createChatSession = async (): Promise<string> => {
  const created = await postApi<CreateSessionResponse>('/chat_session/create', { agent: 'chat' });
  const id = created.chat_session?.id;
  if (!id)
    throw new ToolError('DeepSeek did not return a new chat session id.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return id;
};

interface UpdateTitleResponse {
  title?: string;
  chat_session_updated_at?: number;
}

export const renameChatSession = async (conversationId: string, title: string): Promise<string> => {
  const updated = await postApi<UpdateTitleResponse>('/chat_session/update_title', {
    chat_session_id: conversationId,
    title,
  });
  return updated.title ?? title;
};

export const deleteChatSession = async (conversationId: string): Promise<void> => {
  await postApi<unknown>('/chat_session/delete', { chat_session_id: conversationId }, { allowNullData: true });
};

export const setChatSessionPinned = async (conversationId: string, pinned: boolean): Promise<void> => {
  await postApi<unknown>(
    '/chat_session/update_pinned',
    { chat_session_id: conversationId, pinned },
    { allowNullData: true },
  );
};
