import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
import { ORIGIN, requireUserId } from './grok-api.js';
import type { RawResponse, RawWebSearchResult } from './grok-messages.js';

const RUN_TIMEOUT_MS = 1_200_000;
const IDLE_TIMEOUT_MS = 180_000;
const CHANNEL_RESPONSE = 'CHANNEL_ASSISTANT_RESPONSE';
const CHANNEL_NOTETAKER_HEADER = 'CHANNEL_ASSISTANT_NOTETAKER_HEADER';

interface GatewayTextChunk {
  text?: string;
  channel?: string;
}

interface GatewayChunk {
  text?: GatewayTextChunk;
  tool_result?: {
    web_search?: { webpages?: RawWebSearchResult[] };
  };
}

interface GatewayStreamError {
  kind?: string;
  message?: string;
  severity?: string;
  details?: { reason?: string };
  globalRateLimit?: unknown;
  usageLimitReached?: unknown;
  usagePoolExhausted?: unknown;
}

interface GatewayEvent {
  type?: string;
  event_id?: string;
  conversation?: { id?: string };
  response?: {
    id?: string;
    status?: string;
    status_details?: { reason?: string };
  };
  item?: { id?: string };
  chunk?: GatewayChunk;
  output?: {
    stream_error?: GatewayStreamError;
    tool_result?: { web_search?: { webpages?: RawWebSearchResult[] } };
    progress_report?: { message?: string };
  };
  title?: string;
  delta?: string;
  text?: string;
  search_result?: RawWebSearchResult;
  result?: RawWebSearchResult;
  message?: string;
}

interface GatewayFrame {
  session_id?: string;
  event?: GatewayEvent;
}

export interface GatewayOptions {
  text: string;
  modelId: string;
  conversationId?: string;
  parentResponseId?: string | null;
  search?: boolean;
  workspaceIds?: string[];
}

export interface GatewayRun {
  socket: WebSocket;
  conversationId: string;
  responseId: string;
  messageId: string;
  previousParentResponseId: string;
  modelId: string;
  prompt: string;
  answer: string;
  thinkingLines: string[];
  searchResults: RawWebSearchResult[];
  title: string;
  done: boolean;
  error: ToolError | null;
  startedAt: number;
  updatedAt: number;
  close: () => void;
}

const streamError = (error: GatewayStreamError): ToolError => {
  const reason = error.details?.reason;
  const message = error.message ?? error.kind ?? 'unknown gateway error';
  const detail = reason ? `${message} (${reason})` : message;
  const rateLimited =
    error.globalRateLimit !== undefined ||
    error.usageLimitReached !== undefined ||
    error.usagePoolExhausted !== undefined ||
    /rate.?limit|usage.?limit|quota|too many/i.test(`${error.kind ?? ''} ${detail}`);
  if (rateLimited)
    return new ToolError(`Grok rate limited the completion: ${detail}`, 'RATE_LIMIT', {
      category: 'rate_limit',
      retryable: true,
    });
  if (/auth|unauth|login/i.test(`${error.kind ?? ''} ${detail}`))
    return new ToolError(`Grok rejected the completion: ${detail}`, 'AUTH_ERROR', {
      category: 'auth',
      retryable: false,
    });
  if (/invalid|unsupported|malformed/i.test(`${error.kind ?? ''} ${detail}`))
    return new ToolError(`Grok rejected the completion: ${detail}`, 'VALIDATION_ERROR', {
      category: 'validation',
      retryable: false,
    });
  return new ToolError(`Grok completion failed: ${detail}`, 'UPSTREAM_ERROR', {
    category: 'internal',
    retryable: error.severity?.toLowerCase() !== 'fatal',
  });
};

