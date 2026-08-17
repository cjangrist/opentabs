import { ToolError, getSessionStorage, setSessionStorage, sleep } from '@opentabs-dev/plugin-sdk';
import { api, conversationUrl } from './grok-api.js';
import { getRetainedCompletionRun } from './grok-completions.js';
import { getConversationMetadata } from './grok-conversations.js';
import { liveRunResponses, startGatewayRun, waitForGatewayRun, type GatewayRun } from './grok-gateway.js';
import {
  getConversationResponses,
  latestAssistantResponse,
  mapResponsesToItems,
  responseFileArtifacts,
  responseSources,
  type RawResponse,
} from './grok-messages.js';
import { DEFAULT_THINKING_MODE, resolveMode } from './grok-models.js';
import {
  newerResearchArtifactResponse,
  researchLineageResponses,
  researchResponseParentId,
} from './grok-research-lineage.js';
import {
  FILE_ARTIFACT_REPAIR_INSTRUCTION,
  hasFileArtifactInstruction,
  withFileArtifactInstruction,
} from './grok-research-prompt.js';
import { RunRetention } from './grok-run-retention.js';
import type { ResearchStatus, ResponseItem } from './tools/normalized-schemas.js';

const START_WAIT_MS = 15_000;
const CANCEL_ATTEMPTS = 12;
const CANCEL_DELAY_MS = 400;
const PERSIST_ATTEMPTS = 12;
const PERSIST_DELAY_MS = 400;
const RUN_RETENTION_MS = 1_800_000;
const MAX_ARTIFACT_REGENERATIONS = 3;
const MAX_ARTIFACT_REPAIRS = 1;
const ARTIFACT_REGENERATION_POLL_BUDGET_MS = 15_000;
const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_ARTIFACT_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_DOWNLOAD_TOTAL_BYTES = MAX_ARTIFACT_DOWNLOAD_BYTES;
const activeRuns = new RunRetention<GatewayRun>(RUN_RETENTION_MS);

interface ResearchPrefs {
  responseId: string;
  modelId: string;
  cancelled: boolean;
  cancellationOrigin: 'explicit' | 'recovered' | null;
  artifactRegenerationAttempts: number;
  artifactRepairAttempts: number;
  downloadedArtifactKeys: string[];
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
  downloadedFilenames: string[];
  hasFileArtifacts: boolean;
}

interface ResearchVisibility {
  includeReasoning: boolean;
  includeToolCalls: boolean;
  downloadFiles?: boolean;
}

const prefsKey = (researchId: string): string => `opentabs:grok:research:v2:${researchId}`;

