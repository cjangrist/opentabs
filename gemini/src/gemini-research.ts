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
import { resolveModel } from './gemini-models.js';
import { runResearchGenerate } from './gemini-send.js';
import { DEFAULT_CLARIFICATION_ANSWER, type ResearchStatus } from './tools/normalized-schemas.js';

const RPC_LIST_CONVERSATIONS = 'MaZiqc';
const RPC_CANCEL_RESEARCH = 'NkpXw';
const RPC_RESEARCH_AVAILABILITY = 'MyzX6c';
const PLAN_EXTENSION_KEY = '56';
const RESEARCH_EXTENSION_KEY = '58';
const POLL_INTERVAL_MS = 500;
const CONTROL_WAIT_MS = 2_000;

export interface ResearchAvailability {
  available: boolean;
  resetAt: number | null;
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
  if (bounded.length === 0) return { available: false, resetAt: null };
  const unavailable = bounded.filter(row => row[1] !== true);
  const resetAt = unavailable.map(row => tupleToUnixSeconds(row[4])).find(timestamp => timestamp > 0);
  return { available: unavailable.length === 0, resetAt: resetAt ?? null };
};

export interface ResearchPrefs {
  auto: boolean;
  answer: string;
  clarifyingQuestion: string | null;
  autoAnswered: boolean;
  cancelRequested: boolean;
}

const DEFAULT_PREFS: ResearchPrefs = {
  auto: true,
  answer: DEFAULT_CLARIFICATION_ANSWER,
  clarifyingQuestion: null,
  autoAnswered: false,
  cancelRequested: false,
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

const waitForPlan = async (prompt: string, knownIds: string[], deadline: number): Promise<GeminiTurn | null> => {
  while (Date.now() < deadline) {
    const ids = await topConversationIds();
    for (const id of ids) {
      if (knownIds.includes(id)) continue;
      const turn = await getLatestTurn(id);
      if (turn?.promptText === prompt) return turn;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
};

const waitForResearchTurn = async (conversationId: string, deadline: number): Promise<GeminiTurn | null> => {
  while (Date.now() < deadline) {
    const turn = await getLatestTurn(conversationId);
    if (hasExtension(turn, RESEARCH_EXTENSION_KEY)) return turn;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
};

export interface StartedResearch {
  researchId: string;
  status: ResearchStatus;
}

/**
 * Drives the exact two control turns emitted by Gemini's Deep Research chip.
 * Neither turn waits for the report itself, which continues server-side.
 */
export const startResearch = async (params: {
  text: string;
  modelId?: string;
  projectId?: string;
  autoAnswer: boolean;
  clarificationAnswer: string;
}): Promise<StartedResearch> => {
  if (params.projectId)
    throw ToolError.validation(
      'Gemini Deep Research cannot be filed into a project: this plugin does not expose Gemini Notebooks yet. Omit project_id.',
    );

  const availability = await getResearchAvailability();
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

  const model = await resolveModel(params.modelId);
  const tokens = getAuthTokens();
  const knownIds = await topConversationIds();
  await runResearchGenerate(params.text, tokens.atToken, tokens.bl, tokens.fsid, model, 'plan');

  const planTurn = await waitForPlan(params.text, knownIds, Date.now() + CONTROL_WAIT_MS);
  if (!planTurn)
    throw new ToolError(
      'Gemini accepted the Deep Research question but its plan conversation did not appear within the tool budget. Call list_conversations to locate the new chat.',
      'TIMEOUT',
      { category: 'timeout', retryable: true },
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

  writeResearchPrefs(planTurn.conversationId, {
    auto: params.autoAnswer,
    answer: params.clarificationAnswer,
    autoAnswered: false,
    clarifyingQuestion: null,
    cancelRequested: false,
  });

  const context: [string, string, string] = [planTurn.conversationId, planTurn.responseId, planTurn.responseChoiceId];
  await runResearchGenerate('Start research', tokens.atToken, tokens.bl, tokens.fsid, model, 'start', context);
  const researchTurn = await waitForResearchTurn(planTurn.conversationId, Date.now() + CONTROL_WAIT_MS);
  return {
    researchId: planTurn.conversationId,
    status: researchTurn?.researchReportText ? 'completed' : researchTurn ? 'running' : 'queued',
  };
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
  else if (prefs.cancelRequested) status = 'cancelled';
  else if (researchTurn) status = 'running';
  else status = 'queued';

  return {
    researchId: conversationId,
    conversationId,
    url: conversationUrl(conversationId),
    status,
    clarifyingQuestion: prefs.clarifyingQuestion,
    autoAnswered: prefs.autoAnswered,
    progress: {
      steps_completed: steps.length,
      current_step: status === 'running' ? (steps.at(-1) ?? null) : null,
      sources_found: activitySources.length,
    },
    items: mapTurnsToItems(turns, options).items,
    sources,
    error: null,
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
  writeResearchPrefs(snapshot.researchId, { cancelRequested: true });
  return { ...snapshot, status: 'cancelled' };
};