const dedupeSearchResults = (results: RawWebSearchResult[]): RawWebSearchResult[] => {
  const seen = new Set<string>();
  return results.filter(result => {
    if (!result.url || seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
};

export const startGatewayRun = (options: GatewayOptions): GatewayRun => {
  const userId = requireUserId();
  const socket = new WebSocket(`${ORIGIN.replace('https://', 'wss://')}/ws/mgw/?uid=${encodeURIComponent(userId)}`);
  const run: GatewayRun = {
    socket,
    conversationId: options.conversationId ?? '',
    responseId: '',
    messageId: '',
    previousParentResponseId: options.parentResponseId ?? '',
    modelId: options.modelId,
    prompt: options.text,
    answer: '',
    thinkingLines: [],
    searchResults: [],
    title: '',
    done: false,
    error: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    close: () => {
      try {
        socket.close();
      } catch {
        // The socket can already be closing after the terminal frame.
      }
    },
  };

  let sessionId = options.conversationId ?? '';
  let overallTimer: ReturnType<typeof setTimeout>;
  let idleTimer: ReturnType<typeof setTimeout>;

  const finish = (error?: ToolError) => {
    if (run.done || run.error) return;
    clearTimeout(overallTimer);
    clearTimeout(idleTimer);
    if (error) run.error = error;
    else run.done = true;
    run.updatedAt = Date.now();
    run.close();
  };

  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () =>
        finish(
          new ToolError(
            'Grok stopped sending gateway events. Open https://grok.com to clear any anti-bot challenge, then retry.',
            'TIMEOUT',
            { category: 'timeout', retryable: true },
          ),
        ),
      IDLE_TIMEOUT_MS,
    );
  };

  const send = (event: Record<string, unknown>) => {
    const frame: Record<string, unknown> = { event };
    if (sessionId) frame.session_id = sessionId;
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      finish(
        new ToolError(`Grok's chat gateway rejected a frame: ${String(error).slice(0, 200)}`, 'UPSTREAM_ERROR', {
          category: 'internal',
          retryable: true,
        }),
      );
    }
  };

  overallTimer = setTimeout(
    () =>
      finish(
        new ToolError(`Grok did not finish within ${RUN_TIMEOUT_MS / 60_000} minutes.`, 'TIMEOUT', {
          category: 'timeout',
          retryable: true,
        }),
      ),
    RUN_TIMEOUT_MS,
  );
  resetIdle();

  socket.onopen = () => {
    const xGrok: Record<string, unknown> = {
      protocol_capabilities: ['conversation_attached'],
      use_chunk: true,
      enable_side_by_side: false,
      force_side_by_side: false,
      enable_image_generation: true,
      image_generation_count: 1,
      disable_text_follow_ups: true,
      disable_artifact: false,
      force_concise: false,
    };
    if (options.conversationId) {
      xGrok.conversation_id = options.conversationId;
      xGrok.load_existing = true;
    }
    if (options.search === false) {
      xGrok.disable_web_search = true;
      xGrok.disable_x_search = true;
    }
    if (options.workspaceIds && options.workspaceIds.length > 0) xGrok.workspace_ids = options.workspaceIds;

    send({
      type: 'session.create',
      event_id: `evt_init_${crypto.randomUUID()}`,
      session: { model: options.modelId, x_grok: xGrok },
    });
  };

  socket.onerror = () =>
    finish(
      new ToolError("Grok's chat gateway reported a socket error.", 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      }),
    );

  socket.onclose = event => {
    if (run.done || run.error) return;
    finish(
      new ToolError(
        `Grok's gateway closed before persistence (code ${event.code}${event.reason ? `: ${event.reason}` : ''}).`,
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      ),
    );
  };

  socket.onmessage = message => {
    resetIdle();
    run.updatedAt = Date.now();
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(String(message.data)) as GatewayFrame;
    } catch {
      return;
    }
    const event = frame.event;
    if (!event) return;
    if (frame.session_id && !sessionId) sessionId = frame.session_id;

    switch (event.type) {
      case 'conversation.attached': {
        run.conversationId = event.conversation?.id || run.conversationId || sessionId;
        const itemEvent: Record<string, unknown> = {
          type: 'conversation.item.create',
          event_id: `evt_msg_${crypto.randomUUID()}`,
          item: {
            type: 'message',
            role: 'user',
            x_grok: {
              client_message_id: crypto.randomUUID(),
              input_chunks: [{ text: { text: options.text } }],
            },
          },
        };
        if (run.previousParentResponseId) itemEvent.parent_response_id = run.previousParentResponseId;
        send(itemEvent);
        send({ type: 'response.create', event_id: `evt_resp_${crypto.randomUUID()}` });
        return;
      }
      case 'conversation.item.added':
        run.messageId = event.item?.id ?? run.messageId;
        return;
      case 'response.created':
        run.responseId = event.response?.id ?? run.responseId;
        return;
      case 'response.chunk': {
        const chunk = event.chunk;
        const text = chunk?.text;
        if (text?.text) {
          if (text.channel === CHANNEL_RESPONSE) run.answer += text.text;
          else if (text.channel === CHANNEL_NOTETAKER_HEADER) run.thinkingLines.push(text.text);
        }
        const webpages = chunk?.tool_result?.web_search?.webpages;
        if (webpages) run.searchResults.push(...webpages);
        return;
      }
      case 'response.output_text.delta':
        if (event.delta) run.answer += event.delta;
        else if (event.text) run.answer += event.text;
        return;
      case 'response.search.result': {
        const result = event.search_result ?? event.result;
        if (result) run.searchResults.push(result);
        return;
      }
      case 'conversation.title.updated':
        run.title = event.title ?? run.title;
        return;
      case 'response.grok.output': {
        const error = event.output?.stream_error;
        if (error) {
          finish(streamError(error));
          return;
        }
        const webpages = event.output?.tool_result?.web_search?.webpages;
        if (webpages) run.searchResults.push(...webpages);
        const progress = event.output?.progress_report?.message;
        if (progress) run.thinkingLines.push(progress);
        return;
      }
      case 'response.done':
        if (event.response?.status === 'failed')
          finish(
            new ToolError(
              `Grok's reply failed: ${event.response.status_details?.reason ?? 'unknown reason'}`,
              'UPSTREAM_ERROR',
              { category: 'internal', retryable: false },
            ),
          );
        return;
      case 'response.persisted':
        run.searchResults = dedupeSearchResults(run.searchResults);
        finish();
        return;
      case 'error':
        finish(
          new ToolError(`Grok's gateway returned an error: ${event.message ?? 'unknown error'}`, 'UPSTREAM_ERROR', {
            category: 'internal',
            retryable: false,
          }),
        );
        return;
      default:
        return;
    }
  };

  return run;
};

export const waitForGatewayRun = async (
  run: GatewayRun,
  predicate: (current: GatewayRun) => boolean,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate(run) && !run.done && !run.error && Date.now() < deadline) {
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  if (run.error) throw run.error;
  return predicate(run);
};

export const liveRunResponses = (run: GatewayRun): RawResponse[] => {
  const now = new Date().toISOString();
  const user: RawResponse = {
    responseId: run.messageId || `${run.conversationId}:pending-user`,
    message: run.prompt,
    sender: 'human',
    createTime: now,
    partial: false,
  };
  const assistant: RawResponse = {
    responseId: run.responseId || `${run.conversationId}:pending-assistant`,
    parentResponseId: run.messageId || undefined,
    message: run.answer,
    sender: 'assistant',
    createTime: now,
    partial: false,
    state: run.done ? 'closed' : 'streaming',
    model: run.modelId,
    requestMetadata: { model: run.modelId },
    webSearchResults: run.searchResults,
    steps: run.thinkingLines.map(text => ({ text: [text], tags: ['header'] })),
  };
  return [user, assistant];
};
