import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
import {
  ASK_TIMEOUT_MS,
  CLIENT_SOURCE_VALUE,
  CLIENT_VERSION_VALUE,
  COMPLETION_WAIT_MS,
  api,
  conversationUrl,
  randomUuid,
  request,
} from './perplexity-api.js';
import { type ThreadTip, fetchThreadPage, fetchThreadTip } from './perplexity-conversations.js';
import { type MappedItems, type RawEntry, mapEntriesToItems } from './perplexity-messages.js';
import { type ModelCatalog, getModelCatalog, resolveModelId, resolveThinkingModel } from './perplexity-models.js';
import type { ThinkingLevel } from './tools/normalized-schemas.js';

const ASK_ENDPOINT = '/sse/perplexity_ask';

/** Answer-mode block use cases the Perplexity web client advertises. */
const SUPPORTED_BLOCK_USE_CASES = [
  'answer_modes',
  'media_items',
  'knowledge_cards',
  'inline_entity_cards',
  'inline_images',
  'inline_assets',
  'preserve_latex',
  'answer_tabs',
];

export interface SendParams {
  text: string;
  model_id?: string;
  project_id?: string;
  thinking?: boolean;
  thinking_level?: ThinkingLevel;
  search?: boolean;
  tools?: string[];
  include_reasoning?: boolean;
  include_tool_calls?: boolean;
}

export interface AskOptions {
  text: string;
  modelId: string;
  search: boolean;
  incognito?: boolean;
  collectionUuid?: string;
  frontendUuid: string;
  frontendContextUuid: string;
  tip?: ThreadTip;
}

/** Perplexity's tool set is fixed; a caller-supplied allow-list has nowhere to go. */
export const rejectToolSelection = (tools: string[] | undefined): void => {
  if (tools && tools.length > 0)
    throw ToolError.validation(
      'Perplexity does not accept a per-message tool allow-list — the composer exposes the model picker, the source ' +
        'picker and the mode switch only. Use search / thinking / model_id, or start_deep_research. ' +
        'See list_capabilities().features.',
    );
};

export const buildAskBody = (options: AskOptions): Record<string, unknown> => {
  const isFollowUp = Boolean(options.tip?.lastEntryId && options.tip?.readWriteToken);
  const params: Record<string, unknown> = {
    attachments: [],
    language: 'en-US',
    timezone: 'UTC',
    // "writing" is Perplexity's no-search mode: the model answers from weights
    // alone. There is no other way to turn search off for a query.
    search_focus: options.search ? 'internet' : 'writing',
    sources: options.search ? ['web'] : [],
    frontend_uuid: options.frontendUuid,
    mode: 'copilot',
    model_preference: options.modelId,
    is_related_query: false,
    is_sponsored: false,
    prompt_source: 'user',
    query_source: isFollowUp ? 'followup' : 'home',
    is_incognito: options.incognito ?? false,
    local_search_enabled: false,
    use_schematized_api: true,
    send_back_text_in_streaming_api: false,
    supported_block_use_cases: SUPPORTED_BLOCK_USE_CASES,
    client_coordinates: null,
    mentions: [],
    skip_search_enabled: true,
    is_nav_suggestions_disabled: false,
    source: CLIENT_SOURCE_VALUE,
    always_search_override: false,
    override_no_search: false,
    version: CLIENT_VERSION_VALUE,
  };

  if (isFollowUp) {
    params.last_backend_uuid = options.tip?.lastEntryId;
    params.read_write_token = options.tip?.readWriteToken;
    params.followup_source = 'link';
  } else {
    params.frontend_context_uuid = options.frontendContextUuid;
  }
  if (options.collectionUuid) params.target_collection_uuid = options.collectionUuid;

  try {
    params.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Timezone is advisory — the gateway accepts the UTC default.
  }

  return { params, query_str: options.text };
};

// --- SSE ---

interface SseMessage {
  backend_uuid?: string;
  context_uuid?: string;
  read_write_token?: string;
  thread_url_slug?: string;
  status?: string;
  error_code?: string;
  text?: string;
  final?: boolean;
  final_sse_message?: boolean;
}

