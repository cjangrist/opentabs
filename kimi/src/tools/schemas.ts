import { z } from 'zod';

// --- User ---

export const userSchema = z.object({
  id: z.string().describe('Kimi user ID'),
  nickname: z.string().describe('Display name on the account'),
  phone: z.string().describe('Masked phone number registered to the account, when present'),
  region: z.string().describe('Account region (e.g., "REGION_OVERSEA")'),
  avatar: z.string().describe('Avatar image URL'),
});

// --- Model ---

export const modelSchema = z.object({
  id: z.string().describe('Model ID to pass as model_id (e.g., "k2d6", "k3", "k3-agent-ultra")'),
  display_name: z.string().describe('Display name shown in the Kimi model picker (e.g., "Instant", "K3")'),
  description: z.string().describe('Short description of the model'),
  is_default: z.boolean().describe('Whether this is the account default model'),
  scenario: z.string().describe('Internal Kimi scenario enum used by the chat API'),
});

export interface RawModel {
  id?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  scenario?: string;
}

export const mapModel = (model: RawModel) => ({
  id: model.id ?? '',
  display_name: model.displayName ?? '',
  description: model.description ?? '',
  is_default: model.isDefault ?? false,
  scenario: model.scenario ?? '',
});

// --- Conversation ---

export const conversationSchema = z.object({
  id: z.string().describe('Conversation (chat) ID'),
  title: z.string().describe('Conversation title'),
  url: z.string().describe('URL to the conversation on kimi.com'),
  project_id: z
    .string()
    .describe(
      'Project this conversation belongs to, or "" for a standalone chat. Kimi nests project chats under the Projects section of the sidebar rather than the flat Chats list.',
    ),
});

export interface RawConversation {
  id?: string;
  title?: string;
  url?: string;
  projectId?: string;
}

export const mapConversation = (conversation: RawConversation) => ({
  id: conversation.id ?? '',
  title: conversation.title ?? '',
  url: conversation.url ?? '',
  project_id: conversation.projectId ?? '',
});

// --- Conversation turn ---

export const turnSchema = z.object({
  prompt: z.string().describe('User prompt text'),
  response: z.string().describe('Kimi response text in Markdown'),
  thinking: z.string().describe('Kimi reasoning text, when the turn used thinking mode'),
});

// --- Chat result ---

export const chatResultSchema = z.object({
  conversation_id: z.string().describe('Conversation (chat) ID'),
  message_id: z.string().describe('ID of the assistant message that was generated'),
  parent_message_id: z.string().describe('ID of the user message this reply answers'),
  text: z.string().describe('Kimi response text in Markdown'),
  thinking: z.string().describe('Kimi reasoning text, when thinking mode was enabled'),
  url: z.string().describe('URL to the conversation on kimi.com'),
});

export interface RawChatResult {
  conversationId?: string;
  messageId?: string;
  parentMessageId?: string;
  text?: string;
  thinking?: string;
}

export const mapChatResult = (result: RawChatResult, url: string) => ({
  conversation_id: result.conversationId ?? '',
  message_id: result.messageId ?? '',
  parent_message_id: result.parentMessageId ?? '',
  text: result.text ?? '',
  thinking: result.thinking ?? '',
  url,
});
