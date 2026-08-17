import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModels } from '../grok-models.js';
import { pageLocalArray } from '../grok-pagination.js';
import { modelSchema, paginatedOutput, paginationInputShape, resolvePagination } from './normalized-schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    "List Grok's live composer modes in picker order. Grok exposes named modes (Auto, Fast, Expert, Heavy, Build), not underlying model ids. Availability and required tiers come from POST /rest/modes on every call. Expert/Heavy are reasoning modes with no separate effort ladder; the prompt-driven research tools always select Expert and are not a dedicated provider mode. Pagination is local because the picker returns one complete catalogue.",
  summary: 'List Grok composer modes',
  icon: 'cpu',
  group: 'Account',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(modelSchema),
  handle: async params => pageLocalArray(await getModels(), resolvePagination(params)),
});
