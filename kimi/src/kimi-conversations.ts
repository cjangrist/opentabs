import { ToolError } from '@opentabs-dev/plugin-sdk';
import { callRpc, conversationUrl, toUnixSeconds } from './kimi-api.js';
import type { RawMessage } from './kimi-messages.js';
import type { TokenPage } from './kimi-pagination.js';
import type { ConversationListItem } from './tools/normalized-schemas.js';

// --- Raw shapes ---

export interface RawChat {
  id?: string;
  name?: string;
  projectId?: string;
  createTime?: string;
  updateTime?: string;
  /** STATUS_GENERATING while a turn is running, STATUS_COMPLETED once it lands. */
  status?: string;
  statusText?: string;
  messageContent?: string;
  kimiPlus?: { id?: string; name?: string };
  lastRequest?: {
    scenario?: string;
    options?: { thinking?: boolean; reasoningEffort?: string; contextLength?: string };
    tools?: { type?: string }[];
  };
}

interface FeedItem {
  type?: string;
  chat?: RawChat;
}

interface ListFeedsResponse {
  items?: FeedItem[];
  nextPageToken?: string;
}

interface ListChatsResponse {
  chats?: RawChat[];
  nextPageToken?: string;
}

interface GetChatResponse {
  chat?: RawChat;
}

interface ListMessagesResponse {
  messages?: RawMessage[];
  nextPageToken?: string;
}

// --- Mapping ---

/**
 * Kimi has neither an archive nor a star concept for chats — the row menu offers
 * Delete only, and the chat payload carries no such flag — so both are always
 * false (SPEC §2 requires the keys to be present regardless).
 *
 * `model_id` is read from the chat's own `lastRequest.scenario`, which is the
 * scenario enum rather than a picker id; it is resolved to a picker id by the
 * caller when a model catalog is available.
 */
export const mapChatRow = (chat: RawChat, scenarioToModelId: Map<string, string>): ConversationListItem => ({
  id: chat.id ?? '',
  title: chat.name ?? '',
  url: conversationUrl(chat.id ?? ''),
  created_at: toUnixSeconds(chat.createTime),
  updated_at: toUnixSeconds(chat.updateTime),
  project_id: chat.projectId || null,
  model_id: (chat.lastRequest?.scenario && scenarioToModelId.get(chat.lastRequest.scenario)) || null,
  is_archived: false,
  is_starred: false,
});

// --- Listing ---

/**
 * `FeedService/ListFeeds` is the endpoint the kimi.com sidebar itself drives. It
 * honours `pageSize` exactly and returns an opaque `nextPageToken`, and unlike
 * the rendered sidebar it also surfaces chats that live inside a project (with
 * `projectId` set), so this is the complete conversation list.
 */
export const fetchConversationsPage = async (
  pageToken: string | undefined,
  pageSize: number,
): Promise<TokenPage<RawChat>> => {
  const body: Record<string, unknown> = { pageSize };
  if (pageToken) body.pageToken = pageToken;
  const page = await callRpc<ListFeedsResponse>('kimi.gateway.feed.v1.FeedService/ListFeeds', body);
  return {
    rows: (page.items ?? [])
      .filter(item => item.type === 'FEED_TYPE_CHAT' && item.chat?.id)
      .map(item => item.chat as RawChat),
    nextPageToken: page.nextPageToken || null,
    // ListFeeds publishes no count of any kind.
    total: null,
  };
};

/**
 * `ChatService/ListChats` with a `query` is the sidebar's search box. It filters
 * genuinely (a nonsense term returns `{}`) and wraps matches in `<em>` tags.
 *
 * `FeedService/ListFeeds` also ACCEPTS a `query` and silently ignores it —
 * it re-ranks but still returns every chat — so search must never be routed
 * through the feed endpoint.
 */
export const fetchSearchPage = async (
  query: string,
  pageToken: string | undefined,
  pageSize: number,
): Promise<TokenPage<RawChat>> => {
  const body: Record<string, unknown> = { query, pageSize };
  if (pageToken) body.pageToken = pageToken;
  const page = await callRpc<ListChatsResponse>('kimi.gateway.chat.v1.ChatService/ListChats', body);
  return { rows: page.chats ?? [], nextPageToken: page.nextPageToken || null, total: null };
};

