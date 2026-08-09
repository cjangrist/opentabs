import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getApi } from '../deepseek-api.js';

interface CurrentUserResponse {
  id?: string;
  email?: string;
  mobile_number?: string;
  id_profile?: { provider?: string; name?: string; picture?: string; email?: string };
}

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Get the authenticated DeepSeek account profile, including the user id, masked email, display name and which identity provider signed in. Absent fields are null, never "".',
  summary: 'Get the current DeepSeek user profile',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    id: z.string(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    provider: z.string().nullable().describe('Identity provider that signed in, e.g. "google".'),
    mobile_number: z.string().nullable(),
    avatar: z.string().nullable(),
  }),
  handle: async () => {
    const user = await getApi<CurrentUserResponse>('/users/current');
    if (!user.id)
      throw ToolError.auth(
        'DeepSeek did not return a user — please log in at https://chat.deepseek.com.',
        'AUTH_ERROR',
      );
    return {
      id: user.id,
      email: user.email || user.id_profile?.email || null,
      name: user.id_profile?.name || null,
      provider: user.id_profile?.provider || null,
      mobile_number: user.mobile_number || null,
      avatar: user.id_profile?.picture || null,
    };
  },
});
