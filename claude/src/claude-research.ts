import { ToolError, getSessionStorage, setSessionStorage } from '@opentabs-dev/plugin-sdk';
import { getConversationDetail } from './claude-conversations.js';
import { conversationEffort } from './claude-conversations.js';
import type { RawBlock, RawCitation, RawConversationDetail, RawMessage } from './claude-messages.js';
import { mapMessagesToItems } from './claude-messages.js';
import type { ResearchStatus, ResponseItem } from './tools/normalized-schemas.js';

export const RESEARCH_TOOL_NAME = 'launch_extended_search_task';

// --- Per-job preferences ---
// Kept in the page's sessionStorage so get_deep_research knows whether the caller
// asked for auto-answered clarifications. A browser restart loses it and the job
// falls back to the SPEC default (auto_answer_clarifications: true).

export interface ResearchPrefs {
  auto: boolean;
  answer: string;
  clarifyingQuestion: string | null;
  autoAnswered: boolean;
}

const prefsKey = (conversationId: string): string => `opentabs:claude:research:${conversationId}`;

export const readPrefs = (conversationId: string): ResearchPrefs => {
  const raw = getSessionStorage(prefsKey(conversationId));
  if (!raw) return { auto: true, answer: 'Include everything.', clarifyingQuestion: null, autoAnswered: false };
  try {
    return JSON.parse(raw) as ResearchPrefs;
  } catch {
    return { auto: true, answer: 'Include everything.', clarifyingQuestion: null, autoAnswered: false };
  }
};

export const writePrefs = (conversationId: string, prefs: ResearchPrefs): void => {
  setSessionStorage(prefsKey(conversationId), JSON.stringify(prefs));
};

// --- Reading the research turn out of the conversation ---

const lastAssistantMessage = (detail: RawConversationDetail): RawMessage | undefined =>
  [...(detail.chat_messages ?? [])].reverse().find(message => message.sender === 'assistant');

const blocksOf = (message: RawMessage | undefined): RawBlock[] => message?.content ?? [];

const researchTaskIdFrom = (blocks: RawBlock[]): string | null => {
  for (const block of blocks) {
    if (block.type !== 'tool_result' || block.name !== RESEARCH_TOOL_NAME) continue;
    for (const part of block.content ?? []) {
      if (typeof part.text !== 'string') continue;
      try {
        const parsed = JSON.parse(part.text) as { task_id?: string };
        if (parsed.task_id) return parsed.task_id;
      } catch {
        // The result carries a JSON string; anything else is not the task envelope.
      }
    }
  }
  return null;
};

const textOf = (blocks: RawBlock[]): string =>
  blocks
    .filter(block => block.type === 'text' && block.text)
    .map(block => (block.text as string).trim())
    .join('\n\n')
    .trim();

/**
 * Detecting a clarifying question, conservatively.
 *
 * Claude's Research flow either launches `launch_extended_search_task` straight
 * away, or replies with a short question first and launches nothing. So a turn is
 * treated as clarifying ONLY when BOTH hold:
 *   1. the assistant message contains no `launch_extended_search_task` tool_use, and
 *   2. its concatenated text, trimmed, ends with "?".
 *
 * Both conditions are required because a research turn opens with a preamble
 * ("I'll dig into this…") that is briefly the only text block while the stream is
 * still running; that preamble does not end in a question mark, so a run in
 * progress reads as `running`, never as a falsely-parked `clarifying`.
 */
export const isClarifying = (blocks: RawBlock[]): boolean => {
  if (blocks.some(block => block.type === 'tool_use' && block.name === RESEARCH_TOOL_NAME)) return false;
  const text = textOf(blocks);
  return text.length > 0 && text.endsWith('?');
};

interface ArtifactInput {
  content?: string;
  md_citations?: RawCitation[];
}

const artifactInput = (block: RawBlock): ArtifactInput | null =>
  block.type === 'tool_use' && block.name === 'artifacts' ? ((block.input ?? {}) as ArtifactInput) : null;

const artifactCitations = (block: RawBlock): RawCitation[] => artifactInput(block)?.md_citations ?? [];

/**
 * A completed Research turn says almost nothing in its own text blocks — the
 * report is the artifact. Append it to the assistant message as a second
 * output_text part (with the artifact's own citations as annotations) so the
 * research answer is present even at the default include_tool_calls: false.
 */
