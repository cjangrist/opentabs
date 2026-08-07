import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './chatgpt-api.js';
import {
  archiveConversation,
  deleteConversation,
  renameConversation,
  starConversation,
} from './tools/conversation-actions.js';
import { discoverGpts } from './tools/discover-gpts.js';
import { getAccountInfo } from './tools/get-account-info.js';
import { getBetaFeatures } from './tools/get-beta-features.js';
import { getConversation } from './tools/get-conversation.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { getCustomInstructions } from './tools/get-custom-instructions.js';
import { getGpt } from './tools/get-gpt.js';
import { getMemories } from './tools/get-memories.js';
import { getPromptLibrary } from './tools/get-prompt-library.js';
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
import { createConversation, sendMessage } from './tools/send.js';
import { updateCustomInstructions } from './tools/update-custom-instructions.js';

class ChatGPTPlugin extends OpenTabsPlugin {
  readonly name = 'chatgpt';
  readonly description = 'OpenTabs plugin for ChatGPT';
  override readonly displayName = 'ChatGPT';
  readonly urlPatterns = ['*://*.chatgpt.com/*'];
  override readonly homepage = 'https://chatgpt.com';
  readonly tools: ToolDefinition[] = [
    // Account
    getCurrentUser,
    getAccountInfo,
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
    starConversation,
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
    // ChatGPT-specific extras (outside the SPEC surface)
    getMemories,
    getCustomInstructions,
    updateCustomInstructions,
    getBetaFeatures,
    getPromptLibrary,
    getGpt,
    discoverGpts,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new ChatGPTPlugin();
