import { ToolError, getSessionStorage, setSessionStorage, sleep } from '@opentabs-dev/plugin-sdk';
import { DEEP_SEARCH_WORKSPACE_ID, api, conversationUrl } from './grok-api.js';
import { getConversationMetadata } from './grok-conversations.js';
import { liveRunResponses, startGatewayRun, waitForGatewayRun, type GatewayRun } from './grok-gateway.js';
import {
  getConversationResponses,
  latestAssistantResponse,
  mapResponsesToItems,
  responseSources,
  type RawResponse,
} from './grok-messages.js';
import { resolveResearchMode } from './grok-models.js';
import { getProjectRecord, settleProjectMembership } from './grok-projects.js';
import { RunRetention } from './grok-run-retention.js';
import type { ResearchStatus, ResponseItem } from './tools/normalized-schemas.js';

const START_WAIT_MS = 15_000;
const CANCEL_ATTEMPTS = 12;
const CANCEL_DELAY_MS = 400;
const PERSIST_ATTEMPTS = 12;
const PERSIST_DELAY_MS = 400;
const RUN_RETENTION_MS = 1_800_000;
const activeRuns = new RunRetention<GatewayRun>(RUN_RETENTION_MS);

interface ResearchPrefs {
  responseId: string;
  projectId: string | null;
  cancelled: boolean;
  cancellationOrigin: 'explicit' | 'recovered' | null;
}

export interface ResearchSnapshot {
  researchId: string;
  conversationId: string;
  status: ResearchStatus;
  clarifyingQuestion: string | null;
  autoAnswered: boolean;
  progress: { steps_completed: number; current_step: string | null; sources_found: number };
  items: ResponseItem[];
  sources: Array<{ title: string; url: string; snippet: string | null }>;
  error: string | null;
}

const prefsKey = (researchId: string): string => `opentabs:grok:research:${researchId}`;

const readPrefs = (researchId: string): ResearchPrefs | null => {
  const raw = getSessionStorage(prefsKey(researchId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ResearchPrefs>;
    if (typeof parsed.responseId !== 'string') return null;
    return {
      responseId: parsed.responseId,
      projectId: parsed.projectId ?? null,
      cancelled: parsed.cancelled === true,
      cancellationOrigin:
        parsed.cancellationOrigin === 'explicit' || parsed.cancellationOrigin === 'recovered'
          ? parsed.cancellationOrigin
          : parsed.cancelled === true
            ? 'explicit'
            : null,
    };
  } catch {
    return null;
  }
};

const writePrefs = (researchId: string, prefs: ResearchPrefs): void =>
  setSessionStorage(prefsKey(researchId), JSON.stringify(prefs));

const workspaceIdsOf = (conversation: Awaited<ReturnType<typeof getConversationMetadata>>): string[] => [
  ...(conversation.workspaceId ? [conversation.workspaceId] : []),
  ...(conversation.workspaces ?? []).flatMap(workspace =>
    typeof workspace === 'string' ? [workspace] : workspace.workspaceId ? [workspace.workspaceId] : [],
  ),
];

const ensureResearchConversation = async (researchId: string): Promise<ResearchPrefs> => {
  let conversation: Awaited<ReturnType<typeof getConversationMetadata>> | null = null;
  for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
    try {
      conversation = await getConversationMetadata(researchId);
      break;
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== 'NOT_FOUND' || attempt === PERSIST_ATTEMPTS - 1) throw error;
      await sleep(PERSIST_DELAY_MS);
    }
  }
  if (!conversation)
    throw new ToolError(`Grok did not persist DeepSearch conversation ${researchId}.`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  const stored = readPrefs(researchId);
  if (stored) return stored;
  if (!workspaceIdsOf(conversation).includes(DEEP_SEARCH_WORKSPACE_ID))
    throw ToolError.validation(
      `Conversation ${researchId} was not created from Grok's native DeepSearch template.`,
      'VALIDATION_ERROR',
    );
  const history = await getConversationResponses(researchId);
  const assistant = latestAssistantResponse(history.responses);
  const nativeState = (assistant?.state ?? assistant?.status ?? '').toLowerCase();
  const stillRunning =
    history.inflight.length > 0 || ['streaming', 'optimistic', 'reconnecting', 'running'].includes(nativeState);
  const recoveredCancellation = assistant?.partial === true && !stillRunning;
  const recovered = {
    responseId: assistant?.responseId ?? '',
    projectId: null,
    cancelled: recoveredCancellation,
    cancellationOrigin: recoveredCancellation ? ('recovered' as const) : null,
  };
  writePrefs(researchId, recovered);
  return recovered;
};

const terminalStatus = (response: RawResponse | null, running: boolean, cancelled: boolean): ResearchStatus => {
  if (running) return 'running';
  if (response?.error || (response?.streamErrors ?? []).some(error => error.severity?.toLowerCase() === 'fatal'))
    return 'failed';
  if (response && response.partial !== true) return 'completed';
  if (cancelled || response?.partial === true) return 'cancelled';
  return 'queued';
};

