import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api } from './perplexity-api.js';
import type { NormalizedModel, ThinkingLevel } from './tools/normalized-schemas.js';

// --- Raw /rest/models/config/v2 shapes ---

interface RawModelEntry {
  label?: string;
  description?: string;
  mode?: string;
  provider?: string | null;
}

interface RawSearchConfigEntry {
  label?: string;
  description?: string;
  subscription_tier?: string;
  non_reasoning_model?: string | null;
  reasoning_model?: string | null;
}

interface RawComputerConfigEntry {
  label?: string;
  description?: string;
  subheading?: string;
  subscription_tier?: string;
  model?: string;
  fast_model?: string | null;
}

interface RawModelsConfig {
  models?: Record<string, RawModelEntry>;
  search_config?: RawSearchConfigEntry[];
  computer_config?: RawComputerConfigEntry[];
  default_models?: Record<string, string>;
}

interface RawUserSettings {
  subscription_status?: string;
  subscription_tier?: string | null;
  default_model?: string;
}

interface RawRateLimits {
  free_queries?: { available?: boolean };
  modes?: Record<string, { available?: boolean; remaining_detail?: { kind?: string; remaining?: number } }>;
}

// --- Catalog ---

export interface ModelPair {
  /** Model id used when thinking is off, or null when the entry is reasoning-only. */
  nonReasoning: string | null;
  /** Model id used when thinking is on, or null when the entry has no reasoning form. */
  reasoning: string | null;
}

export interface ModelCatalog {
  models: NormalizedModel[];
  defaultModelId: string;
  /** Perplexity mode ("search", "research", "asi", …) per model id. */
  modeById: Record<string, string>;
  /** Thinking/non-thinking sibling ids per model id. */
  pairById: Record<string, ModelPair>;
  /** Live per-mode availability from /rest/rate-limit/status. */
  modeAvailability: Record<string, { available: boolean; remaining: number | null }>;
  accountTier: string;
  researchModelId: string | null;
  agenticResearchModelId: string | null;
}

const TIER_RANK: Record<string, number> = { free: 0, pro: 1, max: 2 };

/** Perplexity modes whose models answer from live web results rather than weights alone. */
const SEARCHING_MODES = new Set(['search', 'research', 'agentic_research', 'asi', 'browser_agent', 'study']);
/** Modes whose runs execute code — observed live as CODE steps in research threads. */
const CODE_MODES = new Set(['research', 'agentic_research', 'asi']);
const RESEARCH_MODES = new Set(['research', 'agentic_research']);

/**
 * Perplexity publishes no per-account model gate. The rendered picker greys out
 * entries above the plan (verified live: the two `max`-tier rows render as plain
 * `menuitem`s while every `pro` row is a selectable `menuitemradio` on a Pro
 * account), so the plan has to be inferred. `subscription_status` distinguishes
 * "no subscription" from "subscribed", and `subscription_tier` is the only place
 * a tier name could appear — in practice it carries the billing interval
 * ("monthly"), so a Max plan is only recognised when it literally says so.
 */
const inferAccountTier = (settings: RawUserSettings): string => {
  const tier = (settings.subscription_tier ?? '').toLowerCase();
  if (tier.includes('max')) return 'max';
  const status = (settings.subscription_status ?? '').toLowerCase();
  if (status === '' || status === 'none' || status === 'free' || status === 'canceled') return 'free';
  return 'pro';
};

interface Candidate {
  id: string;
  label: string;
  description: string;
  tier: string | null;
  pair: ModelPair;
}

/**
 * The set of ids the site's own pickers can actually select:
 *   - `search_config` rows whose models are in `search` mode (the model picker;
 *     the browser-agent rows in that same array belong to a different picker)
 *   - `computer_config` rows (the Computer/ASI picker)
 *   - every `default_models` value (the "Best" row plus each mode's own model)
 *
 * `models` itself lists ~114 gateway-accepted ids, most of which the picker
 * never shows; offering those would let a caller select a model the site would
 * silently downgrade, which is exactly the trap SPEC §4 forbids.
 */
