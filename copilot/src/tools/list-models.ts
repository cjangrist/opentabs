import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModels } from '../copilot-models.js';
import { pageLocalArray } from '../copilot-pagination.js';
import { modelSchema, paginatedOutput, paginationInputShape, resolvePagination } from './normalized-schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    "List the mutually-exclusive modes in Copilot's live composer picker: the exact ids, labels, descriptions, " +
    'availability, and capabilities rendered for this account. Copilot exposes modes rather than underlying model ' +
    'names. The picker is parsed on every call; this adapter does not ship a hardcoded catalogue. Because the whole ' +
    'picker is local, total is exact and normalized pagination is applied locally.',
  summary: 'List live Copilot modes',
  icon: 'cpu',
  group: 'Account',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(modelSchema),
  handle: async params => pageLocalArray(await getModels(), resolvePagination(params)),
});
