import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
import { COMPLETION_WAIT_MS, callStreamingRpc, conversationUrl } from './kimi-api.js';
import {
  chatEffort,
  fetchConversationsPage,
  getChat,
  getConversationMessages,
  getLatestMessageId,
  type RawChat,
} from './kimi-conversations.js';
import { type MappedItems, mapMessagesToItems } from './kimi-messages.js';
import {
  type KimiModelCatalog,
  type KimiModelRuntime,
  type ThinkingSelection,
  getModelCatalog,
  resolveModelId,
  resolveThinking,
  scenarioToModelId,
} from './kimi-models.js';
import type { ThinkingLevel } from './tools/normalized-schemas.js';

export const CHAT_METHOD = 'kimi.gateway.chat.v1.ChatService/Chat';
export const DEEP_RESEARCH_KIMIPLUS_ID = 'deep-researcher';

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

export interface SendResult extends MappedItems {
  conversation_id: string;
  message_id: string;
  model: string;
  url: string;
  status: 'completed' | 'in_progress';
}

/** Kimi's per-message tool surface is the search toggle; the agentic tools are model-chosen. */
const rejectToolSelection = (tools: string[] | undefined): void => {
  if (tools && tools.length > 0)
    throw ToolError.validation(
      'Kimi does not accept a per-message tool allow-list — the composer exposes only the web-search toggle, and the agentic tools ' +
        '(shell, read_file, write_file, spawn_subagent, …) are chosen by the model itself. Use search / thinking, or start_deep_research. ' +
        'See list_capabilities().features.',
    );
};

export interface ChatPayloadOptions {
  text: string;
  runtime: KimiModelRuntime;
  thinking: ThinkingSelection;
  search: boolean;
  conversationId?: string;
  parentMessageId?: string;
  projectId?: string;
  /** Set for Deep Research: swaps in the deep-researcher kimiPlus and the ask_user tool. */
  deepResearch?: boolean;
}

/**
 * Builds the Chat RPC payload.
 *
 * The Deep Research shape is copied from what kimi.com's own /deep-research
 * composer sends, read back out of the chat's `lastRequest`: the agentic
 * scenario, `kimiplus_id: "deep-researcher"`, plugins enabled, and the
 * `TOOL_TYPE_ASK_USER` tool that lets the model ask a clarifying question.
 */
export const buildChatPayload = (options: ChatPayloadOptions): Record<string, unknown> => {
  const scenario = options.runtime.scenario;
  const tools: Record<string, unknown>[] = [];
  if (options.search) tools.push({ type: 'TOOL_TYPE_SEARCH', search: {} });
  if (options.deepResearch) tools.push({ type: 'TOOL_TYPE_ASK_USER' });

  const chatOptions: Record<string, unknown> = {
    thinking: options.thinking.thinking,
    enable_plugin: options.deepResearch === true,
    reasoning_effort: options.thinking.reasoningEffort,
  };
  if (options.runtime.contextLength) chatOptions.context_length = options.runtime.contextLength;

  const payload: Record<string, unknown> = {
    chat_id: options.conversationId ?? '',
    scenario,
    kimiplus_id: options.deepResearch ? DEEP_RESEARCH_KIMIPLUS_ID : options.runtime.kimiPlusId,
    tools,
    message: {
      parent_id: options.parentMessageId ?? '',
      role: 'user',
      blocks: [{ message_id: '', text: { content: options.text } }],
      scenario,
      is_goal: false,
    },
    options: chatOptions,
    project_id: options.projectId ?? '',
  };
  // K3 and K3 Swarm share one scenario and one kimiPlus; agent_mode is the only
  // field that tells them apart, so omitting it silently downgrades Swarm to K3.
  if (options.runtime.agentMode) payload.agent_mode = options.runtime.agentMode;
  return payload;
};

export interface PreparedTurn {
  payload: Record<string, unknown>;
  modelId: string;
  catalog: KimiModelCatalog;
  conversationId?: string;
}

/**
 * Applies model / thinking / search selection and returns the exact Chat body.
 * Every validation happens here, before any request is sent (SPEC §4).
 */
export const prepareTurn = async (
  params: SendParams,
  options: { conversationId?: string; deepResearch?: boolean } = {},
): Promise<PreparedTurn> => {
  rejectToolSelection(params.tools);

  const catalog = await getModelCatalog();
  const modelId = resolveModelId(catalog, params.model_id);
  const runtime = catalog.runtimeById[modelId];
  if (!runtime) throw ToolError.validation(`Unknown model_id "${modelId}".`);

  if (options.deepResearch && !catalog.models.find(model => model.id === modelId)?.capabilities.deep_research.supported)
    throw ToolError.validation(
      `Model "${modelId}" cannot run Kimi Deep Research. Models that can: ${catalog.models
        .filter(model => model.capabilities.deep_research.supported)
        .map(model => model.id)
        .join(', ')}`,
    );

  const thinking = resolveThinking(runtime, params.thinking, params.thinking_level);

  let parentMessageId: string | undefined;
  if (options.conversationId) parentMessageId = await getLatestMessageId(options.conversationId);

  return {
    catalog,
    modelId,
    conversationId: options.conversationId,
    payload: buildChatPayload({
      text: params.text,
      runtime,
      thinking,
      // Kimi's composer defaults web search on; only an explicit false turns it off.
      search: params.search !== false,
      conversationId: options.conversationId,
      parentMessageId,
      projectId: params.project_id,
      deepResearch: options.deepResearch,
    }),
  };
};

