import { getSessionStorage, setSessionStorage } from '@opentabs-dev/plugin-sdk';
import { callRpc } from './kimi-api.js';
import { type RawChat, chatEffort, getChat, getConversationMessages } from './kimi-conversations.js';
import { type RawBlock, type RawMessage, ASK_USER_TOOL, mapMessagesToItems } from './kimi-messages.js';
import { type KimiModelCatalog, scenarioToModelId } from './kimi-models.js';
import { DEFAULT_CLARIFICATION_ANSWER, type ResearchStatus, type ResponseItem } from './tools/normalized-schemas.js';

/**
 * Kimi publishes the "waiting on the user" state as a first-class chat status —
 * this is the whole clarification detector, no text heuristics involved.
 */
export const ASK_USER_STATUS = 'STATUS_ASK_USER_QUESTION';
export const GENERATING_STATUS = 'STATUS_GENERATING';

// --- Per-run state ---
// Kept in the page's sessionStorage. It holds the caller's clarification
// preference AND the question text, which is NOT otherwise recoverable: while a
// run is parked at STATUS_ASK_USER_QUESTION, ListMessages reports the assistant
// message with zero blocks (verified live), so the question exists only in the
// open Chat stream.

export interface ResearchState {
  auto: boolean;
  answer: string;
  clarifyingQuestion: string | null;
  autoAnswered: boolean;
  /** Set by cancel_deep_research so a stopped run reports `cancelled`, not `failed`. */
  cancelRequested?: boolean;
  /** Latest error frame seen on the stream. */
  error?: string | null;
}

const defaultState = (): ResearchState => ({
  auto: true,
  answer: DEFAULT_CLARIFICATION_ANSWER,
  clarifyingQuestion: null,
  autoAnswered: false,
  error: null,
});

const stateKey = (conversationId: string): string => `opentabs:kimi:research:${conversationId}`;

export const readState = (conversationId: string): ResearchState => {
  const raw = getSessionStorage(stateKey(conversationId));
  if (!raw) return defaultState();
  try {
    return { ...defaultState(), ...(JSON.parse(raw) as ResearchState) };
  } catch {
    return defaultState();
  }
};

export const writeState = (conversationId: string, state: ResearchState): void => {
  setSessionStorage(stateKey(conversationId), JSON.stringify(state));
};

export const mergeState = (conversationId: string, patch: Partial<ResearchState>): ResearchState => {
  const merged = { ...readState(conversationId), ...patch };
  writeState(conversationId, merged);
  return merged;
};

// --- Live stream reader ---

interface StreamHandle {
  chatId: string | null;
  finished: boolean;
  error: string | null;
}

interface AskUserQuestion {
  question?: string;
  type?: string;
  options?: { option?: string; description?: string; recommended?: boolean }[];
}

/**
 * Renders Kimi's structured clarification as readable text.
 *
 * Kimi's ask_user arguments are not a single question: they are a `questions`
 * array, each with a `type` ("single"/"multi") and a list of options, some
 * flagged `recommended`. Handing the caller raw JSON would make them parse a
 * provider-specific shape, so it is flattened here while keeping every option.
 */
const renderQuestions = (questions: AskUserQuestion[]): string =>
  questions
    .map((entry, index) => {
      const heading = `${index + 1}. ${entry.question ?? '(no question text)'}${
        entry.type ? ` [${entry.type}-select]` : ''
      }`;
      const options = (entry.options ?? []).map(option => {
        const mark = option.recommended ? ' (recommended)' : '';
        const detail = option.description ? ` — ${option.description}` : '';
        return `   - ${option.option ?? ''}${detail}${mark}`;
      });
      return [heading, ...options].join('\n');
    })
    .join('\n');

/**
 * Pulls the question text out of an ask_user call's arguments.
 *
 * Arguments arrive as a stream of fragments, so this is called on a value that is
 * usually still half-written JSON. Returning null until it parses means exactly
 * one write lands — the complete question — instead of persisting `{"question":
 * "Wha` and hoping a later fragment overwrites it.
 */
