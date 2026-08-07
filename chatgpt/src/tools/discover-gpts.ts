import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../chatgpt-api.js';
import { gptSchema, mapGpt } from './schemas.js';

export const discoverGpts = defineTool({
  name: 'discover_gpts',
  displayName: 'Discover GPTs',
  description: 'Browse the ChatGPT GPT store to discover custom GPTs. Returns categorized lists of featured GPTs.',
  summary: 'Explore the GPT store',
  icon: 'store',
  group: 'GPTs',
  input: z.object({
    cursor: z.number().int().min(0).optional().describe('Pagination cursor (default 0)'),
    limit: z.number().int().min(1).max(50).optional().describe('Number of results per category (default 10)'),
    locale: z
      .enum(['en', 'global'])
      .optional()
      .describe('Locale for results — the API only accepts "en" or "global" (default "global")'),
  }),
  output: z.object({
    categories: z
      .array(
        z.object({
          title: z.string().describe('Category title'),
          gpts: z.array(gptSchema).describe('GPTs in this category'),
        }),
      )
      .describe('GPT categories with their items'),
  }),
  handle: async params => {
    const data = await api<{
      cuts?: {
        info?: { title?: string };
        list?: { items?: { resource?: { gizmo?: Record<string, unknown> } }[] };
      }[];
    }>('/gizmos/discovery', {
      // The store discovery feed lives under /public-api. The old /backend-api path still
      // answers 200 but always with `cuts: []`, which looked like "no GPTs" rather than a
      // moved endpoint. `locale` is a strict enum server-side — "en-US" returns HTTP 422.
      base: 'public',
      query: {
        cursor: params.cursor ?? 0,
        limit: params.limit ?? 10,
        locale: params.locale ?? 'global',
      },
    });
    const categories = (data.cuts ?? []).map(cut => ({
      title: cut.info?.title ?? '',
      gpts: (cut.list?.items ?? []).map(item => mapGpt((item.resource?.gizmo ?? {}) as Parameters<typeof mapGpt>[0])),
    }));
    return { categories };
  },
});
