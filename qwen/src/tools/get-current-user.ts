import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { apiRaw } from '../qwen-api.js';

interface RawUser {
  id?: string;
  email?: string;
  name?: string;
  role?: string;
  tier?: string;
  profile_image_url?: string;
}

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Read the signed-in Qwen account from GET /api/v1/auths/, which is served unwrapped (no success/data envelope). ' +
    "role and tier come from the server rather than from the bearer token — Qwen's JWT carries only {id, last_password_change, exp} — so this is the tool that distinguishes a real account from the anonymous session /api/config enables.",
  summary: 'Get the signed-in account',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role: z.string().describe('Qwen account role, e.g. "user".'),
    tier: z.string().describe('Qwen plan tier, e.g. "normal".'),
  }),
  handle: async () => {
    const user = await apiRaw<RawUser>('/v1/auths/');
    return {
      id: user?.id ?? '',
      name: user?.name ?? '',
      email: user?.email ?? '',
      role: user?.role ?? '',
      tier: user?.tier ?? '',
    };
  },
});
