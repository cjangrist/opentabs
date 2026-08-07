import { z } from 'zod';

// --- Timestamps ---

/**
 * Coerces the several timestamp shapes the ChatGPT backend uses into an ISO 8601 string.
 * Handles epoch seconds, epoch milliseconds, numeric strings and already-formatted date
 * strings (e.g. "2025-02-10"). Returns '' rather than throwing on unparseable input —
 * `new Date(NaN).toISOString()` raises "Invalid time value", which previously took down
 * the whole get_memories tool when /memories switched updated_at to a date string.
 */
export const toIsoTimestamp = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    const milliseconds = Math.abs(value) > 1e11 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return toIsoTimestamp(Number(trimmed));
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  return '';
};

// --- User ---

export const userSchema = z.object({
  id: z.string().describe('User ID'),
  email: z.string().describe('Email address'),
  name: z.string().describe('Display name'),
  picture: z.string().describe('Avatar URL'),
  country: z.string().describe('Country code'),
  created: z.string().describe('Account creation timestamp'),
});

interface RawUser {
  id?: string;
  email?: string;
  name?: string;
  picture?: string;
  country?: string;
  created?: number | string;
}

export const mapUser = (u: RawUser) => ({
  id: u.id ?? '',
  email: u.email ?? '',
  name: u.name ?? '',
  picture: u.picture ?? '',
  country: u.country ?? '',
  created: toIsoTimestamp(u.created),
});

// --- Conversation (list item) ---

export const conversationListItemSchema = z.object({
  id: z.string().describe('Conversation ID (UUID)'),
  title: z.string().describe('Conversation title'),
  create_time: z.string().describe('Created ISO 8601 timestamp'),
  update_time: z.string().describe('Last updated ISO 8601 timestamp'),
  is_archived: z.boolean().describe('Whether the conversation is archived'),
  is_starred: z.boolean().describe('Whether the conversation is starred'),
  gizmo_id: z.string().describe('GPT ID used in conversation, empty if none'),
  snippet: z.string().describe('Preview snippet of the conversation'),
});

export interface RawConversationListItem {
  id?: string;
  title?: string;
  create_time?: string;
  update_time?: string;
  is_archived?: boolean;
  is_starred?: boolean;
  gizmo_id?: string | null;
  snippet?: string | null;
}

export const mapConversationListItem = (c: RawConversationListItem) => ({
  id: c.id ?? '',
  title: c.title ?? '',
  create_time: c.create_time ?? '',
  update_time: c.update_time ?? '',
  is_archived: c.is_archived ?? false,
  is_starred: c.is_starred ?? false,
  gizmo_id: c.gizmo_id ?? '',
  snippet: c.snippet ?? '',
});

// --- Message ---

export const messageSchema = z.object({
  id: z.string().describe('Message ID'),
  role: z.string().describe('Author role: system, user, assistant, or tool'),
  content_type: z
    .string()
    .describe('Content type (text, code, thoughts, reasoning_recap, multimodal_text, execution_output, ...)'),
  text: z.string().describe('Message text content'),
  recipient: z.string().describe('Message recipient — "all" means addressed to the user, otherwise a tool name'),
  model: z.string().describe('Model slug used for this message, empty if not applicable'),
  create_time: z.string().describe('Created ISO 8601 timestamp'),
});

interface RawSearchResultGroup {
  domain?: string;
  entries?: { title?: string; url?: string; snippet?: string }[];
}

interface RawThought {
  summary?: string;
  content?: string;
}

interface RawMessageContent {
  content_type?: string;
  /** text / multimodal_text */
  parts?: (string | Record<string, unknown>)[];
  /** code / execution_output */
  text?: string;
  /** thoughts */
  thoughts?: RawThought[];
  /** reasoning_recap */
  content?: string;
  /** tether_browsing_display */
  result?: string;
  summary?: string;
  /** tether_quote */
  title?: string;
  url?: string;
  [key: string]: unknown;
}

