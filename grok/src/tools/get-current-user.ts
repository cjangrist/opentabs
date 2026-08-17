import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getCurrentUser as fetchCurrentUser, toUnixSeconds } from '../grok-api.js';

const userSchema = z.object({
  id: z.string().describe('Grok account id.'),
  email: z.string().describe('Account email, or empty when Grok withholds it.'),
  name: z.string().describe('Account display name, or empty when absent.'),
  username: z.string().describe('Linked X username, or empty when absent.'),
  subscription_tier: z.string().describe('Native subscription tier, or empty when absent.'),
  created_at: z.number().int().nullable().describe('Unix seconds, or null when Grok withholds it.'),
});

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Get the authenticated Grok (xAI) account profile, including the user ID, email, display name, linked X username and subscription tier.',
  summary: 'Get the current Grok user profile',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: userSchema,
  handle: async () => {
    const user = await fetchCurrentUser();
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username,
      subscription_tier: user.subscriptionTier,
      created_at: user.createdAt ? toUnixSeconds(user.createdAt) : null,
    };
  },
});
