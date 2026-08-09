import { ToolError } from '@opentabs-dev/plugin-sdk';
import { getApi, readDeviceId } from './deepseek-api.js';
import type { NormalizedModel, ThinkingLevel } from './tools/normalized-schemas.js';

/**
 * DeepSeek's picker offers "modes", not named checkpoints, and the API calls the
 * id a `model_type`. `default` is the one the composer starts on.
 */
export const DEFAULT_MODEL_TYPE = 'default';

interface RawModelConfig {
  model_type?: string;
  name?: string;
  description?: string;
  is_default?: boolean;
  enabled?: boolean;
  switchable?: boolean;
  input_character_limit?: number;
  /** `{}` when the mode offers the toggle, `null`/absent when it does not. */
  think_feature?: unknown;
  search_feature?: unknown;
  file_feature?: { support_file_exts?: string[] } | null;
}

interface ModelSettingsResponse {
  settings?: { model_configs?: { value?: RawModelConfig[] } };
}

export interface DeepSeekModelRuntime {
  modelType: string;
  supportsThinking: boolean;
  supportsSearch: boolean;
  supportsVision: boolean;
}

export interface DeepSeekModelCatalog {
  models: NormalizedModel[];
  runtimeById: Record<string, DeepSeekModelRuntime>;
  defaultModelId: string;
}

/** Image extensions in `file_feature.support_file_exts` mark a mode that reads pictures. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

const supportsVision = (config: RawModelConfig): boolean => {
  const extensions = config.file_feature?.support_file_exts ?? [];
  // Only the Vision mode is actually described as reading images; Instant lists
  // the same extensions but its own tip says "text extraction only", so the mode
  // id is the honest signal and the extension list alone is not.
  return config.model_type === 'vision' && IMAGE_EXTENSIONS.some(extension => extensions.includes(extension));
};

const toNormalizedModel = (config: RawModelConfig): NormalizedModel => {
  const thinking = config.think_feature !== null && config.think_feature !== undefined;
  const search = config.search_feature !== null && config.search_feature !== undefined;
  return {
    id: config.model_type ?? '',
    display_name: config.name ?? '',
    description: config.description ?? '',
    is_default: config.is_default === true,
    is_available: config.enabled !== false && config.switchable !== false,
    // DeepSeek's web app is free for every mode listed here; no tier gate is
    // published anywhere in the settings payload.
    requires_subscription: null,
    // `input_character_limit` is a CHARACTER cap on the prompt box, not a token
    // context window, so it is not reported as one.
    context_window: null,
    capabilities: {
      // DeepThink is a plain on/off checkbox in the composer — there is no effort
      // ladder anywhere in the payload or the UI, so `levels` is null (SPEC §4).
      thinking: { supported: thinking, levels: null, per_message: thinking },
      web_search: { supported: search, per_message: search },
      deep_research: { supported: false },
      vision: { supported: supportsVision(config) },
      code_interpreter: { supported: false },
    },
  };
};

/**
 * Reads the live model picker.
 *
 * `GET /client/settings?scope=model` is what the SPA itself calls, and it
 * REQUIRES the `did` device id — without it the call answers biz_code 2
 * (INVALID_PARAM), which is why the id is read out of localStorage rather than
 * left blank.
 */
export const getModelCatalog = async (): Promise<DeepSeekModelCatalog> => {
  const deviceId = readDeviceId();
  if (!deviceId)
    throw ToolError.auth(
      'DeepSeek has not issued a device id to this browser yet — open https://chat.deepseek.com and try again.',
      'AUTH_ERROR',
    );

  const settings = await getApi<ModelSettingsResponse>(
    `/client/settings?did=${encodeURIComponent(deviceId)}&scope=model`,
  );
  const configs = (settings.settings?.model_configs?.value ?? []).filter(
    config => typeof config.model_type === 'string' && config.model_type.length > 0 && config.enabled !== false,
  );
  if (configs.length === 0)
    throw new ToolError(
      'DeepSeek returned no models — reload https://chat.deepseek.com and try again.',
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: true },
    );

  const models = configs.map(toNormalizedModel);
  const runtimeById: Record<string, DeepSeekModelRuntime> = {};
  for (const model of models) {
    runtimeById[model.id] = {
      modelType: model.id,
      supportsThinking: model.capabilities.thinking.supported,
      supportsSearch: model.capabilities.web_search.supported,
      supportsVision: model.capabilities.vision.supported,
    };
  }

  return {
    models,
    runtimeById,
    defaultModelId: models.find(model => model.is_default)?.id ?? models[0]?.id ?? DEFAULT_MODEL_TYPE,
  };
};

/** Validates a model id against the live picker BEFORE anything is sent (SPEC §4). */
export const resolveModelId = (catalog: DeepSeekModelCatalog, modelId: string | undefined): string => {
  if (modelId === undefined) return catalog.defaultModelId;
  if (!catalog.runtimeById[modelId])
    throw ToolError.validation(
      `Unknown DeepSeek model_id "${modelId}". Valid ids: ${catalog.models.map(model => model.id).join(', ')}.`,
      'VALIDATION_ERROR',
    );
  return modelId;
};

export interface TurnToggles {
  thinkingEnabled: boolean;
  searchEnabled: boolean;
}

/**
 * Maps the normalized `thinking` / `thinking_level` / `search` options onto
 * DeepSeek's two per-message booleans.
 *
 * DeepThink has no effort ladder, so `thinking_level` cannot be honoured and is
 * rejected rather than silently dropped (SPEC §4).
 */
export const resolveToggles = (
  runtime: DeepSeekModelRuntime,
  options: { thinking?: boolean; thinking_level?: ThinkingLevel; search?: boolean },
): TurnToggles => {
  if (options.thinking_level !== undefined)
    throw ToolError.validation(
      'DeepSeek has no reasoning-effort ladder — DeepThink is a plain on/off toggle, so thinking_level cannot be honoured. ' +
        'Use thinking:true / thinking:false instead (list_models().capabilities.thinking.levels is null for every mode).',
      'VALIDATION_ERROR',
    );

  if (options.thinking === true && !runtime.supportsThinking)
    throw ToolError.validation(
      `DeepSeek mode "${runtime.modelType}" does not offer DeepThink. See list_models().capabilities.thinking.`,
      'VALIDATION_ERROR',
    );

  if (options.search === true && !runtime.supportsSearch)
    throw ToolError.validation(
      `DeepSeek mode "${runtime.modelType}" does not offer web search — the composer hides the Search button for it, ` +
        'and the mode answers with a "Search is unavailable" tip if asked. Use model_id "default" (Instant) for search.',
      'VALIDATION_ERROR',
    );

  return {
    thinkingEnabled: options.thinking === true,
    // Search cannot be forced on for a mode that has no search_feature; omitting
    // it there sends false, matching the composer, which hides the button.
    searchEnabled: options.search === true && runtime.supportsSearch,
  };
};
