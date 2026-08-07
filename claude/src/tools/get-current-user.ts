import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getOrgId, toUnixSeconds } from '../claude-api.js';
import { fetchBootstrap } from '../claude-models.js';

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description: 'Get the authenticated Claude account and the organization id every other tool is scoped to.',
  summary: 'Get the current user profile',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    id: z.string().describe('Account UUID'),
    email: z.string(),
    full_name: z.string().nullable(),
    display_name: z.string().nullable(),
    created_at: z.number().int().describe('Unix seconds'),
    is_verified: z.boolean(),
    organization_id: z.string().describe('Active organization UUID (from the lastActiveOrg cookie)'),
  }),
  handle: async () => {
    const bootstrap = await fetchBootstrap();
    const account = bootstrap.account ?? {};
    return {
      id: account.uuid ?? '',
      email: account.email_address ?? '',
      full_name: account.full_name ?? null,
      display_name: account.display_name ?? null,
      created_at: toUnixSeconds(account.created_at),
      is_verified: account.is_verified ?? false,
      organization_id: getOrgId(),
    };
  },
});
