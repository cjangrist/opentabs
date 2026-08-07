import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModels } from '../grok-api.js';
import { mapModel, modelSchema } from './schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    "List the Grok models available to this account — the same entries the site's model picker shows (Fast, Auto, Expert, Heavy, Build). Pass a returned id as model_id to send_message or create_conversation. Grok treats reasoning as a property of the model rather than a per-message flag, so use the `thinking` boolean as a shorthand for picking Expert vs Fast. Check is_available before sending: locked models fail with an entitlement error.",
  summary: 'List available Grok models',
  icon: 'cpu',
  group: 'Models',
  input: z.object({}),
  output: z.object({
    models: z.array(modelSchema).describe('Models available to the signed-in Grok account, picker order'),
  }),
  handle: async () => {
    const models = await getModels();
    return { models: models.map(mapModel) };
  },
});
