import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './copilot-api.js';
import { createConversation } from './tools/create-conversation.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listConversations } from './tools/list-conversations.js';
import { listModels } from './tools/list-models.js';
import { sendMessage } from './tools/send-message.js';

class CopilotPlugin extends OpenTabsPlugin {
  readonly name = 'copilot';
  readonly description = 'OpenTabs plugin for Microsoft Copilot (copilot.microsoft.com)';
  override readonly displayName = 'Microsoft Copilot';
  readonly urlPatterns = ['*://copilot.microsoft.com/*'];
  override readonly homepage = 'https://copilot.microsoft.com';
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

export default new CopilotPlugin();
