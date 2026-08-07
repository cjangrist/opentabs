import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api, conversationUrl, toUnixSeconds } from './chatgpt-api.js';
import { isProjectId } from './chatgpt-projects.js';
import type { RawConversationDetail } from './chatgpt-messages.js';
import type { OffsetPage } from './chatgpt-pagination.js';
import type { ConversationListItem } from './tools/normalized-schemas.js';

export interface RawConversationRow {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number | string;
  update_time?: number | string;
  is_archived?: boolean;
  is_starred?: boolean | null;
  gizmo_id?: string | null;
  conversation_template_id?: string | null;
  default_model_slug?: string | null;
}

interface RawConversationsResponse {
  items?: RawConversationRow[];
  /** chatgpt.com returns `offset + items + 1`, NOT a real total — never surfaced. */
  total?: number;
}

export const mapConversationRow = (row: RawConversationRow): ConversationListItem => {
  const id = row.id ?? row.conversation_id ?? '';
  // gizmo_id carries a custom GPT (`g-…`) as often as a project (`g-p-…`); only
  // the latter is a project_id the SPEC §5 tools will accept.
  const owner = row.gizmo_id ?? row.conversation_template_id ?? null;
  return {
    id,
    title: row.title ?? '',
    url: conversationUrl(id),
    created_at: toUnixSeconds(row.create_time),
    updated_at: toUnixSeconds(row.update_time),
    project_id: owner && isProjectId(owner) ? owner : null,
    model_id: row.default_model_slug ?? null,
    is_archived: row.is_archived ?? false,
    is_starred: row.is_starred ?? false,
  };
};

export interface ConversationFilters {
  is_archived?: boolean;
  is_starred?: boolean;
  order?: 'updated' | 'created';
}

/** /backend-api/conversations rejects limit > 100 with a 422; SPEC's ceiling is 200. */
export const CONVERSATIONS_MAX_LIMIT = 100;

/**
 * One page of /backend-api/conversations. The endpoint honours `offset`/`limit`
 * for real (verified across a page boundary with disjoint ids), and signals
 * "more exist" through `total = offset + items + 1` rather than a count — so
 * `hasMore` is derived from that probe, and `total` is dropped.
 */
export const fetchConversationPage = async (
  offset: number,
  limit: number,
  filters: ConversationFilters,
): Promise<OffsetPage<RawConversationRow>> => {
  const data = await api<RawConversationsResponse>('/conversations', {
    query: {
      offset,
      limit: Math.min(limit, CONVERSATIONS_MAX_LIMIT),
      order: filters.order ?? 'updated',
      is_archived: filters.is_archived,
      is_starred: filters.is_starred,
    },
  });
  const rows = data.items ?? [];
  const reportedTotal = data.total ?? 0;
  return { rows, hasMore: rows.length > 0 && reportedTotal > offset + rows.length };
};

export const getConversationDetail = async (conversationId: string): Promise<RawConversationDetail> =>
  api<RawConversationDetail>(`/conversation/${conversationId}`);

/**
 * chatgpt.com answers a conversation PATCH with `{"success": true}`. A 200
 * carrying `success: false` is a failed write, and treating it as success is the
 * write-helper-ignores-an-error-inside-a-200 failure this repo has shipped
 * before.
 */
export const patchConversation = async (conversationId: string, body: Record<string, unknown>): Promise<void> => {
  const result = await api<{ success?: boolean }>(`/conversation/${conversationId}`, { method: 'PATCH', body });
  if (result && result.success === false)
    throw new ToolError(
      `ChatGPT rejected the change to conversation ${conversationId}: the endpoint answered 200 with "success": false.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
};
