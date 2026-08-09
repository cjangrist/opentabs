import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './perplexity-api.js';
import { archiveConversation, deleteConversation, renameConversation } from './tools/conversation-actions.js';
import { answerDeepResearch, cancelDeepResearch, getDeepResearch, startDeepResearch } from './tools/deep-research.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listCapabilities } from './tools/list-capabilities.js';
import { listConversations, searchConversations } from './tools/list-conversations.js';
import { listModels } from './tools/list-models.js';
import {
  addConversationToProject,
  createProject,
  deleteProject,
  getProject,
  listProjectConversations,
  listProjects,
  moveConversationToProject,
  removeConversationFromProject,
  updateProject,
} from './tools/projects.js';
import { createConversation, sendMessage } from './tools/send-message.js';

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
    archiveConversation,
    // Projects (Spaces)
    listProjects,
    getProject,
    listProjectConversations,
    createProject,
    updateProject,
    deleteProject,
    addConversationToProject,
    removeConversationFromProject,
    moveConversationToProject,
    // Deep research
    startDeepResearch,
    getDeepResearch,
    answerDeepResearch,
    cancelDeepResearch,
  ];

  /**
   * Perplexity's session lives in an HttpOnly cookie, so there is nothing in
   * localStorage or document.cookie to inspect — readiness is settled by asking
   * the session endpoint for a user id. Logged out it answers `200 {}`, which
   * this reports as not ready.
   */
  async isReady(): Promise<boolean> {
    if (await isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new PerplexityPlugin();
