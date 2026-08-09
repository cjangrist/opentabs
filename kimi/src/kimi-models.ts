import { ToolError } from '@opentabs-dev/plugin-sdk';
import { callRpc } from './kimi-api.js';
import type { NormalizedModel, ThinkingLevel } from './tools/normalized-schemas.js';

// --- Raw GetAvailableModels payload ---

interface RawReasoningEffortOption {
  effort?: string;
  displayName?: string;
  description?: string;
}

interface RawContextLengthOption {
  contextLength?: string;
  displayName?: string;
  available?: boolean;
  minMembershipLevel?: string;
}

interface RawAvailableModel {
  scenario?: string;
  key?: string;
  displayName?: string;
  description?: string;
  kimiPlusId?: string;
  /** TYPE_NORMAL vs TYPE_ULTRA — the ONLY thing separating K3 from K3 Swarm. */
  agentMode?: string;
  reasoningEffortOptions?: RawReasoningEffortOption[];
  defaultReasoningEffort?: string;
  contextLengthOptions?: RawContextLengthOption[];
  defaultContextLength?: string;
  switchableTo?: string[];
}

interface GetAvailableModelsResponse {
  availableModels?: RawAvailableModel[];
  /** Wrapped in an object by the gateway, e.g. `{ "scenario": "SCENARIO_K2D5" }`. */
  defaultScenario?: { scenario?: string };
}

/** Everything the Chat RPC needs to address one model, kept beside the normalized row. */
export interface KimiModelRuntime {
  id: string;
  scenario: string;
  kimiPlusId: string;
  agentMode: string;
  /** Native reasoning-effort ids, coarsest first, as the gateway published them. */
  efforts: string[];
  defaultEffort: string;
  contextLength: string;
}

export interface KimiModelCatalog {
  models: NormalizedModel[];
  runtimeById: Record<string, KimiModelRuntime>;
  defaultModelId: string | null;
}

/**
 * "REASONING_EFFORT_NONE" is Kimi's off switch, not a level: the picker renders
 * the remaining options as the thinking ladder and shows NONE as "Standard" on
 * Instant, where thinking is simply off.
 */
export const EFFORT_NONE = 'REASONING_EFFORT_NONE';

const NATIVE_EFFORT_ORDER = [
  EFFORT_NONE,
  'REASONING_EFFORT_LOW',
  'REASONING_EFFORT_MEDIUM',
  'REASONING_EFFORT_HIGH',
  'REASONING_EFFORT_MAX',
];

const orderEfforts = (efforts: string[]): string[] =>
  [...new Set(efforts)].sort((left, right) => NATIVE_EFFORT_ORDER.indexOf(left) - NATIVE_EFFORT_ORDER.indexOf(right));

/**
 * Parses the live picker payload into SPEC §4 rows.
 *
 * Verified against the rendered model picker: the three ids here (k2d6, k3,
 * k3-agent-ultra) are exactly the three entries kimi.com renders, with the same
 * display names, descriptions and effort ladders ("Standard/High" on Instant,
 * "Standard/High/Max" on K3 and K3 Swarm).
 */
export const parseModels = (raw: GetAvailableModelsResponse): KimiModelCatalog => {
  const defaultScenario = raw.defaultScenario?.scenario ?? '';
  const models: NormalizedModel[] = [];
  const runtimeById: Record<string, KimiModelRuntime> = {};
  let defaultModelId: string | null = null;

  for (const row of raw.availableModels ?? []) {
    const id = row.key;
    if (!id) continue;

    const nativeEfforts = orderEfforts(
      (row.reasoningEffortOptions ?? []).map(option => option.effort ?? '').filter(Boolean),
    );
    const thinkingLevels = nativeEfforts.filter(effort => effort !== EFFORT_NONE);
    const contextOption = (row.contextLengthOptions ?? []).find(
      option => option.contextLength === row.defaultContextLength,
    );

    runtimeById[id] = {
      id,
      scenario: row.scenario ?? '',
      kimiPlusId: row.kimiPlusId ?? '',
      agentMode: row.agentMode ?? '',
      efforts: nativeEfforts,
      defaultEffort: row.defaultReasoningEffort ?? nativeEfforts[0] ?? EFFORT_NONE,
      contextLength: row.defaultContextLength ?? '',
    };

    // The gateway marks the default by scenario, and K3 / K3 Swarm share one
    // scenario — so the first match wins, matching the picker's own highlight.
    const isDefault = defaultModelId === null && row.scenario === defaultScenario;
    if (isDefault) defaultModelId = id;

    models.push({
      id,
      display_name: row.displayName ?? id,
      description: row.description ?? '',
      is_default: isDefault,
      // Every model the gateway publishes for this account is selectable in the
      // picker; Kimi ships no "listed but locked" flag on the model itself.
      is_available: true,
      // Tier gating rides on the context-length option, not the model.
      requires_subscription: contextOption?.minMembershipLevel ?? null,
      // Kimi publishes no numeric context window — only opaque size classes
      // (CONTEXT_LENGTH_L / _XL), so a number here would be invented.
      context_window: null,
      capabilities: {
        thinking: {
          supported: thinkingLevels.length > 0,
          levels: thinkingLevels.length > 0 ? thinkingLevels : null,
          per_message: true,
        },
        web_search: { supported: true, per_message: true },
        // Deep Research is the "deep-researcher" kimiPlus, which runs on the
        // agentic SCENARIO_OK_COMPUTER stack — Instant cannot host it.
        deep_research: { supported: row.scenario === 'SCENARIO_OK_COMPUTER' },
        vision: { supported: true },
        // The agentic scenario is the one that exposes shell / file tools.
        code_interpreter: { supported: row.scenario === 'SCENARIO_OK_COMPUTER' },
      },
    });
  }

  return { models, runtimeById, defaultModelId };
};

