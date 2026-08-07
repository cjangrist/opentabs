import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModels } from '../qwen-api.js';
import { mapModel, modelSchema } from './schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    "List the Qwen models available to this account — the same entries the site's model picker shows. Pass a returned id as model_id to send_message or create_conversation. Reasoning and web search are per-message toggles rather than separate models: use the `thinking` and `search` booleans on the chat tools, and check supports_thinking / supports_search here to see which models accept them.",
  summary: 'List available Qwen models',
  icon: 'cpu',
  group: 'Models',
  input: z.object({}),
  output: z.object({
    models: z.array(modelSchema).describe('Models available to the signed-in Qwen account, picker order'),
  }),
  handle: async () => {
    const models = await getModels();
    return { models: models.map(mapModel) };
  },
});
