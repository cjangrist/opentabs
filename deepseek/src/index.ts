import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './deepseek-api.js';
import { deleteConversation, starConversation, renameConversation } from './tools/conversation-admin.js';
import { createConversation } from './tools/create-conversation.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listCapabilities } from './tools/list-capabilities.js';
import { listConversations } from './tools/list-conversations.js';
import { listModels } from './tools/list-models.js';
import { searchConversations } from './tools/search-conversations.js';
import { sendMessage } from './tools/send-message.js';

class DeepSeekPlugin extends OpenTabsPlugin {
  readonly name = 'deepseek';
  readonly description = 'OpenTabs plugin for DeepSeek (chat.deepseek.com)';
  override readonly displayName = 'DeepSeek';
  readonly urlPatterns = ['*://chat.deepseek.com/*', '*://*.deepseek.com/*'];
  override readonly homepage = 'https://chat.deepseek.com';
  readonly tools: ToolDefinition[] = [
    // Account
    getCurrentUser,
    listModels,
    listCapabilities,
    // Conversations
    listConversations,
    searchConversations,
    getConversation,
    createConversation,
    sendMessage,
    renameConversation,
    deleteConversation,
    starConversation,
    // DeepSeek has no projects and no Deep Research mode, so SPEC §5 and §7 tools
    // are deliberately absent — declared false with a reason in
    // list_capabilities().features rather than shipped as empty stubs.
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new DeepSeekPlugin();