export const getModelCatalog = async (): Promise<KimiModelCatalog> =>
  parseModels(await callRpc<GetAvailableModelsResponse>('kimi.gateway.config.v1.ConfigService/GetAvailableModels', {}));

/**
 * Maps Kimi's scenario enum back to a model id, for reading a model off a chat.
 *
 * This is lossy and irreducibly so: K3 and K3 Swarm share BOTH the scenario and
 * the kimiPlus id, differing only in the `agent_mode` field on the request — and
 * `GetChat.lastRequest` records the scenario without it (verified live on a chat
 * sent with agent_mode TYPE_ULTRA). The FIRST model the picker publishes for a
 * scenario therefore wins, so a K3 Swarm conversation reads back as "k3".
 */
export const scenarioToModelId = (catalog: KimiModelCatalog): Map<string, string> => {
  const map = new Map<string, string>();
  for (const model of catalog.models) {
    const scenario = catalog.runtimeById[model.id]?.scenario;
    if (scenario && !map.has(scenario)) map.set(scenario, model.id);
  }
  return map;
};

// --- Selection (SPEC §4) ---

const listValidIds = (catalog: KimiModelCatalog): string => catalog.models.map(model => model.id).join(', ');

/** Validates `model_id` against the live list BEFORE any request is sent. */
export const resolveModelId = (catalog: KimiModelCatalog, modelId: string | undefined): string => {
  if (!modelId) {
    const fallback = catalog.defaultModelId ?? catalog.models[0]?.id;
    if (!fallback)
      throw new ToolError(
        'Kimi published no selectable models — reload https://www.kimi.com and try again.',
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      );
    return fallback;
  }
  if (!catalog.runtimeById[modelId])
    throw ToolError.validation(`Unknown model_id "${modelId}". Valid ids: ${listValidIds(catalog)}`);
  return modelId;
};

/**
 * Kimi's native ladder is LOW < MEDIUM < HIGH < MAX and the published subset
 * differs per model (Instant offers LOW only; K3 offers LOW/HIGH/MAX). The
 * normalized ladder maps by name and, when a model does not publish the named
 * step, walks DOWN to the nearest one it does, only walking up when nothing
 * lower exists.
 */
const NORMALIZED_TO_NATIVE: Record<ThinkingLevel, string> = {
  minimal: 'REASONING_EFFORT_LOW',
  low: 'REASONING_EFFORT_LOW',
  medium: 'REASONING_EFFORT_MEDIUM',
  high: 'REASONING_EFFORT_HIGH',
  max: 'REASONING_EFFORT_MAX',
};

export const mapThinkingLevel = (level: ThinkingLevel, efforts: string[]): string => {
  const target = NORMALIZED_TO_NATIVE[level];
  if (efforts.includes(target)) return target;
  const targetIndex = NATIVE_EFFORT_ORDER.indexOf(target);
  const available = efforts
    .map(effort => ({ effort, index: NATIVE_EFFORT_ORDER.indexOf(effort) }))
    .filter(entry => entry.index > 0)
    .sort((left, right) => left.index - right.index);
  const below = [...available].reverse().find(entry => entry.index <= targetIndex);
  const chosen = below ?? available[0];
  if (!chosen) throw ToolError.validation('This model exposes no reasoning-effort levels.');
  return chosen.effort;
};

export interface ThinkingSelection {
  thinking: boolean;
  reasoningEffort: string;
}

/**
 * Translates the normalized `thinking` / `thinking_level` pair onto Kimi's
 * `options.thinking` + `options.reasoning_effort`, raising VALIDATION_ERROR
 * rather than silently ignoring a control the model does not have.
 */
export const resolveThinking = (
  runtime: KimiModelRuntime,
  thinking: boolean | undefined,
  level: ThinkingLevel | undefined,
): ThinkingSelection => {
  const levels = runtime.efforts.filter(effort => effort !== EFFORT_NONE);

  if (levels.length === 0 && (thinking === true || level !== undefined))
    throw ToolError.validation(
      `Model "${runtime.id}" publishes no reasoning-effort levels, so thinking cannot be enabled for it. ` +
        'See list_models().capabilities.thinking.',
    );

  if (thinking === false) {
    if (!runtime.efforts.includes(EFFORT_NONE))
      throw ToolError.validation(
        `Model "${runtime.id}" cannot turn thinking off — its picker offers only ${levels.join(', ')}. ` +
          'Omit thinking, or choose a model whose ladder includes REASONING_EFFORT_NONE.',
      );
    if (level !== undefined)
      throw ToolError.validation('thinking:false contradicts thinking_level — pass one or the other.');
    return { thinking: false, reasoningEffort: EFFORT_NONE };
  }

  if (level !== undefined) return { thinking: true, reasoningEffort: mapThinkingLevel(level, runtime.efforts) };
  if (thinking === true)
    return {
      thinking: true,
      reasoningEffort:
        runtime.defaultEffort !== EFFORT_NONE ? runtime.defaultEffort : (levels[levels.length - 1] ?? EFFORT_NONE),
    };

  // Neither given: follow the model's own published default, exactly as the
  // composer does when the user never touches the effort selector.
  return { thinking: runtime.defaultEffort !== EFFORT_NONE, reasoningEffort: runtime.defaultEffort };
};
