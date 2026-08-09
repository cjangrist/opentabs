import { defineTool } from '@opentabs-dev/plugin-sdk';
import { getBootstrap } from '../qwen-models.js';
import { pageLocalArray } from '../qwen-pagination.js';
import { z } from 'zod';
import { modelSchema, paginatedOutput, paginationInputShape, resolvePagination } from './normalized-schemas.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    'List the models Qwen offers, parsed from GET /api/models on every call — never a hardcoded array. ' +
    'The endpoint returns every model in one unpaginated response and marks none of them hidden, so the result matches the rendered model picker one-for-one and total is a true total; pagination is applied locally. ' +
    "capabilities.thinking.levels reports Qwen's own three reasoning modes (Fast, Auto, Thinking) rather than an effort ladder — Qwen has no numeric reasoning effort. " +
    'web_search and deep_research are read from the model\'s meta.chat_type ("search" / "deep_research"), which is what actually routes a completion; meta.capabilities.search is absent on several models that do publish the chat type, so the chat type decides. ' +
    'code_interpreter is read from meta.mcp. requires_subscription is always null: Qwen publishes no plan field on the model list.',
  summary: 'List models (paginated)',
  icon: 'cpu',
  group: 'Account',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(modelSchema),
  handle: async params => pageLocalArray((await getBootstrap()).models, resolvePagination(params)),
});
