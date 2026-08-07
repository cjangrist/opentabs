import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
import { api, conversationUrl, getBearerToken, getFrontendVersion, nowSeconds } from './zai-api.js';
import { HANDLER_BUDGET_MS, mintCaptchaToken, runCompletion, startCompletion } from './zai-completions.js';
import { type RawChatDetail, getConversationDetail, setConversationFolder } from './zai-conversations.js';
import { type MappedItems, loadConversationItems } from './zai-messages.js';
import {
  DEEP_RESEARCH_SERVER,
  WEB_SEARCH_SERVER,
  type ZaiBootstrap,
  assertEffortSupported,
  getBootstrap,
  resolveModel,
  toNativeEffort,
} from './zai-models.js';
import type { NormalizedModel, ThinkingLevel } from './tools/normalized-schemas.js';

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

const DEFAULT_TITLE = 'New Chat';
/** z.ai always posts this hidden feature; omitting it changes tool routing. */
const HIDDEN_TOOL_SELECTOR = { server: 'tool_selector_h', status: 'hidden', type: 'tool_selector' };

interface TurnPlan {
  model: NormalizedModel;
  thinkingEnabled: boolean;
  nativeEffort: string | null;
  autoWebSearch: boolean;
  mcpServers: string[];
}

/**
 * Resolves every caller option against the live model list, raising before a single
 * byte is sent upstream. `tools` maps onto z.ai's MCP server ids, which each model
 * publishes in `info.meta.mcpServerIds`.
 */
export const planTurn = (bootstrap: ZaiBootstrap, params: SendParams, research: boolean): TurnPlan => {
  const model = resolveModel(bootstrap, params.model_id);
  const available = bootstrap.serversByModel.get(model.id) ?? [];

  if (params.thinking === true && !model.capabilities.thinking.supported)
    throw ToolError.validation(
      `Model "${model.id}" has no Deep Think mode. Models that do: ${bootstrap.models
        .filter(entry => entry.capabilities.thinking.supported)
        .map(entry => entry.id)
        .join(', ')}.`,
    );
  assertEffortSupported(model, params.thinking_level);

  if (params.search === true && !model.capabilities.web_search.supported)
    throw ToolError.validation(
      `Model "${model.id}" cannot search the web. Models that can: ${bootstrap.models
        .filter(entry => entry.capabilities.web_search.supported)
        .map(entry => entry.id)
        .join(', ')}.`,
    );

  const requestedServers = params.tools ?? [];
  const unknown = requestedServers.filter(name => !available.includes(name));
  if (unknown.length > 0)
    throw ToolError.validation(
      `Model "${model.id}" does not publish tool(s) ${unknown.join(', ')}. Valid tools for this model: ${
        available.join(', ') || '(none)'
      }.`,
    );

  if (research && !model.capabilities.deep_research.supported)
    throw ToolError.validation(
      `Model "${model.id}" does not offer deep research. Models that do: ${bootstrap.models
        .filter(entry => entry.capabilities.deep_research.supported)
        .map(entry => entry.id)
        .join(', ')}.`,
    );

  const mcpServers = new Set(requestedServers);
  if (research) mcpServers.add(DEEP_RESEARCH_SERVER);
  if (params.search === true && available.includes(WEB_SEARCH_SERVER)) mcpServers.add(WEB_SEARCH_SERVER);

  // Deep Think defaults on wherever the model has it, matching the composer.
  const thinkingEnabled = (params.thinking ?? model.capabilities.thinking.supported) === true;
  const nativeEffort =
    thinkingEnabled && model.capabilities.thinking.levels !== null
      ? toNativeEffort(params.thinking_level ?? 'max')
      : null;

  return {
    model,
    thinkingEnabled,
    nativeEffort,
    autoWebSearch: params.search === true,
    mcpServers: [...mcpServers],
  };
};

