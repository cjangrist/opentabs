import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './qwen-api.js';
import { createConversation } from './tools/create-conversation.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listConversations } from './tools/list-conversations.js';
import { listModels } from './tools/list-models.js';
import { sendMessage } from './tools/send-message.js';

class QwenPlugin extends OpenTabsPlugin {
  readonly name = 'qwen';
  readonly description = 'OpenTabs plugin for Qwen (chat.qwen.ai)';
  override readonly displayName = 'Qwen';
  readonly urlPatterns = ['*://chat.qwen.ai/*', '*://*.qwen.ai/*'];
  override readonly homepage = 'https://chat.qwen.ai';
  readonly tools: ToolDefinition[] = [
    // Account
    getCurrentUser,
    // Models
    listModels,
    // Conversations
    listConversations,
    getConversation,
    createConversation,
    // Chat
    sendMessage,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new QwenPlugin();
