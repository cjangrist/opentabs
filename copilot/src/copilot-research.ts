import { ToolError, getSessionStorage, removeSessionStorage, setSessionStorage, sleep } from '@opentabs-dev/plugin-sdk';
import {
  ORIGIN,
  closeGatewayRun,
  getApi,
  sendGatewayTaskCancel,
  startGatewayTurn,
  type GatewayRun,
  waitForGatewayRun,
} from './copilot-api.js';
import { createEmptyConversation, getConversationHistory } from './copilot-conversations.js';
import { resolveResearchModel } from './copilot-models.js';
import { collectProjectConversationIndex, getProjectRecord } from './copilot-projects.js';
import type { ResearchStatus, ResponseItem } from './tools/normalized-schemas.js';

const START_WAIT_MS = 18_000;
const START_READ_ATTEMPTS = 4;
const START_READ_DELAY_MS = 500;
const CANCEL_ACK_WAIT_MS = 5_000;
const CANCEL_SETTLE_ATTEMPTS = 16;
const CANCEL_SETTLE_DELAY_MS = 500;
const MAX_RECOVERY_PAGES = 200;
const RECOVERY_BUDGET_MS = 15_000;
const RESEARCH_RUN_RETENTION_MS = 1_800_000;
const activeResearchRuns = new Map<string, GatewayRun>();
const activeResearchRunTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Closes and unregisters the retained gateway run for one research task. */
const releaseResearchRun = (researchId: string): void => {
  clearTimeout(activeResearchRunTimers.get(researchId));
  activeResearchRunTimers.delete(researchId);
  const run = activeResearchRuns.get(researchId);
  if (run) closeGatewayRun(run);
  activeResearchRuns.delete(researchId);
};

const retainResearchRun = (researchId: string, run: GatewayRun): void => {
  releaseResearchRun(researchId);
  activeResearchRuns.set(researchId, run);
  activeResearchRunTimers.set(
    researchId,
    setTimeout(() => {
      if (activeResearchRuns.get(researchId) === run) releaseResearchRun(researchId);
    }, RESEARCH_RUN_RETENTION_MS),
  );
};

interface RawUserUsage {
  remainingUsage?: { researchCalls?: number | null };
}

interface RawResearchContent {
  type?: 'query' | 'chainOfThought' | 'citation';
  text?: string;
  title?: string;
  url?: string;
}

interface RawInlineCitation {
  title?: string;
  url?: string;
  position?: number;
  publisher?: string | null;
  snippet?: string | null;
}

export interface RawResearchTask {
  type?: string;
  id?: string;
  title?: string | null;
  prompt?: string;
  contents?: RawResearchContent[] | null;
  inlineCitations?: RawInlineCitation[] | null;
  partialOutput?: string[] | null;
  finalResponse?: string | null;
  summary?: string | null;
  progress?: { completion?: number; step?: string } | null;
  status?: string;
  updatedAt?: string;
  error?: string | { message?: string } | null;
}

