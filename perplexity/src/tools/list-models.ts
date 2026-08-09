import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { getModelCatalog } from '../perplexity-models.js';
import { pageLocalArray } from '../perplexity-pagination.js';
import { modelSchema, paginatedOutput, paginationInputShape, resolvePagination } from './normalized-schemas.js';

export const MODEL_LIST_NOTES =
  'Parsed live from /rest/models/config/v2 on every call. That endpoint lists ~114 gateway-accepted ids, but only the ' +
  "subset the site's own pickers can select is returned here — the search model picker (each row's non-thinking and " +
  'thinking model), the Computer picker, and each mode default (Best, Deep research, Study, Agentic research, ' +
  'Document review, Browser agent). Offering the rest would let you pick an id Perplexity silently downgrades. ' +
  'thinking is a MODEL on Perplexity, not a request flag: capabilities.thinking.levels is null everywhere and ' +
  'thinking:true on send_message swaps to the picker row\'s "…thinking" sibling. context_window is null because ' +
  'Perplexity publishes none. is_available is inferred from the plan (Perplexity exposes no per-account model gate); ' +
  'a "max"-tier model on a Pro account is reported unavailable, which matches the picker rendering those rows as ' +
  'non-selectable.';

export const listModels = defineTool({
  name: 'list_models',
  displayName: 'List Models',
  description: `List the models this Perplexity account can select. ${MODEL_LIST_NOTES}`,
  summary: 'List available Perplexity models',
  icon: 'cpu',
  group: 'Account',
  input: z.object({ ...paginationInputShape }),
  output: paginatedOutput(modelSchema),
  handle: async params => {
    const catalog = await getModelCatalog();
    // Perplexity returns its whole model config in one response, so paging is
    // applied over the parsed list and `total` IS a true total.
    return pageLocalArray(catalog.models, resolvePagination(params));
  },
});
