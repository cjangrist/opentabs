import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './gemini-api.js';
import { deleteConversation, listConversations, renameConversation } from './tools/conversations.js';
import { answerDeepResearch, cancelDeepResearch, getDeepResearch, startDeepResearch } from './tools/deep-research.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listCapabilities } from './tools/list-capabilities.js';
import { listModels } from './tools/list-models.js';
import { searchConversations } from './tools/search-conversations.js';
import { createConversation, sendMessage } from './tools/send.js';

class GeminiPlugin extends OpenTabsPlugin {
  readonly name = 'gemini';
  readonly description = 'OpenTabs plugin for Google Gemini';
  override readonly displayName = 'Gemini';
  readonly urlPatterns = ['*://gemini.google.com/*'];
  override readonly homepage = 'https://gemini.google.com';
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
    // Deep Research
    startDeepResearch,
    getDeepResearch,
    answerDeepResearch,
    cancelDeepResearch,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new GeminiPlugin();
