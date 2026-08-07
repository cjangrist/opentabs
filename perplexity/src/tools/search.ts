import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { ask, assertKnownModel, conversationUrl } from '../perplexity-api.js';
import { askResultSchema, focusInput, mapAskResult, modelIdInput, sourcesInput } from './schemas.js';

export const search = defineTool({
  name: 'search',
  displayName: 'Search',
  description:
    'Run a one-shot Perplexity search and get the cited answer. This is the answer-engine entry point: it returns the answer in Markdown, the ranked web sources it cited ([n] markers index into sources) and suggested follow-up questions. Use focus to search academic papers or social/forum content instead of the general web, or "writing" to answer from the model alone. Set incognito to keep the query out of the account\'s Library.',
  summary: 'Search Perplexity and get a cited answer',
  icon: 'search',
  group: 'Search',
  input: z.object({
    text: z.string().min(1).describe('The search query'),
    model_id: modelIdInput,
    focus: focusInput,
    sources: sourcesInput,
    incognito: z
      .boolean()
      .optional()
      .describe("Run as an incognito query so it is not saved to the account's Library (default false)."),
  }),
  output: askResultSchema,
  handle: async params => {
    if (params.model_id) await assertKnownModel(params.model_id);

    const result = await ask({
      text: params.text,
      modelId: params.model_id,
      focus: params.focus,
      sources: params.sources,
      incognito: params.incognito ?? false,
    });

    return mapAskResult(result, conversationUrl(result.conversationId));
  },
});
