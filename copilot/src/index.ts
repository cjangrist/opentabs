import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './copilot-api.js';
import { deleteConversation, listConversations, renameConversation, starConversation } from './tools/conversations.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listModels } from './tools/list-models.js';
import { searchConversations } from './tools/search-conversations.js';
import { createConversation, sendMessage } from './tools/send.js';

class CopilotPlugin extends OpenTabsPlugin {
  readonly name = 'copilot';
  readonly description = 'OpenTabs plugin for Microsoft Copilot (copilot.microsoft.com)';
  override readonly displayName = 'Microsoft Copilot';
  readonly urlPatterns = ['*://copilot.microsoft.com/*'];
  override readonly homepage = 'https://copilot.microsoft.com';
  readonly tools: ToolDefinition[] = [
    // Account
    getCurrentUser,
    listModels,
    // Conversations
    listConversations,
    searchConversations,
    getConversation,
    createConversation,
    sendMessage,
    renameConversation,
    starConversation,
    deleteConversation,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new CopilotPlugin();
