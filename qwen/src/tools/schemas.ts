import { z } from 'zod';
import type { QwenChatResult, QwenConversation, QwenModel, QwenSearchResult, QwenTurn } from '../qwen-api.js';

// --- User ---

export const userSchema = z.object({
  id: z.string().describe('Qwen user ID'),
  email: z.string().describe('Email on the account'),
  name: z.string().describe('Display name on the account'),
  role: z.string().describe('Account role reported by Qwen (e.g., "user")'),
  tier: z.string().describe('Subscription tier reported by Qwen (e.g., "normal")'),
});

// --- Model ---

export const modelSchema = z.object({
  id: z.string().describe('Model ID to pass as model_id (e.g., "qwen3.8-max")'),
  display_name: z.string().describe('Name shown in the Qwen model picker (e.g., "Qwen3.8-Max")'),
  description: z.string().describe('Short description of the model'),
  is_default: z.boolean().describe('Whether Qwen preselects this model (the first entry in the picker)'),
  supports_thinking: z.boolean().describe('Whether this model accepts the reasoning toggle (the `thinking` parameter)'),
  supports_search: z.boolean().describe('Whether this model accepts the web search toggle (the `search` parameter)'),
  max_context_length: z.number().describe('Maximum context window in tokens'),
});

export const mapModel = (model: QwenModel) => ({
  id: model.id,
  display_name: model.displayName,
  description: model.description,
  is_default: model.isDefault,
  supports_thinking: model.supportsThinking,
  supports_search: model.supportsSearch,
  max_context_length: model.maxContextLength,
});

// --- Conversation ---

export const conversationSchema = z.object({
  id: z.string().describe('Conversation (chat) ID'),
  title: z.string().describe('Conversation title, or "" while Qwen is still generating one'),
  url: z.string().describe('URL to the conversation on chat.qwen.ai'),
  chat_type: z
    .string()
    .describe('Kind of chat Qwen recorded ("t2t" plain chat, "search" web search, "deep_research", "t2i", …)'),
  project_id: z.string().describe('ID of the project the chat belongs to, or "" for chats in the main sidebar list'),
  pinned: z.boolean().describe('Whether the conversation is pinned to the top of the sidebar'),
  updated_at: z.number().describe('Unix timestamp (seconds) of the last update'),
});

export const mapConversation = (conversation: QwenConversation) => ({
  id: conversation.id,
  title: conversation.title,
  url: conversation.url,
  chat_type: conversation.chatType,
  project_id: conversation.projectId,
  pinned: conversation.pinned,
  updated_at: conversation.updatedAt,
});

// --- Search ---

export const searchResultSchema = z.object({
  title: z.string().describe('Title of the cited page'),
  url: z.string().describe('URL of the cited page'),
  snippet: z.string().describe('Extract Qwen read from the page'),
  hostname: z.string().describe('Host the page belongs to'),
});

export const mapSearchResult = (result: QwenSearchResult) => ({
  title: result.title,
  url: result.url,
  snippet: result.snippet,
  hostname: result.hostname,
});

const searchResultsField = z
  .array(searchResultSchema)
  .describe('Web pages Qwen consulted, when the search toggle was enabled');

// --- Conversation turn ---

export const turnSchema = z.object({
  prompt: z.string().describe('User prompt text'),
  response: z.string().describe('Qwen response text in Markdown'),
  thinking: z.string().describe('Reasoning summary, when the turn used the thinking toggle'),
  search_results: searchResultsField,
});

export const mapTurn = (turn: QwenTurn) => ({
  prompt: turn.prompt,
  response: turn.response,
  thinking: turn.thinking,
  search_results: turn.searchResults.map(mapSearchResult),
});

// --- Chat result ---

export const chatResultSchema = z.object({
  conversation_id: z.string().describe('Conversation (chat) ID'),
  response_id: z.string().describe('ID of the assistant message that was generated'),
  parent_message_id: z.string().describe('ID of the user message this reply answers'),
  text: z.string().describe('Qwen response text in Markdown'),
  thinking: z.string().describe('Reasoning summary, when the thinking toggle was enabled'),
  search_results: searchResultsField,
  title: z.string().describe('Title Qwen assigned to the conversation'),
  model_id: z.string().describe('Model that produced the reply'),
  url: z.string().describe('URL to the conversation on chat.qwen.ai'),
});

export const mapChatResult = (result: QwenChatResult, url: string) => ({
  conversation_id: result.conversationId,
  response_id: result.responseId,
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
  .describe('Model ID from list_models (e.g., "qwen3.8-max"). Defaults to the model Qwen preselects.');

export const thinkingInput = z
  .boolean()
  .optional()
  .describe(
    'Force Qwen\'s reasoning mode on (true) or off (false) for this message. Thinking is a per-message toggle rather than a separate model; the reasoning summary comes back in the `thinking` field. Omit to leave Qwen on its default "Auto" setting, where the model decides.',
  );

export const searchInput = z
  .boolean()
  .optional()
  .describe(
    'Let Qwen search the web while answering (default false). Sends the message as a "search" chat, and the pages consulted come back in `search_results`. See supports_search in list_models.',
  );
