import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getCurrentUser as fetchCurrentUser } from '../deepseek-api.js';
import { userSchema } from './schemas.js';

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Get the authenticated DeepSeek account profile, including the user ID, masked email, display name and which identity provider signed in.',
  summary: 'Get the current DeepSeek user profile',
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
      provider: user.provider,
      mobile_number: user.mobileNumber,
      avatar: user.avatar,
    };
  },
});
