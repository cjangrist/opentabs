import { ToolError } from '@opentabs-dev/plugin-sdk';
import { asArray, asString, callRpc } from './gemini-api.js';
import type { NormalizedModel, ThinkingLevel } from './tools/normalized-schemas.js';

// `otAQ7b` is the bootstrap RPC gemini.google.com issues on every page load; slot 15
// holds the same mode list the composer's mode picker renders.
const RPC_BOOTSTRAP = 'otAQ7b';
const MODEL_SLOT = 15;

/**
 * "Extended thinking" is NOT a model. The picker renders it as a fourth row whose
 * VE metadata pins it to the Pro mode id with an extra selector, and choosing it
 * only flips slot 15 of the `x-goog-ext-525001261-jspb` request header from 1 to 2.
 * The transcript then labels the turn "<Pro display name> Extended".
 */
export const THINKING_HEADER_STANDARD = 1;
export const THINKING_HEADER_EXTENDED = 2;

/**
 * Gemini's two native depths on the mode that offers the picker's "Extended thinking"
 * row. `standard` is what a send uses when neither control is passed.
 */
export const NATIVE_THINKING_LEVELS = ['standard', 'extended'] as const;
export const DEFAULT_NATIVE_THINKING_LEVEL = 'standard';

/** Normalized levels that request the deeper native depth. */
export const EXTENDED_LEVELS: readonly ThinkingLevel[] = ['medium', 'high', 'max'];

export interface GeminiMode {
  id: string;
  /** Versioned label exactly as the picker renders it, e.g. "3.1 Pro". */
  displayName: string;
  description: string;
  /** Capability ids Gemini publishes for the mode; used to derive per-model support. */
  capabilityIds: number[];
  isNew: boolean;
}

