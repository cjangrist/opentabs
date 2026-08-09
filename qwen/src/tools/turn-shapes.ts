import { z } from 'zod';
import {
  itemVisibilityInputShape,
  messageOptionsInputShape,
  omittedSchema,
  responseItemSchema,
} from './normalized-schemas.js';

/**
 * SPEC §4 selection options shared by create_conversation and send_message, plus the
 * §3 visibility switches.
 */
export const turnInputShape = {
  text: z.string().min(1).describe('The message to send.'),
  ...messageOptionsInputShape,
  ...itemVisibilityInputShape,
};

export const turnOutputSchema = z.object({
  conversation_id: z.string(),
  message_id: z.string().describe('Id of the assistant message this turn produced. Empty while it is still starting.'),
  status: z
    .enum(['completed', 'in_progress'])
    .describe('in_progress when the 20s handler budget elapsed before the stream finished; poll get_conversation.'),
  model: z.string(),
  title: z.string().describe('Title Qwen generated for the conversation. Empty until the first exchange completes.'),
  url: z.string(),
  items: z.array(responseItemSchema).describe('SPEC §3 items produced by this turn only, not the whole history.'),
  omitted: omittedSchema,
});

/** The mapping notes every message tool repeats, kept in one place. */
export const TURN_DESCRIPTION_SUFFIX =
  'model_id is validated against the live /api/models list before anything is sent; unknown ids raise VALIDATION_ERROR listing the valid ones. ' +
  'thinking maps onto Qwen\'s three-value reasoning mode: true -> "Thinking", false -> "Fast", OMITTED -> "Auto" (Qwen\'s own default, where the model decides). thinking_level maps onto the same enum: minimal -> Fast, low/medium -> Auto, high/max -> Thinking. Qwen has no numeric effort, so thinking and thinking_level with values that disagree raise VALIDATION_ERROR rather than silently picking one. ' +
  'search is a real control, not a hint: it routes the message as chat_type "search"; a model whose meta.chat_type omits it rejects the request. ' +
  'Returns after at most 20s WITHOUT cancelling the generation — poll get_conversation while status is in_progress.';