const readPrefs = (researchId: string): ResearchPrefs | null => {
  const raw = getSessionStorage(prefsKey(researchId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ResearchPrefs>;
    if (typeof parsed.responseId !== 'string') return null;
    return {
      responseId: parsed.responseId,
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : '',
      cancelled: parsed.cancelled === true,
      cancellationOrigin:
        parsed.cancellationOrigin === 'explicit' || parsed.cancellationOrigin === 'recovered'
          ? parsed.cancellationOrigin
          : parsed.cancelled === true
            ? 'explicit'
            : null,
      artifactRegenerationAttempts:
        typeof parsed.artifactRegenerationAttempts === 'number' && parsed.artifactRegenerationAttempts >= 0
          ? parsed.artifactRegenerationAttempts
          : 0,
      artifactRepairAttempts:
        typeof parsed.artifactRepairAttempts === 'number' && parsed.artifactRepairAttempts >= 0
          ? parsed.artifactRepairAttempts
          : 0,
      downloadedArtifactKeys: Array.isArray(parsed.downloadedArtifactKeys)
        ? parsed.downloadedArtifactKeys.filter(key => typeof key === 'string')
        : [],
    };
  } catch {
    return null;
  }
};

const writePrefs = (researchId: string, prefs: ResearchPrefs): void =>
  setSessionStorage(prefsKey(researchId), JSON.stringify(prefs));

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
    throw new ToolError(`Grok did not persist research conversation ${researchId}.`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  const stored = readPrefs(researchId);
  if (stored) return stored;
  const history = await getConversationResponses(researchId);
  const lineageResponses = researchLineageResponses(history.responses, history.nodes);
  const hasResearchPrompt = lineageResponses.some(response => hasFileArtifactInstruction(response.message ?? ''));
  if (!hasResearchPrompt)
    throw ToolError.validation(
      `Conversation ${researchId} does not contain OpenTabs' exact research artifact instruction.`,
      'VALIDATION_ERROR',
    );
  const assistant = latestAssistantResponse(lineageResponses);
  const nativeState = (assistant?.state ?? assistant?.status ?? '').toLowerCase();
  const stillRunning =
    history.inflight.length > 0 || ['streaming', 'optimistic', 'reconnecting', 'running'].includes(nativeState);
  const recoveredCancellation = assistant?.partial === true && !stillRunning;
  const recovered = {
    responseId: assistant?.responseId ?? '',
    modelId:
      assistant?.requestMetadata?.model ?? assistant?.metadata?.request_metadata?.model ?? assistant?.model ?? '',
    cancelled: recoveredCancellation,
    cancellationOrigin: recoveredCancellation ? ('recovered' as const) : null,
    artifactRegenerationAttempts: 0,
    artifactRepairAttempts: 0,
    downloadedArtifactKeys: [],
  };
  writePrefs(researchId, recovered);
  return recovered;
};

const terminalStatus = (
  response: RawResponse | null,
  running: boolean,
  cancelled: boolean,
  activeError: ToolError | null,
  activeResponseId: string,
): ResearchStatus => {
  if (running) return 'running';
  if (response?.error || (response?.streamErrors ?? []).some(error => error.severity?.toLowerCase() === 'fatal'))
    return 'failed';
  if (activeError) {
    if (activeResponseId && response?.responseId === activeResponseId && response.partial !== true) return 'completed';
    return 'failed';
  }
  if (response && response.partial !== true) return 'completed';
  if (cancelled || response?.partial === true) return 'cancelled';
  return 'queued';
};

const withRetainedCompletionArtifacts = (response: RawResponse): RawResponse => {
  const retained = response.responseId ? getRetainedCompletionRun(response.responseId) : null;
  if (!retained) return response;
  const liveResponse = latestAssistantResponse(liveRunResponses(retained));
  if (!liveResponse || liveResponse.responseId !== response.responseId) return response;
  return {
    ...response,
    outputChunks: [...(response.outputChunks ?? []), ...(liveResponse.outputChunks ?? [])],
    cardAttachmentsJson: [...(response.cardAttachmentsJson ?? []), ...(liveResponse.cardAttachmentsJson ?? [])],
  };
};

const isGrokAssetUrl = (url: string): boolean => {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'grok.com' || hostname.endsWith('.grok.com');
  } catch {
    return false;
  }
};

const sizeLimitError = (filename: string, sizeBytes: number, maxBytes: number): ToolError =>
  new ToolError(
    `Grok's native file download for "${filename}" is ${sizeBytes} bytes, exceeding the ${maxBytes}-byte remaining safety limit.`,
    'UPSTREAM_ERROR',
    { category: 'internal', retryable: false },
  );

const readArtifactBody = async (result: Response, filename: string, maxBytes: number): Promise<Blob> => {
  const rawContentLength = result.headers.get('content-length');
  const contentLength = rawContentLength?.trim() ? Number(rawContentLength) : Number.NaN;
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes)
    throw sizeLimitError(filename, contentLength, maxBytes);
  if (!result.body)
    throw new ToolError(`Grok's native file download for "${filename}" has no readable body.`, 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });

  const chunks: ArrayBuffer[] = [];
  const reader = result.body.getReader();
  let sizeBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!chunk.value) continue;
    sizeBytes += chunk.value.byteLength;
    if (sizeBytes > maxBytes) {
      void reader.cancel().catch(() => {});
      throw sizeLimitError(filename, sizeBytes, maxBytes);
    }
    const bytes = new Uint8Array(chunk.value.byteLength);
    bytes.set(chunk.value);
    chunks.push(bytes.buffer);
  }
  return new Blob(chunks, { type: result.headers.get('content-type') ?? '' });
};

