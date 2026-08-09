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
  'model_id is validated against the live picker before anything is sent; an unknown id raises VALIDATION_ERROR listing the valid ids. ' +
  "thinking maps to DeepSeek's DeepThink toggle (thinking_enabled) and search to the Search toggle (search_enabled). " +
  'Returns after at most 18s WITHOUT cancelling the generation, so poll get_conversation while status is in_progress.';

const THINKING_NOTE =
  'Turn on DeepThink for this message (sent as thinking_enabled). DeepSeek exposes NO effort ladder — it is a plain on/off checkbox — ' +
  'so thinking_level is rejected rather than silently ignored, and list_models().capabilities.thinking.levels is null for every mode.';

const THINKING_LEVEL_NOTE =
  'NOT SUPPORTED by DeepSeek and raises VALIDATION_ERROR if set: DeepThink has no minimal/low/medium/high/max ladder. Use thinking instead.';

const SEARCH_NOTE =
  'Turn on web search for this message (sent as search_enabled). Only the "default" (Instant) mode offers it — Expert and Vision hide the ' +
  'Search button, so search:true on those raises VALIDATION_ERROR. DeepSeek still decides autonomously whether to actually query.';

const MODEL_NOTE =
  'DeepSeek "mode" id from list_models (default | expert | vision). On send_message the mode is FIXED to whatever the conversation was ' +
  'created with — DeepSeek\'s own UI says "To switch modes, please start a new chat" — so a different model_id raises VALIDATION_ERROR.';

const TOOLS_NOTE =
  'Not supported by DeepSeek: a non-empty value raises VALIDATION_ERROR. The composer offers only the DeepThink and Search toggles.';

const PROJECT_NOTE =
  'Not supported by DeepSeek: a non-empty value raises VALIDATION_ERROR. DeepSeek has no projects, folders or spaces.';

/** SPEC §4 selection options shared by create_conversation and send_message, plus the §3 visibility switches. */
export const turnInputShape = {
  text: z.string().min(1).describe('The message to send.'),
  ...messageOptionsInputShape,
  model_id: messageOptionsInputShape.model_id.describe(MODEL_NOTE),
  thinking: messageOptionsInputShape.thinking.describe(THINKING_NOTE),
  thinking_level: messageOptionsInputShape.thinking_level.describe(THINKING_LEVEL_NOTE),
  search: messageOptionsInputShape.search.describe(SEARCH_NOTE),
  tools: messageOptionsInputShape.tools.describe(TOOLS_NOTE),
  project_id: z.string().optional().describe(PROJECT_NOTE),
  ...itemVisibilityInputShape,
};

export const turnOutputSchema = z.object({
  conversation_id: z.string(),
  message_id: z.string().describe('Id of the assistant message this turn produced, or "" when none landed in time.'),
  status: z
    .enum(['completed', 'in_progress'])
    .describe(
      'in_progress when the 18s wait budget elapsed before DeepSeek finished. The generation keeps running in the page — poll get_conversation.',
    ),
  model: z.string(),
  url: z.string(),
  items: z.array(responseItemSchema).describe('SPEC §3 items produced by this turn only, not the whole history.'),
  omitted: omittedSchema,
});