/** Splits an `event:`/`data:` SSE body into its decoded JSON payloads. */
const parseSseMessages = (body: string): SseMessage[] =>
  body
    .split(/\r?\n\r?\n/)
    .map(chunk =>
      chunk
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n'),
    )
    .filter(payload => payload.length > 0)
    .flatMap(payload => {
      try {
        return [JSON.parse(payload) as SseMessage];
      } catch {
        return [];
      }
    });

/**
 * Perplexity spells stream-level failures as `error_code` strings. The rate-limit
 * ones are plan-specific (`FREE_TIER_RATE_LIMITED`, `PRO_TIER_…`), so match on
 * the family rather than enumerating every variant.
 */
const errorCodeToToolError = (code: string, message: string): ToolError => {
  if (code === 'INVALID_MODEL_SELECTION')
    return new ToolError(`Perplexity rejected the model selection: ${message}`, 'VALIDATION_ERROR', {
      category: 'validation',
    });
  if (code.includes('RATE_LIMIT') || code === 'TOO_MANY_REQUESTS' || code.includes('QUOTA'))
    return new ToolError(
      `Perplexity rate limited this account (${code}). Wait for the rolling window to refill, or upgrade the plan.`,
      'RATE_LIMIT',
      { category: 'rate_limit', retryable: true },
    );
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'NOT_AUTHENTICATED')
    return new ToolError(`Perplexity rejected the session (${code}) — reload perplexity.ai and log in.`, 'AUTH_ERROR', {
      category: 'auth',
    });
  return new ToolError(`Perplexity ask failed (${code}): ${message}`, 'UPSTREAM_ERROR', {
    category: 'internal',
    retryable: true,
  });
};

export interface AskOutcome {
  conversationId: string;
  contextUuid: string;
  entryId: string;
}

/**
 * Sends a query and folds the SSE stream into the ids the caller needs.
 *
 * The endpoint ALWAYS replies HTTP 200: an invalid model, a rate limit or an
 * expired session all arrive as a normal `event: message` frame carrying
 * `status: "failed"` and an `error_code`, so the status code is never the
 * success signal.
 */
export const runAsk = async (options: AskOptions): Promise<AskOutcome> => {
  const response = await request(ASK_ENDPOINT, {
    method: 'POST',
    body: buildAskBody(options),
    timeout: ASK_TIMEOUT_MS,
  });
  const messages = parseSseMessages(await response.text());
  if (messages.length === 0)
    throw new ToolError('Perplexity returned an empty answer stream.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });

  const failed = messages.find(message => message.error_code || message.status === 'failed');
  if (failed) throw errorCodeToToolError(failed.error_code ?? 'UNKNOWN', failed.text ?? failed.status ?? 'unknown');

  const final = messages.filter(message => message.final_sse_message || message.final).pop() ?? messages.at(-1);
  if (!final?.backend_uuid)
    throw new ToolError('Perplexity answer stream ended without an entry id.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return {
    conversationId: final.thread_url_slug || final.backend_uuid,
    contextUuid: final.context_uuid ?? '',
    entryId: final.backend_uuid,
  };
};

/**
 * Starts an ask without draining the stream. The run is persisted server-side,
 * so a caller that cannot wait (deep research) reads the result back from the
 * thread instead.
 */
export const startAsk = (options: AskOptions): Promise<AskOutcome | null> =>
  runAsk(options).then(
    outcome => outcome,
    () => null,
  );

// --- Resolving a thread that has not finished streaming ---

interface RecentRow {
  context_uuid?: string;
  slug?: string;
  frontend_uuid?: string;
  frontend_context_uuid?: string;
}

/**
 * A brand-new thread has no id until the stream produces one, so when the wait
 * budget expires the thread is found by the `frontend_uuid` we minted and sent —
 * the Library echoes it back on the row.
 */
export const resolveStartedThread = async (
  frontendUuid: string,
  frontendContextUuid: string,
  attempts = 3,
): Promise<{ conversationId: string; contextUuid: string } | null> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rows =
      (await api<RecentRow[]>('/thread/list_ask_threads', {
        method: 'POST',
        body: { limit: 10, offset: 0, ascending: false },
        timeout: 15_000,
      }).catch(() => [])) ?? [];
    const match = rows.find(
      row => row.frontend_uuid === frontendUuid || row.frontend_context_uuid === frontendContextUuid,
    );
    if (match?.context_uuid)
      return { conversationId: match.slug || match.context_uuid, contextUuid: match.context_uuid };
    if (attempt < attempts - 1) await sleep(1500);
  }
  return null;
};

