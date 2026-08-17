import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  fetchSearchPage,
  getConversationMetadata,
  mapConversationRow,
  type RawConversation,
} from '../copilot-conversations.js';
import { walkCursorPages } from '../copilot-pagination.js';
import { collectProjectConversations, collectProjects } from '../copilot-projects.js';
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

const projectMembership = async (): Promise<Map<string, string>> => {
  const projects = await collectProjects();
  const pages = await Promise.all(
    projects.map(async project => ({
      projectId: project.id ?? '',
      members: project.id ? await collectProjectConversations(project.id) : [],
    })),
  );
  return new Map(
    pages.flatMap(page => page.members.flatMap(member => (member.id ? [[member.id, page.projectId] as const] : []))),
  );
};

export const searchConversations = defineTool({
  name: 'search_conversations',
  displayName: 'Search Conversations',
  description:
    'Full-text search across Copilot chats using the same native /conversations/search cursor as the UI. Copilot ' +
    'chooses its own upstream page size, so next_cursor also records an intra-page offset: a small limit never drops ' +
    'the remainder of a provider page. Every returned hit is re-read for Pin state and joined to native Project ' +
    'membership. Copilot reports no true total, so total is null.',
  summary: 'Search Copilot chats',
  icon: 'search',
  group: 'Conversations',
  input: z.object({
    query: z.string().trim().min(1),
    ...paginationInputShape,
  }),
  output: paginatedOutput(conversationListItemSchema),
  handle: async params => {
    const memberships = await projectMembership();
    return walkCursorPages(
      resolvePagination(params),
      async cursor => {
        const page = await fetchSearchPage(params.query, cursor);
        const rows = await Promise.all(
          page.rows.map(async hit => {
            const conversationId = hit.conversationId ?? '';
            const metadata = await getConversationMetadata(conversationId).catch(() => ({
              id: conversationId,
              title: hit.title,
              updatedAt: hit.updatedAt,
              type: hit.conversationType,
            }));
            return { row: metadata, projectId: memberships.get(conversationId) ?? null } satisfies SearchConversation;
          }),
        );
        return { rows, next: page.next };
      },
      hit => mapConversationRow(hit.row, hit.projectId),
    );
  },
});
