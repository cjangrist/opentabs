import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated } from './perplexity-api.js';
import { createConversation } from './tools/create-conversation.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listConversations } from './tools/list-conversations.js';
import { listModels } from './tools/list-models.js';
import { search } from './tools/search.js';
import { sendMessage } from './tools/send-message.js';

class PerplexityPlugin extends OpenTabsPlugin {
  readonly name = 'perplexity';
  readonly description = 'OpenTabs plugin for Perplexity (perplexity.ai)';
  override readonly displayName = 'Perplexity';
  readonly urlPatterns = [
    '*://perplexity.ai/*',
    '*://*.perplexity.ai/*',
    '*://perplexity.com/*',
    '*://*.perplexity.com/*',
  ];
  override readonly homepage = 'https://www.perplexity.ai';
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
    // Search
    search,
  ];

  /**
   * Perplexity's session lives in an HttpOnly cookie, so there is nothing in
   * localStorage or document.cookie to inspect — readiness is settled by asking
   * the session endpoint for a user id. Logged out it answers `200 {}`, which
   * this reports as not ready.
   */
  async isReady(): Promise<boolean> {
    return isAuthenticated();
  }
}

export default new PerplexityPlugin();
