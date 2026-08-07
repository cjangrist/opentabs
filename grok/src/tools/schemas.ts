import { z } from 'zod';
import type { GrokChatResult, GrokConversation, GrokModel, GrokSearchResult, GrokTurn } from '../grok-api.js';

// --- User ---

export const userSchema = z.object({
  id: z.string().describe('Grok (xAI) user ID'),
  email: z.string().describe('Email on the account'),
  name: z.string().describe('Display name on the account'),
  username: z.string().describe('Linked X/Twitter username, or "" when no X account is linked'),
  subscription_tier: z.string().describe('Subscription tier Grok reports for the account (e.g., "None")'),
  created_at: z.string().describe('ISO 8601 timestamp the account was created'),
});

// --- Model ---

export const modelSchema = z.object({
  id: z.string().describe('Model ID to pass as model_id (e.g., "fast", "expert")'),
  display_name: z.string().describe('Name shown in the Grok model picker (e.g., "Expert")'),
  description: z.string().describe('Short description shown under the name (e.g., "Thinks hard · Grok 4.5")'),
  is_default: z.boolean().describe('Whether Grok preselects this model for the account'),
  is_available: z
    .boolean()
    .describe(
      'Whether the signed-in account may use this model. Sending a message with an unavailable model returns an entitlement error.',
    ),
  requires_subscription_tier: z
    .string()
    .describe('Subscription tier needed to unlock this model, or "" when it is already available'),
  badge: z.string().describe('Badge the picker shows next to the name (e.g., "Beta"), or ""'),
});

export const mapModel = (model: GrokModel) => ({
  id: model.id,
  display_name: model.displayName,
  description: model.description,
  is_default: model.isDefault,
  is_available: model.isAvailable,
  requires_subscription_tier: model.requiresSubscriptionTier,
  badge: model.badge,
});

// --- Conversation ---

export const conversationSchema = z.object({
  id: z.string().describe('Conversation ID'),
  title: z.string().describe('Conversation title, or "" while Grok is still generating one'),
  url: z.string().describe('URL to the conversation on grok.com'),
  starred: z.boolean().describe('Whether the conversation is starred'),
  temporary: z.boolean().describe('Whether this was a temporary (not saved to history) chat'),
  workspace_ids: z
    .array(z.string())
    .describe('IDs of the projects (workspaces) the chat is filed under; empty for chats in the main History list'),
  created_at: z.string().describe('ISO 8601 timestamp the conversation was created'),
  updated_at: z.string().describe('ISO 8601 timestamp of the last message'),
});

export const mapConversation = (conversation: GrokConversation) => ({
  id: conversation.id,
  title: conversation.title,
  url: conversation.url,
  starred: conversation.starred,
  temporary: conversation.temporary,
  workspace_ids: conversation.workspaceIds,
  created_at: conversation.createdAt,
  updated_at: conversation.updatedAt,
});

// --- Search ---

export const searchResultSchema = z.object({
  title: z.string().describe('Title of the cited page'),
  url: z.string().describe('URL of the cited page'),
  snippet: z.string().describe('Extract Grok read from the page'),
  site_name: z.string().describe('Host the page belongs to'),
  cite_index: z.number().describe('Position of the source in the citation list'),
});

export const mapSearchResult = (result: GrokSearchResult) => ({
  title: result.title,
  url: result.url,
  snippet: result.snippet,
  site_name: result.siteName,
  cite_index: result.citeIndex,
});

const searchResultsField = z
  .array(searchResultSchema)
  .describe(
    'Web pages Grok consulted while answering. Grok searches on its own initiative, so this can be non-empty even when search was not requested.',
  );

const thinkingField = z
  .string()
  .describe(
    "Grok's reasoning trace for the turn — one line per step it narrated while working. Empty when the model answered without narrating any steps.",
  );

// --- Conversation turn ---

export const turnSchema = z.object({
  prompt: z.string().describe('User prompt text'),
  response: z.string().describe('Grok response text in Markdown'),
  thinking: thinkingField,
  search_results: searchResultsField,
  response_id: z.string().describe('ID of the message that holds this turn'),
  model_id: z.string().describe('Model that produced the reply (e.g., "fast"), or "" for the user side of the turn'),
});

export const mapTurn = (turn: GrokTurn) => ({
  prompt: turn.prompt,
  response: turn.response,
  thinking: turn.thinking,
  search_results: turn.searchResults.map(mapSearchResult),
  response_id: turn.responseId,
  model_id: turn.modelId,
});

// --- Chat result ---

export const chatResultSchema = z.object({
  conversation_id: z.string().describe('Conversation ID'),
  response_id: z.string().describe('ID of the assistant message that was generated'),
  parent_response_id: z.string().describe('ID of the user message this reply answers'),
  text: z.string().describe('Grok response text in Markdown'),
  thinking: thinkingField,
  search_results: searchResultsField,
  title: z.string().describe('Title Grok assigned to the conversation'),
  model_id: z.string().describe('Model that produced the reply'),
  url: z.string().describe('URL to the conversation on grok.com'),
});

export const mapChatResult = (result: GrokChatResult, url: string) => ({
  conversation_id: result.conversationId,
  response_id: result.responseId,
  parent_response_id: result.parentResponseId,
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
    'Model ID from list_models (e.g., "fast", "expert", "heavy"). Defaults to the model Grok preselects, or to the model implied by `thinking`. Check is_available in list_models first — an unavailable model fails with an entitlement error.',
  );

export const thinkingInput = z
  .boolean()
  .optional()
  .describe(
    'Shorthand for picking a reasoning model when model_id is not given: true selects Grok\'s "expert" (thinks hard) model, false selects "fast". Grok exposes reasoning as a model choice rather than a per-message flag. The reasoning trace comes back in `thinking` either way. Omit to use the account default.',
  );

export const searchInput = z
  .boolean()
  .optional()
  .describe(
    'Ask Grok to use (true) or avoid (false) its web-search tools for this message. Grok has no user-facing search switch and decides autonomously, so treat this as a hint rather than a guarantee; pages it actually read always come back in `search_results`.',
  );