const downloadArtifacts = async (
  response: RawResponse,
  downloadedArtifactKeys: string[],
  recordDownloadedArtifact: (key: string) => void,
): Promise<string[]> => {
  const artifacts = responseFileArtifacts(response);
  const alreadyDownloaded = new Set(downloadedArtifactKeys);
  const artifactKey = (filename: string, url: string): string =>
    `${response.responseId ?? ''}\u0000${filename}\u0000${url}`;
  const downloads: Array<{ filename: string; blob: Blob; key: string }> = [];
  let totalDownloadBytes = 0;
  for (const artifact of artifacts) {
    const key = artifactKey(artifact.filename, artifact.url);
    if (alreadyDownloaded.has(key)) continue;
    const remainingBytes = MAX_ARTIFACT_DOWNLOAD_TOTAL_BYTES - totalDownloadBytes;
    if (artifact.sizeBytes !== null && artifact.sizeBytes > remainingBytes)
      throw sizeLimitError(artifact.filename, artifact.sizeBytes, remainingBytes);
    let result: Response;
    try {
      result = await fetch(artifact.url, {
        credentials: isGrokAssetUrl(artifact.url) ? 'include' : 'omit',
        signal: AbortSignal.timeout(ARTIFACT_DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ToolError(
        `Grok's native file download for "${artifact.filename}" did not complete: ${String(error).slice(0, 200)}`,
        'TIMEOUT',
        { category: 'timeout', retryable: true },
      );
    }
    if (!result.ok)
      throw new ToolError(
        `Grok's native file download failed for "${artifact.filename}" (${result.status} ${result.statusText}).`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: result.status >= 500 },
      );
    let blob: Blob;
    try {
      blob = await readArtifactBody(result, artifact.filename, remainingBytes);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        `Grok's native file download body for "${artifact.filename}" did not complete: ${String(error).slice(0, 200)}`,
        'TIMEOUT',
        { category: 'timeout', retryable: true },
      );
    }
    if (artifact.sizeBytes !== null && blob.size !== artifact.sizeBytes)
      throw new ToolError(
        `Grok's native file download for "${artifact.filename}" returned ${blob.size} bytes; its file card declares ${artifact.sizeBytes} bytes. The incomplete file was not saved.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      );
    totalDownloadBytes += blob.size;
    downloads.push({ filename: artifact.filename, blob, key });
  }
  for (const download of downloads) {
    const url = URL.createObjectURL(download.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = download.filename;
    anchor.style.display = 'none';
    (document.body ?? document.documentElement).append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    recordDownloadedArtifact(download.key);
  }
  return downloads.map(download => download.filename);
};

const snapshot = async (researchId: string, visibility: ResearchVisibility): Promise<ResearchSnapshot> => {
  let prefs = await ensureResearchConversation(researchId);
  const history = await getConversationResponses(researchId);
  const lineageResponses = researchLineageResponses(history.responses, history.nodes);
  const active = activeRuns.get(researchId);
  if (active?.responseId && active.responseId !== prefs.responseId) {
    prefs = { ...prefs, responseId: active.responseId, modelId: active.modelId };
    writePrefs(researchId, prefs);
  }
  const currentLineageResponse = lineageResponses.find(candidate => candidate.responseId === prefs.responseId);
  if (!currentLineageResponse && (!active || active.done || active.error)) {
    const fallbackResponse = latestAssistantResponse(lineageResponses);
    if (fallbackResponse?.responseId) {
      prefs = {
        ...prefs,
        responseId: fallbackResponse.responseId,
        modelId:
          fallbackResponse.requestMetadata?.model ??
          fallbackResponse.metadata?.request_metadata?.model ??
          fallbackResponse.model ??
          prefs.modelId,
      };
      writePrefs(researchId, prefs);
    }
  }
  const newerArtifactResponse =
    !active || active.done || active.error
      ? newerResearchArtifactResponse(
          history.responses.map(withRetainedCompletionArtifacts),
          history.nodes,
          prefs.responseId,
        )
      : null;
  if (newerArtifactResponse?.responseId) {
    prefs = {
      ...prefs,
      responseId: newerArtifactResponse.responseId,
      modelId:
        newerArtifactResponse.requestMetadata?.model ??
        newerArtifactResponse.metadata?.request_metadata?.model ??
        newerArtifactResponse.model ??
        prefs.modelId,
    };
    writePrefs(researchId, prefs);
  }
  const rawStoredResponse =
    lineageResponses.find(candidate => candidate.responseId === prefs.responseId) ??
    (!prefs.responseId || !active ? latestAssistantResponse(lineageResponses) : null);
  const storedResponse = rawStoredResponse ? withRetainedCompletionArtifacts(rawStoredResponse) : null;
  const liveResponses = active && !active.error ? liveRunResponses(active) : [];
  const liveResponse = latestAssistantResponse(liveResponses);
  const response =
    storedResponse && liveResponse && liveResponse.responseId === storedResponse.responseId
      ? {
          ...storedResponse,
          outputChunks: [...(storedResponse.outputChunks ?? []), ...(liveResponse.outputChunks ?? [])],
          cardAttachmentsJson: [
            ...(storedResponse.cardAttachmentsJson ?? []),
            ...(liveResponse.cardAttachmentsJson ?? []),
          ],
        }
      : (storedResponse ?? liveResponse);
  const running =
    history.inflight.some(candidate => !prefs.responseId || candidate.responseId === prefs.responseId) ||
    Boolean(active && !active.done && !active.error);
  if (prefs.cancelled && prefs.cancellationOrigin === 'recovered' && !running && response?.partial !== true) {
    prefs = { ...prefs, cancelled: false, cancellationOrigin: null };
    writePrefs(researchId, prefs);
  }
  const activeError = active?.error ?? null;
  const status = terminalStatus(response, running, prefs.cancelled, activeError, active?.responseId ?? '');
  const mapped = mapResponsesToItems(storedResponse ? lineageResponses : liveResponses, visibility);
  const responseLineageIndex = response?.responseId
    ? lineageResponses.findIndex(candidate => candidate.responseId === response.responseId)
    : -1;
  const sourceCandidates =
    responseLineageIndex >= 0
      ? lineageResponses.slice(0, responseLineageIndex + 1)
      : active?.responseId === response?.responseId
        ? lineageResponses
        : [];
  const priorResearchResponse =
    response &&
    responseSources(response).length === 0 &&
    (responseFileArtifacts(response).length > 0 || prefs.downloadedArtifactKeys.length > 0)
      ? [...sourceCandidates].reverse().find(candidate => responseSources(candidate).length > 0)
      : null;
  const researchResponse = priorResearchResponse ?? response;
  const sources = researchResponse ? responseSources(researchResponse) : [];
  const hasFileArtifacts =
    (response ? responseFileArtifacts(response).length > 0 : false) || prefs.downloadedArtifactKeys.length > 0;
  const steps = researchResponse?.steps ?? [];
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
        activeError?.message ??
        'Grok reported that DeepSearch failed.')
      : null;
  let downloadedFilenames: string[] = [];
  if (visibility.downloadFiles === true && status === 'completed' && response) {
    downloadedFilenames = await downloadArtifacts(response, prefs.downloadedArtifactKeys, key => {
      if (prefs.downloadedArtifactKeys.includes(key)) return;
      prefs = {
        ...prefs,
        downloadedArtifactKeys: [...prefs.downloadedArtifactKeys, key],
      };
      writePrefs(researchId, prefs);
    });
  }
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
    downloadedFilenames,
    hasFileArtifacts,
  };
};

const recoverMissingArtifact = async (researchId: string): Promise<GatewayRun> => {
  let prefs = await ensureResearchConversation(researchId);
  if (
    prefs.artifactRegenerationAttempts >= MAX_ARTIFACT_REGENERATIONS &&
    prefs.artifactRepairAttempts >= MAX_ARTIFACT_REPAIRS
  )
    throw new ToolError(
      `Grok completed research ${researchId} without a downloadable file artifact after ${MAX_ARTIFACT_REGENERATIONS} native regenerations and ${MAX_ARTIFACT_REPAIRS} focused attachment repair.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );
  const history = await getConversationResponses(researchId);
  const lineageResponses = researchLineageResponses(history.responses, history.nodes);
  const response =
    lineageResponses.find(candidate => candidate.responseId === prefs.responseId) ??
    latestAssistantResponse(lineageResponses);
  if (response?.responseId && response.responseId !== prefs.responseId) {
    prefs = { ...prefs, responseId: response.responseId };
    writePrefs(researchId, prefs);
  }
  const mode = await resolveMode({ modelId: DEFAULT_THINKING_MODE });
  const shouldRegenerate = prefs.artifactRegenerationAttempts < MAX_ARTIFACT_REGENERATIONS;
  let attempted: ResearchPrefs;
  let run: GatewayRun;
  if (shouldRegenerate) {
    const parentResponseId = response ? researchResponseParentId(response, history.nodes) : undefined;
    if (!parentResponseId)
      throw new ToolError(
        `Grok completed research ${researchId} without a downloadable file artifact, but its stored response has no regeneratable parent.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: false },
      );
    attempted = {
      ...prefs,
      artifactRegenerationAttempts: prefs.artifactRegenerationAttempts + 1,
    };
    run = startGatewayRun({
      text: '',
      modelId: mode.id,
      conversationId: researchId,
      regenerateParentResponseId: parentResponseId,
      search: true,
    });
  } else {
    if (!response?.responseId)
      throw new ToolError(
        `Grok completed research ${researchId} without a downloadable file artifact, but its stored response has no id for attachment repair.`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: false },
      );
    attempted = {
      ...prefs,
      artifactRepairAttempts: prefs.artifactRepairAttempts + 1,
    };
    run = startGatewayRun({
      text: FILE_ARTIFACT_REPAIR_INSTRUCTION,
      modelId: mode.id,
      conversationId: researchId,
      parentResponseId: response.responseId,
      search: false,
    });
  }
  writePrefs(researchId, attempted);
  const started = await waitForGatewayRun(run, current => Boolean(current.responseId), START_WAIT_MS);
  if (!started) {
    activeRuns.retain(researchId, run);
    throw new ToolError(
      `Grok accepted ${shouldRegenerate ? 'native regeneration' : 'focused attachment repair'} for research ${researchId} but did not publish its response id in time. Poll the same research; do not start a duplicate.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  }
  writePrefs(researchId, { ...attempted, responseId: run.responseId, modelId: mode.id });
  activeRuns.retain(researchId, run);
  return run;
};

export const startResearch = async (params: { text: string }): Promise<ResearchSnapshot> => {
  const text = params.text.trim();
  if (!text) throw ToolError.validation('A research question must contain non-whitespace text.', 'VALIDATION_ERROR');

  const mode = await resolveMode({ modelId: DEFAULT_THINKING_MODE });
  if (!mode.capabilities.web_search.supported)
    throw new ToolError(
      `Grok mode "${mode.id}" does not support the search tools required for research.`,
      'UNSUPPORTED',
      {
        category: 'validation',
        retryable: false,
      },
    );
  const run = startGatewayRun({
    text: withFileArtifactInstruction(text),
    modelId: mode.id,
    search: true,
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
        ? `Grok accepted research in conversation ${run.conversationId} but did not publish its response id in time. Do not start a duplicate; poll that conversation.`
        : 'Grok accepted research but did not publish a conversation id in time. Do not immediately retry; inspect Grok history.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  }

  const prefs: ResearchPrefs = {
    responseId: run.responseId,
    modelId: mode.id,
    cancelled: false,
    cancellationOrigin: null,
    artifactRegenerationAttempts: 0,
    artifactRepairAttempts: 0,
    downloadedArtifactKeys: [],
  };
  writePrefs(run.conversationId, prefs);
  activeRuns.retain(run.conversationId, run);

  return snapshot(run.conversationId, { includeReasoning: false, includeToolCalls: false });
};

export const readResearch = async (researchId: string, visibility: ResearchVisibility): Promise<ResearchSnapshot> => {
  let current = await snapshot(researchId, visibility);
  if (visibility.downloadFiles !== true) return current;
  const deadline = Date.now() + ARTIFACT_REGENERATION_POLL_BUDGET_MS;
  while (current.status === 'completed' && !current.hasFileArtifacts) {
    if (Date.now() >= deadline) return current;
    const run = await recoverMissingArtifact(researchId);
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining > 0) await waitForGatewayRun(run, candidate => candidate.done, remaining);
    for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
      current = await snapshot(researchId, visibility);
      if (current.status !== 'completed' || current.downloadedFilenames.length > 0) return current;
      if (Date.now() >= deadline) return current;
      await sleep(PERSIST_DELAY_MS);
    }
  }
  return current;
};

export const answerResearch = async (researchId: string, text: string): Promise<ResearchSnapshot> => {
  if (!text.trim()) throw ToolError.validation('Clarification text must not be blank.', 'VALIDATION_ERROR');
  await ensureResearchConversation(researchId);
  throw new ToolError(
    'Grok prompt-driven research has no native clarification gate. No message was sent.',
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
