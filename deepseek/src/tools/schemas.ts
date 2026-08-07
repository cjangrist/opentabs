import { z } from 'zod';
import type {
  DeepSeekChatResult,
  DeepSeekConversation,
  DeepSeekModel,
  DeepSeekSearchResult,
  DeepSeekTurn,
} from '../deepseek-api.js';

// --- User ---

export const userSchema = z.object({
  id: z.string().describe('DeepSeek user ID'),
  email: z.string().describe('Email on the account, partially masked by DeepSeek'),
  name: z.string().describe('Display name from the linked identity provider'),
  provider: z.string().describe('Identity provider used to sign in (e.g., "GOOGLE", "APPLE", or "" for email/phone)'),
  mobile_number: z.string().describe('Mobile number registered to the account, when present'),
  avatar: z.string().describe('Avatar image URL'),
});

// --- Model ---

export const modelSchema = z.object({
  id: z.string().describe('Model ID to pass as model_id ("default", "expert", or "vision")'),
  display_name: z.string().describe('Name shown in the DeepSeek model picker (e.g., "Instant", "Expert", "Vision")'),
  description: z.string().describe('Short description of the model'),
  is_default: z.boolean().describe('Whether this is the account default model'),
  supports_thinking: z
    .boolean()
    .describe('Whether this model accepts the DeepThink reasoning toggle (the `thinking` parameter)'),
  supports_search: z.boolean().describe('Whether this model accepts the web Search toggle (the `search` parameter)'),
});

export const mapModel = (model: DeepSeekModel) => ({
  id: model.id,
  display_name: model.displayName,
  description: model.description,
  is_default: model.isDefault,
  supports_thinking: model.supportsThinking,
  supports_search: model.supportsSearch,
});

// --- Conversation ---

export const conversationSchema = z.object({
  id: z.string().describe('Conversation (chat session) ID'),
  title: z.string().describe('Conversation title, or "" while DeepSeek is still generating one'),
  url: z.string().describe('URL to the conversation on chat.deepseek.com'),
  model_id: z.string().describe('Model the conversation was started with ("default", "expert" or "vision")'),
  pinned: z.boolean().describe('Whether the conversation is pinned to the top of the sidebar'),
  updated_at: z.number().describe('Unix timestamp (seconds) of the last update'),
});

export const mapConversation = (conversation: DeepSeekConversation) => ({
  id: conversation.id,
  title: conversation.title,
  url: conversation.url,
  model_id: conversation.modelId,
  pinned: conversation.pinned,
  updated_at: conversation.updatedAt,
});

// --- Search ---

export const searchResultSchema = z.object({
  title: z.string().describe('Title of the cited page'),
  url: z.string().describe('URL of the cited page'),
  snippet: z.string().describe('Extract DeepSeek read from the page'),
  site_name: z.string().describe('Name of the site the page belongs to'),
  cite_index: z
    .number()
    .describe('Number this source appears as in the response text, written inline as "[citation:N]"'),
});

export const mapSearchResult = (result: DeepSeekSearchResult) => ({
  title: result.title,
  url: result.url,
  snippet: result.snippet,
  site_name: result.siteName,
  cite_index: result.citeIndex,
});

const searchQueriesField = z
  .array(z.string())
  .describe('Web search queries DeepSeek ran, when the search toggle was enabled');

const searchResultsField = z
  .array(searchResultSchema)
  .describe('Sources DeepSeek cited. Match cite_index against the "[citation:N]" markers in the response text.');

// --- Conversation turn ---

export const turnSchema = z.object({
  prompt: z.string().describe('User prompt text'),
  response: z.string().describe('DeepSeek response text in Markdown'),
  thinking: z.string().describe('DeepThink reasoning text, when the turn used the reasoning toggle'),
  search_queries: searchQueriesField,
  search_results: searchResultsField,
});

export const mapTurn = (turn: DeepSeekTurn) => ({
  prompt: turn.prompt,
  response: turn.response,
  thinking: turn.thinking,
  search_queries: turn.searchQueries,
  search_results: turn.searchResults.map(mapSearchResult),
});

// --- Chat result ---

export const chatResultSchema = z.object({
  conversation_id: z.string().describe('Conversation (chat session) ID'),
  message_id: z.number().describe('ID of the assistant message that was generated'),
  parent_message_id: z.number().describe('ID of the user message this reply answers'),
  text: z.string().describe('DeepSeek response text in Markdown'),
  thinking: z.string().describe('DeepThink reasoning text, when the reasoning toggle was enabled'),
  search_queries: searchQueriesField,
  search_results: searchResultsField,
  title: z.string().describe('Title DeepSeek assigned to the conversation, when it generated one on this turn'),
  url: z.string().describe('URL to the conversation on chat.deepseek.com'),
});

export const mapChatResult = (result: DeepSeekChatResult, url: string) => ({
  conversation_id: result.conversationId,
  message_id: result.messageId,
  parent_message_id: result.parentMessageId,
  text: result.text,
  thinking: result.thinking,
  search_queries: result.searchQueries,
  search_results: result.searchResults.map(mapSearchResult),
  title: result.title,
  url,
});

// --- Shared chat inputs ---

export const modelIdInput = z
  .string()
  .optional()
  .describe('Model ID from list_models ("default", "expert", "vision"). Defaults to "default" (Instant).');

export const thinkingInput = z
  .boolean()
  .optional()
  .describe(
    "Enable DeepSeek's DeepThink reasoning mode for this message (default false). DeepThink is a per-message toggle rather than a separate model; the reasoning text comes back in the `thinking` field.",
  );

export const searchInput = z
  .boolean()
  .optional()
  .describe(
    'Let DeepSeek search the web while answering (default false). Only the "default" (Instant) model supports search — see supports_search in list_models.',
  );
