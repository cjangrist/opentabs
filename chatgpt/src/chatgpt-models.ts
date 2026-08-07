import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api } from './chatgpt-api.js';
import type { NormalizedModel, ThinkingLevel } from './tools/normalized-schemas.js';

// --- Raw /backend-api/models payload ---

interface RawThinkingEffort {
  thinking_effort?: string;
  full_label?: string;
  short_label?: string;
  description?: string;
}

interface RawModel {
  slug?: string;
  title?: string;
  description?: string;
  max_tokens?: number;
  tags?: string[];
  enabled_tools?: string[];
  reasoning_type?: string;
  configurable_thinking_effort?: boolean;
  thinking_efforts?: RawThinkingEffort[];
  default_thinking_effort?: string;
  is_work_mode_model?: boolean;
  product_features?: {
    attachments?: { image_mime_types?: string[] };
  };
}

interface RawCategory {
  category?: string;
  human_category_name?: string;
  human_category_short_name?: string;
  subscription_level?: string;
  default_model?: string;
  subcategory?: string | null;
  supported_models?: string[];
  supported_features?: string[];
  model_lane?: string | null;
  tagline?: string;
  short_explainer?: string;
}

interface RawIntelligencePreset {
  id?: number;
  title?: string;
  model_slug?: string;
  lane?: string;
  thinking_effort?: string;
  preset_type?: string;
}

interface RawVersion {
  id?: string;
  display_text_full?: string;
  display_text_for_intelligence?: string;
  slugs?: string[];
  enabled?: boolean;
  intelligence_presets?: RawIntelligencePreset[];
}

interface RawModelsResponse {
  models?: RawModel[];
  categories?: RawCategory[];
  versions?: RawVersion[];
  default_model_slug?: string;
  model_picker_version?: number;
}

export interface ModelCatalog {
  models: NormalizedModel[];
  defaultModelSlug: string;
  /** Native effort ids per model, in the order the picker publishes them. */
  effortsByModel: Record<string, string[]>;
  /** Rendered picker rows: one per version, with the preset labels it offers. */
  pickerVersions: { id: string; label: string; presets: { title: string; slug: string; effort: string | null }[] }[];
  /** True when the account can reach the Deep research tool at all. */
  deepResearchSupported: boolean;
}

/** The exact query the web app sends; omitting it returns a different picker payload. */
const MODELS_ENDPOINT = '/models';
const MODELS_QUERY = { iim: false, is_gizmo: false, supports_model_picker_upgrade_presets: true };

export const fetchModelsPayload = async (): Promise<RawModelsResponse> =>
  api<RawModelsResponse>(MODELS_ENDPOINT, { query: MODELS_QUERY });

/**
 * chatgpt.com's picker is two-dimensional: a *version* row (GPT-5.6 Sol / GPT-5.5
 * / o3) and an *effort* row of intelligence presets (Instant / Medium / High /
 * Extra High / Pro). Each preset resolves to a concrete model slug plus an
 * optional `thinking_effort`. `/models.models[]` additionally lists slugs the
 * picker never renders (older point releases, `-mini` variants and work-mode
 * `-wm` builds), so reachability is decided by the picker, not by that array:
 *
 *   reachable = versions[].slugs ∪ versions[].intelligence_presets[].model_slug
 *
 * Verified against the rendered picker: the Model submenu lists exactly the
 * three enabled versions and the Effort submenu exactly the five presets of the
 * selected version.
 */
export const parseModelCatalog = (payload: RawModelsResponse): ModelCatalog => {
  const versions = (payload.versions ?? []).filter(version => version.enabled !== false);
  const categories = payload.categories ?? [];
  const defaultModelSlug = payload.default_model_slug ?? '';

  const reachable = new Set<string>();
  // Efforts a preset can actually select for a given slug. A model may publish
  // more in /models than the picker offers (gpt-5-6-thinking publishes "min",
  // but no 5.6 preset selects it), and the picker is this plugin's only lever.
  const pickerEfforts = new Map<string, Set<string>>();
  for (const version of versions) {
    for (const slug of version.slugs ?? []) reachable.add(slug);
    for (const preset of version.intelligence_presets ?? []) {
      if (!preset.model_slug) continue;
      reachable.add(preset.model_slug);
      if (!preset.thinking_effort) continue;
      const efforts = pickerEfforts.get(preset.model_slug) ?? new Set<string>();
      efforts.add(preset.thinking_effort);
      pickerEfforts.set(preset.model_slug, efforts);
    }
  }

  const categoryOf = (slug: string): RawCategory | undefined =>
    categories.find(category => category.default_model === slug || (category.supported_models ?? []).includes(slug));

  const effortsByModel: Record<string, string[]> = {};
  const models: NormalizedModel[] = [];

  for (const raw of payload.models ?? []) {
    const slug = raw.slug;
    if (!slug || !reachable.has(slug)) continue;

    const selectable = pickerEfforts.get(slug) ?? new Set<string>();
    const efforts = (raw.thinking_efforts ?? [])
      .map(effort => effort.thinking_effort ?? '')
      .filter((effort): effort is string => effort.length > 0 && selectable.has(effort));
    effortsByModel[slug] = efforts;

    const category = categoryOf(slug);
    const features = new Set(category?.supported_features ?? []);
    const tools = new Set(raw.enabled_tools ?? []);
    const tier = category?.subscription_level ?? null;

    models.push({
      id: slug,
      display_name: raw.title ?? slug,
      description: raw.description ?? category?.tagline ?? '',
      is_default: slug === defaultModelSlug,
      is_available: true,
      requires_subscription: tier && tier !== 'free' ? tier : null,
      context_window: raw.max_tokens ?? null,
      capabilities: {
        thinking: {
          // reasoning_type is one of none | auto | reasoning | pro. Everything
          // except "none" reasons; only the ladder differs.
          supported: (raw.reasoning_type ?? 'none') !== 'none' || efforts.length > 0,
          levels: efforts.length > 0 ? efforts : null,
          // per_message is what THIS plugin can vary per request, which is the
          // picker's effort row: a model whose presets expose no effort (auto,
          // instant, pro, o3) cannot have it changed per message from here even
          // when /models reports configurable_thinking_effort: true.
          per_message: efforts.length > 0,
        },
        web_search: { supported: tools.has('search') || features.has('tool_search'), per_message: true },
        // "Deep research" is a composer plugin (system hint
        // plugin:connector_openai_deep_research), not a model capability, so it
        // is reported per-model as "this model can host a research run".
        deep_research: { supported: tools.has('search') || features.has('tool_search') },
        vision: {
          supported: (raw.product_features?.attachments?.image_mime_types ?? []).length > 0 || features.has('image'),
        },
        code_interpreter: { supported: features.has('python') || tools.has('tools2') },
      },
    });
  }

  return {
    models,
    defaultModelSlug,
    effortsByModel,
    pickerVersions: versions.map(version => ({
      id: version.id ?? '',
      label: version.display_text_for_intelligence ?? version.id ?? '',
      presets: (version.intelligence_presets ?? []).map(preset => ({
        title: preset.title ?? '',
        slug: preset.model_slug ?? '',
        effort: preset.thinking_effort ?? null,
      })),
    })),
    deepResearchSupported: models.some(model => model.capabilities.deep_research.supported),
  };
};

