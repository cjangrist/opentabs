import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getCurrentUser as fetchCurrentUser } from '../copilot-api.js';
import { userSchema } from './schemas.js';

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Get the Microsoft account profile Copilot is signed in with, including the Copilot user ID, first name, account tier and region.',
  summary: 'Get the current Copilot user profile',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: userSchema,
  handle: async () => {
    const user = await fetchCurrentUser();
    return {
      id: user.id,
      first_name: user.firstName,
      preferred_name: user.preferredName,
      account_tier: user.accountTier,
      is_pro: user.isPro,
      region_code: user.regionCode,
      subscriptions: user.subscriptions,
    };
  },
});
