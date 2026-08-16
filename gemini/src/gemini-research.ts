import { ToolError, getSessionStorage, setSessionStorage } from '@opentabs-dev/plugin-sdk';
import {
  asArray,
  asString,
  callRpc,
  conversationUrl,
  getAuthTokens,
  toConversationId,
  tupleToUnixSeconds,
} from './gemini-api.js';
import {
  type GeminiTurn,
  getConversationTurns,
  getLatestTurn,
  mapTurnsToItems,
  researchActivitySourcesOfTurn,
  researchSourcesOfTurn,
  researchStepsOfTurn,
} from './gemini-messages.js';
import { type ResolvedModel, resolveModel } from './gemini-models.js';
import { runResearchGenerate } from './gemini-send.js';
import type { ResearchStatus } from './tools/normalized-schemas.js';

const RPC_LIST_CONVERSATIONS = 'MaZiqc';
const RPC_CANCEL_RESEARCH = 'NkpXw';
const RPC_RESEARCH_AVAILABILITY = 'MyzX6c';
const PLAN_EXTENSION_KEY = '56';
const RESEARCH_EXTENSION_KEY = '58';
const POLL_INTERVAL_MS = 500;
const PLAN_DISCOVERY_WAIT_MS = 2_000;
const RESEARCH_AMBIGUOUS_ERROR = 'RESEARCH_CONFIRMATION_AMBIGUOUS';
const confirmationsInFlight = new Set<string>();

export interface ResearchAvailability {
  available: boolean;
  resetAt: number | null;
  /** False when MyzX6c published no recognizable bounded research-budget rows. */
  recognized: boolean;
}

/**
 * Selecting Deep Research makes MyzX6c publish all agent gates. Its bounded
 * research-budget rows flip false together and carry the same reset timestamp
 * when the UI renders "current usage limit". Reading that state first avoids
 * creating a dead ordinary chat whose HTTP-200 answer merely reports an error.
 */
export const getResearchAvailability = async (): Promise<ResearchAvailability> => {
  const data = await callRpc<unknown[]>(RPC_RESEARCH_AVAILABILITY, []);
  const bounded = asArray(data[1])
    .map(asArray)
    .filter(row => typeof row[2] === 'number' && row[2] > 1);
  if (bounded.length === 0) return { available: false, resetAt: null, recognized: false };
  const unavailable = bounded.filter(row => row[1] !== true && row[1] !== 1);
  const resetAt = unavailable.map(row => tupleToUnixSeconds(row[4])).find(timestamp => timestamp > 0);
  return { available: unavailable.length === 0, resetAt: resetAt ?? null, recognized: true };
};

export interface ResearchPrefs {
  planContext: [string, string, string] | null;
  modelId: string | null;
  clarifyingQuestion: string | null;
  autoAnswered: boolean;
  confirmationAmbiguous: boolean;
  cancelledResponseId: string | null;
}

const DEFAULT_PREFS: ResearchPrefs = {
  planContext: null,
  modelId: null,
  clarifyingQuestion: null,
  autoAnswered: false,
  confirmationAmbiguous: false,
  cancelledResponseId: null,
};

const prefsKey = (conversationId: string): string => `opentabs:gemini:research:${toConversationId(conversationId)}`;

export const readResearchPrefs = (conversationId: string): ResearchPrefs => {
  const raw = getSessionStorage(prefsKey(conversationId));
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ResearchPrefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
};

