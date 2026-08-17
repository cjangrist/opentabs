import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  fetchSearchPage,
  getConversationHistory,
  getConversationMetadata,
  mapConversationRow,
  type RawConversation,
  type SearchRow,
} from '../copilot-conversations.js';
import { pageLocalArray, type CursorPage } from '../copilot-pagination.js';
import { collectProjectConversationIndex } from '../copilot-projects.js';
import {
  conversationListItemSchema,
  paginatedOutput,
  paginationInputShape,
  resolvePagination,
} from './normalized-schemas.js';

interface SearchConversation {
  row: RawConversation;
  projectId: string | null;
}

interface ProjectSearchIndex {
  memberships: Map<string, string>;
  conversations: Array<{ row: RawConversation; projectId: string }>;
  pagesFetched: number;
  complete: boolean;
}

const MAX_SEARCH_PAGES = 200;
const SEARCH_CONCURRENCY = 5;
const SEARCH_BUDGET_MS = 24_000;

const collectUniqueHits = async (
  query: string,
  deadline: number,
): Promise<{ rows: SearchRow[]; pagesFetched: number; complete: boolean }> => {
  const rows: SearchRow[] = [];
  const seenConversationIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;
  let complete = false;
  for (let pageNumber = 0; pageNumber < MAX_SEARCH_PAGES && Date.now() < deadline; pageNumber += 1) {
    let page: CursorPage<SearchRow>;
    try {
      page = await fetchSearchPage(query, cursor, Math.max(1, deadline - Date.now()));
    } catch (error) {
      if (error instanceof ToolError && error.code === 'TIMEOUT') break;
      throw error;
    }
    pagesFetched += 1;
    for (const row of page.rows) {
      const conversationId = row.conversationId ?? '';
      if (!conversationId || seenConversationIds.has(conversationId)) continue;
      seenConversationIds.add(conversationId);
      rows.push(row);
    }
    if (!page.next) {
      complete = true;
      break;
    }
    if (page.next === cursor || seenCursors.has(page.next) || page.rows.length === 0) break;
    seenCursors.add(page.next);
    cursor = page.next;
  }
  return { rows, pagesFetched, complete };
};

const projectSearchIndex = async (deadline: number): Promise<ProjectSearchIndex> => {
  const index = await collectProjectConversationIndex(deadline);
  return {
    conversations: index.conversations,
    memberships: index.memberships,
    pagesFetched: index.pagesFetched,
    complete: index.complete,
  };
};

const findProjectHits = async (
  index: ProjectSearchIndex,
  query: string,
  deadline: number,
): Promise<{ rows: SearchRow[]; pagesFetched: number; complete: boolean }> => {
  const needle = query.toLocaleLowerCase();
  const hits: Array<SearchRow | null> = Array.from({ length: index.conversations.length }, () => null);
  let nextIndex = 0;
  let pagesFetched = 0;
  let complete = index.complete;
  const workers = Array.from({ length: Math.min(SEARCH_CONCURRENCY, index.conversations.length) }, async () => {
    while (nextIndex < index.conversations.length && Date.now() < deadline) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const candidate = index.conversations[currentIndex];
      if (!candidate?.row.id) continue;
      const titleMatches = (candidate.row.title ?? '').toLocaleLowerCase().includes(needle);
      let history = null;
      if (!titleMatches) {
        try {
          history = await getConversationHistory(candidate.row.id, Math.max(1, deadline - Date.now()));
          if (history.truncated) complete = false;
        } catch (error) {
          if (!(error instanceof ToolError) || (!error.retryable && error.code !== 'NOT_FOUND')) throw error;
          complete = false;
        }
      }
      pagesFetched += history?.pagesFetched ?? 0;
      const contentMatches =
        history?.messages.some(message =>
          (message.content ?? []).some(part =>
            [part.text, part.prompt, part.title, part.task?.title].some(
              value => typeof value === 'string' && value.toLocaleLowerCase().includes(needle),
            ),
          ),
        ) ?? false;
      if (titleMatches || contentMatches)
        hits[currentIndex] = {
          type: 'conversation',
          conversationId: candidate.row.id,
          title: candidate.row.title,
          updatedAt: candidate.row.updatedAt,
          conversationType: candidate.row.type,
        };
    }
  });
  await Promise.all(workers);
  if (nextIndex < index.conversations.length) complete = false;
  return { rows: hits.filter((hit): hit is SearchRow => hit !== null), pagesFetched, complete };
};

