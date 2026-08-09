import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { callRpc } from '../kimi-api.js';

interface GetCurrentUserResponse {
  user?: {
    id?: string;
    nickname?: string;
    avatar?: string;
    region?: string;
    phone?: { countryCode?: string; number?: string };
  };
}

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Get the authenticated Kimi account profile, including the user id, display name, masked phone number and region.',
  summary: 'Get the current Kimi user profile',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    id: z.string().describe('Kimi user id'),
    nickname: z.string().describe('Display name on the account'),
    phone: z.string().describe('Masked phone number registered to the account, or "" when none'),
    region: z.string().describe('Account region (e.g. "REGION_OVERSEA")'),
    avatar: z.string().describe('Avatar image URL'),
  }),
  handle: async () => {
    const data = await callRpc<GetCurrentUserResponse>('kimi.gateway.account.v1.UserService/GetCurrentUser', {});
    const user = data.user;
    if (!user?.id) throw ToolError.auth('Kimi did not return a user — please log in at https://www.kimi.com.');
    return {
      id: user.id,
      nickname: user.nickname ?? '',
      phone: user.phone?.number ? `+${user.phone.countryCode ?? ''} ${user.phone.number}`.trim() : '',
      region: user.region ?? '',
      avatar: user.avatar ?? '',
    };
  },
});
