import { z } from 'zod';
import {
  itemVisibilityInputShape,
  messageOptionsInputShape,
  omittedSchema,
  responseItemSchema,
} from './normalized-schemas.js';

/**
 * The mapping notes every message tool repeats, kept in one place.
 *
 * Deliberately terse: the platform caps a tool description at 1000 characters,
 * so the per-parameter notes below carry the detail instead.
 */
export const TURN_DESCRIPTION_SUFFIX =
  'model_id is validated against the live model list before anything is sent; an unknown id raises VALIDATION_ERROR listing the valid ids. ' +
  "thinking / thinking_level map onto Kimi's native reasoning_effort ladder; search defaults ON as in the composer; tools is rejected. " +
  'Returns after at most 18s WITHOUT cancelling the generation, so poll get_conversation while status is in_progress.';

const THINKING_TOGGLE_NOTE =
  "Enable Kimi's thinking mode. thinking:false sends REASONING_EFFORT_NONE and raises VALIDATION_ERROR for a model whose picker has no " +
  '"off" rung. Omitting it follows the model\'s own published default, exactly as the composer does.';

const THINKING_LEVEL_NOTE =
  "Reasoning effort, mapped onto Kimi's NATIVE ladder by name (minimal/low→REASONING_EFFORT_LOW, medium→_MEDIUM, high→_HIGH, max→_MAX), " +
  'falling back to the nearest lower rung a model publishes — on Instant, whose ladder is LOW only, every level resolves to LOW. ' +
  'See list_models().capabilities.thinking.levels.';

const SEARCH_NOTE =
  'Declare the TOOL_TYPE_SEARCH tool for this message. Defaults to true, matching the kimi.com composer; Kimi still decides autonomously whether to query.';

/**
 * SPEC §4 selection options shared by create_conversation and send_message, plus
 * the §3 visibility switches.
 */
export const turnInputShape = {
  text: z.string().min(1).describe('The message to send.'),
  ...messageOptionsInputShape,
  thinking: messageOptionsInputShape.thinking.describe(THINKING_TOGGLE_NOTE),
  thinking_level: messageOptionsInputShape.thinking_level.describe(THINKING_LEVEL_NOTE),
  search: messageOptionsInputShape.search.describe(SEARCH_NOTE),
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
