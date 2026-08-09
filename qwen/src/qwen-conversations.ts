import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api, conversationUrl, requireArray } from './qwen-api.js';
import type { ConversationListItem } from './tools/normalized-schemas.js';

// --- Raw chat.qwen.ai shapes ---

/** Row shape of every list endpoint. Deliberately thin — see `enrichConversationRows`. */
export interface RawChatRow {
  id?: string;
  title?: string | null;
  created_at?: number;
  updated_at?: number;
  chat_type?: string;
  project_id?: string | null;
  pinned?: boolean;
}

export interface RawSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  hostname?: string;
  website?: string;
  /** Deep-research references use these names instead. */
  description?: string;
  index_number?: number;
}

export interface RawPartExtra {
  web_search_info?: RawSearchResult[];
  summary_title?: { content?: string[] };
  summary_thought?: { content?: string[] };
  deep_research?: unknown;
}

export interface RawContentPart {
  content?: unknown;
  phase?: string;
  status?: string;
  extra?: RawPartExtra;
  timestamp?: number;
}

export interface RawMessage {
  id?: string;
  role?: string;
  content?: string;
  parentId?: string | null;
  childrenIds?: string[];
  model?: string;
  models?: string[];
  modelName?: string;
  content_list?: RawContentPart[];
  chat_type?: string;
  sub_chat_type?: string;
  feature_config?: {
    thinking_enabled?: boolean;
    thinking_mode?: string;
    auto_thinking?: boolean;
    research_mode?: string;
  };
  files?: { name?: string; type?: string; size?: number }[];
  status?: string;
  done?: boolean;
  /** Qwen's own flag for a turn ended by the stop button (or by cancel_deep_research). */
  is_stop?: boolean;
  timestamp?: number;
  extra?: Record<string, unknown>;
}

export interface RawChatDetail {
  id?: string;
  user_id?: string;
  title?: string;
  chat?: {
    models?: string[];
    messages?: RawMessage[];
    history?: { messages?: Record<string, RawMessage>; currentId?: string; currentResponseIds?: string[] };
  };
  created_at?: number;
  updated_at?: number;
  archived?: boolean;
  pinned?: boolean;
  chat_type?: string;
  models?: string[] | null;
  project_id?: string | null;
  folder_id?: string | null;
  currentId?: string;
  /** Assistant message ids of the newest turn; the web app stops exactly these. */
  currentResponseIds?: string[];
}

// --- Listing ---

const CHATS_PATH = '/v2/chats/';

/**
 * The row endpoint the Qwen sidebar drives.
 *
 * The web app sends `exclude_project=true`, but that parameter is a decoration:
 * probed live against a chat known to be in a project, the endpoint returned the
 * SAME 79 rows and omitted that chat at `exclude_project=true`, `=false` and with
 * the parameter absent entirely. Project chats are simply never in this list — the
 * only way to reach them is `project_id=<id>`, which `fetchProjectConversationPage`
 * uses. Sending the parameter here would therefore imply a control that does not
 * exist, so it is omitted and the limitation is documented on the tool instead.
 */
export const fetchConversationPage = async (page: number): Promise<RawChatRow[]> =>
  requireArray(await api<RawChatRow[]>(CHATS_PATH, { query: { page } }), `${CHATS_PATH}?page=${page}`);

export const searchConversationPage = async (query: string, page: number): Promise<RawChatRow[]> =>
  requireArray(await api<RawChatRow[]>('/v2/chats/search', { query: { text: query, page } }), '/v2/chats/search');

export const fetchProjectConversationPage = async (projectId: string, page: number): Promise<RawChatRow[]> =>
  requireArray(
    await api<RawChatRow[]>(CHATS_PATH, { query: { project_id: projectId, page } }),
    `${CHATS_PATH}?project_id=…`,
  );

/**
 * Counts a project's conversations by walking every page of its chat list.
 *
 * Qwen publishes no count anywhere, so this is the only honest way to answer
 * `conversation_count`. The walk stops on an empty page or on one whose ids were all
 * seen before, and is capped so an endpoint that ignored `page` could never spin.
 */
