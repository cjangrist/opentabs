import { z } from 'zod';
import {
  itemVisibilityInputShape,
  messageOptionsInputShape,
  omittedSchema,
  responseItemSchema,
} from './normalized-schemas.js';

/**
 * SPEC §4 selection options shared by create_conversation and send_message, plus
 * the §3 visibility switches.
 */
export const turnInputShape = {
  text: z.string().min(1).describe('The message to send.'),
  ...messageOptionsInputShape,
  ...itemVisibilityInputShape,
};

export const turnOutputSchema = z.object({
  conversation_id: z.string(),
  message_id: z.string().describe('Id of the assistant message this turn produced.'),
  status: z
    .enum(['completed', 'in_progress'])
    .describe('in_progress when the 18s wait budget elapsed before the stream finished; poll get_conversation.'),
  model: z.string(),
  url: z.string(),
  items: z.array(responseItemSchema).describe('SPEC §3 items produced by this turn only, not the whole history.'),
  omitted: omittedSchema,
});

/** The mapping notes every message tool repeats, kept in one place. */
export const TURN_DESCRIPTION_SUFFIX =
  'model_id is validated against the live /api/models list before anything is sent; an unknown id raises VALIDATION_ERROR listing the valid ids. ' +
  'thinking maps to z.ai\'s "Deep Think" (features.enable_thinking) and defaults on for every model that has it, matching the composer. ' +
  'thinking_level maps onto z.ai\'s native ladder, which has exactly two rungs — high and max: minimal/low/medium/high all resolve to "high" (z.ai publishes nothing below it) and max resolves to "max". ' +
  'Only GLM-5.2 publishes reasoning_effort; on the other thinking models Deep Think is an on/off toggle and passing thinking_level raises VALIDATION_ERROR rather than being ignored. ' +
  'search sets features.auto_web_search and enables the deep-web-search MCP server; z.ai still decides autonomously whether to run a query. ' +
  'tools takes z.ai MCP server ids (see list_capabilities and list_models); an id the chosen model does not publish raises VALIDATION_ERROR. ' +
  'Returns after at most 18s without cancelling the generation: the request keeps running in the page and the reply still persists, so poll get_conversation when status is in_progress.';
