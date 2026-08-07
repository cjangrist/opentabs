import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getBootstrap } from '../zai-models.js';
import { pageLocalArray } from '../zai-pagination.js';
import { modelSchema, paginatedOutput, paginationInputShape, resolvePagination } from './normalized-schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    'List the models this z.ai account can select, parsed live from GET /api/models on every call. ' +
    'z.ai publishes 14 entries but marks nine `info.meta.hidden` — internal/API-only builds such as `deep-research` and `0808-360B-DR` that the picker never offers — so hidden entries are dropped and the result matches the rendered model picker one-for-one. ' +
    'capabilities.thinking.levels reports z.ai\'s native "Deep Think" ladder ["high","max"], and is null for models that expose Deep Think as an on/off toggle with no reasoning_effort. ' +
    'deep_research is true when the model publishes the `deep-research` MCP server. ' +
    'context_window is always null: z.ai publishes only info.params.max_tokens, which is the per-request output cap rather than a context size. ' +
    'requires_subscription is always null — no plan/tier field exists on the model list. ' +
    'z.ai does not paginate this endpoint, so a single page carries everything and total is a true total.',
  summary: 'List available models',
  icon: 'cpu',
  group: 'Account',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(modelSchema),
  handle: async params => pageLocalArray((await getBootstrap()).models, resolvePagination(params)),
});
