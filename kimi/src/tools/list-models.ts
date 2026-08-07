import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModels } from '../kimi-api.js';
import { mapModel, modelSchema } from './schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    'List the Kimi models available to this account. Returns model IDs, display names, descriptions and which one is the account default. Pass a returned id as model_id to send_message or create_conversation to pick a specific model.',
  summary: 'List available Kimi models',
  icon: 'cpu',
  group: 'Models',
  input: z.object({}),
  output: z.object({
    models: z.array(modelSchema).describe('Models available to the signed-in Kimi account'),
  }),
  handle: async () => {
    const models = await getModels();
    return { models: models.map(mapModel) };
  },
});