export const writeResearchPrefs = (conversationId: string, patch: Partial<ResearchPrefs>): ResearchPrefs => {
  const next = { ...readResearchPrefs(conversationId), ...patch };
  setSessionStorage(prefsKey(conversationId), JSON.stringify(next));
  return next;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const topConversationIds = async (): Promise<string[]> => {
  const data = await callRpc<unknown[]>(RPC_LIST_CONVERSATIONS, [10, null]);
  return asArray(data[2])
    .map(row => asString(asArray(row)[0]))
    .filter((id): id is string => id !== null);
};

const hasExtension = (turn: GeminiTurn | null, key: string): boolean =>
  turn !== null && turn.extensions !== null && key in turn.extensions;

const normalizePrompt = (value: string): string => value.trim().replace(/\s+/g, ' ');

const waitForPlan = async (prompt: string, knownIds: string[], deadline: number): Promise<GeminiTurn | null> => {
  const known = new Set(knownIds);
  const retryableReadErrors = new Map<string, ToolError>();
  while (Date.now() < deadline) {
    let ids: string[];
    try {
      ids = await topConversationIds();
      retryableReadErrors.delete('list');
    } catch (error) {
      if (!(error instanceof ToolError) || !error.retryable) throw error;
      retryableReadErrors.set('list', error);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const candidates = ids.filter(id => !known.has(id));
    const turns = await Promise.all(
      candidates.map(async id => {
        try {
          const turn = await getLatestTurn(id);
          retryableReadErrors.delete(id);
          return turn;
        } catch (error) {
          // MaZiqc can publish a conversation shell before hNvQHb can read its
          // turn. Treat that as persistence lag and retry it on the next pass.
          if (error instanceof ToolError && (error.code === 'NOT_FOUND' || error.retryable)) {
            retryableReadErrors.set(id, error);
            return null;
          }
          throw error;
        }
      }),
    );
    const plans: GeminiTurn[] = [];
    for (const turn of turns) {
      if (hasExtension(turn, PLAN_EXTENSION_KEY) && turn) plans.push(turn);
    }
    const matching = plans.filter(turn => normalizePrompt(turn.promptText) === normalizePrompt(prompt));
    if (matching.length === 1) return matching[0] ?? null;
    if (matching.length > 1) {
      throw new ToolError(
        `Gemini created multiple new Deep Research plans for the same prompt (${matching.map(turn => turn.conversationId).join(', ')}), so the adapter refused to confirm the wrong one.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: false },
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const lastRetryableReadError = [...retryableReadErrors.values()].at(-1);
  if (lastRetryableReadError)
    throw new ToolError(
      `Gemini accepted the Deep Research question, but plan discovery remained unavailable. A plan may still exist; call list_conversations instead of starting a duplicate. Last read error: ${lastRetryableReadError.message}`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  return null;
};

export interface StartedResearch {
  researchId: string;
  status: ResearchStatus;
}

const ambiguousConfirmationError = (conversationId: string, error: unknown): ToolError => {
  const detail = error instanceof Error ? error.message : 'unknown transport failure';
  return new ToolError(
    `Gemini may have accepted the Start research confirmation for ${conversationId}. Do not start a duplicate; poll or cancel that conversation id instead. Transport detail: ${detail}`,
    'UPSTREAM_ERROR',
    { category: 'internal', retryable: false },
  );
};

const isAmbiguousConfirmationError = (error: unknown): boolean =>
  !(error instanceof ToolError) || error.code === 'TIMEOUT' || error.code === RESEARCH_AMBIGUOUS_ERROR;

const sameContext = (left: [string, string, string] | null, right: [string, string, string]): boolean =>
  left?.every((value, index) => value === right[index]) === true;

const confirmResearchPlan = async (params: {
  conversationId: string;
  context: [string, string, string];
  model: ResolvedModel;
  autoAnswered: boolean;
}): Promise<void> => {
  if (confirmationsInFlight.has(params.conversationId))
    throw new ToolError(
      `Gemini research ${params.conversationId} already has a plan confirmation in flight. Poll it before retrying.`,
      'CONFIRMATION_IN_PROGRESS',
      { category: 'internal', retryable: true },
    );
  confirmationsInFlight.add(params.conversationId);
  try {
    const currentPrefs = readResearchPrefs(params.conversationId);
    if (!sameContext(currentPrefs.planContext, params.context))
      throw ToolError.validation(
        `Gemini research ${params.conversationId} no longer has this plan confirmation pending. Poll before retrying.`,
      );

    const tokens = getAuthTokens();
    try {
      await runResearchGenerate(
        'Start research',
        tokens.atToken,
        tokens.bl,
        tokens.fsid,
        params.model,
        'start',
        params.context,
      );
    } catch (error) {
      if (!isAmbiguousConfirmationError(error)) {
        if (error instanceof ToolError)
          throw new ToolError(
            `${error.message} Research plan ${params.conversationId} remains parked; retry it with answer_deep_research rather than starting a duplicate.`,
            error.code,
            { category: error.category, retryable: error.retryable, retryAfterMs: error.retryAfterMs },
          );
        throw error;
      }
      writeResearchPrefs(params.conversationId, {
        planContext: null,
        clarifyingQuestion: null,
        autoAnswered: params.autoAnswered,
        confirmationAmbiguous: true,
      });
      throw ambiguousConfirmationError(params.conversationId, error);
    }
    writeResearchPrefs(params.conversationId, {
      planContext: null,
      modelId: null,
      clarifyingQuestion: null,
      autoAnswered: params.autoAnswered,
      confirmationAmbiguous: false,
      cancelledResponseId: null,
    });
  } finally {
    confirmationsInFlight.delete(params.conversationId);
  }
};

/**
 * Drives the exact two control turns emitted by Gemini's Deep Research chip.
 * Neither turn waits for the report itself, which continues server-side.
 */
export const startResearch = async (params: {
  text: string;
  modelId?: string;
  projectId?: string;
  autoAnswer: boolean;
}): Promise<StartedResearch> => {
  if (params.projectId)
    throw ToolError.validation(
      'Gemini Deep Research cannot be filed into a project: this plugin does not expose Gemini Notebooks yet. Omit project_id.',
    );

  const [availability, model] = await Promise.all([getResearchAvailability(), resolveModel(params.modelId)]);
  if (!availability.recognized)
    throw new ToolError(
      'Gemini published no recognizable Deep Research budget rows. The MyzX6c payload may have changed; refusing to misreport this as exhausted quota.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  if (!availability.available) {
    const reset = availability.resetAt ? ` It resets at ${new Date(availability.resetAt * 1000).toISOString()}.` : '';
    throw new ToolError(
      `Gemini reports that this account's Deep Research usage limit is exhausted.${reset}`,
      'RATE_LIMIT',
      {
        category: 'rate_limit',
        retryable: true,
      },
    );
  }

  const knownIds = await topConversationIds();
  const planTokens = getAuthTokens();
  let planTransportError: unknown = null;
  try {
    await runResearchGenerate(params.text, planTokens.atToken, planTokens.bl, planTokens.fsid, model, 'plan');
  } catch (error) {
    planTransportError = error;
  }

  const planTurn = await waitForPlan(params.text, knownIds, Date.now() + PLAN_DISCOVERY_WAIT_MS);
  if (!planTurn && planTransportError) throw planTransportError;
  if (!planTurn)
    throw new ToolError(
      'Gemini accepted the Deep Research question but its plan conversation did not appear within the tool budget. Call list_conversations to locate the new chat.',
      'TIMEOUT',
      { category: 'timeout', retryable: false },
    );
  if (!hasExtension(planTurn, PLAN_EXTENSION_KEY))
    throw new ToolError(
      `Gemini created ${planTurn.conversationId} but did not attach a Deep Research plan. The account may have exhausted its research quota; inspect that chat for Gemini's reason.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  if (!planTurn.responseChoiceId)
    throw new ToolError(
      `Gemini created research plan ${planTurn.conversationId} without a response choice id, so it cannot be confirmed.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );

  const context: [string, string, string] = [planTurn.conversationId, planTurn.responseId, planTurn.responseChoiceId];
  const clarifyingQuestion =
    planTurn.responseText || 'Review the generated Gemini research plan, then confirm to start research.';
  writeResearchPrefs(planTurn.conversationId, {
    planContext: context,
    modelId: model.id,
    clarifyingQuestion,
    autoAnswered: false,
    confirmationAmbiguous: false,
    cancelledResponseId: null,
  });
  if (!params.autoAnswer)
    return {
      researchId: planTurn.conversationId,
      status: 'clarifying',
    };

  await confirmResearchPlan({
    conversationId: planTurn.conversationId,
    context,
    model,
    autoAnswered: true,
  });
  return {
    researchId: planTurn.conversationId,
    status: 'queued',
  };
};

export const answerResearch = async (researchId: string): Promise<ResearchSnapshot> => {
  const snapshot = await readResearch(researchId, { includeReasoning: false, includeToolCalls: false });
  if (snapshot.status !== 'clarifying')
    throw ToolError.validation(
      `Gemini research ${snapshot.researchId} is "${snapshot.status}", not "clarifying" — there is no plan confirmation waiting for an answer.`,
    );
  const prefs = readResearchPrefs(snapshot.conversationId);
  if (!prefs.planContext || !prefs.modelId)
    throw new ToolError(
      `Gemini research ${snapshot.researchId} lost its session-scoped plan context and cannot be confirmed safely. Open that conversation and confirm it in the Gemini web UI; do not start a duplicate.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  let model: ResolvedModel;
  try {
    model = await resolveModel(prefs.modelId);
  } catch (error) {
    if (!(error instanceof ToolError) || error.code !== 'VALIDATION_ERROR') throw error;
    model = await resolveModel(undefined);
  }
  await confirmResearchPlan({
    conversationId: snapshot.conversationId,
    context: prefs.planContext,
    model,
    autoAnswered: false,
  });
  return readResearch(snapshot.conversationId, { includeReasoning: false, includeToolCalls: false });
};

export interface ResearchSnapshot {
  researchId: string;
  conversationId: string;
  url: string;
  status: ResearchStatus;
  clarifyingQuestion: string | null;
  autoAnswered: boolean;
  progress: { steps_completed: number; current_step: string | null; sources_found: number };
  items: ReturnType<typeof mapTurnsToItems>['items'];
  sources: ReturnType<typeof researchSourcesOfTurn>;
  error: string | null;
  researchTurn: GeminiTurn | null;
}

const newestTurnWithExtension = (turns: GeminiTurn[], key: string): GeminiTurn | null => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (hasExtension(turn ?? null, key)) return turn ?? null;
  }
  return null;
};

export const readResearch = async (
  researchId: string,
  options: { includeReasoning: boolean; includeToolCalls: boolean },
): Promise<ResearchSnapshot> => {
  const conversationId = toConversationId(researchId);
  const { turns } = await getConversationTurns(conversationId);
  const researchTurn = newestTurnWithExtension(turns, RESEARCH_EXTENSION_KEY);
  const planTurn = newestTurnWithExtension(turns, PLAN_EXTENSION_KEY);
  if (!researchTurn && !planTurn)
    throw new ToolError(
      `Gemini conversation ${conversationId} is not a Deep Research run. Pass the research_id returned by start_deep_research.`,
      'NOT_FOUND',
      { category: 'not_found' },
    );

  const prefs = readResearchPrefs(conversationId);
  const steps = researchTurn ? researchStepsOfTurn(researchTurn) : [];
  const activitySources = researchTurn ? researchActivitySourcesOfTurn(researchTurn) : [];
  const sources = researchTurn ? researchSourcesOfTurn(researchTurn) : [];
  let status: ResearchStatus;
  if (researchTurn?.researchReportText) status = 'completed';
  else if (researchTurn && prefs.cancelledResponseId === researchTurn.responseId) status = 'cancelled';
  else if (researchTurn) status = 'running';
  else if (planTurn && !prefs.autoAnswered && !prefs.confirmationAmbiguous) status = 'clarifying';
  else status = 'queued';

  return {
    researchId: conversationId,
    conversationId,
    url: conversationUrl(conversationId),
    status,
    clarifyingQuestion:
      status === 'clarifying'
        ? prefs.clarifyingQuestion ||
          planTurn?.responseText ||
          'Review the generated Gemini research plan, then confirm to start research.'
        : null,
    autoAnswered: prefs.autoAnswered,
    progress: {
      steps_completed: steps.length,
      current_step: status === 'running' ? (steps.at(-1) ?? null) : null,
      sources_found: activitySources.length,
    },
    items: mapTurnsToItems(turns, options).items,
    sources,
    error:
      !researchTurn && prefs.confirmationAmbiguous
        ? 'The Start research confirmation had an ambiguous transport result. Poll this conversation instead of starting a duplicate.'
        : null,
    researchTurn,
  };
};

/** Stop the task with the same RPC the native confirmation dialog issues. */
export const cancelResearch = async (researchId: string): Promise<ResearchSnapshot> => {
  const snapshot = await readResearch(researchId, { includeReasoning: false, includeToolCalls: false });
  if (snapshot.status !== 'running' || !snapshot.researchTurn)
    throw ToolError.validation(
      `Gemini research ${snapshot.researchId} is "${snapshot.status}", not "running" — there is no active task to cancel.`,
    );

  await callRpc(RPC_CANCEL_RESEARCH, [[snapshot.researchTurn.conversationId, snapshot.researchTurn.responseId], ['']]);
  writeResearchPrefs(snapshot.researchId, { cancelledResponseId: snapshot.researchTurn.responseId });
  return { ...snapshot, status: 'cancelled' };
};
