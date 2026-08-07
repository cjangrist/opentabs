import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../chatgpt-api.js';

/**
 * The settings document the backend stores. POST replaces it wholesale, so any field left
 * out of the body is cleared — which is why this tool reads the current settings and merges
 * into them instead of posting only the fields it knows about.
 */
interface UserSystemMessages {
  about_user_message?: string;
  about_model_message?: string;
  name_user_message?: string;
  role_user_message?: string;
  traits_model_message?: string;
  other_user_message?: string;
  personality_type_selection?: string;
  disabled_tools?: string[];
  enabled?: boolean;
  traits_enabled?: boolean;
  personality_traits?: Record<string, string>;
  [key: string]: unknown;
}

export const updateCustomInstructions = defineTool({
  name: 'update_custom_instructions',
  displayName: 'Update Custom Instructions',
  description:
    'Update ChatGPT custom instructions. Only the fields you pass are changed — everything else (name, role, traits, personality preset) is preserved. Pass an empty string to clear a specific field.',
  summary: 'Update your custom instructions',
  icon: 'pencil',
  group: 'Settings',
  input: z.object({
    about_user: z.string().optional().describe('What you want ChatGPT to know about you'),
    about_model: z.string().optional().describe('How you want ChatGPT to respond'),
    name: z.string().optional().describe('What ChatGPT should call you'),
    role: z.string().optional().describe('What you do (occupation)'),
    traits: z.string().optional().describe('Traits ChatGPT should have'),
    other: z.string().optional().describe('Other free-form instructions'),
    enabled: z.boolean().optional().describe('Whether custom instructions are enabled'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the operation succeeded'),
    updated_fields: z.array(z.string()).describe('Names of the settings fields this call changed'),
  }),
  handle: async params => {
    const current = (await api<UserSystemMessages>('/user_system_messages')) ?? {};

    const changes: Record<string, string | boolean> = {};
    if (params.about_user !== undefined) changes.about_user_message = params.about_user;
    if (params.about_model !== undefined) changes.about_model_message = params.about_model;
    if (params.name !== undefined) changes.name_user_message = params.name;
    if (params.role !== undefined) changes.role_user_message = params.role;
    if (params.traits !== undefined) changes.traits_model_message = params.traits;
    if (params.other !== undefined) changes.other_user_message = params.other;
    if (params.enabled !== undefined) changes.enabled = params.enabled;

    const { object: _object, ...existing } = current as UserSystemMessages & { object?: string };

    await api('/user_system_messages', {
      method: 'POST',
      body: { ...existing, ...changes },
    });

    return { success: true, updated_fields: Object.keys(changes) };
  },
});
