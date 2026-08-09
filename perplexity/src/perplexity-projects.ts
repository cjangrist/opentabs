import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api, projectUrl, toUnixSeconds } from './perplexity-api.js';
import type { FetchedPage } from './perplexity-pagination.js';
import type { NormalizedProject } from './tools/normalized-schemas.js';

/**
 * Perplexity calls these Spaces in the product and Projects in the URL, and
 * "collections" everywhere in the API. All three are the same object.
 */
interface RawCollection {
  uuid?: string;
  slug?: string;
  title?: string;
  description?: string;
  instructions?: string;
  emoji?: string;
  updated_datetime?: string;
  thread_count?: number;
  has_next_page?: boolean;
  url?: string;
}

interface RawCollectionThread {
  context_uuid?: string;
  uuid?: string;
  slug?: string;
  title?: string;
  display_model?: string;
  last_query_datetime?: string;
  updated_datetime?: string;
  has_next_page?: boolean;
  read_write_token?: string;
}

export interface CollectionRef {
  uuid: string;
  slug: string;
}

export const mapCollection = (collection: RawCollection): NormalizedProject => ({
  id: collection.uuid ?? '',
  name: collection.title ?? '',
  description: collection.description || collection.instructions || null,
  // list_user_collections publishes only updated_datetime; Perplexity reports no
  // creation time for a Space anywhere in its REST surface.
  created_at: 0,
  updated_at: toUnixSeconds(collection.updated_datetime),
  conversation_count: typeof collection.thread_count === 'number' ? collection.thread_count : null,
  url: projectUrl(collection.slug ?? collection.uuid ?? ''),
});

const COLLECTION_PAGE_SIZE = 30;

/**
 * `list_user_collections` pages with limit/offset and marks "there is more" on
 * the FIRST row rather than in an envelope — the Library's own hook reads
 * `page[0].has_next_page`.
 */
export const fetchProjectsPage = async (offset: number, limit: number): Promise<FetchedPage<RawCollection>> => {
  const rows =
    (await api<RawCollection[]>('/collections/list_user_collections', {
      query: { limit, offset },
      timeout: 25_000,
    })) ?? [];
  const list = Array.isArray(rows) ? rows : [];
  return { rows: list, hasMore: list[0]?.has_next_page === true, nextCursor: null, total: null };
};

/** Walks every page of Spaces. Used to resolve a uuid to the slug the API wants. */
const fetchAllCollections = async (): Promise<RawCollection[]> => {
  const collected: RawCollection[] = [];
  for (let offset = 0; offset < 1000; offset += COLLECTION_PAGE_SIZE) {
    const page = await fetchProjectsPage(offset, COLLECTION_PAGE_SIZE);
    collected.push(...page.rows);
    if (!page.hasMore || page.rows.length === 0) break;
  }
  return collected;
};

/**
 * `get_collection` and `list_collection_threads` are keyed on the Space's SLUG,
 * while every membership mutation is keyed on its UUID, and SPEC §5 exposes one
 * `project_id`. This accepts either and returns both.
 */
export const resolveCollection = async (projectId: string): Promise<CollectionRef> => {
  if (!projectId) throw ToolError.validation('project_id must be a Perplexity Space uuid or slug.');
  const collections = await fetchAllCollections();
  const match = collections.find(collection => collection.uuid === projectId || collection.slug === projectId);
  if (!match?.uuid)
    throw ToolError.notFound(
      `Perplexity Space "${projectId}" was not found on this account. Call list_projects for valid ids.`,
    );
  return { uuid: match.uuid, slug: match.slug ?? match.uuid };
};

export const getCollection = async (ref: CollectionRef): Promise<NormalizedProject> => {
  const collection = await api<RawCollection>('/collections/get_collection', {
    query: { collection_slug: ref.slug },
    timeout: 25_000,
  });
  if (!collection?.uuid) throw ToolError.notFound(`Perplexity Space "${ref.slug}" was not found.`);
  return mapCollection(collection);
};

export const fetchProjectThreadsPage = async (
  slug: string,
  offset: number,
  limit: number,
): Promise<FetchedPage<RawCollectionThread>> => {
  const rows =
    (await api<RawCollectionThread[]>('/collections/list_collection_threads', {
      query: {
        collection_slug: slug,
        limit,
        offset,
        filter_by_user: false,
        filter_by_shared_threads: false,
        include_user_and_shared_threads: true,
      },
      timeout: 25_000,
    })) ?? [];
  const list = Array.isArray(rows) ? rows : [];
  return { rows: list, hasMore: list[0]?.has_next_page === true, nextCursor: null, total: null };
};

export const mapProjectThread = (thread: RawCollectionThread, projectId: string) => ({
  id: thread.slug || thread.context_uuid || '',
  title: thread.title ?? '',
  url: `https://www.perplexity.ai/search/${thread.slug || thread.context_uuid || ''}`,
  created_at: 0,
  updated_at: toUnixSeconds(thread.last_query_datetime ?? thread.updated_datetime),
  project_id: projectId,
  model_id: thread.display_model || null,
  is_archived: false,
  is_starred: false,
});

export const createCollection = async (name: string, description?: string): Promise<NormalizedProject> => {
  const created = await api<RawCollection>('/collections/create_collection', {
    method: 'POST',
    body: { title: name, description: description ?? '', emoji: '', instructions: '' },
  });
  if (!created?.uuid)
    throw new ToolError('Perplexity accepted create_collection but returned no Space.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: false,
    });
  return mapCollection(created);
};

export const editCollection = async (
  ref: CollectionRef,
  changes: { title?: string; description?: string },
): Promise<NormalizedProject> => {
  const body: Record<string, unknown> = {};
  if (changes.title !== undefined) body.title = changes.title;
  if (changes.description !== undefined) body.description = changes.description;
  if (Object.keys(body).length === 0) throw ToolError.validation('Pass at least one of name or description.');
  const updated = await api<RawCollection>(`/collections/edit_collection/${encodeURIComponent(ref.uuid)}`, {
    method: 'POST',
    body,
  });
  return updated?.uuid ? mapCollection(updated) : getCollection(ref);
};

export const deleteCollection = async (ref: CollectionRef): Promise<void> => {
  await api(`/collections/delete_collection/${encodeURIComponent(ref.uuid)}`, { method: 'DELETE' });
};

/**
 * `batch_move_threads` is Perplexity's single "put this thread in that Space"
 * primitive — it both adds and moves. Removal is a different endpoint that names
 * the Space the thread is leaving.
 */
export const moveThreadToCollection = async (contextUuid: string, collectionUuid: string): Promise<void> => {
  await api('/collections/batch_move_threads', {
    method: 'POST',
    body: { context_uuids: [contextUuid], new_collection_uuid: collectionUuid },
  });
};

export const removeThreadFromCollection = async (contextUuid: string, collectionUuid: string): Promise<void> => {
  await api('/collections/batch_remove_collection_threads', {
    method: 'POST',
    body: { items: [{ collection_uuid: collectionUuid, context_uuid: contextUuid }] },
  });
};
