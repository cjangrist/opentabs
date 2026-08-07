import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './claude-api.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listCapabilities } from './tools/list-capabilities.js';
import { listConversations } from './tools/list-conversations.js';
import { listModels } from './tools/list-models.js';
import { listOrganizations } from './tools/list-organizations.js';

class ClaudePlugin extends OpenTabsPlugin {
  readonly name = 'claude';
  readonly description = 'OpenTabs plugin for Claude';
  override readonly displayName = 'Claude';
  readonly urlPatterns = ['*://claude.ai/*'];
  override readonly homepage = 'https://claude.ai';
  readonly tools: ToolDefinition[] = [
    // Account
    getCurrentUser,
    listOrganizations,
    listModels,
    listCapabilities,
    // Conversations
    listConversations,
    getConversation,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new ClaudePlugin();
