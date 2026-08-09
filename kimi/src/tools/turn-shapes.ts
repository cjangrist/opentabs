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
    .describe(
      'in_progress when the 18s wait budget elapsed before Kimi finished. The generation keeps running in the page — poll get_conversation.',
    ),
  model: z.string(),
  url: z.string(),
  items: z.array(responseItemSchema).describe('SPEC §3 items produced by this turn only, not the whole history.'),
  omitted: omittedSchema,
});

/** The mapping notes every message tool repeats, kept in one place. */
export const TURN_DESCRIPTION_SUFFIX =
  'model_id is validated against the live GetAvailableModels list before anything is sent; an unknown id raises VALIDATION_ERROR listing the valid ids. ' +
  "thinking maps to Kimi's options.thinking plus options.reasoning_effort. thinking_level maps onto Kimi's NATIVE ladder by name " +
  '(minimal/low→REASONING_EFFORT_LOW, medium→_MEDIUM, high→_HIGH, max→_MAX), falling back to the nearest lower rung a model publishes — ' +
  'so on Instant, whose ladder is LOW only, every level resolves to LOW. thinking:false sends REASONING_EFFORT_NONE and is rejected for a ' +
  'model whose picker has no "off" rung. Omitting both follows the model\'s own published default, exactly as the composer does. ' +
  'search defaults ON, matching the composer; search:false drops the search tool. Kimi still decides autonomously whether to query. ' +
  'tools is rejected: Kimi has no per-message tool allow-list and picks its agentic tools itself. ' +
  'Returns after at most 18s without cancelling the generation, so poll get_conversation while status is in_progress.';