const snapshot = async (
  researchId: string,
  visibility: { includeReasoning: boolean; includeToolCalls: boolean },
): Promise<ResearchSnapshot> => {
  const prefs = await ensureResearchConversation(researchId);
  const history = await getConversationResponses(researchId);
  const storedResponse =
    history.responses.find(candidate => candidate.responseId === prefs.responseId) ??
    latestAssistantResponse(history.responses);
  const active = activeRuns.get(researchId);
  const liveResponses = active && !active.error ? liveRunResponses(active) : [];
  const response = storedResponse ?? latestAssistantResponse(liveResponses);
  const running =
    history.inflight.some(candidate => !prefs.responseId || candidate.responseId === prefs.responseId) ||
    (!storedResponse && Boolean(active && !active.done && !active.error));
  if (prefs.cancelled && prefs.cancellationOrigin === 'recovered' && !running && response?.partial !== true)
    writePrefs(researchId, { ...prefs, cancelled: false, cancellationOrigin: null });
  const status = terminalStatus(response, running, prefs.cancelled);
  const mapped = mapResponsesToItems(storedResponse ? history.responses : liveResponses, visibility);
  const sources = response ? responseSources(response) : [];
  const steps = response?.steps ?? [];
  const currentStep =
    status === 'running'
      ? [...steps]
          .reverse()
          .find(step => (step.tags ?? []).includes('header'))
          ?.text?.filter(Boolean)
          .join('\n') || 'Researching'
      : null;
  const failure =
    status === 'failed'
      ? (response?.error ??
        response?.streamErrors
          ?.map(error => error.message)
          .filter(Boolean)
          .join('; ') ??
        'Grok reported that DeepSearch failed.')
      : null;
  return {
    researchId,
    conversationId: researchId,
    status,
    clarifyingQuestion: null,
    autoAnswered: false,
    progress: {
      steps_completed: steps.filter(step => (step.tags ?? []).some(tag => tag !== 'raw_function_result')).length,
      current_step: currentStep,
      sources_found: sources.length,
    },
    items: mapped.items,
    sources,
    error: failure,
  };
};

export const startResearch = async (params: {
  text: string;
  modelId?: string;
  projectId?: string;
}): Promise<ResearchSnapshot> => {
  const text = params.text.trim();
  if (!text) throw ToolError.validation('A DeepSearch question must contain non-whitespace text.', 'VALIDATION_ERROR');

  const [mode, template, project] = await Promise.all([
    resolveResearchMode(params.modelId),
    getProjectRecord(DEEP_SEARCH_WORKSPACE_ID),
    params.projectId ? getProjectRecord(params.projectId) : Promise.resolve(null),
  ]);
  if (template.isReadonly !== true || template.preferredModel !== mode.id)
    throw new ToolError(
      "Grok's native DeepSearch template no longer advertises the expected read-only research mode.",
      'UNSUPPORTED',
      { category: 'validation', retryable: false },
    );

  const workspaceIds = [DEEP_SEARCH_WORKSPACE_ID];
  if (project?.workspaceId) workspaceIds.push(project.workspaceId);
  const run = startGatewayRun({
    text,
    modelId: mode.id,
    search: true,
    workspaceIds,
  });
  const started = await waitForGatewayRun(
    run,
    current => Boolean(current.conversationId && current.responseId && current.messageId),
    START_WAIT_MS,
  );
  if (!started) {
    if (run.conversationId) activeRuns.retain(run.conversationId, run);
    throw new ToolError(
      run.conversationId
        ? `Grok accepted DeepSearch in conversation ${run.conversationId} but did not publish its response id in time. Do not start a duplicate; poll that conversation.`
        : 'Grok accepted DeepSearch but did not publish a conversation id in time. Do not immediately retry; inspect Grok history.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  }

  const prefs: ResearchPrefs = {
    responseId: run.responseId,
    projectId: project?.workspaceId ?? null,
    cancelled: false,
    cancellationOrigin: null,
  };
  writePrefs(run.conversationId, prefs);
  activeRuns.retain(run.conversationId, run);

  if (project?.workspaceId && !(await settleProjectMembership(project.workspaceId, run.conversationId, true)))
    throw new ToolError(
      `Grok started DeepSearch ${run.conversationId}, but did not verify membership in Project ${project.workspaceId}. Do not start a duplicate; move that conversation explicitly.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );

  return snapshot(run.conversationId, { includeReasoning: false, includeToolCalls: false });
};

export const readResearch = (
  researchId: string,
  visibility: { includeReasoning: boolean; includeToolCalls: boolean },
): Promise<ResearchSnapshot> => snapshot(researchId, visibility);

export const answerResearch = async (researchId: string, text: string): Promise<ResearchSnapshot> => {
  if (!text.trim()) throw ToolError.validation('Clarification text must not be blank.', 'VALIDATION_ERROR');
  await ensureResearchConversation(researchId);
  throw new ToolError(
    'Grok DeepSearch launches directly and has no native clarification gate. No message was sent.',
    'UNSUPPORTED',
    { category: 'validation', retryable: false },
  );
};

export const cancelResearch = async (
  researchId: string,
): Promise<{ snapshot: ResearchSnapshot; cancelled: boolean }> => {
  const prefs = await ensureResearchConversation(researchId);
  const before = await snapshot(researchId, { includeReasoning: false, includeToolCalls: false });
  if (['completed', 'failed', 'cancelled'].includes(before.status))
    return { snapshot: before, cancelled: before.status === 'cancelled' };

  await api<void>(`/app-chat/conversations/${encodeURIComponent(researchId)}/stop-inflight-responses`, {
    method: 'POST',
  });
  writePrefs(researchId, { ...prefs, cancelled: true, cancellationOrigin: 'explicit' });
  const run = activeRuns.get(researchId);
  if (run && !run.done && !run.error) run.close();

  let current = await snapshot(researchId, { includeReasoning: false, includeToolCalls: false });
  for (let attempt = 1; attempt < CANCEL_ATTEMPTS && current.status === 'running'; attempt += 1) {
    await sleep(CANCEL_DELAY_MS);
    current = await snapshot(researchId, { includeReasoning: false, includeToolCalls: false });
  }
  if (current.status === 'running')
    throw new ToolError(
      `Grok acknowledged cancellation for ${researchId}, but the native inflight record has not settled yet.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  return { snapshot: current, cancelled: current.status === 'cancelled' };
};

export const researchUrl = (researchId: string): string => conversationUrl(researchId);