export const fetchProjectChatsPage = async (
  projectId: string,
  pageToken: string | undefined,
  pageSize: number,
): Promise<TokenPage<RawChat>> => {
  const body: Record<string, unknown> = { projectId, pageSize };
  if (pageToken) body.pageToken = pageToken;
  const page = await callRpc<ListChatsResponse>('kimi.gateway.chat.v1.ChatService/ListChats', body);
  return { rows: page.chats ?? [], nextPageToken: page.nextPageToken || null, total: null };
};

/** Strips the `<em>` highlight tags `ListChats(query)` wraps matches in. */
export const stripHighlight = (value: string | undefined): string => (value ?? '').replace(/<\/?em>/g, '');

// --- Detail ---

export const getChat = async (conversationId: string): Promise<RawChat> => {
  const data = await callRpc<GetChatResponse>('kimi.gateway.chat.v1.ChatService/GetChat', { chatId: conversationId });
  if (!data.chat?.id) throw ToolError.notFound(`Kimi conversation ${conversationId} was not found.`);
  return data.chat;
};

const MESSAGE_PAGE_SIZE = 100;
const MESSAGE_WALK_LIMIT = 50;

/**
 * Reads a whole conversation, oldest-first.
 *
 * `ListMessages` returns messages newest-first, both within a page and across
 * pages — a page's `nextPageToken` points strictly further back in time — so
 * pages are concatenated in fetch order and reversed exactly once at the end,
 * never per page.
 *
 * A Kimi conversation is a handful of messages carrying dozens of blocks each
 * (one real chat here holds 3 messages and 106 blocks), which is why pagination
 * is applied to the normalized §3 items rather than to messages: paging by
 * message would hand back one enormous page and then nothing.
 */
export const getConversationMessages = async (conversationId: string): Promise<RawMessage[]> => {
  const newestFirst: RawMessage[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MESSAGE_WALK_LIMIT; page += 1) {
    const body: Record<string, unknown> = { chatId: conversationId, pageSize: MESSAGE_PAGE_SIZE };
    if (pageToken) body.pageToken = pageToken;
    const data = await callRpc<ListMessagesResponse>('kimi.gateway.chat.v1.ChatService/ListMessages', body);
    newestFirst.push(...(data.messages ?? []));
    pageToken = data.nextPageToken || undefined;
    if (!pageToken) break;
  }

  return newestFirst.reverse();
};

/**
 * Returns the id of the newest message in a chat. The Chat RPC threads replies
 * by parent id, so a follow-up must point at the current tip of the thread.
 */
export const getLatestMessageId = async (conversationId: string): Promise<string> => {
  const data = await callRpc<ListMessagesResponse>('kimi.gateway.chat.v1.ChatService/ListMessages', {
    chatId: conversationId,
    pageSize: 1,
  });
  return data.messages?.[0]?.id ?? '';
};

// --- Mutations ---

/**
 * `UpdateChat` replaces the chat message wholesale — it takes NO update_mask, so
 * a rename must carry every field the caller wants to keep. Verified live:
 * sending `{chat:{id}}` alone clears the chat's name.
 *
 * It also accepts `projectId` and silently ignores it (HTTP 200, membership
 * unchanged), which is why project membership is create-time only.
 */
export const renameChat = async (conversationId: string, title: string): Promise<RawChat> => {
  const data = await callRpc<{ chat?: RawChat }>('kimi.gateway.chat.v1.ChatService/UpdateChat', {
    chat: { id: conversationId, name: title },
  });
  if (!data.chat?.id)
    throw new ToolError('Kimi accepted the rename but returned no chat.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return data.chat;
};

export const deleteChat = async (conversationId: string): Promise<void> => {
  await callRpc('kimi.gateway.chat.v1.ChatService/DeleteChat', { chatId: conversationId });
};

/** Conversation-level reasoning effort, as Kimi recorded it on the last request. */
export const chatEffort = (chat: RawChat): string | null => chat.lastRequest?.options?.reasoningEffort ?? null;