const loadSearchConversations = async (
  hits: SearchRow[],
  memberships: Map<string, string>,
  deadline: number,
): Promise<{ rows: SearchConversation[]; complete: boolean }> => {
  const loaded: Array<SearchConversation | undefined> = Array.from({ length: hits.length });
  let nextIndex = 0;
  let complete = true;
  const workers = Array.from({ length: Math.min(SEARCH_CONCURRENCY, hits.length) }, async () => {
    while (nextIndex < hits.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const hit = hits[currentIndex];
      const conversationId = hit?.conversationId ?? '';
      if (!hit || !conversationId) continue;
      const fallback: RawConversation = {
        id: conversationId,
        title: hit.title,
        updatedAt: hit.updatedAt,
        type: hit.conversationType,
      };
      let metadata = fallback;
      if (Date.now() < deadline) {
        try {
          metadata = await getConversationMetadata(conversationId, Math.max(1, deadline - Date.now()));
        } catch (error) {
          if (!(error instanceof ToolError) || error.code !== 'NOT_FOUND') {
            if (!(error instanceof ToolError) || error.code !== 'TIMEOUT') throw error;
            complete = false;
          }
        }
      } else {
        complete = false;
      }
      loaded[currentIndex] = {
        row: metadata,
        projectId: memberships.get(conversationId) ?? null,
      };
    }
  });
  await Promise.all(workers);
  return { rows: loaded.filter((item): item is SearchConversation => item !== undefined), complete };
};

export const searchConversations = defineTool({
  name: 'search_conversations',
  displayName: 'Search Conversations',
  description:
    'Full-text search across Copilot chats using the same native /conversations/search cursor as the UI. That endpoint ' +
    'returns one hit per matching message, so this tool exhausts it and de-duplicates by conversation id before local ' +
    'pagination; total is therefore the exact unique-chat count and a small limit cannot leak duplicates or drop a ' +
    'provider-page tail. Copilot excludes Project-filed chats from native search, so their titles and full histories ' +
    'are scanned separately with bounded concurrency and merged. The complete scan has a 24-second budget; if it is ' +
    'reached, page_info.truncated is true and total is null. Every returned chat is re-read for Pin state and joined to native Project membership.',
  summary: 'Search Copilot chats',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().trim().min(1),
    ...paginationInputShape,
  }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    const deadline = Date.now() + SEARCH_BUDGET_MS;
    const [nativeHits, projects] = await Promise.all([
      collectUniqueHits(params.query, deadline),
      projectSearchIndex(deadline),
    ]);
    const projectHits = await findProjectHits(projects, params.query, deadline);
    const hitsById = new Map(
      [...nativeHits.rows, ...projectHits.rows].flatMap(hit =>
        hit.conversationId ? ([[hit.conversationId, hit]] as const) : [],
      ),
    );
    const hits = [...hitsById.values()].sort(
      (left, right) => (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0),
    );
    const page = pageLocalArray(hits, resolvePagination(params));
    const loaded = await loadSearchConversations(page.items, projects.memberships, deadline);
    const complete = nativeHits.complete && projectHits.complete && loaded.complete;
    page.page_info.pages_fetched = nativeHits.pagesFetched + projects.pagesFetched + projectHits.pagesFetched;
    page.page_info.truncated ||= !complete;
    if (!complete) page.total = null;
    return { ...page, items: loaded.rows.map(hit => mapConversationRow(hit.row, hit.projectId)) };
  },
});
