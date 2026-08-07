import { ToolError } from '@opentabs-dev/plugin-sdk';
import { conversationUrl } from './chatgpt-api.js';
import {
  COMPLETION_WAIT_MS,
  applyPickerSelection,
  currentConversationId,
  openComposer,
  resolvePickerSelection,
  setComposerText,
  submitComposer,
  waitForGenerationToSettle,
  waitForSendAccepted,
} from './chatgpt-composer.js';
import { getConversationDetail, patchConversation } from './chatgpt-conversations.js';
import { type MappedItems, mapConversationToItems } from './chatgpt-messages.js';
import { getModelCatalog, resolveModelId, resolveThinkingEffort } from './chatgpt-models.js';
import { assertProjectId } from './chatgpt-projects.js';
import type { ResponseItem, ThinkingLevel } from './tools/normalized-schemas.js';

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

/** ChatGPT's composer tool set is fixed; a caller-supplied allow-list has nowhere to go. */
const rejectToolSelection = (tools: string[] | undefined): void => {
  if (tools && tools.length > 0)
    throw ToolError.validation(
      'chatgpt.com does not accept a per-message tool allow-list — the composer decides which built-in tools a model ' +
        'may use. Use start_deep_research for a research run. See list_capabilities().features.',
    );
};

/**
 * ChatGPT decides autonomously whether to search; the composer has no
 * per-message on/off switch that survives a send. Rejecting an explicit
 * `search` is better than pretending it is a control (SPEC §4).
 */
const rejectSearchSelection = (search: boolean | undefined): void => {
  if (search !== undefined)
    throw ToolError.validation(
      'chatgpt.com has no per-message web-search switch — the model searches autonomously whenever it judges it ' +
        'useful. Omit `search`. See list_capabilities().toggles, where web_search is reported controllable:false.',
    );
};

/** Applies model / thinking selection to the live composer. Every validation happens first. */
const prepareComposer = async (params: SendParams, conversationId: string | undefined): Promise<string> => {
  rejectToolSelection(params.tools);
  rejectSearchSelection(params.search);
  // Validate the project id before the conversation exists: the move happens
  // after the send, and a bad id would otherwise leave an orphaned chat behind.
  if (params.project_id) assertProjectId(params.project_id);

  const catalog = await getModelCatalog();
  const model = resolveModelId(catalog, params.model_id);
  const effort = resolveThinkingEffort(catalog, model, params.thinking, params.thinking_level);
  // Resolve the picker path BEFORE routing so an unreachable model fails without
  // touching the page.
  const selection =
    params.model_id !== undefined || params.thinking !== undefined || params.thinking_level !== undefined
      ? resolvePickerSelection(catalog, model, effort)
      : null;

  await openComposer(conversationId);
  if (selection) await applyPickerSelection(selection);
  return model;
};

/** Returns only the items produced by this turn, so callers do not re-read history. */
const collectTurn = async (
  conversationId: string,
  knownItemIds: Set<string>,
  params: SendParams,
  status: 'completed' | 'in_progress',
): Promise<SendResult> => {
  const detail = await getConversationDetail(conversationId);
  const mapped = mapConversationToItems(detail, {
    includeReasoning: params.include_reasoning ?? false,
    includeToolCalls: params.include_tool_calls ?? false,
    model: detail.default_model_slug ?? null,
  });
  const fresh = mapped.items.filter(item => !knownItemIds.has(item.id));
  const assistant = [...fresh].reverse().find(item => item.type === 'message' && item.role === 'assistant');
  return {
    items: fresh,
    omitted: mapped.omitted,
    conversation_id: conversationId,
    message_id: assistant?.id ?? '',
    model: detail.default_model_slug ?? '',
    url: conversationUrl(conversationId),
    status: status === 'completed' && assistant ? 'completed' : 'in_progress',
  };
};

const itemIdsOf = (items: ResponseItem[]): Set<string> => new Set(items.map(item => item.id));

/**
 * Full send. Drives the page composer, then stops *waiting* at
 * COMPLETION_WAIT_MS without cancelling the generation and reads back whatever
 * landed. The adapter aborts a handler at 25s with a platform-level timeout
 * that carries no result at all; returning early instead yields a well-formed
 * answer with `status: "in_progress"`, and the reply still lands server-side so
 * get_conversation returns it.
 */
export const sendTurn = async (params: SendParams, conversationId?: string): Promise<SendResult> => {
  const started = Date.now();
  const model = await prepareComposer(params, conversationId);

  let knownItemIds = new Set<string>();
  if (conversationId) {
    const before = await getConversationDetail(conversationId);
    knownItemIds = itemIdsOf(
      mapConversationToItems(before, { includeReasoning: true, includeToolCalls: true, model: null }).items,
    );
  }

  await setComposerText(params.text);
  submitComposer();
  const resolvedId = await waitForSendAccepted(conversationId);

  const remaining = COMPLETION_WAIT_MS - (Date.now() - started);
  const settled = remaining > 0 ? await waitForGenerationToSettle(remaining) : false;
  const result = await collectTurn(resolvedId, knownItemIds, params, settled ? 'completed' : 'in_progress');

  if (params.project_id && !conversationId) {
    const projectId = assertProjectId(params.project_id);
    await patchConversation(resolvedId, { gizmo_id: projectId, conversation_template_id: projectId });
  }
  return { ...result, model: result.model || model };
};

export const activeConversationId = currentConversationId;
