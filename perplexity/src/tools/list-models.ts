import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModels } from '../perplexity-api.js';
import { mapModel, modelSchema } from './schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    "List the models Perplexity's answer engine accepts. Pass a returned id as model_id to search, create_conversation or send_message. Set picker_only to see just the models the on-page model picker offers, together with the plan each one requires.",
  summary: 'List available Perplexity models',
  icon: 'cpu',
  group: 'Models',
  input: z.object({
    picker_only: z
      .boolean()
      .optional()
      .describe(
        "Return only the models the site's model picker lists (default false — the API accepts many more ids than the picker shows).",
      ),
    mode: z
      .string()
      .optional()
      .describe('Filter to one Perplexity mode: search, research, study, asi, document_review, browser_agent, studio.'),
  }),
  output: z.object({
    models: z.array(modelSchema).describe('Models available to the signed-in Perplexity account'),
  }),
  handle: async params => {
    const models = await getModels();
    const filtered = models
      .filter(model => (params.picker_only ? model.inModelPicker : true))
      .filter(model => (params.mode ? model.mode === params.mode : true));
    return { models: filtered.map(mapModel) };
  },
});