export const getModelCatalog = async (): Promise<ModelCatalog> => parseModelCatalog(await fetchModelsPayload());

// --- Model / thinking selection ---

const listValidIds = (catalog: ModelCatalog): string => catalog.models.map(model => model.id).join(', ');

/** Validates `model_id` against the live list BEFORE any request is sent (SPEC §4). */
export const resolveModelId = (catalog: ModelCatalog, modelId: string | undefined): string => {
  if (!modelId) {
    const fallback = catalog.defaultModelSlug || catalog.models[0]?.id;
    if (!fallback)
      throw new ToolError(
        'ChatGPT published no selectable models — reload https://chatgpt.com and try again.',
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      );
    return fallback;
  }
  const match = catalog.models.find(model => model.id === modelId);
  if (!match) throw ToolError.validation(`Unknown model_id "${modelId}". Valid ids: ${listValidIds(catalog)}`);
  return modelId;
};

/**
 * ChatGPT's native effort ladder is min < standard < extended < max, and the
 * subset differs per model. The normalized ladder maps by rank; when a model
 * does not publish the mapped step we walk DOWN to the nearest one it does, and
 * only walk up when nothing lower exists.
 */
const NATIVE_LADDER = ['min', 'standard', 'extended', 'max'];
const NORMALIZED_TO_NATIVE: Record<ThinkingLevel, string> = {
  minimal: 'min',
  low: 'min',
  medium: 'standard',
  high: 'extended',
  max: 'max',
};

export const mapThinkingLevel = (level: ThinkingLevel, efforts: string[]): string => {
  const target = NORMALIZED_TO_NATIVE[level];
  if (efforts.includes(target)) return target;
  const targetIndex = NATIVE_LADDER.indexOf(target);
  const available = efforts
    .map(effort => ({ effort, index: NATIVE_LADDER.indexOf(effort) }))
    .filter(entry => entry.index >= 0)
    .sort((left, right) => left.index - right.index);
  const below = [...available].reverse().find(entry => entry.index <= targetIndex);
  const chosen = below ?? available[0];
  if (!chosen) throw ToolError.validation('This model exposes no reasoning-effort levels.');
  return chosen.effort;
};

/**
 * Translates the normalized `thinking` / `thinking_level` pair onto ChatGPT's
 * `thinking_effort`, raising VALIDATION_ERROR rather than silently ignoring a
 * control the model does not have.
 *
 * `thinking: true` on a model with no effort ladder is an error rather than a
 * no-op: on chatgpt.com thinking is a *model lane*, so the caller wants a
 * `-thinking` model id instead.
 */
export const resolveThinkingEffort = (
  catalog: ModelCatalog,
  modelId: string,
  thinking: boolean | undefined,
  level: ThinkingLevel | undefined,
): string | undefined => {
  const efforts = catalog.effortsByModel[modelId] ?? [];
  if (efforts.length === 0) {
    if (thinking === true || level !== undefined)
      throw ToolError.validation(
        `Model "${modelId}" has no reasoning-effort ladder — on ChatGPT thinking is a model lane, not a toggle. ` +
          `Pick a model with an effort ladder instead: ${catalog.models
            .filter(model => (model.capabilities.thinking.levels ?? []).length > 0)
            .map(model => model.id)
            .join(', ')}`,
      );
    return undefined;
  }
  if (thinking === false)
    throw ToolError.validation(
      `Model "${modelId}" always reasons — thinking:false has no effect on it. ` +
        `Pick a model without an effort ladder instead: ${catalog.models
          .filter(model => (model.capabilities.thinking.levels ?? []).length === 0)
          .map(model => model.id)
          .join(', ')}`,
    );
  if (level !== undefined) return mapThinkingLevel(level, efforts);
  return thinking === true ? mapThinkingLevel('medium', efforts) : undefined;
};
