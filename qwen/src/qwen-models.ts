import { ToolError } from '@opentabs-dev/plugin-sdk';
import { apiRaw } from './qwen-api.js';
import type { NormalizedModel, ThinkingLevel } from './tools/normalized-schemas.js';

// --- Raw /api/models + /api/config shapes ---

interface RawModelCapabilities {
  thinking?: boolean;
  search?: boolean;
  vision?: boolean;
  document?: boolean;
  audio?: boolean;
  video?: boolean;
}

interface RawModel {
  id?: string;
  name?: string;
  info?: {
    is_active?: boolean;
    is_visitor_active?: boolean;
    meta?: {
      description?: string;
      short_description?: string;
      max_context_length?: number;
      chat_type?: string[];
      capabilities?: RawModelCapabilities;
      mcp?: string[];
      auto_thinking?: boolean;
      thinking_format?: string;
    };
  };
}

interface RawConfig {
  features?: {
    enable_project?: boolean;
    enable_subscription?: boolean;
    feature_feature?: Record<string, string[]>;
    limits?: { project?: { project_max_count?: number; project_file_max_count?: number } };
  };
  permissions?: Record<string, unknown>;
  version?: string;
}

/** Chat types Qwen routes a message through, as declared per model in `meta.chat_type`. */
export const CHAT_TYPE_TEXT = 't2t';
export const CHAT_TYPE_SEARCH = 'search';
export const CHAT_TYPE_DEEP_RESEARCH = 'deep_research';
/** The sub type a deep-research chat opens with; Qwen answers it with a clarifying question. */
export const SUB_CHAT_TYPE_DEEP_THINKING = 'deep_thinking';
/** The sub type that runs the actual research, sent once the clarification is answered. */
export const SUB_CHAT_TYPE_DEEP_RESEARCH = 'deep_research';
/** Qwen's own label for a mid-run clarification. */
export const SUB_CHAT_TYPE_INTERRUPT = 'interrupt';

/** The MCP tool ids a model publishes in `meta.mcp`; the valid values for `tools`. */
export const CODE_INTERPRETER_TOOL = 'code-interpreter';

/**
 * Qwen's reasoning control is a three-value enum, taken from the site bundle's
 * ThinkingMode setter (`case "Auto": case "Thinking": … case "Fast":`) and listed
 * coarsest first. Any value outside it makes the completion endpoint HANG rather
 * than error, so it is never derived from user input directly.
 */
export const THINKING_MODE_OFF = 'Fast';
export const THINKING_MODE_AUTO = 'Auto';
export const THINKING_MODE_ON = 'Thinking';
export const NATIVE_THINKING_LEVELS = [THINKING_MODE_OFF, THINKING_MODE_AUTO, THINKING_MODE_ON] as const;

export type ThinkingMode = (typeof NATIVE_THINKING_LEVELS)[number];

/** Deep research runs at one of two efforts; the picker labels them Normal and Advanced. */
export const RESEARCH_MODE_NORMAL = 'normal';
export const RESEARCH_MODE_ADVANCED = 'advance';
export const NATIVE_RESEARCH_MODES = [RESEARCH_MODE_NORMAL, RESEARCH_MODE_ADVANCED] as const;

export interface QwenBootstrap {
  models: NormalizedModel[];
  defaultModelId: string;
  /** MCP tool ids each model publishes, for validating `tools`. */
  toolsByModel: Map<string, string[]>;
  config: RawConfig;
}

const toModel = (raw: RawModel, isDefault: boolean): NormalizedModel => {
  const meta = raw.info?.meta ?? {};
  const capabilities = meta.capabilities ?? {};
  const chatTypes = meta.chat_type ?? [];
  const thinkingSupported = capabilities.thinking === true;
  return {
    id: raw.id ?? '',
    display_name: raw.name ?? raw.id ?? '',
    description: meta.short_description ?? meta.description ?? '',
    is_default: isDefault,
    is_available: raw.info?.is_active !== false,
    // Qwen publishes no plan/tier field on the model list, and /api/config reports
    // enable_subscription:false for this account — there is nothing to report.
    requires_subscription: null,
    context_window: meta.max_context_length ?? null,
    capabilities: {
      thinking: {
        supported: thinkingSupported,
        // Fast|Auto|Thinking is a mode enum rather than an effort ladder, but it is
        // the provider's own ordered set of reasoning settings, so it is reported as
        // the native levels and the normalized ladder maps onto it.
        levels: thinkingSupported ? [...NATIVE_THINKING_LEVELS] : null,
        per_message: true,
      },
      // `search` is a chat_type, not a model flag: a model can search when its
      // meta.chat_type includes "search". capabilities.search agrees but is absent on
      // several models that do list the chat type, so the chat type decides.
      web_search: { supported: chatTypes.includes(CHAT_TYPE_SEARCH), per_message: true },
      deep_research: { supported: chatTypes.includes(CHAT_TYPE_DEEP_RESEARCH) },
      vision: { supported: capabilities.vision === true },
      code_interpreter: { supported: (meta.mcp ?? []).includes(CODE_INTERPRETER_TOOL) },
    },
  };
};

/**
 * Reads the live model list and site config on every call.
 *
 * `/api/models` is served unwrapped (a bare `{data:[…]}` with no success/code
 * envelope) and is not auth-gated — probed live, a bogus bearer still returns the
 * full list — so it goes through `apiRaw`. Verified against the rendered picker:
 * all 18 entries appear, in the same order, so nothing is filtered here. The picker
 * preselects the first entry, which is what `is_default` marks.
 */
