import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModelCatalog } from '../kimi-models.js';
import { pageLocalArray } from '../kimi-pagination.js';
import { modelSchema, paginatedOutput, paginationInputShape, resolvePagination } from './normalized-schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    'List the Kimi models available to this account, parsed live from ConfigService/GetAvailableModels on every call — never a hardcoded list. ' +
    'Verified against the rendered model picker: the ids returned are exactly the entries kimi.com shows, with the same display names and effort ladders. ' +
    'capabilities.thinking.levels holds Kimi’s NATIVE reasoning-effort ids (REASONING_EFFORT_LOW / _MEDIUM / _HIGH / _MAX), coarsest first; ' +
    'REASONING_EFFORT_NONE is Kimi’s off switch rather than a level, so it is excluded from levels and drives thinking:false instead. ' +
    'context_window is always null: Kimi publishes only opaque size classes (CONTEXT_LENGTH_L / _XL), never a token count, so a number here would be invented. ' +
    'requires_subscription reflects the membership level the model’s default context length demands, or null when it is free. ' +
    'deep_research and code_interpreter are true only for the agentic scenario (K3 / K3 Swarm) — the fast Instant model hosts neither.',
  summary: 'List available Kimi models',
  icon: 'cpu',
  group: 'Account',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(modelSchema),
  handle: async params => pageLocalArray((await getModelCatalog()).models, resolvePagination(params)),
});
