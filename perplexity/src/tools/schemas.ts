import { z } from 'zod';
import { FOCUS_VALUES, SOURCE_VALUES } from '../perplexity-api.js';

// --- User ---

export const userSchema = z.object({
  id: z.string().describe('Perplexity account UUID'),
  email: z.string().describe('Email address on the account'),
  username: z.string().describe('Perplexity username'),
  subscription_status: z.string().describe('Subscription status (e.g., "none", "active")'),
  subscription_tier: z.string().describe('Subscription tier when subscribed (e.g., "pro", "max"), else ""'),
  org_role: z.string().describe('Enterprise organisation role, or "none" for a personal account'),
});

// --- Model ---

export const modelSchema = z.object({
  id: z.string().describe('Model ID to pass as model_id (e.g., "turbo", "gpt56_terra", "claude50sonnetthinking")'),
  display_name: z.string().describe('Label shown in the Perplexity model picker (e.g., "Best", "Claude Sonnet 5")'),
  description: z.string().describe('Short description of the model'),
  is_default: z.boolean().describe("Whether this is the account's default search model"),
  mode: z.string().describe('Perplexity mode the model belongs to: search, research, study, asi, browser_agent, …'),
  provider: z.string().describe('Upstream provider (PERPLEXITY, OPENAI, ANTHROPIC, GOOGLE, XAI, …)'),
  subscription_tier: z
    .string()
    .describe('Plan required to select this model in the UI ("pro", "max"), or "" when not gated / not in the picker'),
  in_model_picker: z
    .boolean()
    .describe(
      "Whether the site's own model picker lists this id. The API accepts many more ids than the picker shows, so non-picker ids are still usable but may be silently downgraded on a free plan.",
    ),
});

export interface RawModel {
  id?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  mode?: string;
  provider?: string;
  subscriptionTier?: string;
  inModelPicker?: boolean;
}

export const mapModel = (model: RawModel) => ({
  id: model.id ?? '',
  display_name: model.displayName ?? '',
  description: model.description ?? '',
  is_default: model.isDefault ?? false,
  mode: model.mode ?? '',
  provider: model.provider ?? '',
  subscription_tier: model.subscriptionTier ?? '',
  in_model_picker: model.inModelPicker ?? false,
});

// --- Conversation ---

export const conversationSchema = z.object({
  id: z.string().describe('Thread ID (the slug in the /search/<id> URL)'),
  title: z.string().describe('Thread title'),
  url: z.string().describe('URL to the thread on perplexity.ai'),
  updated_at: z.string().describe('ISO timestamp of the last update'),
  status: z.string().describe('Thread status (e.g., "completed")'),
  mode: z.string().describe('Thread mode (e.g., "search", "research")'),
  space_name: z.string().describe('Space/Project the thread belongs to, or "" for a standalone thread'),
});

export interface RawConversation {
  id?: string;
  title?: string;
  url?: string;
  updatedAt?: string;
  status?: string;
  mode?: string;
  spaceName?: string;
}

export const mapConversation = (conversation: RawConversation) => ({
  id: conversation.id ?? '',
  title: conversation.title ?? '',
  url: conversation.url ?? '',
  updated_at: conversation.updatedAt ?? '',
  status: conversation.status ?? '',
  mode: conversation.mode ?? '',
  space_name: conversation.spaceName ?? '',
});

// --- Sources / citations ---

export const sourceSchema = z.object({
  title: z.string().describe('Title of the cited page'),
  url: z.string().describe('URL of the cited page'),
  snippet: z.string().describe('Snippet Perplexity extracted from the page, when present'),
});

export interface RawSource {
  title?: string;
  url?: string;
  snippet?: string;
}

export const mapSource = (source: RawSource) => ({
  title: source.title ?? '',
  url: source.url ?? '',
  snippet: source.snippet ?? '',
});

// --- Conversation turn ---

export const turnSchema = z.object({
  prompt: z.string().describe('The query the user asked'),
  response: z.string().describe('Perplexity answer in Markdown; [n] markers index into sources'),
  model: z.string().describe('Model that produced this answer'),
  sources: z.array(sourceSchema).describe('Cited web results, in citation order — [1] is sources[0]'),
});

export interface RawTurn {
  prompt?: string;
  response?: string;
  model?: string;
  sources?: RawSource[];
}

export const mapTurn = (turn: RawTurn) => ({
  prompt: turn.prompt ?? '',
  response: turn.response ?? '',
  model: turn.model ?? '',
  sources: (turn.sources ?? []).map(mapSource),
});

// --- Ask result ---

export const askResultSchema = z.object({
  conversation_id: z.string().describe('Thread ID — pass to send_message or get_conversation'),
  entry_id: z.string().describe('Backend UUID of this specific query/answer entry within the thread'),
  text: z.string().describe('Perplexity answer in Markdown; [n] markers index into sources'),
  sources: z.array(sourceSchema).describe('Cited web results, in citation order — [1] is sources[0]'),
  related_questions: z.array(z.string()).describe('Follow-up questions Perplexity suggests'),
  model: z.string().describe('Model that actually produced the answer (may differ from model_id on a free plan)'),
  title: z.string().describe('Thread title'),
  url: z.string().describe('URL to the thread on perplexity.ai'),
});

export interface RawAskResult {
  conversationId?: string;
  entryId?: string;
  text?: string;
  sources?: RawSource[];
  relatedQuestions?: string[];
  model?: string;
  title?: string;
}

export const mapAskResult = (result: RawAskResult, url: string) => ({
  conversation_id: result.conversationId ?? '',
  entry_id: result.entryId ?? '',
  text: result.text ?? '',
  sources: (result.sources ?? []).map(mapSource),
  related_questions: result.relatedQuestions ?? [],
  model: result.model ?? '',
  title: result.title ?? '',
  url,
});

// --- Shared inputs ---

export const modelIdInput = z
  .string()
  .optional()
  .describe('Model ID from list_models (e.g., "turbo", "gpt56_terra"). Defaults to the account default ("turbo").');

export const focusInput = z
  .enum(FOCUS_VALUES)
  .optional()
  .describe(
    'Where Perplexity should look: "internet" (default, general web), "scholar" (academic papers), "social" (forums/Reddit/YouTube), or "writing" (answer from the model alone, no web search).',
  );

export const sourcesInput = z
  .array(z.enum(SOURCE_VALUES))
  .optional()
  .describe('Explicit source set, overriding focus. Any of "web", "scholar", "social".');