const askQuestionFrom = (args: string | undefined): string | null => {
  if (!args) return null;
  const trimmed = args.trim();
  if (!trimmed.startsWith('{')) return trimmed.length > 0 ? trimmed : null;
  let parsed: { questions?: AskUserQuestion[]; question?: string; prompt?: string; message?: string };
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    return null;
  }
  if (Array.isArray(parsed.questions) && parsed.questions.length > 0) return renderQuestions(parsed.questions);
  return parsed.question ?? parsed.prompt ?? parsed.message ?? trimmed;
};

/**
 * Reads a Connect stream INCREMENTALLY instead of buffering it.
 *
 * A deep-research run stays open for minutes and, when it asks a clarifying
 * question, parks with the stream still open — so awaiting the whole body (what
 * `fetchFromPage` does) would never surface either the chat id or the question.
 * Reading frame by frame gives both while the run continues in the page.
 *
 * Kimi streams a block the way the web app renders it: one `{"op":"set"}` frame
 * seeds the block (and is the ONLY frame carrying `tool.name`), then a run of
 * `{"op":"append","mask":"block.tool.args"}` frames delivers the arguments one
 * fragment at a time — `{"args":"{"}`, `{"args":"\"question\": \""}`, … So the
 * name has to be remembered per block id and the fragments concatenated;
 * inspecting frames individually finds an `ask_user` call with empty arguments
 * and never sees the question.
 *
 * The reader keeps running after the tool handler returns; the question is
 * persisted to sessionStorage so `get_deep_research` can read it later.
 */
export const readStreamIncrementally = (
  response: Response,
  seed: { auto: boolean; answer: string },
  onChatId: (chatId: string) => void,
): StreamHandle => {
  const handle: StreamHandle = { chatId: null, finished: false, error: null };
  const body = response.body;
  if (!body) {
    handle.finished = true;
    handle.error = 'Kimi returned no stream body.';
    return handle;
  }

  void (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = new Uint8Array(0);
    const toolNameByBlock = new Map<string, string>();
    const toolArgsByBlock = new Map<string, string>();

    const rememberQuestion = (blockId: string): void => {
      if (!handle.chatId || toolNameByBlock.get(blockId) !== ASK_USER_TOOL) return;
      const question = askQuestionFrom(toolArgsByBlock.get(blockId));
      if (question) mergeState(handle.chatId, { clarifyingQuestion: question });
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer);
      merged.set(value, buffer.length);
      buffer = merged;

      let offset = 0;
      while (offset + 5 <= buffer.length) {
        const length = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 4).getUint32(0);
        if (offset + 5 + length > buffer.length) break;
        const text = decoder.decode(buffer.subarray(offset + 5, offset + 5 + length));
        offset += 5 + length;

        let event: {
          op?: string;
          mask?: string;
          chat?: { id?: string };
          block?: RawBlock;
          error?: { code?: string; message?: string };
        };
        try {
          event = JSON.parse(text) as typeof event;
        } catch {
          continue;
        }

        if (event.chat?.id && !handle.chatId) {
          handle.chatId = event.chat.id;
          writeState(event.chat.id, { ...defaultState(), auto: seed.auto, answer: seed.answer });
          onChatId(event.chat.id);
        }

        const blockId = event.block?.id;
        const tool = event.block?.tool;
        if (blockId && tool) {
          if (tool.name) toolNameByBlock.set(blockId, tool.name);
          if (typeof tool.args === 'string') {
            // `set` replaces the accumulated args; `append` extends them.
            const previous = event.op === 'append' ? (toolArgsByBlock.get(blockId) ?? '') : '';
            toolArgsByBlock.set(blockId, `${previous}${tool.args}`);
          }
          rememberQuestion(blockId);
        }

        if (event.error?.code && handle.chatId) {
          mergeState(handle.chatId, { error: event.error.message ?? event.error.code });
        }
      }
      buffer = buffer.subarray(offset);
    }
    handle.finished = true;
  })().catch((error: unknown) => {
    handle.finished = true;
    handle.error = String(error);
  });

  return handle;
};

