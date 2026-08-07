import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getCurrentUser as fetchCurrentUser } from '../grok-api.js';
import { userSchema } from './schemas.js';

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
      created_at: user.createdAt,
    };
  },
});
