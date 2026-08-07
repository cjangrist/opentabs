import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getBootstrap } from '../claude-models.js';
import { modelSchema, paginatedOutput, paginationInputShape, resolvePagination } from './normalized-schemas.js';
import { pageLocalArray } from '../claude-pagination.js';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description:
    'List every Claude model the active organization publishes, parsed live from the bootstrap model_selector_config on each call — never a hardcoded list. ' +
    'is_available:false marks models claude.ai has deprecated (section "deprecated"): they are still in the org payload but the model picker does not render them, and create_conversation / send_message reject them. ' +
    'The is_available subset equals the picker exactly, including the entries behind "More models". ' +
    "capabilities.thinking.levels holds Claude's NATIVE effort ids (low, medium, high, xhigh, max) — the normalized thinking_level input maps onto them by name.",
  summary: 'List available Claude models',
  icon: 'cpu',
  group: 'Account',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(modelSchema),
  handle: async params => {
    const bootstrap = await getBootstrap();
    return pageLocalArray(bootstrap.models, resolvePagination(params));
  },
});
