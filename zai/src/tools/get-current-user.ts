import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../zai-api.js';

interface RawProfile {
  id?: string;
  email?: string;
  name?: string;
  role?: string;
  idp?: string;
  permissions?: Record<string, unknown>;
}

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Read the signed-in z.ai account from GET /api/v1/auths/. `role` is "guest" for a browsing session that never signed in — such a session has no conversations, which is why every other tool refuses to run under it.',
  summary: 'Who am I on z.ai',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    role: z.string(),
    identity_provider: z.string().nullable().describe('SSO provider that minted the session, e.g. "google".'),
  }),
  handle: async () => {
    const profile = await api<RawProfile>('/v1/auths/');
    return {
      id: profile?.id ?? '',
      email: profile?.email ?? '',
      name: profile?.name ?? '',
      role: profile?.role ?? '',
      identity_provider: profile?.idp ?? null,
    };
  },
});
