import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './zai-api.js';
import { archiveConversation, deleteConversation, renameConversation } from './tools/conversation-admin.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listCapabilities } from './tools/list-capabilities.js';
import { listConversations } from './tools/list-conversations.js';
import { listModels } from './tools/list-models.js';
import { searchConversations } from './tools/search-conversations.js';

class ZaiPlugin extends OpenTabsPlugin {
  readonly name = 'zai';
  readonly description = 'OpenTabs plugin for Z.ai';
  override readonly displayName = 'Z.ai';
  readonly urlPatterns = ['*://z.ai/*', '*://*.z.ai/*'];
  override readonly homepage = 'https://chat.z.ai';
  readonly tools: ToolDefinition[] = [
    getCurrentUser,
    listModels,
    listCapabilities,
    listConversations,
    searchConversations,
    getConversation,
    renameConversation,
    archiveConversation,
    deleteConversation,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new ZaiPlugin();
