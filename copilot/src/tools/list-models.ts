import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModels } from '../copilot-api.js';
import { mapModel, modelSchema } from './schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    "List the entries Copilot's composer picker offers (Smart, Think deeper, Study and learn, Search). Copilot has no model picker and no model ids — it selects a chat mode that is sent with each message — so these are modes rather than models. Pass a returned id as model_id to send_message or create_conversation, or use the `thinking` / `search` booleans as shorthand.",
  summary: 'List available Copilot chat modes',
  icon: 'cpu',
  group: 'Models',
  input: z.object({}),
  output: z.object({
    models: z.array(modelSchema).describe("Chat modes Copilot's composer offers, picker order"),
  }),
  handle: async () => ({ models: getModels().map(mapModel) }),
});
