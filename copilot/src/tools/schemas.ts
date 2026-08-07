import { z } from 'zod';
import type {
  CopilotChatResult,
  CopilotConversation,
  CopilotModel,
  CopilotSearchResult,
  CopilotTurn,
} from '../copilot-api.js';

// --- User ---

export const userSchema = z.object({
  id: z.string().describe('Copilot user ID'),
  first_name: z.string().describe('First name on the Microsoft account'),
  preferred_name: z.string().describe('Name Copilot addresses the user by, or "" when none is set'),
  account_tier: z.string().describe('Copilot account tier (e.g., "free", "pro")'),
  is_pro: z.boolean().describe('Whether the account has Copilot Pro'),
  region_code: z.string().describe('Two-letter region Copilot serves the account from (e.g., "BW")'),
  subscriptions: z
    .array(z.string())
    .describe('Microsoft subscription tiers attached to the account (e.g., "m365-family-guest")'),
});

// --- Model ---

export const modelSchema = z.object({
  id: z.string().describe('Mode ID to pass as model_id (e.g., "smart", "reasoning")'),
  display_name: z.string().describe('Name shown in the Copilot composer picker (e.g., "Think deeper")'),
  description: z.string().describe('Short description shown under the name in the picker'),
  is_default: z.boolean().describe('Whether Copilot preselects this mode for new messages'),
});

export const mapModel = (model: CopilotModel) => ({
  id: model.id,
  display_name: model.displayName,
  description: model.description,
  is_default: model.isDefault,
});

// --- Conversation ---

export const conversationSchema = z.object({
  id: z.string().describe('Conversation ID'),
  title: z
    .string()
    .describe('Conversation title. Empty until Copilot generates one; the sidebar shows "New conversation" instead.'),
  url: z.string().describe('URL to the conversation on copilot.microsoft.com'),
  type: z.string().describe('Conversation type Copilot filed the chat under (e.g., "chat")'),
  pinned: z.boolean().describe('Whether the conversation is pinned in the sidebar'),
  updated_at: z.string().describe('ISO 8601 timestamp of the last message'),
});

export const mapConversation = (conversation: CopilotConversation) => ({
  id: conversation.id,
  title: conversation.title,
  url: conversation.url,
  type: conversation.type,
  pinned: conversation.pinned,
  updated_at: conversation.updatedAt,
});

// --- Search ---

export const searchResultSchema = z.object({
  title: z.string().describe('Title of the cited page'),
  url: z.string().describe('URL of the cited page'),
  snippet: z
    .string()
    .describe('Always "" — Copilot cites by position in the answer and does not return the extract it read'),
  site_name: z.string().describe('Publisher Copilot attributed the page to, falling back to the host'),
  cite_index: z.number().describe('Position of the source in the citation list'),
});

export const mapSearchResult = (result: CopilotSearchResult) => ({
  title: result.title,
  url: result.url,
  snippet: result.snippet,
  site_name: result.siteName,
  cite_index: result.citeIndex,
});

const searchResultsField = z
  .array(searchResultSchema)
  .describe(
    'Web pages Copilot cited while answering. Copilot searches on its own initiative, so this can be non-empty even when search was not requested.',
  );

const thinkingField = z
  .string()
  .describe(
    'Progress narration Copilot streamed while working — one line per tool call, e.g. "webSearch: latest stable Linux kernel version". Copilot does not expose a token-level reasoning trace even in Think Deeper mode, so this is empty whenever it answered without calling a tool.',
  );

// --- Conversation turn ---

export const turnSchema = z.object({
  prompt: z.string().describe('User prompt text'),
  response: z.string().describe('Copilot response text in Markdown'),
  thinking: thinkingField,
  search_results: searchResultsField,
  message_id: z.string().describe('ID of the Copilot message that holds the reply'),
  model_id: z.string().describe('Mode the prompt was sent under (e.g., "smart"), or "" when Copilot recorded none'),
  created_at: z.string().describe('ISO 8601 timestamp of the turn'),
});

export const mapTurn = (turn: CopilotTurn) => ({
  prompt: turn.prompt,
  response: turn.response,
  thinking: turn.thinking,
  search_results: turn.searchResults.map(mapSearchResult),
  message_id: turn.messageId,
  model_id: turn.modelId,
  created_at: turn.createdAt,
});

// --- Chat result ---

export const chatResultSchema = z.object({
  conversation_id: z.string().describe('Conversation ID'),
  message_id: z.string().describe('ID of the Copilot message that was generated'),
  parent_message_id: z.string().describe('ID of the user message this reply answers'),
  text: z.string().describe('Copilot response text in Markdown'),
  thinking: thinkingField,
  search_results: searchResultsField,
  title: z.string().describe('Title Copilot assigned to the conversation'),
  model_id: z.string().describe('Mode the message was sent under'),
  url: z.string().describe('URL to the conversation on copilot.microsoft.com'),
});

export const mapChatResult = (result: CopilotChatResult, url: string) => ({
  conversation_id: result.conversationId,
  message_id: result.messageId,
  parent_message_id: result.parentMessageId,
  text: result.text,
  thinking: result.thinking,
  search_results: result.searchResults.map(mapSearchResult),
  title: result.title,
  model_id: result.modelId,
  url,
});

// --- Shared chat inputs ---

export const modelIdInput = z
  .string()
  .optional()
  .describe(
    'Mode ID from list_models ("smart", "reasoning", "study", "search"). Copilot has no model picker — these are the composer\'s chat modes. Defaults to "smart", or to the mode implied by `thinking` / `search`.',
  );

export const thinkingInput = z
  .boolean()
  .optional()
  .describe(
    'Shorthand for selecting Copilot\'s "Think deeper" mode (model_id "reasoning") when model_id is not given. Copilot exposes reasoning as a mode rather than a per-message flag and never streams the reasoning itself, so `thinking` in the result only ever holds tool-call narration. Note that Think Deeper occasionally returns no content at all for search-heavy prompts; "smart" is more reliable.',
  );

export const searchInput = z
  .boolean()
  .optional()
  .describe(
    'Shorthand for selecting Copilot\'s "Search" mode (model_id "search"), which answers with enhanced references, when model_id is not given. Copilot decides on its own whether to search in every other mode, so pages it actually cited always come back in `search_results` regardless of this flag. Passing false does not disable search.',
  );
