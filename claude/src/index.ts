import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './claude-api.js';
import { createConversation } from './tools/create-conversation.js';
import { answerDeepResearch, cancelDeepResearch, getDeepResearch, startDeepResearch } from './tools/deep-research.js';
import { deleteConversation } from './tools/delete-conversation.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listCapabilities } from './tools/list-capabilities.js';
import { listConversations } from './tools/list-conversations.js';
import { listModels } from './tools/list-models.js';
import { listOrganizations } from './tools/list-organizations.js';
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
import { renameConversation } from './tools/rename-conversation.js';
import { searchConversations } from './tools/search-conversations.js';
import { sendMessage } from './tools/send-message.js';

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
    searchConversations,
    getConversation,
    createConversation,
    sendMessage,
    renameConversation,
    deleteConversation,
    // Projects
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

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new ClaudePlugin();
