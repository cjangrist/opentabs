import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModelCatalog } from '../chatgpt-models.js';
import { modelSchema, paginatedOutput, paginationInputShape, resolvePagination } from './normalized-schemas.js';
import { pageLocalArray } from '../chatgpt-pagination.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    'List the models the live chatgpt.com picker can actually select, parsed from /backend-api/models on every call. ' +
    'The picker is two-dimensional: a version row (GPT-5.6 Sol / GPT-5.5 / o3) and an effort row of intelligence ' +
    'presets (Instant / Medium / High / Extra High / Pro), each of which resolves to a concrete model slug plus a ' +
    'native thinking_effort. /backend-api/models also lists slugs the picker never renders (older point releases, ' +
    '-mini variants, work-mode -wm builds); those are excluded rather than reported as available. ' +
    'capabilities.thinking.levels carries the provider-native ladder (min < standard < extended < max); the ' +
    'normalized thinking_level maps minimal/low→min, medium→standard, high→extended, max→max. ' +
    'chatgpt.com returns the whole list in one request, so total IS a true total.',
  summary: 'List available ChatGPT models',
  icon: 'cpu',
  group: 'Models',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(modelSchema).extend({
    default_model_id: z.string().describe('Slug ChatGPT uses when model_id is omitted.'),
  }),
  handle: async params => {
    const catalog = await getModelCatalog();
    return { ...pageLocalArray(catalog.models, resolvePagination(params)), default_model_id: catalog.defaultModelSlug };
  },
});
