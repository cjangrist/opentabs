import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api, conversationUrl } from './zai-api.js';
import { UPSTREAM_PAGE_SIZE } from './zai-pagination.js';
import type { ConversationListItem } from './tools/normalized-schemas.js';

// --- Raw chat.z.ai shapes ---

/** Row shape of every list endpoint. Deliberately thin — see `ListEnrichment`. */
export interface RawChatRow {
  id?: string;
  title?: string;
  created_at?: number;
  updated_at?: number;
  type?: string;
  im_context?: unknown;
}

export interface RawHistoryMessage {
  id?: string;
  parentId?: string | null;
  childrenIds?: string[];
  role?: string;
  content?: string;
  timestamp?: number;
  models?: string[];
  files?: unknown[];
}

export interface RawChatBlob {
  id?: string;
  title?: string;
  models?: string[];
  params?: Record<string, unknown>;
  history?: { messages?: Record<string, RawHistoryMessage>; currentId?: string };
  tags?: unknown[];
  features?: { type?: string; server?: string; status?: string }[];
  mcp_servers?: string[];
  enable_thinking?: boolean;
  reasoning_effort?: string;
  auto_web_search?: boolean;
  timestamp?: number;
  extra?: Record<string, unknown>;
}

export interface RawChatDetail {
  id?: string;
  user_id?: string;
  title?: string;
  chat?: RawChatBlob;
  created_at?: number;
  updated_at?: number;
  share_id?: string | null;
  archived?: boolean;
  pinned?: boolean;
  meta?: { models?: string[]; mcp_servers?: string[]; auto_web_search?: boolean };
  folder_id?: string | null;
  message_version?: number;
  type?: string;
}

// --- Listing ---

const CHATS_PATH = '/v1/chats/';

/**
 * The row endpoint the z.ai sidebar itself drives. `type=default` is what the app
 * sends; it is deliberately omitted here so agent-mode chats are listed too.
 */
