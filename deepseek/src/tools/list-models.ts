import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModelCatalog } from '../deepseek-models.js';
import { pageLocalArray } from '../deepseek-pagination.js';
import { modelSchema, paginatedOutput, paginationInputShape, resolvePagination } from './normalized-schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    'List the DeepSeek "modes" the picker offers, parsed live from GET /client/settings?scope=model on every call — never hardcoded. ' +
    'DeepSeek exposes modes (default = Instant, expert, vision), not named checkpoints, and the API field is model_type. ' +
    'DeepThink and Search are per-message TOGGLES, not models, so they appear in capabilities rather than as invented ids. ' +
    'thinking.levels is null for every mode: DeepThink is a plain on/off checkbox with no effort ladder. ' +
    'web_search is true only for "default" — Expert and Vision hide the Search button. ' +
    'context_window is always null: DeepSeek publishes only a prompt-box CHARACTER cap, which is not a token window. ' +
    'DeepSeek returns every mode in one payload, so this pages locally and total IS a true total.',
  summary: 'List models (live from the picker)',
  icon: 'cpu',
  group: 'Account',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(modelSchema),
  handle: async params => pageLocalArray((await getModelCatalog()).models, resolvePagination(params)),
});
