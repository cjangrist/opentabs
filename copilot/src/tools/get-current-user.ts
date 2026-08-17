import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getApi } from '../copilot-api.js';

interface RawUser {
  id?: string;
  anid?: string | null;
  firstName?: string | null;
  preferredName?: string | null;
  accountTier?: string;
  isPro?: boolean;
  regionCode?: string;
  subscriptions?: Array<{ tier?: string }>;
  remainingUsage?: { researchCalls?: number | null };
}

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Read the signed-in Microsoft Copilot profile and native remaining Deep Research quota. The endpoint also answers ' +
    'for anonymous visitors, so guest/null identity is rejected as AUTH_ERROR rather than misreported as an empty account.',
  summary: 'Get the active Copilot account',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    id: z.string(),
    first_name: z.string(),
    preferred_name: z.string(),
    account_tier: z.string(),
    is_pro: z.boolean(),
    region_code: z.string(),
    subscriptions: z.array(z.string()),
    deep_research_remaining: z.number().int().nullable(),
  }),
  handle: async () => {
    const user = await getApi<RawUser>('/user?api-version=4');
    if (!user.id || user.accountTier === 'guest' || (!user.firstName && !user.anid))
      throw ToolError.auth(
        'Copilot returned an anonymous profile. Sign in with a Microsoft account and reload the tab.',
        'AUTH_ERROR',
      );
    const remaining = user.remainingUsage?.researchCalls;
    return {
      id: user.id,
      first_name: user.firstName ?? '',
      preferred_name: user.preferredName ?? '',
      account_tier: user.accountTier ?? '',
      is_pro: user.isPro === true,
      region_code: user.regionCode ?? '',
      subscriptions: (user.subscriptions ?? []).map(subscription => subscription.tier ?? '').filter(Boolean),
      deep_research_remaining: typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : null,
    };
  },
});