// --- Turn assembly ---

export interface SendResult extends MappedItems {
  conversation_id: string;
  message_id: string;
  model: string;
  url: string;
  status: 'completed' | 'in_progress';
}

const collectTurn = async (
  conversationId: string,
  params: SendParams,
  status: 'completed' | 'in_progress',
): Promise<SendResult> => {
  const page = await fetchThreadPage(conversationId, 1);
  const entry: RawEntry | undefined = page.entries[page.entries.length - 1];
  const mapped = mapEntriesToItems(entry ? [entry] : [], {
    includeReasoning: params.include_reasoning ?? false,
    includeToolCalls: params.include_tool_calls ?? false,
  });
  const slug = entry?.thread_url_slug || conversationId;
  return {
    ...mapped,
    conversation_id: slug,
    message_id: entry?.backend_uuid ?? '',
    model: entry?.display_model ?? '',
    url: conversationUrl(slug),
    status,
  };
};

export interface PreparedTurn {
  options: AskOptions;
  model: string;
  catalog: ModelCatalog;
}

/** Applies model / thinking / search / Space selection. Every check happens before any request. */
export const prepareTurn = async (
  params: SendParams,
  options: { tip?: ThreadTip; collectionUuid?: string; incognito?: boolean; modelOverride?: string },
): Promise<PreparedTurn> => {
  rejectToolSelection(params.tools);
  const catalog = await getModelCatalog();
  const base = options.modelOverride ?? resolveModelId(catalog, params.model_id);
  const model = options.modelOverride
    ? base
    : resolveThinkingModel(catalog, base, params.thinking, params.thinking_level);

  return {
    catalog,
    model,
    options: {
      text: params.text,
      modelId: model,
      search: params.search !== false,
      incognito: options.incognito,
      collectionUuid: options.collectionUuid,
      frontendUuid: randomUuid(),
      frontendContextUuid: randomUuid(),
      tip: options.tip,
    },
  };
};

/**
 * Full send. Waits up to COMPLETION_WAIT_MS for the stream, then stops *waiting*
 * (without cancelling it) and reads back whatever landed.
 *
 * The OpenTabs adapter aborts a handler at 25s with a platform-level timeout
 * that carries no result at all. Returning early instead yields a well-formed
 * answer with `status: "in_progress"`; the fetch keeps running in the page, so
 * get_conversation returns the finished reply.
 */
export const sendTurn = async (params: SendParams, conversationId?: string): Promise<SendResult> => {
  const tip = conversationId ? await fetchThreadTip(conversationId) : undefined;
  const collectionUuid = params.project_id;
  const prepared = await prepareTurn(params, { tip, collectionUuid });

  let askError: unknown;
  const ask = runAsk(prepared.options).then(
    outcome => outcome,
    (error: unknown) => {
      askError = error;
      return null;
    },
  );

  const outcome = await Promise.race([ask, sleep(COMPLETION_WAIT_MS).then(() => 'pending' as const)]);
  if (outcome === null) throw askError;

  if (outcome !== 'pending') return collectTurn(outcome.conversationId, params, 'completed');

  const resolved =
    tip?.conversationId ??
    (await resolveStartedThread(prepared.options.frontendUuid, prepared.options.frontendContextUuid))?.conversationId;
  if (!resolved)
    throw new ToolError(
      'Perplexity accepted the query but the thread had not appeared in the Library within the tool budget. ' +
        'It is still running — call list_conversations in a few seconds to find it.',
      'TIMEOUT',
      { category: 'timeout', retryable: true },
    );
  return collectTurn(resolved, params, 'in_progress');
};