/** Pulls the chat id out of the Chat stream's events, or falls back to the one we sent. */
export const conversationIdFromStream = (
  events: Record<string, unknown>[],
  fallback: string | undefined,
): string | null => {
  for (const event of events) {
    const id = (event as { chat?: { id?: string } }).chat?.id;
    if (id) return id;
  }
  return fallback ?? null;
};

const NEW_CHAT_POLL_INTERVAL_MS = 700;
const NEW_CHAT_POLL_ATTEMPTS = 14;
const NEW_CHAT_PROBE_SIZE = 5;

const topConversationIds = async (): Promise<string[]> =>
  (await fetchConversationsPage(undefined, NEW_CHAT_PROBE_SIZE)).rows.map(chat => chat.id ?? '');

/**
 * Recovers the id of a chat the Chat stream is still creating.
 *
 * A new chat has no id until the gateway mints one inside the stream, and
 * `fetchFromPage` only hands back the body once the whole stream has ended —
 * which for a long answer is well past the 18s budget. `ChatService/CreateChat`
 * would solve this but answers `unimplemented` (HTTP 501).
 *
 * The chat is nevertheless persisted the moment generation starts: measured
 * live, it appears at the top of ListFeeds ~1.5s in, while still generating. So
 * the ids present before the send are diffed against the feed until a new one
 * shows up.
 *
 * `stop` is checked every round so the poll ends the instant the stream itself
 * yields the id — otherwise a fast completion would leave this issuing another
 * dozen ListFeeds calls after the tool has already returned.
 */
export const awaitNewConversationId = async (before: string[], stop: () => boolean): Promise<string | null> => {
  for (let attempt = 0; attempt < NEW_CHAT_POLL_ATTEMPTS; attempt += 1) {
    await sleep(NEW_CHAT_POLL_INTERVAL_MS);
    if (stop()) return null;
    const fresh = (await topConversationIds()).find(id => id && !before.includes(id));
    if (fresh) return fresh;
  }
  return null;
};

/** Reads back only the messages this turn produced, so callers do not re-read history. */
export const collectTurn = async (
  conversationId: string,
  parentMessageId: string | undefined,
  params: SendParams,
  catalog: KimiModelCatalog,
  status: 'completed' | 'in_progress',
  /** The id this turn was actually sent with. Reading it back off the chat cannot
   *  tell K3 from K3 Swarm — Kimi records the shared scenario without agent_mode. */
  sentModelId?: string,
): Promise<SendResult> => {
  const [chat, messages] = await Promise.all([getChat(conversationId), getConversationMessages(conversationId)]);
  const parentIndex = parentMessageId ? messages.findIndex(message => message.id === parentMessageId) : -1;
  const turn = messages.slice(parentIndex + 1);

  const modelId =
    sentModelId ?? ((chat.lastRequest?.scenario && scenarioToModelId(catalog).get(chat.lastRequest.scenario)) || '');
  const mapped = mapMessagesToItems(turn, {
    includeReasoning: params.include_reasoning ?? false,
    includeToolCalls: params.include_tool_calls ?? false,
    effort: chatEffort(chat),
    model: modelId || null,
  });

  const assistant = [...turn].reverse().find(message => message.role === 'assistant');
  return {
    ...mapped,
    conversation_id: conversationId,
    message_id: assistant?.id ?? '',
    model: modelId,
    url: conversationUrl(conversationId),
    // The chat's own status is authoritative: Kimi keeps generating after the
    // wait budget expires and flips it to STATUS_COMPLETED when it lands.
    status: status === 'completed' && isChatSettled(chat) ? 'completed' : 'in_progress',
  };
};

export const isChatSettled = (chat: RawChat): boolean => chat.status !== 'STATUS_GENERATING';

/**
 * Full send. Waits up to COMPLETION_WAIT_MS for the stream, then stops *waiting*
 * (without cancelling it) and reads back whatever landed.
 *
 * The OpenTabs adapter aborts a handler at 25s with a platform-level timeout
 * carrying no result at all. Returning early instead yields a well-formed answer
 * with `status: "in_progress"`; the streaming fetch keeps running in the page, so
 * `get_conversation` returns the finished reply.
 */
export const sendTurn = async (params: SendParams, conversationId?: string): Promise<SendResult> => {
  const prepared = await prepareTurn(params, { conversationId });
  const parentMessageId = (prepared.payload.message as { parent_id?: string } | undefined)?.parent_id || undefined;
  const idsBefore = conversationId ? [] : await topConversationIds();

  // Capture rather than re-throw: a failure that arrives after the budget must
  // not surface as an unhandled rejection in the page.
  let streamError: unknown;
  let streamedConversationId: string | null = null;
  const completion = callStreamingRpc(CHAT_METHOD, prepared.payload).then(
    events => {
      streamedConversationId = conversationIdFromStream(events, conversationId);
      return 'completed' as const;
    },
    (error: unknown) => {
      streamError = error;
      return 'failed' as const;
    },
  );

  // For a brand-new chat the id hunt runs CONCURRENTLY with the generation —
  // it resolves in ~1.5s and must not be tacked onto the 18s wait budget. It
  // stops as soon as the stream itself reports the id.
  const newIdSearch = conversationId
    ? Promise.resolve<string | null>(null)
    : awaitNewConversationId(idsBefore, () => streamedConversationId !== null);

  const outcome = await Promise.race([completion, sleep(COMPLETION_WAIT_MS).then(() => 'in_progress' as const)]);
  if (outcome === 'failed') throw streamError;

  const resolvedId = conversationId ?? streamedConversationId ?? (await newIdSearch);
  if (!resolvedId)
    throw new ToolError(
      'Kimi did not return a chat id for the new conversation — the stream may have been interrupted.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );

  return collectTurn(resolvedId, parentMessageId, params, prepared.catalog, outcome, prepared.modelId);
};
