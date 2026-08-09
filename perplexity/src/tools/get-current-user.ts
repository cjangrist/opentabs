import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, requireSession } from '../perplexity-api.js';

interface RawUserSettings {
  subscription_status?: string;
  subscription_tier?: string | null;
  default_model?: string;
}

export const getCurrentUser = defineTool({
  name: 'get_current_user',
  displayName: 'Get Current User',
  description:
    'Get the signed-in Perplexity account: account UUID, email, username, subscription status and the default model the account uses when model_id is omitted. Perplexity keeps its session in an HttpOnly cookie, so this endpoint is the only readable auth signal — logged out it answers 200 with an empty body, which this reports as AUTH_ERROR.',
  summary: 'Get the current Perplexity account',
  icon: 'user',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    id: z.string(),
    email: z.string(),
    username: z.string(),
    subscription_status: z.string().describe('e.g. "none", "active", "trialing".'),
    subscription_tier: z
      .string()
      .describe('What Perplexity records on the subscription — in practice the billing interval, not a plan name.'),
    org_role: z.string().describe('Enterprise organisation role, or "" for a personal account.'),
    default_model_id: z.string().describe('Model id used when model_id is omitted.'),
  }),
  handle: async () => {
    const [user, settings] = await Promise.all([
      requireSession(),
      api<RawUserSettings>('/user/settings', { query: { skip_connector_picker_credentials: true } }).catch(
        () => ({}) as RawUserSettings,
      ),
    ]);
    return {
      id: user.id ?? '',
      email: user.email ?? '',
      username: user.username ?? '',
      subscription_status: settings.subscription_status ?? user.subscription_status ?? 'none',
      subscription_tier: settings.subscription_tier ?? '',
      org_role: user.org_role ?? '',
      default_model_id: settings.default_model ?? '',
    };
  },
});
