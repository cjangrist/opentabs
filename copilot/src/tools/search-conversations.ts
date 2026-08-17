import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  fetchSearchPage,
  getConversationHistory,
  getConversationMetadata,
  mapConversationRow,
  type RawConversation,
  type SearchRow,
} from '../copilot-conversations.js';
import { pageLocalArray } from '../copilot-pagination.js';
import { collectProjectConversationsWithStats, collectProjectsWithStats } from '../copilot-projects.js';
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
}

const MAX_SEARCH_PAGES = 200;

const collectUniqueHits = async (query: string): Promise<{ rows: SearchRow[]; pagesFetched: number }> => {
  const rows: SearchRow[] = [];
  const seenConversationIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;
  for (let pageNumber = 0; pageNumber < MAX_SEARCH_PAGES; pageNumber += 1) {
    const page = await fetchSearchPage(query, cursor);
    pagesFetched += 1;
    for (const row of page.rows) {
      const conversationId = row.conversationId ?? '';
      if (!conversationId || seenConversationIds.has(conversationId)) continue;
      seenConversationIds.add(conversationId);
      rows.push(row);
    }
    if (!page.next || page.next === cursor || seenCursors.has(page.next) || page.rows.length === 0) break;
    seenCursors.add(page.next);
    cursor = page.next;
  }
  return { rows, pagesFetched };
};

const projectSearchIndex = async (): Promise<ProjectSearchIndex> => {
  const projects = await collectProjectsWithStats();
  const pages = await Promise.all(
    projects.rows.map(async project => ({
      projectId: project.id ?? '',
      result: project.id ? await collectProjectConversationsWithStats(project.id) : { rows: [], pagesFetched: 0 },
    })),
  );
  const conversations = pages.flatMap(page =>
    page.result.rows.flatMap(row => (row.id ? [{ row, projectId: page.projectId }] : [])),
  );
  return {
    conversations,
    memberships: new Map(
      pages.flatMap(page =>
        page.result.rows.flatMap(member => (member.id ? [[member.id, page.projectId] as const] : [])),
      ),
    ),
    pagesFetched: projects.pagesFetched + pages.reduce((total, page) => total + page.result.pagesFetched, 0),
  };
};

const findProjectHits = async (
  index: ProjectSearchIndex,
  query: string,
): Promise<{ rows: SearchRow[]; pagesFetched: number }> => {
  const needle = query.toLocaleLowerCase();
  const hits: Array<SearchRow | null> = Array.from({ length: index.conversations.length }, () => null);
  let nextIndex = 0;
  let pagesFetched = 0;
  const workers = Array.from({ length: Math.min(5, index.conversations.length) }, async () => {
    while (nextIndex < index.conversations.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const candidate = index.conversations[currentIndex];
      if (!candidate?.row.id) continue;
      const titleMatches = (candidate.row.title ?? '').toLocaleLowerCase().includes(needle);
      const history = titleMatches ? null : await getConversationHistory(candidate.row.id);
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
  return { rows: hits.filter((hit): hit is SearchRow => hit !== null), pagesFetched };
};

export const searchConversations = defineTool({
  name: 'search_conversations',
  displayName: 'Search Conversations',
  description:
    'Full-text search across Copilot chats using the same native /conversations/search cursor as the UI. That endpoint ' +
    'returns one hit per matching message, so this tool exhausts it and de-duplicates by conversation id before local ' +
    'pagination; total is therefore the exact unique-chat count and a small limit cannot leak duplicates or drop a ' +
    'provider-page tail. Copilot excludes Project-filed chats from native search, so their titles and full histories ' +
    'are scanned separately with bounded concurrency and merged. Every returned chat is re-read for Pin state and joined to native Project membership.',
  summary: 'Search Copilot chats',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().trim().min(1),
    ...paginationInputShape,
  }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    const [nativeHits, projects] = await Promise.all([collectUniqueHits(params.query), projectSearchIndex()]);
    const projectHits = await findProjectHits(projects, params.query);
    const hitsById = new Map(
      [...nativeHits.rows, ...projectHits.rows].flatMap(hit =>
        hit.conversationId ? ([[hit.conversationId, hit]] as const) : [],
      ),
    );
    const hits = [...hitsById.values()].sort(
      (left, right) => (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0),
    );
    const page = pageLocalArray(hits, resolvePagination(params));
    const items = await Promise.all(
      page.items.map(async hit => {
        const conversationId = hit.conversationId ?? '';
        const metadata = await getConversationMetadata(conversationId).catch(() => ({
          id: conversationId,
          title: hit.title,
          updatedAt: hit.updatedAt,
          type: hit.conversationType,
        }));
        return {
          row: metadata,
          projectId: projects.memberships.get(conversationId) ?? null,
        } satisfies SearchConversation;
      }),
    );
    page.page_info.pages_fetched = nativeHits.pagesFetched + projects.pagesFetched + projectHits.pagesFetched;
    return { ...page, items: items.map(hit => mapConversationRow(hit.row, hit.projectId)) };
  },
});