export const getBootstrap = async (): Promise<QwenBootstrap> => {
  const [payload, config] = await Promise.all([apiRaw<{ data?: RawModel[] }>('/models'), apiRaw<RawConfig>('/config')]);
  const rawModels = (payload?.data ?? []).filter(model => typeof model.id === 'string');
  if (rawModels.length === 0)
    throw new ToolError('Qwen returned no models. Reload https://chat.qwen.ai and try again.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });

  const defaultModelId = rawModels[0]?.id ?? '';
  return {
    models: rawModels.map(model => toModel(model, model.id === defaultModelId)),
    defaultModelId,
    toolsByModel: new Map(rawModels.map(model => [model.id ?? '', model.info?.meta?.mcp ?? []])),
    config: config ?? {},
  };
};

/** Validates `model_id` against the live list *before* anything is sent upstream. */
export const resolveModel = (bootstrap: QwenBootstrap, modelId: string | undefined): NormalizedModel => {
  if (!modelId) {
    const fallback = bootstrap.models.find(model => model.id === bootstrap.defaultModelId) ?? bootstrap.models[0];
    if (!fallback) throw new ToolError('Qwen published no selectable model.', 'UPSTREAM_ERROR', { retryable: true });
    return fallback;
  }
  const match = bootstrap.models.find(model => model.id === modelId);
  if (match) return match;
  throw ToolError.validation(
    `Unknown model_id "${modelId}". Valid ids: ${bootstrap.models.map(model => model.id).join(', ')}.`,
  );
};

/**
 * Maps the normalized minimal|low|medium|high|max ladder onto Qwen's three reasoning
 * modes. Qwen has no numeric effort — `thinking_budget` exists in the payload shape
 * but the composer never sets it — so the ladder collapses onto the mode enum:
 * `minimal → Fast` (reasoning off), `low`/`medium` → `Auto` (the model decides), and
 * `high`/`max` → `Thinking` (reasoning forced on).
 */
export const toThinkingMode = (level: ThinkingLevel): ThinkingMode => {
  if (level === 'minimal') return THINKING_MODE_OFF;
  if (level === 'low' || level === 'medium') return THINKING_MODE_AUTO;
  return THINKING_MODE_ON;
};

/**
 * Resolves the reasoning mode for one turn from both selection params.
 *
 * `thinking` is the boolean toggle (`true → Thinking`, `false → Fast`) and
 * `thinking_level` is the finer ladder. Omitting both leaves Qwen on "Auto", its own
 * default, where the model decides. When the two disagree the call is rejected
 * rather than silently resolved — a caller that asked for `thinking: true` and
 * `thinking_level: "minimal"` has contradicted itself.
 */
export const resolveThinkingMode = (
  model: NormalizedModel,
  thinking: boolean | undefined,
  level: ThinkingLevel | undefined,
): ThinkingMode => {
  if (thinking !== undefined || level !== undefined) {
    if (!model.capabilities.thinking.supported)
      throw ToolError.validation(
        `Model "${model.id}" has no reasoning mode, so thinking / thinking_level cannot be applied. See capabilities.thinking.supported in list_models.`,
      );
  }
  const fromBoolean = thinking === undefined ? undefined : thinking ? THINKING_MODE_ON : THINKING_MODE_OFF;
  const fromLevel = level === undefined ? undefined : toThinkingMode(level);
  if (fromBoolean !== undefined && fromLevel !== undefined && fromBoolean !== fromLevel)
    throw ToolError.validation(
      `thinking: ${thinking} maps to Qwen mode "${fromBoolean}" but thinking_level: "${level}" maps to "${fromLevel}". Pass one or the other, or make them agree.`,
    );
  return fromLevel ?? fromBoolean ?? THINKING_MODE_AUTO;
};

/** Maps the normalized ladder onto deep research's own two-rung Normal|Advanced effort. */
export const toResearchMode = (level: ThinkingLevel | undefined): string =>
  level === 'high' || level === 'max' ? RESEARCH_MODE_ADVANCED : RESEARCH_MODE_NORMAL;

export const assertSupportsChatType = (model: NormalizedModel, chatType: string): void => {
  if (chatType === CHAT_TYPE_SEARCH && !model.capabilities.web_search.supported)
    throw ToolError.validation(
      `Model "${model.id}" cannot search the web — its meta.chat_type does not list "search". See capabilities.web_search in list_models.`,
    );
  if (chatType === CHAT_TYPE_DEEP_RESEARCH && !model.capabilities.deep_research.supported)
    throw ToolError.validation(
      `Model "${model.id}" does not offer deep research — its meta.chat_type does not list "deep_research". See capabilities.deep_research in list_models.`,
    );
};

export const assertToolsSupported = (bootstrap: QwenBootstrap, model: NormalizedModel, tools: string[]): void => {
  const available = bootstrap.toolsByModel.get(model.id) ?? [];
  const unknown = tools.filter(name => !available.includes(name));
  if (unknown.length > 0)
    throw ToolError.validation(
      `Model "${model.id}" does not publish MCP tool(s) ${unknown.join(', ')}. Valid tools for this model: ${
        available.join(', ') || '(none)'
      }.`,
    );
};