const appendArtifactReport = (items: ResponseItem[], blocks: RawBlock[]): void => {
  const report = blocks.map(artifactInput).find(input => input?.content);
  if (!report?.content) return;
  const message = [...items].reverse().find(item => item.type === 'message' && item.role === 'assistant');
  if (!message || message.type !== 'message') return;
  message.content.push({
    type: 'output_text',
    text: report.content,
    annotations: (report.md_citations ?? [])
      .filter(citation => citation.url)
      .map(citation => ({
        type: 'url_citation' as const,
        url: citation.url ?? '',
        title: citation.title ?? '',
        start_index: typeof citation.start_index === 'number' ? citation.start_index : null,
        end_index: typeof citation.end_index === 'number' ? citation.end_index : null,
      })),
  });
};

export interface ResearchSnapshot {
  conversationId: string;
  status: ResearchStatus;
  clarifyingQuestion: string | null;
  taskId: string | null;
  progress: { steps_completed: number; current_step: string | null; sources_found: number };
  items: ResponseItem[];
  sources: { title: string; url: string; snippet: string | null }[];
  error: string | null;
}

export const readResearch = async (
  conversationId: string,
  options: { includeReasoning: boolean; includeToolCalls: boolean },
): Promise<ResearchSnapshot> => {
  const detail = await getConversationDetail(conversationId);
  const messages = detail.chat_messages ?? [];
  const assistant = lastAssistantMessage(detail);
  const blocks = blocksOf(assistant);
  const taskId = researchTaskIdFrom(blocks);

  const toolUses = blocks.filter(block => block.type === 'tool_use');
  const launchIndex = blocks.findIndex(block => block.type === 'tool_use' && block.name === RESEARCH_TOOL_NAME);
  const resultIndex = blocks.findIndex(block => block.type === 'tool_result' && block.name === RESEARCH_TOOL_NAME);
  const textAfterResult =
    resultIndex >= 0 && blocks.slice(resultIndex + 1).some(block => block.type === 'text' && (block.text ?? '').trim());

  const errorBlock = blocks.find(
    block => block.type === 'tool_result' && block.name === RESEARCH_TOOL_NAME && block.is_error,
  );

  let status: ResearchStatus;
  if (!assistant) status = 'queued';
  else if (errorBlock) status = 'failed';
  else if (isClarifying(blocks)) status = 'clarifying';
  else if (launchIndex < 0) status = 'running';
  else if (textAfterResult) status = 'completed';
  else status = 'running';

  const sourceMap = new Map<string, { title: string; url: string; snippet: string | null }>();
  for (const block of blocks) {
    // A finished Research run publishes its report as an artifact, and the
    // report's citations ride on that artifact as `input.md_citations` — not on
    // any text block. Reading only text-block citations returns sources: [].
    for (const citation of [...(block.citations ?? []), ...artifactCitations(block)]) {
      if (citation.url && !sourceMap.has(citation.url))
        sourceMap.set(citation.url, { title: citation.title ?? '', url: citation.url, snippet: null });
    }
    if (block.type === 'tool_result') {
      for (const part of block.content ?? []) {
        if (part.type === 'knowledge' && part.url && !sourceMap.has(part.url))
          sourceMap.set(part.url, { title: part.title ?? '', url: part.url, snippet: part.text ?? null });
      }
    }
  }

  const lastToolUse = toolUses[toolUses.length - 1] as (RawBlock & { message?: string }) | undefined;
  const turn = assistant ? messages.slice(messages.indexOf(assistant) - 1) : [];
  const { items } = mapMessagesToItems(turn, {
    includeReasoning: options.includeReasoning,
    includeToolCalls: options.includeToolCalls,
    effort: conversationEffort(detail),
    model: detail.model || null,
  });
  appendArtifactReport(items, blocks);

  return {
    conversationId,
    status,
    clarifyingQuestion: status === 'clarifying' ? textOf(blocks) : null,
    taskId,
    progress: {
      steps_completed: toolUses.length,
      current_step: lastToolUse?.message ?? (status === 'completed' ? 'Done' : null),
      sources_found: sourceMap.size,
    },
    items,
    sources: [...sourceMap.values()],
    error: errorBlock ? 'Claude reported an error running the research task.' : null,
  };
};

export const requireResearchTaskId = (snapshot: ResearchSnapshot): string => {
  if (!snapshot.taskId)
    throw ToolError.notFound(
      `No running Claude research task was found on conversation ${snapshot.conversationId}. Only a task that has already launched can be cancelled.`,
    );
  return snapshot.taskId;
};
