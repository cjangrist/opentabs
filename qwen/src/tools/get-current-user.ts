import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getCurrentUser as fetchCurrentUser } from '../qwen-api.js';
import { userSchema } from './schemas.js';

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Get the authenticated Qwen account profile, including the user ID, email, display name, role and subscription tier.',
  summary: 'Get the current Qwen user profile',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: userSchema,
  handle: async () => {
    const user = await fetchCurrentUser();
    return { id: user.id, email: user.email, name: user.name, role: user.role, tier: user.tier };
  },
});
