import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './grok-api.js';
import {
  deleteConversation,
  listConversations,
  renameConversation,
  searchConversations,
  starConversation,
} from './tools/conversations.js';
import { answerDeepResearch, cancelDeepResearch, getDeepResearch, startDeepResearch } from './tools/deep-research.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listCapabilities } from './tools/list-capabilities.js';
import { listModels } from './tools/list-models.js';
import {
  addConversationToProjectTool,
  createProject,
  deleteProject,
  getProject,
  listProjectConversations,
  listProjects,
  moveConversationToProject,
  removeConversationFromProject,
  updateProject,
} from './tools/projects.js';
import { createConversation, sendMessage } from './tools/send.js';

class GrokPlugin extends OpenTabsPlugin {
  readonly name = 'grok';
  readonly description = 'OpenTabs plugin for Grok (grok.com)';
  override readonly displayName = 'Grok';
  readonly urlPatterns = ['*://grok.com/*', '*://*.grok.com/*'];
  override readonly homepage = 'https://grok.com';
  readonly tools: ToolDefinition[] = [
    // Account
    getCurrentUser,
    // Models
    listModels,
    listCapabilities,
    // Conversations
    listConversations,
    searchConversations,
    getConversation,
    createConversation,
    sendMessage,
    renameConversation,
    starConversation,
    deleteConversation,
    // Projects
    listProjects,
    getProject,
    listProjectConversations,
    createProject,
    updateProject,
    deleteProject,
    addConversationToProjectTool,
    removeConversationFromProject,
    moveConversationToProject,
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

export default new GrokPlugin();
