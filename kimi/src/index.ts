import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './kimi-api.js';
import { deleteConversation, renameConversation } from './tools/conversation-admin.js';
import { createConversation } from './tools/create-conversation.js';
import { answerDeepResearch, cancelDeepResearch, getDeepResearch, startDeepResearch } from './tools/deep-research.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { listCapabilities } from './tools/list-capabilities.js';
import { listConversations } from './tools/list-conversations.js';
import { listModels } from './tools/list-models.js';
import {
  createProject,
  deleteProject,
  getProject,
  listProjectConversations,
  listProjects,
  updateProject,
} from './tools/projects.js';
import { searchConversations } from './tools/search-conversations.js';
import { sendMessage } from './tools/send-message.js';

class KimiPlugin extends OpenTabsPlugin {
  readonly name = 'kimi';
  readonly description = 'OpenTabs plugin for Kimi (kimi.com)';
  override readonly displayName = 'Kimi';
  readonly urlPatterns = ['*://kimi.com/*', '*://*.kimi.com/*'];
  override readonly homepage = 'https://www.kimi.com';
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
    // Projects — Kimi has no membership-move primitive, so
    // add/remove/move_conversation_to_project are deliberately absent
    // (declared false with a reason in list_capabilities().features).
    listProjects,
    getProject,
    listProjectConversations,
    createProject,
    updateProject,
    deleteProject,
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

export default new KimiPlugin();
