import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModels } from '../gemini-models.js';
import { modelSchema } from './normalized-schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    'List the Gemini modes the account can select, parsed live from the bootstrap payload (RPC otAQ7b, slot 15) that ' +
    "the composer's mode picker itself renders. Never hardcoded. display_name is the versioned label the picker " +
    'shows (e.g. "3.1 Pro"). is_default reflects the mode currently selected in the composer; it is false for every ' +
    'model when the composer is not on screen to read it from. Gemini does not paginate this list, so has_more is ' +
    'always false and total is the real count. "Extended thinking" is NOT a model — it is a per-message toggle on ' +
    'the most capable mode; see capabilities.thinking and the send_message description.',
  summary: 'List Gemini modes',
  icon: 'cpu',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    items: z.array(modelSchema),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
    total: z.number().int().nullable(),
    page_info: z.object({
      returned: z.number().int(),
      pages_fetched: z.number().int(),
      truncated: z.boolean(),
    }),
  }),
  handle: async () => {
    const models = await getModels();
    return {
      items: models,
      next_cursor: null,
      has_more: false,
      total: models.length,
      page_info: { returned: models.length, pages_fetched: 1, truncated: false },
    };
  },
});