const MAX_COUNT_PAGES = 50;

export const countProjectConversations = async (projectId: string): Promise<number> => {
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_COUNT_PAGES; page += 1) {
    const rows = await fetchProjectConversationPage(projectId, page);
    const fresh = rows.filter(row => row.id && !seen.has(row.id));
    for (const row of fresh) seen.add(row.id ?? '');
    if (rows.length === 0 || fresh.length === 0) break;
  }
  return seen.size;
};

/**
 * The list rows carry a `pinned` flag but no archive flag, and archived chats are
 * absent from the main list entirely — they live behind `/v2/chats/archived`. That
 * endpoint is read once per call so `is_archived` is answered from data rather than
 * hardcoded false.
 */
export const fetchArchivedIds = async (): Promise<Set<string>> => {
  const rows = requireArray(await api<RawChatRow[]>('/v2/chats/archived'), '/v2/chats/archived');
  return new Set(rows.map(row => row.id ?? '').filter(Boolean));
};

export const mapConversationRow =
  (archived: Set<string>) =>
  (row: RawChatRow): ConversationListItem => {
    const id = row.id ?? '';
    return {
      id,
      title: row.title ?? '',
      url: conversationUrl(id),
      created_at: row.created_at ?? 0,
      updated_at: row.updated_at ?? 0,
      // `|| null`, not `?? null`: Qwen represents "no project" as the EMPTY STRING,
      // not as null — verified live, a chat removed from a project comes back with
      // `project_id: ""` — and SPEC §0 requires absent to be null, never "".
      project_id: row.project_id || null,
      // The row endpoint never reports which model answered; only the full chat does.
      model_id: null,
      is_archived: archived.has(id),
      is_starred: row.pinned === true,
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
    // See mapConversationRow: "no project" is the empty string on Qwen, not null.
    project_id: detail.project_id || null,
    model_id: detail.chat?.models?.[0] || detail.models?.[0] || null,
    is_archived: detail.archived === true,
    is_starred: detail.pinned === true,
  };
};

// --- Detail + mutations ---

/**
 * Reads one chat in full.
 *
 * `limit`, `cursor` and `direction` are accepted by this endpoint and silently
 * ignored (asking for 2 messages of an 8-message chat returns all 8, verified live),
 * so the whole message tree always arrives in one response and SPEC §1 pagination is
 * applied over the normalized items instead.
 */
export const getConversationDetail = async (conversationId: string): Promise<RawChatDetail> => {
  const detail = await api<RawChatDetail>(`/v2/chats/${encodeURIComponent(conversationId)}`);
  if (!detail?.id)
    throw ToolError.notFound(`Qwen has no conversation ${conversationId} (or it belongs to another account).`);
  return detail;
};

/**
 * Qwen's chat POST is a field-level patch — the SPA sends only the keys it changes
 * (`title`, `currentId`, `currentResponseIds`, `tags`, `permission`) and the server
 * merges them — so a rename cannot clobber the history.
 */
export const renameConversationById = async (conversationId: string, title: string): Promise<RawChatDetail> => {
  await getConversationDetail(conversationId);
  await api<unknown>(`/v2/chats/${encodeURIComponent(conversationId)}`, { method: 'POST', body: { title } });
  return getConversationDetail(conversationId);
};

export const deleteConversationById = async (conversationId: string): Promise<void> => {
  await api<unknown>(`/v2/chats/${encodeURIComponent(conversationId)}`, { method: 'DELETE' });
};

/** `/archive` is a toggle upstream, so the desired state is compared first. */
export const setConversationArchived = async (conversationId: string, archived: boolean): Promise<RawChatDetail> => {
  const detail = await getConversationDetail(conversationId);
  if ((detail.archived ?? false) === archived) return detail;
  await api<unknown>(`/v2/chats/${encodeURIComponent(conversationId)}/archive`, { method: 'POST' });
  return getConversationDetail(conversationId);
};
