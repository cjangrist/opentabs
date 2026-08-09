import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getUserInfo } from '../gemini-api.js';

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Return the Google account signed in to gemini.google.com, read from the page bootstrap data. Use it to confirm which account the other tools will act on.',
  summary: 'Signed-in Google account',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    email: z.string().describe('Account email. Empty string when the page does not publish one.'),
    user_id: z.string().describe('Google obfuscated account id. Empty string when unavailable.'),
  }),
  handle: async () => {
    const info = getUserInfo();
    return { email: info.email, user_id: info.userId };
  },
});