interface RawMessage {
  id?: string;
  author?: { role?: string };
  content?: RawMessageContent;
  recipient?: string;
  metadata?: {
    model_slug?: string;
    is_visually_hidden_from_conversation?: boolean;
    search_result_groups?: RawSearchResultGroup[];
  };
  create_time?: number | string;
}

/** Renders a single content part. Non-string parts (images, audio) used to be silently discarded. */
const extractPart = (part: string | Record<string, unknown>): string => {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';

  const contentType = typeof part.content_type === 'string' ? part.content_type : '';

  if (contentType === 'image_asset_pointer') {
    const pointer = typeof part.asset_pointer === 'string' ? part.asset_pointer : '';
    const width = typeof part.width === 'number' ? part.width : '?';
    const height = typeof part.height === 'number' ? part.height : '?';
    return `[image ${width}x${height}${pointer ? ` ${pointer}` : ''}]`;
  }

  if (typeof part.text === 'string' && part.text) return part.text;
  if (typeof part.transcription === 'string' && part.transcription) return part.transcription;

  return contentType ? `[${contentType}]` : '';
};

export const extractTextFromParts = (parts?: (string | Record<string, unknown>)[]): string => {
  if (!parts) return '';
  return parts.map(extractPart).filter(Boolean).join('\n');
};

/** Renders the web-search cards that ride along in metadata on otherwise-empty tool messages. */
const extractSearchResults = (groups?: RawSearchResultGroup[]): string => {
  if (!groups?.length) return '';
  const lines = groups.flatMap(group =>
    (group.entries ?? []).map(entry => `- ${entry.title ?? ''}${entry.url ? ` (${entry.url})` : ''}`),
  );
  return lines.length ? `[search results]\n${lines.join('\n')}` : '';
};

/**
 * Extracts the readable text of a message across every content type the backend emits.
 * Only `text` and `multimodal_text` carry a `parts` array; `code`, `thoughts`,
 * `reasoning_recap`, `execution_output`, `tether_browsing_display` and `tether_quote`
 * each store their payload under a different key. Reading `parts` alone silently
 * discarded all of them.
 */