const collectCandidates = (config: RawModelsConfig): Candidate[] => {
  const models = config.models ?? {};
  const candidates = new Map<string, Candidate>();

  const add = (id: string | null | undefined, entry: Partial<Candidate>): void => {
    if (!id || !models[id]) return;
    const existing = candidates.get(id);
    candidates.set(id, {
      id,
      label: entry.label ?? existing?.label ?? models[id]?.label ?? id,
      description: entry.description ?? existing?.description ?? models[id]?.description ?? '',
      tier: entry.tier ?? existing?.tier ?? null,
      pair: entry.pair ?? existing?.pair ?? { nonReasoning: null, reasoning: null },
    });
  };

  for (const row of config.search_config ?? []) {
    const ids = [row.non_reasoning_model, row.reasoning_model].filter((id): id is string => Boolean(id));
    if (ids.length === 0) continue;
    // The browser-agent rows share this array but their models are in browser_agent mode.
    if (!ids.every(id => models[id]?.mode === 'search')) continue;
    const pair: ModelPair = { nonReasoning: row.non_reasoning_model ?? null, reasoning: row.reasoning_model ?? null };
    for (const id of ids)
      add(id, { label: row.label, description: row.description, tier: row.subscription_tier, pair });
  }

  for (const row of config.computer_config ?? []) {
    for (const id of [row.model, row.fast_model])
      add(id, { label: row.label, description: row.subheading ?? row.description, tier: row.subscription_tier });
  }

  for (const id of Object.values(config.default_models ?? {})) add(id, {});

  return [...candidates.values()];
};

const buildModel = (
  candidate: Candidate,
  options: { mode: string; isDefault: boolean; accountTier: string },
): NormalizedModel => {
  const required = candidate.tier && candidate.tier !== 'free' ? candidate.tier : null;
  const hasReasoning = candidate.pair.reasoning !== null;
  const hasNonReasoning = candidate.pair.nonReasoning !== null;
  return {
    id: candidate.id,
    display_name: candidate.label,
    description: candidate.description,
    is_default: options.isDefault,
    is_available: required === null || (TIER_RANK[required] ?? 0) <= (TIER_RANK[options.accountTier] ?? 0),
    requires_subscription: required,
    // Perplexity publishes no context window anywhere in its model config.
    context_window: null,
    capabilities: {
      thinking: {
        // Reasoning is a separate model id, not a request flag: the picker rows
        // pair a non-reasoning and a reasoning model, and the Thinking toggle
        // swaps between them.
        supported: hasReasoning || (hasNonReasoning && candidate.pair.reasoning === candidate.id),
        levels: null,
        per_message: true,
      },
      web_search: { supported: SEARCHING_MODES.has(options.mode), per_message: true },
      deep_research: { supported: RESEARCH_MODES.has(options.mode) },
      // Perplexity's model config publishes no vision flag, and this plugin does
      // not implement attachments, so there is nothing to claim here.
      vision: { supported: false },
      code_interpreter: { supported: CODE_MODES.has(options.mode) },
    },
  };
};

