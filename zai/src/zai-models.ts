import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api } from './zai-api.js';
import type { NormalizedModel, ThinkingLevel } from './tools/normalized-schemas.js';

// --- Raw /api/models + /api/config shapes ---

interface RawModelCapabilities {
  think?: boolean;
  reasoning_effort?: boolean;
  web_search?: boolean;
  vision?: boolean;
  agent_mode?: boolean;
  mcp?: boolean;
  citations?: boolean;
  file_qa?: boolean;
}

interface RawModel {
  id?: string;
  name?: string;
  info?: {
    is_active?: boolean;
    params?: { max_tokens?: number };
    meta?: {
      hidden?: boolean;
      description?: string;
      capabilities?: RawModelCapabilities;
      mcpServerIds?: string[];
      tags?: { name?: string }[];
    };
  };
}

interface RawConfig {
  default_models?: string;
  recommand_model?: string;
  features?: Record<string, boolean>;
  permissions?: { features?: Record<string, boolean> };
}

/**
 * z.ai's "Deep Think" control publishes exactly two efforts, coarsest first. There
 * is nothing below `high`: the picker offers High and Max only, and defaults to Max.
 */
export const NATIVE_THINKING_LEVELS = ['high', 'max'] as const;
export const DEFAULT_THINKING_EFFORT = 'max';

/** The MCP server id that turns a normal chat into a deep-research run. */
export const DEEP_RESEARCH_SERVER = 'deep-research';
/** The MCP server id behind the composer's "Web Search" tool. */
export const WEB_SEARCH_SERVER = 'deep-web-search';

export interface ZaiBootstrap {
  models: NormalizedModel[];
  defaultModelId: string;
  /** Server ids each model advertises, for building the completion payload. */
  serversByModel: Map<string, string[]>;
  config: RawConfig;
}

const toModel = (raw: RawModel, defaultModelId: string, config: RawConfig): NormalizedModel => {
  const capabilities = raw.info?.meta?.capabilities ?? {};
  const servers = raw.info?.meta?.mcpServerIds ?? [];
  const thinkingSupported = capabilities.think === true;
  const hasEffortLadder = thinkingSupported && capabilities.reasoning_effort === true;
  return {
    id: raw.id ?? '',
    display_name: raw.name ?? raw.id ?? '',
    description: raw.info?.meta?.description ?? '',
    is_default: raw.id === defaultModelId,
    is_available: raw.info?.is_active !== false,
    // z.ai publishes no plan/tier field on the model list; entitlement only shows up
    // as a per-response `usage.benefit_level` after a completion has run.
    requires_subscription: null,
    // `info.params.max_tokens` is the per-request output cap, not a context window,
    // and z.ai publishes no context size anywhere. Reporting it would be a lie.
    context_window: null,
    capabilities: {
      thinking: {
        supported: thinkingSupported,
        levels: hasEffortLadder ? [...NATIVE_THINKING_LEVELS] : null,
        per_message: true,
      },
      web_search: { supported: capabilities.web_search === true, per_message: true },
      deep_research: { supported: servers.includes(DEEP_RESEARCH_SERVER) },
      vision: { supported: capabilities.vision === true },
      code_interpreter: { supported: config.features?.enable_code_interpreter === true },
    },
  };
};

/**
 * Reads the live model list and site config on every call.
 *
 * `/api/models` returns 14 entries, nine of which carry `info.meta.hidden: true` —
 * internal/API-only builds such as `deep-research` and `0808-360B-DR` that the
 * picker never offers. Serving those as selectable would repeat the kimi A/B trap,
 * so hidden models are filtered out and the result matches the rendered picker
 * one-for-one.
 */
export const getBootstrap = async (): Promise<ZaiBootstrap> => {
  const [payload, config] = await Promise.all([api<{ data?: RawModel[] }>('/models'), api<RawConfig>('/config')]);
  const rawModels = payload?.data;
  if (!Array.isArray(rawModels))
    throw new ToolError('z.ai returned no model list. Reload https://chat.z.ai and try again.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });

  const visible = rawModels.filter(model => model.id && model.info?.meta?.hidden !== true);
  if (visible.length === 0)
    throw new ToolError(
      `z.ai published ${rawModels.length} models but every one is marked hidden. The /api/models shape may have changed.`,
      'UPSTREAM_ERROR',
      { category: 'internal', retryable: false },
    );

  // The picker preselects `recommand_model`; `default_models` is the Open WebUI
  // admin fallback and does not always name a visible model.
  const byId = new Map(visible.map(model => [model.id ?? '', model]));
  const preferred = [config?.recommand_model, config?.default_models].find(
    candidate => candidate && byId.has(candidate),
  );
  const defaultModelId = preferred ?? visible[0]?.id ?? '';

  return {
    models: visible.map(model => toModel(model, defaultModelId, config ?? {})),
    defaultModelId,
    serversByModel: new Map(visible.map(model => [model.id ?? '', model.info?.meta?.mcpServerIds ?? []])),
    config: config ?? {},
  };
};

/** Validates `model_id` against the live list *before* anything is sent upstream. */
export const resolveModel = (bootstrap: ZaiBootstrap, modelId: string | undefined): NormalizedModel => {
  if (!modelId) {
    const fallback = bootstrap.models.find(model => model.id === bootstrap.defaultModelId) ?? bootstrap.models[0];
    if (!fallback) throw new ToolError('z.ai published no selectable model.', 'UPSTREAM_ERROR', { retryable: true });
    return fallback;
  }
  const match = bootstrap.models.find(model => model.id === modelId);
  if (match) return match;
  throw ToolError.validation(
    `Unknown model_id "${modelId}". Valid ids: ${bootstrap.models.map(model => model.id).join(', ')}.`,
  );
};

/**
 * Maps the normalized minimal|low|medium|high|max ladder onto z.ai's native
 * high|max. z.ai exposes nothing below `high`, so every level under it resolves to
 * the nearest step it publishes, exactly as SPEC §4 prescribes.
 */
export const toNativeEffort = (level: ThinkingLevel): string => (level === 'max' ? 'max' : 'high');

export const assertThinkingSupported = (model: NormalizedModel, thinking: boolean | undefined): void => {
  if (thinking === true && !model.capabilities.thinking.supported)
    throw ToolError.validation(
      `Model "${model.id}" has no Deep Think mode. Models that do: ${'see list_models capabilities.thinking.supported'}.`,
    );
};

export const assertEffortSupported = (model: NormalizedModel, level: ThinkingLevel | undefined): void => {
  if (level === undefined) return;
  if (!model.capabilities.thinking.supported)
    throw ToolError.validation(`Model "${model.id}" has no Deep Think mode, so thinking_level cannot be applied.`);
  if (model.capabilities.thinking.levels === null)
    throw ToolError.validation(
      `Model "${model.id}" exposes Deep Think as an on/off toggle only — it publishes no reasoning_effort ladder, so thinking_level cannot be applied. Use thinking:true instead.`,
    );
};
