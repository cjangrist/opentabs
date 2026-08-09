import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
import { api, conversationUrl, nowSeconds } from './qwen-api.js';
import { HANDLER_BUDGET_MS, runCompletion, startCompletion } from './qwen-completions.js';
import { type RawChatDetail, getConversationDetail } from './qwen-conversations.js';
import { type MappedItems, mapConversation } from './qwen-messages.js';
import {
  CHAT_TYPE_DEEP_RESEARCH,
  CHAT_TYPE_SEARCH,
  CHAT_TYPE_TEXT,
  type QwenBootstrap,
  RESEARCH_MODE_NORMAL,
  SUB_CHAT_TYPE_DEEP_THINKING,
  THINKING_MODE_AUTO,
  THINKING_MODE_OFF,
  type ThinkingMode,
  assertSupportsChatType,
  assertToolsSupported,
  getBootstrap,
  resolveModel,
  resolveThinkingMode,
} from './qwen-models.js';
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
  title: string;
  url: string;
  status: 'completed' | 'in_progress';
}

interface TurnPlan {
  model: NormalizedModel;
  chatType: string;
  subChatType: string;
  thinkingMode: ThinkingMode;
  researchMode: string;
  tools: string[];
}

export interface TurnOptions {
  conversationId?: string;
  /** Deep research: the chat/sub-chat type pair to route the turn through. */
  chatType?: string;
  subChatType?: string;
  researchMode?: string;
}

/**
 * Resolves every caller option against the live model list, raising before a single
 * byte is sent upstream.
 *
 * Qwen routes features through `chat_type` rather than flags: a plain message is
 * "t2t", a web-searching one is "search", and deep research is "deep_research". The
 * model must publish the type in `meta.chat_type` or the completion is rejected.
 */
export const planTurn = (bootstrap: QwenBootstrap, params: SendParams, options: TurnOptions): TurnPlan => {
  const model = resolveModel(bootstrap, params.model_id);
  const research = options.chatType === CHAT_TYPE_DEEP_RESEARCH;
  const chatType = research ? CHAT_TYPE_DEEP_RESEARCH : params.search === true ? CHAT_TYPE_SEARCH : CHAT_TYPE_TEXT;
  assertSupportsChatType(model, chatType);

  const tools = params.tools ?? [];
  assertToolsSupported(bootstrap, model, tools);

  // Deep research runs its own pipeline and Qwen's composer disables the reasoning
  // toggle for it, so a thinking option there is rejected rather than ignored.
  if (research && (params.thinking !== undefined || params.thinking_level !== undefined))
    throw ToolError.validation(
      'Deep research does not use the reasoning toggle — Qwen disables it for deep_research chats. Use thinking_level on start_deep_research to pick the research effort (normal vs advance) instead.',
    );

  return {
    model,
    chatType,
    subChatType: options.subChatType ?? chatType,
    thinkingMode: research ? THINKING_MODE_OFF : resolveThinkingMode(model, params.thinking, params.thinking_level),
    researchMode: options.researchMode ?? RESEARCH_MODE_NORMAL,
    tools,
  };
};

/**
 * Builds the `feature_config` the SPA sends.
 *
 * `thinking_mode` is a closed enum — Fast | Auto | Thinking. Any other value makes
 * the completion endpoint hang instead of erroring, which is why it is only ever
 * produced by `resolveThinkingMode`.
 */
const buildFeatureConfig = (plan: TurnPlan): Record<string, unknown> => ({
  thinking_enabled: plan.thinkingMode !== THINKING_MODE_OFF,
  auto_thinking: plan.thinkingMode === THINKING_MODE_AUTO,
  thinking_mode: plan.thinkingMode,
  thinking_format: 'summary',
  output_schema: 'phase',
  research_mode: plan.researchMode,
  auto_search: plan.chatType !== CHAT_TYPE_TEXT,
  ...(plan.tools.length > 0 ? { mcp: plan.tools } : {}),
});

