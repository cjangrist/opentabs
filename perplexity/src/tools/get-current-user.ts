import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getCurrentUser as fetchCurrentUser } from '../perplexity-api.js';
import { userSchema } from './schemas.js';

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Get the signed-in Perplexity account: account UUID, email, username and subscription status/tier. Use this to confirm which account the browser session belongs to.',
  summary: 'Get the current Perplexity account',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: userSchema,
  handle: async () => {
    const user = await fetchCurrentUser();
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      subscription_status: user.subscriptionStatus,
      subscription_tier: user.subscriptionTier,
      org_role: user.orgRole,
    };
  },
});
