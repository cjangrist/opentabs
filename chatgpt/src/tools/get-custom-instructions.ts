import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../chatgpt-api.js';

export const getCustomInstructions = defineTool({
  name: 'get_custom_instructions',
  displayName: 'Get Custom Instructions',
  description:
    'Get the current ChatGPT custom instructions (system messages). These include "What would you like ChatGPT to know about you?" and "How would you like ChatGPT to respond?".',
  summary: 'Get your custom instructions',
  icon: 'scroll-text',
  group: 'Settings',
  input: z.object({}),
  output: z.object({
    enabled: z.boolean().describe('Whether custom instructions are enabled'),
    about_user: z.string().describe('What you want ChatGPT to know about you ("Anything else" box)'),
    about_model: z.string().describe('How you want ChatGPT to respond'),
    name: z.string().describe('What ChatGPT should call you'),
    role: z.string().describe('What you do (occupation box)'),
    traits: z.string().describe('Traits ChatGPT should have'),
    other: z.string().describe('Other free-form instructions'),
    personality: z.string().describe('Selected personality preset (e.g. "coach"), empty if none'),
    traits_enabled: z.boolean().describe('Whether the traits section is enabled'),
  }),
  handle: async () => {
    // The settings payload grew well past about_user/about_model — name, role, traits,
    // "other" and the personality preset are all separate fields in the same object, and
    // reading only two of them made a populated profile look empty.
    const data = await api<{
      enabled?: boolean;
      about_user_message?: string;
      about_model_message?: string;
      name_user_message?: string;
      role_user_message?: string;
      traits_model_message?: string;
      other_user_message?: string;
      personality_type_selection?: string;
      traits_enabled?: boolean;
    }>('/user_system_messages');
    return {
      enabled: data.enabled ?? false,
      about_user: data.about_user_message ?? '',
      about_model: data.about_model_message ?? '',
      name: data.name_user_message ?? '',
      role: data.role_user_message ?? '',
      traits: data.traits_model_message ?? '',
      other: data.other_user_message ?? '',
      personality: data.personality_type_selection ?? '',
      traits_enabled: data.traits_enabled ?? false,
    };
  },
});
