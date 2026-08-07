import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api } from './zai-api.js';
import { type RawChatDetail, getConversationDetail } from './zai-conversations.js';
import { type RawFullMessage, fetchMessages, resolveActivePath } from './zai-messages.js';
import type { ResearchStatus } from './tools/normalized-schemas.js';

/**
 * z.ai runs deep research as an ordinary chat with the `deep-research` MCP server
 * attached — there is no job resource and no job id, so the conversation id is the
 * research id. The caller's clarification preferences have to outlive the tool call
 * that set them, so they are persisted in the chat's own free-form `chat.extra`
 * rather than in plugin memory, which would not survive a page reload.
 */
export const RESEARCH_STATE_KEY = 'opentabs_deep_research';

export interface ResearchState {
  auto_answer_clarifications: boolean;
  clarification_answer: string;
  auto_answered: boolean;
  clarifying_question: string | null;
}

export const readResearchState = (detail: RawChatDetail): ResearchState | null => {
  const extra = detail.chat?.extra as Record<string, unknown> | undefined;
  const stored = extra?.[RESEARCH_STATE_KEY];
  if (!stored || typeof stored !== 'object') return null;
  const state = stored as Partial<ResearchState>;
  return {
    auto_answer_clarifications: state.auto_answer_clarifications !== false,
    clarification_answer: state.clarification_answer ?? 'Include everything.',
    auto_answered: state.auto_answered === true,
    clarifying_question: state.clarifying_question ?? null,
  };
};

export const writeResearchState = async (conversationId: string, patch: Partial<ResearchState>): Promise<void> => {
  const detail = await getConversationDetail(conversationId);
  const existing = detail.chat ?? {};
  const current = readResearchState(detail) ?? {
    auto_answer_clarifications: true,
    clarification_answer: 'Include everything.',
    auto_answered: false,
    clarifying_question: null,
  };
  await api<RawChatDetail>(`/v1/chats/${encodeURIComponent(conversationId)}`, {
    method: 'POST',
    body: {
      chat: {
        ...existing,
        extra: {
          ...((existing.extra as Record<string, unknown>) ?? {}),
          [RESEARCH_STATE_KEY]: { ...current, ...patch },
        },
      },
    },
  });
};

export interface ResearchSnapshot {
  detail: RawChatDetail;
  /** The newest assistant message on the rendered branch, if any. */
  assistant: RawFullMessage | null;
  /** The user prompt that message answers. */
  userText: string;
  state: ResearchState | null;
}

export const loadResearchSnapshot = async (conversationId: string): Promise<ResearchSnapshot> => {
  const detail = await getConversationDetail(conversationId);
  const { ordered } = resolveActivePath(detail);
  const ids = ordered.map(message => message.id ?? '').filter(Boolean);
  const full = ids.length > 0 ? await fetchMessages(conversationId, ids) : new Map<string, RawFullMessage>();
  let assistant: RawFullMessage | null = null;
  let userText = '';
  for (const stub of ordered) {
    const message = full.get(stub.id ?? '');
    if (!message) continue;
    if (message.role === 'assistant') assistant = message;
    if (message.role === 'user' && typeof message.content === 'string') userText = message.content;
  }
  return { detail, assistant, userText, state: readResearchState(detail) };
};

const textOf = (message: RawFullMessage | null): string =>
  (message?.content_blocks ?? [])
    .filter(block => block.type === 'text' && typeof block.content === 'string')
    .map(block => block.content as string)
    .join('\n\n')
    .trim();

const toolCallCount = (message: RawFullMessage | null): number =>
  (message?.content_blocks ?? [])
    .filter(block => block.type === 'tool_calls')
    .reduce((total, block) => total + (Array.isArray(block.content) ? block.content.length : 0), 0);

const lastToolName = (message: RawFullMessage | null): string | null => {
  const calls = (message?.content_blocks ?? [])
    .filter(block => block.type === 'tool_calls')
    .flatMap(block => (Array.isArray(block.content) ? block.content : []));
  return calls.at(-1)?.function?.name ?? null;
};

export interface ResearchSource {
  title: string;
  url: string;
  snippet: string | null;
}

export const collectSources = (message: RawFullMessage | null): ResearchSource[] => {
  const byUrl = new Map<string, ResearchSource>();
  for (const block of message?.content_blocks ?? []) {
    for (const result of block.results ?? []) {
      for (const entry of result.browser?.search_result ?? []) {
        if (!entry.url || byUrl.has(entry.url)) continue;
        byUrl.set(entry.url, { title: entry.title ?? '', url: entry.url, snippet: entry.text ?? null });
      }
    }
  }
  return [...byUrl.values()];
};

const CLARIFYING_MAX_CHARS = 1500;

/**
 * Conservative clarification detection.
 *
 * A deep-research run that actually started emits `tool_calls` blocks immediately,
 * so "the model finished, produced no tool call at all, wrote something short, and
 * asked a question" is the only shape that can be a clarification. Requiring zero
 * tool calls is what keeps a completed 40-source report — which frequently ends on
 * a rhetorical question — from being parked as `clarifying`, which SPEC §7 calls
 * out as the worse failure.
 */
export const detectClarifyingQuestion = (message: RawFullMessage | null): string | null => {
  if (!message || message.done !== true) return null;
  if (toolCallCount(message) > 0) return null;
  const text = textOf(message);
  if (!text || text.length > CLARIFYING_MAX_CHARS) return null;
  if (!text.includes('?') && !text.includes('？')) return null;
  return text;
};

export interface ResearchStatusReport {
  status: ResearchStatus;
  clarifying_question: string | null;
  auto_answered: boolean;
  progress: { steps_completed: number; current_step: string | null; sources_found: number };
  sources: ResearchSource[];
  error: string | null;
}

export const describeResearch = (snapshot: ResearchSnapshot): ResearchStatusReport => {
  const { assistant, state } = snapshot;
  const sources = collectSources(assistant);
  const progress = {
    steps_completed: toolCallCount(assistant),
    current_step: lastToolName(assistant),
    sources_found: sources.length,
  };
  const storedQuestion = state?.clarifying_question ?? null;

  if (!assistant)
    return {
      status: 'queued',
      clarifying_question: storedQuestion,
      auto_answered: state?.auto_answered === true,
      progress,
      sources,
      error: null,
    };

  if (assistant.error)
    return {
      status: 'failed',
      clarifying_question: storedQuestion,
      auto_answered: state?.auto_answered === true,
      progress,
      sources,
      error: typeof assistant.error === 'string' ? assistant.error : JSON.stringify(assistant.error).slice(0, 400),
    };

  if (assistant.done !== true)
    return {
      status: 'running',
      clarifying_question: storedQuestion,
      auto_answered: state?.auto_answered === true,
      progress,
      sources,
      error: null,
    };

  const question = detectClarifyingQuestion(assistant);
  if (question && state?.auto_answer_clarifications === false)
    return {
      status: 'clarifying',
      clarifying_question: question,
      auto_answered: false,
      progress,
      sources,
      error: null,
    };

  return {
    status: 'completed',
    clarifying_question: question ?? storedQuestion,
    auto_answered: state?.auto_answered === true,
    progress,
    sources,
    error: null,
  };
};

export const researchNotFound = (conversationId: string): ToolError =>
  ToolError.notFound(`z.ai has no research run ${conversationId} — research_id is the conversation id.`);
