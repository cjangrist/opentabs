import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../chatgpt-api.js';

export const getAccountInfo = defineTool({
  name: 'get_account_info',
  displayName: 'Get Account Info',
  description: 'Get ChatGPT account details including subscription plan, features, and entitlements.',
  summary: 'Get account subscription and features',
  icon: 'credit-card',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    plan_type: z.string().describe('Subscription plan type (e.g., "chatgptfreeplan", "chatgptplusplan", "chatgptpro")'),
    is_paid: z.boolean().describe('Whether the account has an active paid subscription'),
    account_id: z.string().describe('Account ID'),
    billing_period: z.string().describe('Billing period (e.g. "monthly"), empty if not subscribed'),
    renews_at: z.string().describe('Next renewal timestamp, empty if not subscribed'),
    features: z.array(z.string()).describe('List of enabled feature flags'),
  }),
  handle: async () => {
    const data = await api<{
      accounts: Record<
        string,
        {
          entitlement?: {
            subscription_plan?: string;
            has_active_subscription?: boolean;
            is_active_subscription_gratis?: boolean;
            billing_period?: string;
            renews_at?: string | null;
          };
          features?: string[];
        }
      >;
      account_ordering: string[];
    }>('/accounts/check/v4-2023-04-27');

    const accountId = data.account_ordering?.[0] ?? '';
    const account = data.accounts?.[accountId] ?? data.accounts?.default;
    const entitlement = account?.entitlement;

    // There is no top-level `is_paid` on the account object any more — reading it made
    // every paid account report is_paid: false. Subscription state lives on `entitlement`.
    const isPaid = entitlement?.has_active_subscription === true && entitlement?.is_active_subscription_gratis !== true;

    return {
      plan_type: entitlement?.subscription_plan ?? '',
      is_paid: isPaid,
      account_id: accountId,
      billing_period: entitlement?.billing_period ?? '',
      renews_at: entitlement?.renews_at ?? '',
      features: account?.features ?? [],
    };
  },
});