export const fetchConversationPage = async (page: number): Promise<RawChatRow[]> => {
  const rows = await api<RawChatRow[]>(CHATS_PATH, { query: { page } });
  if (!Array.isArray(rows))
    throw new ToolError(
      `z.ai returned a non-array chat list for page ${page}. The /api/v1/chats/ shape may have changed.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  return rows;
};

/**
 * The list rows carry only id/title/timestamps — folder membership, pin and archive
 * flags live only on the full chat object. Rather than fetch every chat (megabytes),
 * the three small collection endpoints are read once per call and turned into
 * lookups.
 */
export interface ListEnrichment {
  folderByChat: Map<string, string>;
  pinned: Set<string>;
  archived: Set<string>;
}

const idsOf = (rows: RawChatRow[] | RawChatDetail[] | undefined): string[] =>
  Array.isArray(rows) ? rows.map(row => row.id ?? '').filter(Boolean) : [];

/**
 * Reads a whole collection endpoint. `/chats/pinned` and `/chats/archived` serve the
 * same fixed 60-row pages as the main list, so taking only the first page would
 * quietly mark row 61 onwards as neither pinned nor archived. The walk stops on a
 * short page, and also on a page whose ids were all seen before — some of these
 * endpoints ignore `page` entirely, and that must not become an infinite loop.
 */
const MAX_ENRICHMENT_PAGES = 25;

const collectAllRows = async (path: string): Promise<string[]> => {
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_ENRICHMENT_PAGES; page += 1) {
    const rows = await api<RawChatRow[]>(path, { query: { page } });
    const ids = idsOf(rows);
    const fresh = ids.filter(id => !seen.has(id));
    for (const id of fresh) seen.add(id);
    if (ids.length === 0 || fresh.length === 0 || ids.length < UPSTREAM_PAGE_SIZE) break;
  }
  return [...seen];
};

export const buildListEnrichment = async (): Promise<ListEnrichment> => {
  const folders = await api<RawFolder[]>('/v1/folders/');
  const folderByChat = new Map<string, string>();
  for (const folder of Array.isArray(folders) ? folders : []) {
    if (!folder.id) continue;
    const members = await api<RawChatDetail[]>(`/v1/chats/folder/${encodeURIComponent(folder.id)}`);
    for (const chatId of idsOf(members)) folderByChat.set(chatId, folder.id);
  }
  const [pinned, archived] = await Promise.all([
    collectAllRows('/v1/chats/pinned'),
    collectAllRows('/v1/chats/archived'),
  ]);
  return { folderByChat, pinned: new Set(pinned), archived: new Set(archived) };
};

export const mapConversationRow =
  (enrichment: ListEnrichment) =>
  (row: RawChatRow): ConversationListItem => {
    const id = row.id ?? '';
    return {
      id,
      title: row.title ?? '',
      url: conversationUrl(id),
      created_at: row.created_at ?? 0,
      updated_at: row.updated_at ?? 0,
      project_id: enrichment.folderByChat.get(id) ?? null,
      // The row endpoint never reports which model answered; only the full chat does.
      model_id: null,
      is_archived: enrichment.archived.has(id),
      is_starred: enrichment.pinned.has(id),
    };
  };

/** Maps a full chat object, where every field is present without enrichment. */
export const mapConversationDetail = (detail: RawChatDetail): ConversationListItem => {
  const id = detail.id ?? '';
  return {
    id,
    title: detail.title ?? '',
    url: conversationUrl(id),
    created_at: detail.created_at ?? 0,
    updated_at: detail.updated_at ?? 0,
    project_id: detail.folder_id ?? null,
    model_id: detail.chat?.models?.[0] ?? detail.meta?.models?.[0] ?? null,
    is_archived: detail.archived ?? false,
    is_starred: detail.pinned ?? false,
  };
};

// --- Detail + mutations ---

export const getConversationDetail = async (conversationId: string): Promise<RawChatDetail> => {
  const detail = await api<RawChatDetail>(`/v1/chats/${encodeURIComponent(conversationId)}`);
  if (!detail?.id)
    throw ToolError.notFound(`z.ai has no conversation ${conversationId} (or it belongs to another account).`);
  return detail;
};

export const searchConversationPage = async (query: string, page: number): Promise<RawChatRow[]> => {
  const rows = await api<RawChatRow[]>('/v1/chats/search', { query: { text: query, page } });
  return Array.isArray(rows) ? rows : [];
};

/**
 * z.ai merges the posted `chat` blob over the stored one, so sending only `title`
 * preserves the message history. The blob is still read back first and re-sent
 * whole: a merge that ever became a replace would otherwise erase the conversation.
 */
export const renameConversationById = async (conversationId: string, title: string): Promise<RawChatDetail> => {
  const detail = await getConversationDetail(conversationId);
  return api<RawChatDetail>(`/v1/chats/${encodeURIComponent(conversationId)}`, {
    method: 'POST',
    body: { chat: { ...(detail.chat ?? {}), title } },
  });
};

export const deleteConversationById = async (conversationId: string): Promise<void> => {
  await api<unknown>(`/v1/chats/${encodeURIComponent(conversationId)}`, { method: 'DELETE' });
};

/** `/archive` and `/pin` are toggles, so the desired state is compared first. */
export const setConversationArchived = async (conversationId: string, archived: boolean): Promise<RawChatDetail> => {
  const detail = await getConversationDetail(conversationId);
  if ((detail.archived ?? false) === archived) return detail;
  return api<RawChatDetail>(`/v1/chats/${encodeURIComponent(conversationId)}/archive`, { method: 'POST' });
};

export const setConversationFolder = async (conversationId: string, folderId: string | null): Promise<RawChatDetail> =>
  api<RawChatDetail>(`/v1/chats/${encodeURIComponent(conversationId)}/folder`, {
    method: 'POST',
    body: { folder_id: folderId },
  });

// --- Folders (SPEC §5 projects) ---

export interface RawFolder {
  id?: string;
  parent_id?: string | null;
  user_id?: string;
  name?: string;
  items?: { chats?: unknown[] };
  meta?: Record<string, unknown> | null;
  is_expanded?: boolean;
  created_at?: number;
  updated_at?: number;
}
