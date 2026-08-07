import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, getOrgId } from '../claude-api.js';

const modelSchema = z.object({
  model: z.string().describe('Model ID (e.g., "claude-sonnet-5")'),
  name: z.string().describe('Display name (e.g., "Claude Sonnet 5")'),
  description: z.string().describe('Model description'),
  is_default: z.boolean().describe('Whether this is the default model shown in the picker'),
  inactive: z.boolean().describe('Whether the model is deprecated and no longer offered'),
  overflow: z.boolean().describe('Whether the model is hidden behind the picker’s "More models" menu'),
});

interface RawModel {
  model?: string;
  name?: string;
  description?: string;
  inactive?: boolean;
  overflow?: boolean;
}

interface RawBootstrapModels {
  account?: {
    memberships?: {
      organization?: {
        uuid?: string;
        claude_ai_bootstrap_models_config?: RawModel[];
      };
    }[];
  };
  model_selector_state?: { id?: string; model?: string }[];
}

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    'List all available Claude AI models for the current organization including model IDs, display names, and descriptions.',
  summary: 'List available Claude models',
  icon: 'cpu',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    models: z.array(modelSchema).describe('List of available models'),
  }),
  handle: async () => {
    const orgId = getOrgId();
    const data = await api<RawBootstrapModels>(`/bootstrap/${orgId}/app_start`);

    // memberships[] is not ordered by the active org — an account with both a
    // Claude.ai org and an API org gets the wrong model list from memberships[0].
    const memberships = data.account?.memberships ?? [];
    const activeMembership = memberships.find(m => m.organization?.uuid === orgId) ?? memberships[0];
    const rawModels = activeMembership?.organization?.claude_ai_bootstrap_models_config ?? [];

    const defaultModel = data.model_selector_state?.find(s => s.id === 'chat')?.model;

    const models = rawModels.map(m => ({
      model: m.model ?? '',
      name: m.name ?? '',
      description: m.description ?? '',
      is_default: !!m.model && m.model === defaultModel,
      inactive: m.inactive ?? false,
      overflow: m.overflow ?? false,
    }));

    return { models };
  },
});