// --- Reading the research turn out of the conversation ---

/**
 * The research turn is whatever answers the LAST prompt, not simply the last
 * assistant message: right after answer_deep_research the newest assistant
 * message is still the old clarification, which would keep the job parked.
 */
const currentTurn = (messages: RawMessage[]): { prompt?: RawMessage; answer?: RawMessage } => {
  let promptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      promptIndex = index;
      break;
    }
  }
  return {
    prompt: promptIndex >= 0 ? messages[promptIndex] : undefined,
    answer: messages.slice(promptIndex + 1).find(message => message.role === 'assistant'),
  };
};

export interface ResearchSnapshot {
  conversationId: string;
  chat: RawChat;
  status: ResearchStatus;
  /** Newest assistant message id — CancelChat needs it alongside the chat id. */
  assistantMessageId: string | null;
  progress: { steps_completed: number; current_step: string | null; sources_found: number };
  items: ResponseItem[];
  sources: { title: string; url: string; snippet: string | null }[];
  error: string | null;
}

/**
 * Derives SPEC §7 status from Kimi's own chat status, which is authoritative and
 * needs no heuristic:
 *   STATUS_ASK_USER_QUESTION → clarifying   (Kimi called its ask_user tool)
 *   STATUS_GENERATING        → running
 *   STATUS_COMPLETED         → completed
 *   no status yet            → queued       (the chat exists, the turn has not started)
 */
export const readResearch = async (
  conversationId: string,
  catalog: KimiModelCatalog,
  options: { includeReasoning: boolean; includeToolCalls: boolean },
): Promise<ResearchSnapshot> => {
  const [chat, messages] = await Promise.all([getChat(conversationId), getConversationMessages(conversationId)]);
  const { prompt, answer: assistant } = currentTurn(messages);
  const blocks = assistant?.blocks ?? [];
  const toolBlocks = blocks.filter(block => block.tool);
  const state = readState(conversationId);

  let status: ResearchStatus;
  if (chat.status === ASK_USER_STATUS) status = 'clarifying';
  else if (chat.status === GENERATING_STATUS) status = 'running';
  else if (state.cancelRequested === true) status = 'cancelled';
  else if (state.error) status = 'failed';
  else if (chat.status === 'STATUS_COMPLETED') status = 'completed';
  else if (!assistant) status = 'queued';
  else status = 'running';

  const sourceMap = new Map<string, { title: string; url: string; snippet: string | null }>();
  for (const block of blocks) {
    for (const content of block.tool?.contents ?? []) {
      const base = content.searchResult?.base;
      if (base?.url && !sourceMap.has(base.url))
        sourceMap.set(base.url, { title: base.title ?? '', url: base.url, snippet: base.snippet ?? null });
    }
  }

  const scenarios = scenarioToModelId(catalog);
  const turn = [prompt, assistant].filter((message): message is RawMessage => message !== undefined);
  const { items } = mapMessagesToItems(turn, {
    includeReasoning: options.includeReasoning,
    includeToolCalls: options.includeToolCalls,
    effort: chatEffort(chat),
    model: (chat.lastRequest?.scenario && scenarios.get(chat.lastRequest.scenario)) || null,
  });

  return {
    conversationId,
    chat,
    status,
    assistantMessageId: assistant?.id ?? null,
    progress: {
      steps_completed: toolBlocks.length,
      // Kimi publishes a human-readable statusText ("Working", "Needs reply", "Completed").
      current_step: chat.statusText || toolBlocks[toolBlocks.length - 1]?.tool?.name || null,
      sources_found: sourceMap.size,
    },
    items,
    sources: [...sourceMap.values()],
    error: state.error ?? null,
  };
};

/** Stops a running Kimi generation. Needs both the chat id and the message being generated. */
export const cancelChat = async (conversationId: string, messageId: string): Promise<void> => {
  await callRpc('kimi.gateway.chat.v1.ChatService/CancelChat', { chatId: conversationId, messageId });
};