export const getModelCatalog = async (): Promise<ModelCatalog> => {
  const [config, settings, limits] = await Promise.all([
    api<RawModelsConfig>('/models/config/v2', { timeout: 20_000 }),
    api<RawUserSettings>('/user/settings', { query: { skip_connector_picker_credentials: true }, timeout: 20_000 }),
    api<RawRateLimits>('/rate-limit/status', { timeout: 20_000 }).catch(() => ({}) as RawRateLimits),
  ]);

  const modelEntries = config?.models ?? {};
  if (Object.keys(modelEntries).length === 0)
    throw new ToolError(
      'Perplexity published no models — reload https://www.perplexity.ai and retry.',
      'UPSTREAM_ERROR',
      {
        category: 'internal',
        retryable: true,
      },
    );

  const accountTier = inferAccountTier(settings ?? {});
  const defaults = config.default_models ?? {};
  const candidates = collectCandidates(config);
  // `settings.default_model` is the account's stored choice, but it can name an id
  // the picker no longer renders ("turbo", whose label is also "Best"); in that
  // case the mode default is what the composer actually sends, and it is the row
  // the picker shows as checked.
  const storedDefault = settings?.default_model ?? '';
  const defaultModelId = candidates.some(candidate => candidate.id === storedDefault)
    ? storedDefault
    : (defaults.search ?? '');

  const modeById: Record<string, string> = {};
  const pairById: Record<string, ModelPair> = {};
  const models: NormalizedModel[] = [];

  for (const candidate of candidates) {
    const mode = modelEntries[candidate.id]?.mode ?? '';
    modeById[candidate.id] = mode;
    pairById[candidate.id] = candidate.pair;
    models.push(buildModel(candidate, { mode, isDefault: candidate.id === defaultModelId, accountTier }));
  }

  const modeAvailability: ModelCatalog['modeAvailability'] = {};
  for (const [mode, value] of Object.entries(limits?.modes ?? {}))
    modeAvailability[mode] = {
      available: value?.available === true,
      remaining: typeof value?.remaining_detail?.remaining === 'number' ? value.remaining_detail.remaining : null,
    };

  return {
    models,
    defaultModelId,
    modeById,
    pairById,
    modeAvailability,
    accountTier,
    researchModelId: defaults.research ?? null,
    agenticResearchModelId: defaults.agentic_research ?? null,
  };
};

// --- Selection ---

const listValidIds = (catalog: ModelCatalog): string =>
  catalog.models
    .filter(model => model.is_available)
    .map(model => model.id)
    .join(', ');

/** Validates `model_id` against the live list BEFORE any request is sent (SPEC §4). */
export const resolveModelId = (catalog: ModelCatalog, modelId: string | undefined): string => {
  if (!modelId) {
    const fallback = catalog.defaultModelId || catalog.models.find(model => model.is_available)?.id;
    if (!fallback)
      throw new ToolError('Perplexity offered no selectable model for this account.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return fallback;
  }

  const match = catalog.models.find(model => model.id === modelId);
  if (!match) throw ToolError.validation(`Unknown model_id "${modelId}". Valid ids: ${listValidIds(catalog)}`);
  if (!match.is_available)
    throw ToolError.validation(
      `Model "${modelId}" requires a Perplexity ${match.requires_subscription} plan and this account cannot select it. ` +
        `Valid ids: ${listValidIds(catalog)}`,
    );
  return modelId;
};

/**
 * Perplexity has no reasoning-effort request field: the model picker pairs a
 * non-reasoning model with a reasoning ("Thinking") one, and the toggle swaps
 * the id. So `thinking` selects the sibling and `thinking_level` has nowhere to
 * go — it raises VALIDATION_ERROR rather than being silently dropped.
 */
export const resolveThinkingModel = (
  catalog: ModelCatalog,
  modelId: string,
  thinking: boolean | undefined,
  level: ThinkingLevel | undefined,
): string => {
  if (level !== undefined)
    throw ToolError.validation(
      'Perplexity exposes no reasoning-effort ladder — thinking is a separate model, not a level. ' +
        'Pass thinking:true|false (or pick the "…thinking" model id directly) and omit thinking_level. ' +
        'See list_models().capabilities.thinking.levels, which is null on every Perplexity model.',
    );
  if (thinking === undefined) return modelId;

  const pair = catalog.pairById[modelId] ?? { nonReasoning: null, reasoning: null };
  const wanted = thinking ? pair.reasoning : pair.nonReasoning;
  if (!wanted) {
    const alternatives = catalog.models
      .filter(model => model.is_available && model.capabilities.thinking.supported)
      .map(model => model.id)
      .join(', ');
    throw ToolError.validation(
      thinking
        ? `Model "${modelId}" has no thinking counterpart in Perplexity's model picker. Models that do: ${alternatives}`
        : `Model "${modelId}" is thinking-only in Perplexity's model picker — it has no non-thinking counterpart. ` +
            'Omit thinking, or choose a model whose picker row offers both.',
    );
  }
  return wanted;
};