interface ResearchPrefs {
  conversationId: string;
  projectId: string | null;
  clientSessionId: string | null;
  autoAnswered: boolean;
  clarifyingQuestion: string | null;
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

const prefsKey = (researchId: string): string => `opentabs:copilot:research:${researchId}`;

const readPrefs = (researchId: string): ResearchPrefs | null => {
  const raw = getSessionStorage(prefsKey(researchId));
  if (!raw) return null;
  try {
    const prefs = JSON.parse(raw) as Partial<ResearchPrefs>;
    return typeof prefs.conversationId === 'string'
      ? {
          conversationId: prefs.conversationId,
          projectId: prefs.projectId ?? null,
          clientSessionId: prefs.clientSessionId ?? null,
          autoAnswered: prefs.autoAnswered === true,
          clarifyingQuestion: prefs.clarifyingQuestion ?? null,
        }
      : null;
  } catch {
    return null;
  }
};

const writePrefs = (researchId: string, prefs: ResearchPrefs): void =>
  setSessionStorage(prefsKey(researchId), JSON.stringify(prefs));

export const getResearchQuota = async (): Promise<number | null> => {
  const user = await getApi<RawUserUsage>('/user?api-version=4');
  const value = user.remainingUsage?.researchCalls;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export const researchUrl = (researchId: string): string => `${ORIGIN}/research/${researchId}`;

const taskStatus = (task: RawResearchTask): ResearchStatus => {
  switch (task.status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'running':
      return 'running';
    case 'pending':
      return (task.progress?.completion ?? 0) > 0 || !['start', 'preplan', undefined].includes(task.progress?.step)
        ? 'running'
        : 'queued';
    default:
      return 'running';
  }
};

const fetchTask = async (researchId: string): Promise<RawResearchTask> => {
  const task = await getApi<RawResearchTask>(`/tasks/${encodeURIComponent(researchId)}`);
  if (!task.id || task.type !== 'research')
    throw ToolError.notFound(`Copilot has no Deep Research task with id "${researchId}".`, 'NOT_FOUND');
  return task;
};

interface RawConversationPage {
  results?: Array<{ id?: string }>;
  next?: string | null;
}

/** Reconstructs task-to-conversation identity after adapter/session state loss. */
const recoverConversationId = async (researchId: string): Promise<string> => {
  const deadline = Date.now() + RECOVERY_BUDGET_MS;
  const checked = new Set<string>();
  const deferred = new Set<string>();
  const findInCandidates = async (candidateIds: string[]): Promise<string | null> => {
    let nextIndex = 0;
    let found: string | null = null;
    const workers = Array.from({ length: Math.min(5, candidateIds.length) }, async () => {
      while (!found && Date.now() < deadline && nextIndex < candidateIds.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const conversationId = candidateIds[currentIndex];
        if (!conversationId || checked.has(conversationId)) continue;
        checked.add(conversationId);
        try {
          const history = await getConversationHistory(conversationId);
          const containsTask = history.messages.some(message =>
            (message.content ?? []).some(part => part.type === 'task' && part.task?.id === researchId),
          );
          if (containsTask) found = conversationId;
          deferred.delete(conversationId);
        } catch (error) {
          if (!(error instanceof ToolError) || (!error.retryable && error.code !== 'NOT_FOUND')) throw error;
          if (error.retryable) {
            checked.delete(conversationId);
            deferred.add(conversationId);
          }
        }
      }
    });
    await Promise.all(workers);
    return found;
  };

  const projectIndex = await collectProjectConversationIndex(deadline);
  const projectMatch = await findInCandidates(
    projectIndex.conversations.flatMap(({ row }) => (row.id ? [row.id] : [])),
  );
  if (projectMatch) return projectMatch;

  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_RECOVERY_PAGES; pageNumber += 1) {
    if (Date.now() >= deadline) break;
    const query = new URLSearchParams({ types: 'research' });
    if (cursor) query.set('cursor', cursor);
    const page = await getApi<RawConversationPage>(`/conversations?${query.toString()}`);
    const match = await findInCandidates((page.results ?? []).flatMap(row => (row.id ? [row.id] : [])));
    if (match) return match;
    if (!page.next || page.next === cursor || (page.results ?? []).length === 0) break;
    cursor = page.next;
  }
  let retriedDeferred = false;
  if (deferred.size > 0 && Date.now() < deadline) {
    retriedDeferred = true;
    const retryIds = [...deferred];
    deferred.clear();
    const retryMatch = await findInCandidates(retryIds);
    if (retryMatch) return retryMatch;
  }
  const transientNote =
    deferred.size > 0
      ? ` ${deferred.size} candidate(s) ${retriedDeferred ? 'failed twice transiently' : 'could not be retried before the deadline'}.`
      : '';
  throw new ToolError(
    `Copilot task ${researchId} exists, but its owning conversation could not be recovered within the bounded history scan.${transientNote} Retry from a Project or research tab that still has the task mapping.`,
    'UPSTREAM_ERROR',
    { category: 'internal', retryable: true },
  );
};

const resolvePrefs = async (researchId: string): Promise<ResearchPrefs> => {
  const stored = readPrefs(researchId);
  if (stored) return stored;
  const conversationId = await recoverConversationId(researchId);
  const recovered: ResearchPrefs = {
    conversationId,
    projectId: null,
    clientSessionId: null,
    autoAnswered: false,
    clarifyingQuestion: null,
  };
  writePrefs(researchId, recovered);
  return recovered;
};

const dedupeSources = (task: RawResearchTask) => {
  const inlineSources = (task.inlineCitations ?? []).map(citation => ({
    title: citation.title ?? '',
    url: citation.url ?? '',
    snippet: citation.snippet ?? null,
  }));
  const exploratorySources = (task.contents ?? [])
    .filter(content => content.type === 'citation')
    .map(content => ({ title: content.title ?? '', url: content.url ?? '', snippet: null }));
  const sources = inlineSources.some(source => Boolean(source.url)) ? inlineSources : exploratorySources;
  const seen = new Set<string>();
  return sources.filter(source => {
    if (!source.url || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
};

const hostnameOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const taskItems = (task: RawResearchTask, includeReasoning: boolean, includeToolCalls: boolean): ResponseItem[] => {
  const taskId = task.id ?? '';
  const items: ResponseItem[] = [];
  if (task.prompt)
    items.push({
      id: `${taskId}:prompt`,
      type: 'message',
      role: 'user',
      status: 'completed',
      created_at: 0,
      model: null,
      content: [{ type: 'input_text', text: task.prompt }],
    });

  const contents = task.contents ?? [];
  for (const [index, content] of contents.entries()) {
    if (content.type === 'chainOfThought' && content.text && includeReasoning)
      items.push({
        id: `${taskId}:reasoning:${index}`,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: content.text }],
        effort: 'research',
      });
    if (content.type === 'query' && content.text && includeToolCalls) {
      const nextQuery = contents.findIndex(
        (candidate, candidateIndex) => candidateIndex > index && candidate.type === 'query',
      );
      const end = nextQuery < 0 ? contents.length : nextQuery;
      const results = contents
        .slice(index + 1, end)
        .filter(candidate => candidate.type === 'citation' && Boolean(candidate.url))
        .map(candidate => ({
          title: candidate.title ?? '',
          url: candidate.url ?? '',
          snippet: null,
          site_name: hostnameOf(candidate.url),
        }));
      items.push({
        id: `${taskId}:query:${index}`,
        type: 'web_search_call',
        status: taskStatus(task) === 'completed' ? 'completed' : 'in_progress',
        action: { type: 'search', query: content.text, url: null },
        results,
      });
    }
  }

  const report = task.finalResponse || (task.partialOutput ?? []).join('');
  if (report) {
    const terminal = taskStatus(task);
    items.push({
      id: `${taskId}:report`,
      type: 'message',
      role: 'assistant',
      status: terminal === 'completed' ? 'completed' : terminal === 'failed' ? 'incomplete' : 'in_progress',
      created_at: 0,
      model: 'research',
      content: [
        {
          type: 'output_text',
          text: report,
          annotations: (task.inlineCitations ?? [])
            .filter(citation => Boolean(citation.url))
            .map(citation => {
              const position =
                Number.isInteger(citation.position) &&
                (citation.position as number) >= 0 &&
                (citation.position as number) <= report.length
                  ? (citation.position as number)
                  : null;
              return {
                type: 'url_citation' as const,
                url: citation.url ?? '',
                title: citation.title ?? '',
                start_index: position,
                end_index: position,
              };
            }),
        },
      ],
    });
  }
  return items;
};

const snapshotOf = (
  task: RawResearchTask,
  prefs: ResearchPrefs,
  includeReasoning: boolean,
  includeToolCalls: boolean,
): ResearchSnapshot => {
  const sources = dedupeSources(task);
  const status = taskStatus(task);
  return {
    researchId: task.id ?? '',
    conversationId: prefs.conversationId,
    status,
    clarifyingQuestion: prefs.clarifyingQuestion,
    autoAnswered: prefs.autoAnswered,
    progress: {
      steps_completed: (task.contents ?? []).filter(content => content.type !== 'citation').length,
      current_step: status === 'completed' ? null : (task.progress?.step ?? null),
      sources_found: sources.length,
    },
    items: taskItems(task, includeReasoning, includeToolCalls),
    sources,
    error:
      status === 'failed'
        ? typeof task.error === 'string'
          ? task.error
          : (task.error?.message ?? task.summary ?? 'Copilot reported that the Deep Research task failed.')
        : null,
  };
};

export const startResearch = async (params: {
  text: string;
  modelId?: string;
  projectId?: string;
  autoAnswer: boolean;
}): Promise<ResearchSnapshot> => {
  const text = params.text.trim();
  if (!text)
    throw ToolError.validation('A Deep Research question must contain non-whitespace text.', 'VALIDATION_ERROR');
  await resolveResearchModel(params.modelId);
  if (params.projectId) await getProjectRecord(params.projectId);
  const quota = await getResearchQuota();
  if (quota !== null && quota <= 0)
    throw ToolError.rateLimited(
      'Copilot reports that this account has no Deep Research runs remaining.',
      undefined,
      'RATE_LIMIT',
    );

  const conversationId = await createEmptyConversation(params.projectId);
  const run = startGatewayTurn({
    conversationId,
    modelId: 'research',
    prompt: text,
    keepOpenAfterDone: true,
  });
  const started = await waitForGatewayRun(run, current => Boolean(current.taskId) || current.done, START_WAIT_MS);
  if (!started || !run.taskId) {
    closeGatewayRun(run);
    throw new ToolError(
      run.done
        ? 'Copilot finished the research control turn without publishing a task id. Do not start a duplicate; inspect the new conversation instead.'
        : 'Copilot accepted the research request but did not publish a task id before the tool budget expired. Do not start a duplicate; inspect Tasks or the new conversation.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  }

  const prefs: ResearchPrefs = {
    conversationId,
    projectId: params.projectId ?? null,
    clientSessionId: run.clientSessionId,
    // Copilot launches research directly and has no native clarification gate.
    autoAnswered: false,
    clarifyingQuestion: null,
  };
  writePrefs(run.taskId, prefs);
  retainResearchRun(run.taskId, run);
  for (let attempt = 0; attempt < START_READ_ATTEMPTS; attempt += 1) {
    try {
      const snapshot = snapshotOf(await fetchTask(run.taskId), prefs, false, false);
      if (['completed', 'failed', 'cancelled'].includes(snapshot.status)) releaseResearchRun(run.taskId);
      return snapshot;
    } catch (error) {
      const missing = error instanceof ToolError && error.code === 'NOT_FOUND';
      if (!missing) {
        releaseResearchRun(run.taskId);
        throw error;
      }
      if (attempt < START_READ_ATTEMPTS - 1) await sleep(START_READ_DELAY_MS);
    }
  }
  return snapshotOf(
    { id: run.taskId, type: 'research', prompt: text, status: 'pending', progress: { completion: 0, step: 'start' } },
    prefs,
    false,
    false,
  );
};

export const readResearch = async (
  researchId: string,
  visibility: { includeReasoning: boolean; includeToolCalls: boolean },
): Promise<ResearchSnapshot> => {
  const task = await fetchTask(researchId);
  const prefs = await resolvePrefs(researchId);
  const snapshot = snapshotOf(task, prefs, visibility.includeReasoning, visibility.includeToolCalls);
  if (['completed', 'failed', 'cancelled'].includes(snapshot.status)) {
    releaseResearchRun(researchId);
  }
  return snapshot;
};

export const answerResearch = async (researchId: string, text: string): Promise<ResearchSnapshot> => {
  const prefs = readPrefs(researchId);
  if (!prefs?.clarifyingQuestion)
    throw ToolError.validation(
      'Copilot Deep Research launches directly and this run has no clarification waiting for an answer.',
      'VALIDATION_ERROR',
    );
  const answer = text.trim();
  if (!answer) throw ToolError.validation('Clarification text must not be blank.', 'VALIDATION_ERROR');
  const run = startGatewayTurn({ conversationId: prefs.conversationId, modelId: 'research', prompt: answer });
  await waitForGatewayRun(run, current => Boolean(current.taskId) || current.done, START_WAIT_MS);
  if (!run.taskId)
    throw new ToolError('Copilot did not start a research task after the clarification answer.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: false,
    });
  const nextPrefs = { ...prefs, autoAnswered: false };
  writePrefs(run.taskId, nextPrefs);
  removeSessionStorage(prefsKey(researchId));
  return snapshotOf(await fetchTask(run.taskId), nextPrefs, false, false);
};

export const cancelResearch = async (
  researchId: string,
): Promise<{ snapshot: ResearchSnapshot; cancelled: boolean }> => {
  let task = await fetchTask(researchId);
  const prefs = await resolvePrefs(researchId);
  const before = taskStatus(task);
  if (['completed', 'failed', 'cancelled'].includes(before)) {
    releaseResearchRun(researchId);
    return { snapshot: snapshotOf(task, prefs, false, false), cancelled: before === 'cancelled' };
  }

  const activeRun = activeResearchRuns.get(researchId);
  const sent = activeRun ? sendGatewayTaskCancel(activeRun, researchId) : false;
  if (!sent) {
    if (!prefs.clientSessionId)
      throw new ToolError(
        'Copilot binds cancellation to the live gateway session that started the Task. This run was recovered without that session identity and can still be polled, but cannot be cancelled safely.',
        'UNSUPPORTED',
        { category: 'validation', retryable: false },
      );
    const history = await getConversationHistory(prefs.conversationId);
    const cursor = history.messages
      .flatMap(message => message.content ?? [])
      .flatMap(part => (part.partId ? [part.partId] : []))
      .at(-1);
    releaseResearchRun(researchId);
    const resumedRun = startGatewayTurn({
      conversationId: prefs.conversationId,
      modelId: 'research',
      prompt: '',
      content: [{ type: 'command', command: { type: 'cancelTask', taskId: researchId } }],
      stopBeforeSend: true,
      clientSessionId: prefs.clientSessionId,
      cursor,
    });
    retainResearchRun(researchId, resumedRun);
    try {
      await waitForGatewayRun(resumedRun, current => current.received || current.done, CANCEL_ACK_WAIT_MS);
    } catch (error) {
      releaseResearchRun(researchId);
      throw error;
    }
  }

  for (let attempt = 0; attempt < CANCEL_SETTLE_ATTEMPTS; attempt += 1) {
    task = await fetchTask(researchId);
    const status = taskStatus(task);
    if (status === 'cancelled') {
      releaseResearchRun(researchId);
      return { snapshot: snapshotOf(task, prefs, false, false), cancelled: true };
    }
    if (status === 'completed' || status === 'failed') {
      releaseResearchRun(researchId);
      return { snapshot: snapshotOf(task, prefs, false, false), cancelled: false };
    }
    await sleep(CANCEL_SETTLE_DELAY_MS);
  }
  throw new ToolError(
    'Copilot accepted the cancel command, but the task did not settle to cancelled.',
    'UPSTREAM_ERROR',
    {
      category: 'internal',
      retryable: true,
    },
  );
};