const readModes = async (): Promise<GeminiMode[]> => {
  const bootstrap = await callRpc<unknown[]>(RPC_BOOTSTRAP, []);
  const raw = asArray(bootstrap[MODEL_SLOT]);
  const modes = raw
    .map((entry): GeminiMode | null => {
      if (!Array.isArray(entry)) return null;
      const id = asString(entry[0]);
      if (!id) return null;
      // Slot 11 is the versioned label ("3.1 Pro"); slot 1 is the bare family name
      // ("Pro") and does NOT match the rendered picker, so it is only a fallback.
      const displayName = asString(entry[11]) ?? asString(entry[19]) ?? asString(entry[1]) ?? id;
      return {
        id,
        displayName,
        description: asString(entry[12]) ?? asString(entry[2]) ?? '',
        capabilityIds: asArray(entry[3]).filter((value): value is number => typeof value === 'number'),
        isNew: entry[7] === true,
      };
    })
    .filter((mode): mode is GeminiMode => mode !== null);

  if (modes.length === 0)
    throw new ToolError(
      `Gemini's bootstrap RPC (${RPC_BOOTSTRAP}) published no modes in slot ${MODEL_SLOT}. The picker payload shape has changed.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );
  return modes;
};

/**
 * The account's currently selected mode, read from the composer's mode-switcher
 * button ("Open mode picker, currently Pro"). Gemini publishes the selection only
 * in the rendered UI — no bootstrap slot carries it — so this falls back to the
 * first published mode when the composer is not on screen.
 */
const selectedModeName = (): string | null => {
  const button = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
  const label = button?.getAttribute('aria-label') ?? button?.textContent ?? '';
  const match = /currently\s+(.+)$/i.exec(label.trim());
  return (match?.[1] ?? label).trim() || null;
};

/**
 * Capability ids published per mode in bootstrap slot 15[3]. Verified against the
 * live account: every mode carries these, and they are the only signals Gemini
 * exposes for the SPEC §4 capability flags.
 */
const CAPABILITY_VISION = 4;
const CAPABILITY_CODE_INTERPRETER = 32;

const buildModel = (mode: GeminiMode, modes: GeminiMode[], defaultId: string | null): NormalizedModel => {
  // Extended thinking is offered only on the mode the picker's "Extended thinking"
  // row points at, which is the last (most capable) published mode.
  const thinkingModeId = modes[modes.length - 1]?.id ?? null;
  const supportsThinking = mode.id === thinkingModeId;
  return {
    id: mode.id,
    display_name: mode.displayName,
    description: mode.description,
    is_default: defaultId !== null && mode.id === defaultId,
    is_available: true,
    requires_subscription: null,
    context_window: null,
    capabilities: {
      thinking: {
        supported: supportsThinking,
        levels: supportsThinking ? [...NATIVE_THINKING_LEVELS] : null,
        per_message: true,
      },
      // Gemini searches autonomously on every mode; there is no per-message switch.
      web_search: { supported: true, per_message: false },
      // Deep research is a real Gemini feature but this plugin exposes no tool for it,
      // so it is reported false rather than advertising something a caller cannot drive.
      // See list_capabilities().features.deep_research for the reason.
      deep_research: { supported: false },
      vision: { supported: mode.capabilityIds.includes(CAPABILITY_VISION) },
      code_interpreter: { supported: mode.capabilityIds.includes(CAPABILITY_CODE_INTERPRETER) },
    },
  };
};

export const getModels = async (): Promise<NormalizedModel[]> => {
  const modes = await readModes();
  const selected = selectedModeName();
  // When the composer is not on screen there is nothing to read the selection from,
  // so fall back to the first published mode — which is exactly what resolveModel uses
  // when model_id is omitted, so is_default never disagrees with what a send does.
  const defaultMode =
    modes.find(mode => selected !== null && (mode.displayName === selected || mode.displayName.endsWith(selected))) ??
    modes[0] ??
    null;
  return modes.map(mode => buildModel(mode, modes, defaultMode?.id ?? null));
};

export interface ResolvedModel {
  id: string;
  displayName: string;
  supportsThinking: boolean;
}

/** Validates `model_id` against the live picker so a typo never reaches the wire. */
export const resolveModel = async (modelId: string | undefined): Promise<ResolvedModel> => {
  const models = await getModels();
  if (!modelId) {
    const fallback = models.find(model => model.is_default) ?? models[0];
    if (!fallback)
      throw new ToolError('Gemini published no selectable modes.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return {
      id: fallback.id,
      displayName: fallback.display_name,
      supportsThinking: fallback.capabilities.thinking.supported,
    };
  }
  const match = models.find(model => model.id === modelId);
  if (!match)
    throw ToolError.validation(
      `Unknown Gemini model_id "${modelId}". Valid ids from the live picker: ${models
        .map(model => `${model.id} (${model.display_name})`)
        .join(', ')}.`,
    );
  return { id: match.id, displayName: match.display_name, supportsThinking: match.capabilities.thinking.supported };
};

/**
 * Gemini has a single extended-thinking depth, so the normalized ladder collapses
 * onto on/off: `minimal`/`low` request standard thinking, `medium`/`high`/`max`
 * request Extended thinking. Asking for it on a mode that does not publish it is a
 * VALIDATION_ERROR rather than a silently ignored flag, and so is asking for both
 * controls at once when they disagree — silently letting one win would change which
 * mode actually ran without telling the caller.
 */
export const resolveThinkingHeaderValue = (
  model: ResolvedModel,
  thinking: boolean | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): number => {
  const levelWantsExtended = thinkingLevel !== undefined && EXTENDED_LEVELS.includes(thinkingLevel);
  if (thinking !== undefined && thinkingLevel !== undefined && thinking !== levelWantsExtended)
    throw ToolError.validation(
      `thinking=${thinking} and thinking_level="${thinkingLevel}" disagree for Gemini: ${EXTENDED_LEVELS.join('|')} mean Extended thinking and minimal|low mean standard. Pass only one of them.`,
    );
  const wantsExtended = thinkingLevel !== undefined ? levelWantsExtended : thinking === true;
  if (wantsExtended && !model.supportsThinking)
    throw ToolError.validation(
      `Gemini model "${model.id}" (${model.displayName}) does not offer Extended thinking — the mode picker lists it only for the most capable mode. Omit thinking/thinking_level, or pass a model_id that supports it.`,
    );
  return wantsExtended ? THINKING_HEADER_EXTENDED : THINKING_HEADER_STANDARD;
};
