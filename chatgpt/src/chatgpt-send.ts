import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
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
import { type MappedItems, type OmittedCounts, mapConversationToItems } from './chatgpt-messages.js';
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

/** Everything the mapper filtered out of THIS turn, not out of the whole history. */
const subtractOmitted = (after: OmittedCounts, before: OmittedCounts): OmittedCounts => ({
  reasoning: Math.max(after.reasoning - before.reasoning, 0),
  tool_calls: Math.max(after.tool_calls - before.tool_calls, 0),
  hidden: Math.max(after.hidden - before.hidden, 0),
  empty: Math.max(after.empty - before.empty, 0),
});

const NOTHING_OMITTED: OmittedCounts = { reasoning: 0, tool_calls: 0, hidden: 0, empty: 0 };

/** Read-back budget carved out of COMPLETION_WAIT_MS so the turn is never returned empty. */
const READBACK_ATTEMPTS = 4;
const READBACK_INTERVAL_MS = 1200;
const READBACK_RESERVE_MS = READBACK_ATTEMPTS * READBACK_INTERVAL_MS + 1500;

/** Returns only the items produced by this turn, so callers do not re-read history. */
const collectTurn = async (
  conversationId: string,
  known: { itemIds: Set<string>; omitted: OmittedCounts },
  params: SendParams,
  status: 'completed' | 'in_progress',
): Promise<SendResult> => {
  // /backend-api/conversation lags the stream by a beat: read straight after the
  // wait and the turn that is visibly in the page is not in the payload yet,
  // which would return `items: []` for a send that plainly succeeded.
  let detail = await getConversationDetail(conversationId);
  let mapped = mapConversationToItems(detail, {
    includeReasoning: params.include_reasoning ?? false,
    includeToolCalls: params.include_tool_calls ?? false,
    model: detail.default_model_slug ?? null,
  });
  let fresh = mapped.items.filter(item => !known.itemIds.has(item.id));
  for (let attempt = 0; attempt < READBACK_ATTEMPTS && fresh.length === 0; attempt += 1) {
    await sleep(READBACK_INTERVAL_MS);
    detail = await getConversationDetail(conversationId);
    mapped = mapConversationToItems(detail, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
      model: detail.default_model_slug ?? null,
    });
    fresh = mapped.items.filter(item => !known.itemIds.has(item.id));
  }
  const assistant = [...fresh].reverse().find(item => item.type === 'message' && item.role === 'assistant');
  return {
    items: fresh,
    omitted: subtractOmitted(mapped.omitted, known.omitted),
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
  // z.string().min(1) lets "   " through, which reaches the composer, leaves the
  // send button disabled and surfaces as a cryptic composer timeout.
  if (params.text.trim().length === 0)
    throw ToolError.validation('`text` is empty — ChatGPT will not accept a blank or whitespace-only prompt.');
  const model = await prepareComposer(params, conversationId);

  let known = { itemIds: new Set<string>(), omitted: NOTHING_OMITTED };
  if (conversationId) {
    const before = await getConversationDetail(conversationId);
    // The visibility flags here must match the ones collectTurn uses, so the
    // omitted ledger it subtracts was counted over the same filter.
    const mappedBefore = mapConversationToItems(before, {
      includeReasoning: params.include_reasoning ?? false,
      includeToolCalls: params.include_tool_calls ?? false,
      model: null,
    });
    known = { itemIds: itemIdsOf(mappedBefore.items), omitted: mappedBefore.omitted };
  }

  await setComposerText(params.text);
  submitComposer();
  const resolvedId = await waitForSendAccepted(conversationId, COMPLETION_WAIT_MS - (Date.now() - started));

  const remaining = COMPLETION_WAIT_MS - (Date.now() - started) - READBACK_RESERVE_MS;
  const settled = remaining > 0 ? await waitForGenerationToSettle(remaining) : false;
  const result = await collectTurn(resolvedId, known, params, settled ? 'completed' : 'in_progress');

  if (params.project_id && !conversationId) {
    const projectId = assertProjectId(params.project_id);
    await patchConversation(resolvedId, { gizmo_id: projectId, conversation_template_id: projectId });
  }
  return { ...result, model: result.model || model };
};

export const activeConversationId = currentConversationId;