const newChatBlob = (plan: TurnPlan, userMessageId: string, text: string, extra: Record<string, unknown>) => ({
  id: '',
  title: DEFAULT_TITLE,
  models: [plan.model.id],
  params: {},
  history: {
    messages: {
      [userMessageId]: {
        id: userMessageId,
        parentId: null,
        childrenIds: [],
        role: 'user',
        content: text,
        timestamp: nowSeconds(),
        models: [plan.model.id],
      },
    },
    currentId: userMessageId,
  },
  tags: [],
  flags: [],
  features: [HIDDEN_TOOL_SELECTOR],
  mcp_servers: plan.mcpServers,
  enable_thinking: plan.thinkingEnabled,
  ...(plan.nativeEffort ? { reasoning_effort: plan.nativeEffort } : {}),
  auto_web_search: plan.autoWebSearch,
  message_version: 1,
  extra,
  timestamp: Date.now(),
  type: 'default',
});

export interface PreparedTurn {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  parentId: string | null;
  plan: TurnPlan;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  /** Message ids that already existed, so the new turn can be isolated afterwards. */
  priorIds: Set<string>;
}

/**
 * Persists the user turn into the chat exactly as the web app does, then builds the
 * completion payload. Every validation has already run in `planTurn`.
 */
export const prepareTurn = async (
  params: SendParams,
  options: { conversationId?: string; research?: boolean; extra?: Record<string, unknown> } = {},
): Promise<PreparedTurn> => {
  if (!params.text.trim()) throw ToolError.validation('text must not be empty.');

  const bootstrap = await getBootstrap();
  const plan = planTurn(bootstrap, params, options.research === true);
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();

  let conversationId: string;
  let parentId: string | null = null;
  let history: { role: string; content: string }[] = [];
  let priorIds = new Set<string>();

  if (options.conversationId) {
    conversationId = options.conversationId;
    const detail = await getConversationDetail(conversationId);
    parentId = detail.chat?.history?.currentId ?? null;
    priorIds = new Set(Object.keys(detail.chat?.history?.messages ?? {}));

    // Rebuild the prompt context from the branch the page renders; z.ai's own
    // client sends the full message array rather than relying on chat_id alone.
    const prior = await loadConversationItems(detail, {
      includeReasoning: false,
      includeToolCalls: false,
      effort: null,
    });
    history = prior.items.flatMap(item =>
      item.type === 'message' && item.role !== 'system'
        ? [{ role: item.role, content: item.content.map(part => part.text).join('\n\n') }]
        : [],
    );

    const existing = detail.chat ?? {};
    const messages = { ...(existing.history?.messages ?? {}) };
    const parent = parentId ? messages[parentId] : undefined;
    if (parentId && parent)
      messages[parentId] = { ...parent, childrenIds: [...(parent.childrenIds ?? []), userMessageId] };
    messages[userMessageId] = {
      id: userMessageId,
      parentId,
      childrenIds: [],
      role: 'user',
      content: params.text,
      timestamp: nowSeconds(),
      models: [plan.model.id],
    };
    await api<RawChatDetail>(`/v1/chats/${encodeURIComponent(conversationId)}`, {
      method: 'POST',
      body: {
        chat: {
          ...existing,
          models: [plan.model.id],
          history: { messages, currentId: userMessageId },
          mcp_servers: plan.mcpServers,
          enable_thinking: plan.thinkingEnabled,
          ...(plan.nativeEffort ? { reasoning_effort: plan.nativeEffort } : {}),
          auto_web_search: plan.autoWebSearch,
          ...(options.extra ? { extra: { ...(existing.extra ?? {}), ...options.extra } } : {}),
        },
      },
    });
  } else {
    const created = await api<RawChatDetail>('/v1/chats/new', {
      method: 'POST',
      body: { chat: newChatBlob(plan, userMessageId, params.text, options.extra ?? {}) },
    });
    if (!created?.id)
      throw new ToolError('z.ai did not return a chat id for the new conversation.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    conversationId = created.id;
    if (params.project_id) await setConversationFolder(conversationId, params.project_id);
  }

  const messages = [...history, { role: 'user', content: params.text }];
  const isFirstTurn = history.length === 0;

  const body: Record<string, unknown> = {
    stream: true,
    model: plan.model.id,
    messages,
    signature_prompt: params.text,
    params: {},
    extra: {},
    features: {
      image_generation: false,
      // z.ai's own client pins this to false and drives search through
      // auto_web_search plus the MCP server list; sending true does nothing.
      web_search: false,
      auto_web_search: plan.autoWebSearch,
      preview_mode: false,
      flags: [],
      enable_thinking: plan.thinkingEnabled,
      ...(plan.nativeEffort ? { reasoning_effort: plan.nativeEffort } : {}),
    },
    variables: {},
    chat_id: conversationId,
    id: assistantMessageId,
    current_user_message_id: userMessageId,
    current_user_message_parent_id: parentId,
    ...(plan.mcpServers.length > 0 ? { mcp_servers: plan.mcpServers } : {}),
    ...(isFirstTurn ? { background_tasks: { title_generation: true, tags_generation: false } } : {}),
  };

  const headers: Record<string, string> = {
    'x-fe-version': getFrontendVersion(),
    authorization: `Bearer ${getBearerToken()}`,
  };
  if (bootstrap.config.features?.enable_captcha === true) body.captcha_verify_param = await mintCaptchaToken();

  return { conversationId, userMessageId, assistantMessageId, parentId, plan, body, headers, priorIds };
};

/** Reads back only the items this turn produced, so callers do not re-page history. */
export const collectTurn = async (
  prepared: PreparedTurn,
  params: SendParams,
  status: 'completed' | 'in_progress',
): Promise<SendResult> => {
  const detail = await getConversationDetail(prepared.conversationId);
  const allMessages = detail.chat?.history?.messages ?? {};
  const turnMessages = Object.fromEntries(Object.entries(allMessages).filter(([id]) => !prepared.priorIds.has(id)));
  // The filtered view deliberately keeps no leaf pointer: `resolveActivePath` then
  // orders by timestamp, which is what a single turn needs. Off-branch accounting
  // belongs to get_conversation, which sees the whole tree.
  const turnDetail: RawChatDetail = {
    ...detail,
    chat: { ...(detail.chat ?? {}), history: { messages: turnMessages } },
  };
  const mapped = await loadConversationItems(turnDetail, {
    includeReasoning: params.include_reasoning ?? false,
    includeToolCalls: params.include_tool_calls ?? false,
    effort: detail.chat?.reasoning_effort ?? null,
  });

  const assistant = [...mapped.items].reverse().find(item => item.type === 'message' && item.role === 'assistant');
  return {
    items: mapped.items,
    omitted: { ...mapped.omitted, hidden: 0 },
    conversation_id: prepared.conversationId,
    message_id: assistant?.id ?? prepared.assistantMessageId,
    model: detail.chat?.models?.[0] ?? prepared.plan.model.id,
    url: conversationUrl(prepared.conversationId),
    status: status === 'completed' && assistant ? 'completed' : 'in_progress',
  };
};

/**
 * Full send under a whole-handler budget.
 *
 * The OpenTabs adapter aborts a tool handler after 25s of *script execution*, and
 * that clock covers preparation too — model bootstrap, chat creation, the frontend
 * bundle read and the captcha round trip cost several seconds before a single token
 * is generated. Budgeting only the stream wait therefore still blew the limit and
 * returned a platform timeout with no result at all (observed live at 25000ms), so
 * the wait is whatever is left of HANDLER_BUDGET_MS after preparation, and never
 * negative.
 *
 * When the budget runs out the completion is left running in the page rather than
 * cancelled: the answer still persists server-side, so the caller polls
 * get_conversation while `status` is `in_progress`.
 */
export const sendTurn = async (params: SendParams, conversationId?: string): Promise<SendResult> => {
  const startedAt = Date.now();
  const prepared = await prepareTurn(params, { conversationId });
  let completionError: unknown;
  const completion = runCompletion(prepared.body, prepared.headers).then(
    () => 'completed' as const,
    (error: unknown) => {
      completionError = error;
      return 'failed' as const;
    },
  );
  const remaining = Math.max(0, HANDLER_BUDGET_MS - (Date.now() - startedAt));
  const outcome = await Promise.race([completion, sleep(remaining).then(() => 'in_progress' as const)]);
  if (outcome === 'failed') throw completionError;
  return collectTurn(prepared, params, outcome);
};

/** Fire-and-forget start used by deep research; the run persists server-side. */
export const startTurn = (prepared: PreparedTurn): void => startCompletion(prepared.body, prepared.headers);