/** Creates an empty chat session, the same call the SPA makes before the first message. */
const createChatSession = async (plan: TurnPlan, projectId: string | undefined): Promise<string> => {
  const created = await api<{ id?: string }>('/v2/chats/new', {
    method: 'POST',
    body: {
      chatId: '',
      models: [plan.model.id],
      project_id: projectId ?? '',
      timestamp: Date.now(),
      chat_type: plan.chatType,
      chat_mode: 'normal',
    },
  });
  if (!created?.id)
    throw new ToolError('Qwen did not return a new chat id.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return created.id;
};

export interface PreparedTurn {
  conversationId: string;
  plan: TurnPlan;
  body: Record<string, unknown>;
  /** Message ids that already existed, so the new turn can be isolated afterwards. */
  priorIds: Set<string>;
}

/**
 * Builds the completion payload, creating a chat session first when none is given.
 *
 * Qwen keeps conversation history server side: only the new message is uploaded, and
 * `parentId` selects the branch it continues.
 */
export const prepareTurn = async (params: SendParams, options: TurnOptions = {}): Promise<PreparedTurn> => {
  if (!params.text.trim()) throw ToolError.validation('text must not be empty.');

  const bootstrap = await getBootstrap();
  const plan = planTurn(bootstrap, params, options);

  let conversationId: string;
  let parentId: string | null = null;
  let priorIds = new Set<string>();

  if (options.conversationId) {
    conversationId = options.conversationId;
    const detail = await getConversationDetail(conversationId);
    parentId = detail.chat?.history?.currentId ?? detail.currentId ?? null;
    priorIds = new Set(Object.keys(detail.chat?.history?.messages ?? {}));
  } else {
    conversationId = await createChatSession(plan, params.project_id);
  }

  const featureConfig = buildFeatureConfig(plan);
  const body: Record<string, unknown> = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chatId: conversationId,
    chat_id: conversationId,
    parentId: parentId ?? '',
    parent_id: parentId,
    chat_mode: 'normal',
    model: plan.model.id,
    messages: [
      {
        id: null,
        fid: crypto.randomUUID(),
        parentId,
        parent_id: parentId,
        childrenIds: [crypto.randomUUID()],
        role: 'user',
        content: params.text,
        user_action: 'chat',
        files: [],
        timestamp: nowSeconds(),
        models: [plan.model.id],
        model: '',
        chat_type: plan.chatType,
        sub_chat_type: plan.subChatType,
        feature_config: featureConfig,
        extra: { meta: { subChatType: plan.subChatType } },
      },
    ],
    timestamp: Date.now(),
  };

  return { conversationId, plan, body, priorIds };
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
  // The filtered view deliberately keeps no leaf pointer: resolveActivePath then
  // orders by timestamp, which is what a single turn needs. Off-branch accounting
  // belongs to get_conversation, which sees the whole tree.
  const turnDetail: RawChatDetail = {
    ...detail,
    chat: { ...(detail.chat ?? {}), messages: undefined, history: { messages: turnMessages } },
  };
  const mapped = mapConversation(turnDetail, {
    includeReasoning: params.include_reasoning ?? false,
    includeToolCalls: params.include_tool_calls ?? false,
  });

  const assistant = [...mapped.items].reverse().find(item => item.type === 'message' && item.role === 'assistant');
  return {
    items: mapped.items,
    omitted: { ...mapped.omitted, hidden: 0 },
    conversation_id: prepared.conversationId,
    message_id: assistant?.id ?? '',
    model: detail.chat?.models?.[0] ?? prepared.plan.model.id,
    title: detail.title ?? '',
    url: conversationUrl(prepared.conversationId),
    status: status === 'completed' && assistant ? 'completed' : 'in_progress',
  };
};

/**
 * Full send under a whole-handler budget.
 *
 * The OpenTabs adapter aborts a tool handler after 25s of script execution, and that
 * clock covers preparation too, so the wait is whatever is left of
 * HANDLER_BUDGET_MS after the model bootstrap and the chat-session POST — never
 * negative. When the budget runs out the completion is left running in the page
 * rather than cancelled: the answer still persists server-side, so the caller polls
 * get_conversation while `status` is `in_progress`.
 */
export const sendTurn = async (params: SendParams, options: TurnOptions = {}): Promise<SendResult> => {
  const startedAt = Date.now();
  const prepared = await prepareTurn(params, options);
  let completionError: unknown;
  const completion = runCompletion(prepared.conversationId, prepared.body).then(
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
export const startTurn = (prepared: PreparedTurn): void => startCompletion(prepared.conversationId, prepared.body);

export const DEEP_RESEARCH_TURN: TurnOptions = {
  chatType: CHAT_TYPE_DEEP_RESEARCH,
  subChatType: SUB_CHAT_TYPE_DEEP_THINKING,
};
