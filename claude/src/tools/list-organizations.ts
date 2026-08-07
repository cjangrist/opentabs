import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, getOrgId, toUnixSeconds } from '../claude-api.js';
import { pageLocalArray } from '../claude-pagination.js';
import { paginatedOutput, paginationInputShape, resolvePagination } from './normalized-schemas.js';

interface RawOrganization {
  uuid?: string;
  name?: string;
  billing_type?: string | null;
  capabilities?: string[];
  rate_limit_tier?: string;
  created_at?: string;
}

const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  billing_type: z.string().nullable().describe('Null on free organizations'),
  capabilities: z.array(z.string()).describe('e.g. "chat", "claude_max"'),
  rate_limit_tier: z.string(),
  created_at: z.number().int().describe('Unix seconds'),
  is_active: z.boolean().describe('True for the organization every other tool is scoped to'),
});

export const listOrganizations = defineTool({
  name: 'list_organizations',
  displayName: 'List Organizations',
  description:
    'List the organizations this account belongs to, flagging the active one. /api/organizations returns them all in a single response with no server-side paging, so pagination is applied client-side and total is a true total.',
  summary: 'List organizations (paginated)',
  icon: 'building',
  group: 'Account',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(organizationSchema),
  handle: async params => {
    const activeOrgId = getOrgId();
    const rows = (await api<RawOrganization[]>('/organizations')) ?? [];
    const items = rows.map(row => ({
      id: row.uuid ?? '',
      name: row.name ?? '',
      billing_type: row.billing_type ?? null,
      capabilities: row.capabilities ?? [],
      rate_limit_tier: row.rate_limit_tier ?? '',
      created_at: toUnixSeconds(row.created_at),
      is_active: row.uuid === activeOrgId,
    }));
    return pageLocalArray(items, resolvePagination(params));
  },
});