export const extractMessageText = (m: RawMessage): string => {
  const content = m.content;
  if (!content) return '';

  if (Array.isArray(content.parts) && content.parts.length > 0) {
    const fromParts = extractTextFromParts(content.parts);
    if (fromParts) return fromParts;
  }

  if (typeof content.text === 'string' && content.text) return content.text;

  if (Array.isArray(content.thoughts) && content.thoughts.length > 0) {
    return content.thoughts
      .map(thought => [thought.summary, thought.content].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n');
  }

  if (typeof content.content === 'string' && content.content) return content.content;
  if (typeof content.result === 'string' && content.result) return content.result;
  if (typeof content.summary === 'string' && content.summary) return content.summary;

  if (typeof content.url === 'string' && content.url) {
    return `${content.title ?? content.url} (${content.url})`;
  }

  return extractSearchResults(m.metadata?.search_result_groups);
};

export const mapMessage = (m: RawMessage) => ({
  id: m.id ?? '',
  role: m.author?.role ?? '',
  content_type: m.content?.content_type ?? '',
  text: extractMessageText(m),
  recipient: m.recipient ?? '',
  model: m.metadata?.model_slug ?? '',
  create_time: toIsoTimestamp(m.create_time),
});

// --- Model ---

export const modelSchema = z.object({
  slug: z.string().describe('Model identifier slug (e.g., "gpt-5-6", "o3")'),
  title: z.string().describe('Human-readable model name'),
  description: z.string().describe('Short model description shown in the model picker'),
  is_default: z.boolean().describe('Whether this is the account default model'),
  max_tokens: z.number().describe('Maximum token context window'),
  tags: z.array(z.string()).describe('Model capability tags'),
  enabled_tools: z.array(z.string()).describe('Enabled tool identifiers'),
});

interface RawModel {
  slug?: string;
  title?: string;
  description?: string;
  max_tokens?: number;
  tags?: string[];
  enabled_tools?: string[];
}

export const mapModel = (m: RawModel, defaultModelSlug = '') => ({
  slug: m.slug ?? '',
  title: m.title ?? '',
  description: m.description ?? '',
  is_default: !!m.slug && m.slug === defaultModelSlug,
  max_tokens: m.max_tokens ?? 0,
  tags: m.tags ?? [],
  enabled_tools: m.enabled_tools ?? [],
});

// --- Memory ---

export const memorySchema = z.object({
  id: z.string().describe('Memory ID'),
  content: z.string().describe('Memory content text'),
  status: z.string().describe('Memory status (e.g. "warm"), empty if not reported'),
  conversation_id: z.string().describe('Conversation the memory was learned from, empty if unknown'),
  created_at: z.string().describe('Created ISO 8601 timestamp, empty if not reported'),
  updated_at: z.string().describe('Updated ISO 8601 timestamp, empty if not reported'),
});

interface RawMemory {
  id?: string;
  content?: string;
  status?: string | null;
  conversation_id?: string | null;
  /** Legacy epoch-seconds fields. */
  created_at?: number | string | null;
  /** Current field names — `updated_at` is now a "YYYY-MM-DD" string, not epoch seconds. */
  created_timestamp?: number | string | null;
  updated_at?: number | string | null;
  last_updated?: number | string | null;
}

export const mapMemory = (m: RawMemory) => ({
  id: m.id ?? '',
  content: m.content ?? '',
  status: m.status ?? '',
  conversation_id: m.conversation_id ?? '',
  created_at: toIsoTimestamp(m.created_timestamp ?? m.created_at),
  updated_at: toIsoTimestamp(m.updated_at ?? m.last_updated),
});

// --- GPT (Gizmo) ---

export const gptSchema = z.object({
  id: z.string().describe('GPT ID'),
  name: z.string().describe('GPT display name'),
  description: z.string().describe('GPT description'),
  short_url: z.string().describe('Short URL for the GPT'),
  author_name: z.string().describe('Author display name'),
  num_interactions: z.number().describe('Number of interactions/conversations'),
  tags: z.array(z.string()).describe('GPT tags'),
  created_at: z.string().describe('Created ISO 8601 timestamp'),
  updated_at: z.string().describe('Updated ISO 8601 timestamp'),
});

interface RawGpt {
  id?: string;
  display?: { name?: string; description?: string };
  short_url?: string;
  author?: { display_name?: string };
  num_interactions?: number;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export const mapGpt = (g: RawGpt) => ({
  id: g.id ?? '',
  name: g.display?.name ?? '',
  description: g.display?.description ?? '',
  short_url: g.short_url ?? '',
  author_name: g.author?.display_name ?? '',
  num_interactions: g.num_interactions ?? 0,
  tags: g.tags ?? [],
  created_at: g.created_at ?? '',
  updated_at: g.updated_at ?? '',
});

// --- Prompt Library Item ---

export const promptSchema = z.object({
  id: z.string().describe('Prompt ID'),
  title: z.string().describe('Prompt title'),
  description: z.string().describe('Prompt description'),
  prompt: z.string().describe('Prompt text template'),
  category: z.string().describe('Prompt category'),
});

interface RawPrompt {
  id?: string;
  title?: string;
  description?: string;
  prompt?: string;
  category?: string;
}

export const mapPrompt = (p: RawPrompt) => ({
  id: p.id ?? '',
  title: p.title ?? '',
  description: p.description ?? '',
  prompt: p.prompt ?? '',
  category: p.category ?? '',
});

// --- Conversation detail ---

export const conversationDetailSchema = z.object({
  id: z.string().describe('Conversation ID (UUID)'),
  title: z.string().describe('Conversation title'),
  create_time: z.string().describe('Created ISO 8601 timestamp'),
  update_time: z.string().describe('Last updated ISO 8601 timestamp'),
  is_archived: z.boolean().describe('Whether the conversation is archived'),
  is_starred: z.boolean().describe('Whether the conversation is starred'),
  default_model: z.string().describe('Default model slug used in this conversation'),
  messages: z.array(messageSchema).describe('Messages in the conversation (chronological order)'),
  message_count: z.number().describe('Number of messages returned'),
  omitted: z
    .object({
      reasoning: z.number().describe('Assistant reasoning/recap messages excluded (include_reasoning=false)'),
      tool: z.number().describe('Tool calls and tool results excluded (include_tool_messages=false)'),
      hidden: z.number().describe('Messages ChatGPT marks as hidden from the conversation'),
      empty: z.number().describe('Messages that carried no renderable text'),
    })
    .describe('Counts of active-branch messages left out of `messages`, so nothing is dropped silently'),
});

interface RawConversationDetail {
  conversation_id?: string;
  title?: string;
  create_time?: number | string;
  update_time?: number | string;
  is_archived?: boolean;
  is_starred?: boolean | null;
  default_model_slug?: string | null;
  mapping?: Record<string, { message?: RawMessage; children?: string[] }>;
  current_node?: string;
}

export interface ConversationDetailOptions {
  /** Include assistant `thoughts` and `reasoning_recap` messages. */
  includeReasoning?: boolean;
  /** Include tool results and assistant messages addressed to a tool rather than the user. */
  includeToolMessages?: boolean;
}

const REASONING_CONTENT_TYPES = new Set(['thoughts', 'reasoning_recap']);

/** Rebuilds the active branch: walk parent links from current_node back to the root. */
const activeBranchNodeIds = (
  mapping: Record<string, { message?: RawMessage; children?: string[] }>,
  currentNode?: string,
): string[] => {
  const parentMap = new Map<string, string>();
  for (const [nodeId, node] of Object.entries(mapping)) {
    for (const childId of node.children ?? []) parentMap.set(childId, nodeId);
  }

  const orderedNodeIds: string[] = [];
  const seen = new Set<string>();
  let current = currentNode;
  while (current && !seen.has(current)) {
    seen.add(current);
    orderedNodeIds.unshift(current);
    current = parentMap.get(current);
  }
  return orderedNodeIds;
};

export const mapConversationDetail = (c: RawConversationDetail, options: ConversationDetailOptions = {}) => {
  const includeReasoning = options.includeReasoning ?? false;
  const includeToolMessages = options.includeToolMessages ?? false;

  const messages: ReturnType<typeof mapMessage>[] = [];
  const omitted = { reasoning: 0, tool: 0, hidden: 0, empty: 0 };

  for (const nodeId of activeBranchNodeIds(c.mapping ?? {}, c.current_node)) {
    const message = c.mapping?.[nodeId]?.message;
    if (!message) continue;

    if (message.metadata?.is_visually_hidden_from_conversation === true) {
      omitted.hidden += 1;
      continue;
    }

    const role = message.author?.role ?? '';
    const contentType = message.content?.content_type ?? '';

    if (!includeReasoning && role === 'assistant' && REASONING_CONTENT_TYPES.has(contentType)) {
      omitted.reasoning += 1;
      continue;
    }

    // A message is "for the user" when its recipient is `all`; anything else is a tool call.
    const isToolTraffic = role === 'tool' || (role === 'assistant' && (message.recipient ?? 'all') !== 'all');
    if (!includeToolMessages && isToolTraffic) {
      omitted.tool += 1;
      continue;
    }

    const mapped = mapMessage(message);
    if (!mapped.text) {
      omitted.empty += 1;
      continue;
    }

    messages.push(mapped);
  }

  return {
    id: c.conversation_id ?? '',
    title: c.title ?? '',
    create_time: toIsoTimestamp(c.create_time),
    update_time: toIsoTimestamp(c.update_time),
    is_archived: c.is_archived ?? false,
    is_starred: c.is_starred ?? false,
    default_model: c.default_model_slug ?? '',
    messages,
    message_count: messages.length,
    omitted,
  };
};
