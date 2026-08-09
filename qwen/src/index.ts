import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './qwen-api.js';
import { archiveConversation, deleteConversation, renameConversation } from './tools/conversation-admin.js';
import { createConversation } from './tools/create-conversation.js';
import { answerDeepResearch, cancelDeepResearch, getDeepResearch, startDeepResearch } from './tools/deep-research.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listCapabilities } from './tools/list-capabilities.js';
import { listConversations } from './tools/list-conversations.js';
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
import { searchConversations } from './tools/search-conversations.js';
import { sendMessage } from './tools/send-message.js';

class QwenPlugin extends OpenTabsPlugin {
  readonly name = 'qwen';
  readonly description = 'OpenTabs plugin for Qwen (chat.qwen.ai)';
  override readonly displayName = 'Qwen';
  readonly urlPatterns = ['*://chat.qwen.ai/*', '*://*.qwen.ai/*'];
  override readonly homepage = 'https://chat.qwen.ai';
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
    archiveConversation,
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

export default new QwenPlugin();
