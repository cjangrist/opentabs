import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModels } from '../gemini-models.js';
import { pageLocalArray } from '../gemini-pagination.js';
import { modelSchema, paginatedOutput, paginationInputShape, resolvePagination } from './normalized-schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    'List the Gemini modes the account can select, parsed live from the bootstrap payload (RPC otAQ7b, slot 15) that ' +
    "the composer's mode picker itself renders. Never hardcoded. display_name is the versioned label the picker " +
    'shows (e.g. "3.1 Pro"). is_default reflects the mode currently selected in the composer, falling back to the ' +
    'first published mode when the composer is not on screen — the same mode a send uses when model_id is omitted. ' +
    'Gemini returns the whole catalogue in one call, so pagination is applied locally and total is a true total. ' +
    '"Extended thinking" is NOT a model — it is a per-message toggle on ' +
    'the most capable mode; see capabilities.thinking and the send_message description.',
  summary: 'List Gemini modes',
  icon: 'cpu',
  group: 'Account',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(modelSchema),
  handle: async params => pageLocalArray(await getModels(), resolvePagination(params)),
});
