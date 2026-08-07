import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api, getOrgId } from './claude-api.js';
import type { NormalizedModel, ThinkingLevel } from './tools/normalized-schemas.js';

// --- Bootstrap payload ---

interface RawModelCapabilities {
  compass?: boolean;
  gsuite_tools?: boolean;
  mm_images?: boolean;
  mm_pdf?: boolean;
  web_search?: boolean;
}

interface RawEffortOption {
  id?: string;
  name?: string;
  recommended?: boolean;
}

interface RawSelectorModel {
  id?: string;
  name?: string;
  short_name?: string;
  description?: string;
  notice_text?: string;
  /** 'main' → top of the picker, 'overflow' → behind "More models", 'deprecated' → not rendered. */
  section?: string;
  capabilities?: RawModelCapabilities;
  thinking?: {
    type?: 'effort_and_mode' | 'mode' | 'none';
    effort_options?: RawEffortOption[];
    mode_options?: { id?: string }[];
  };
  hard_limit?: number;
  quick_select?: boolean;
}

interface RawBootstrap {
  account?: {
    uuid?: string;
    email_address?: string;
    full_name?: string | null;
    display_name?: string | null;
    created_at?: string;
    is_verified?: boolean;
    settings?: Record<string, unknown>;
    memberships?: { organization?: { uuid?: string } }[];
  };
  model_selector_config?: { id?: string; models?: RawSelectorModel[] }[];
  model_selector_state?: {
    id?: string;
    model?: string;
    thinking?: { type?: string; effort?: string; mode?: string };
  }[];
  claude_ai_available_models?: { models?: { model_id?: string; minimum_tier?: string }[] };
}

export interface ClaudeBootstrap {
  raw: RawBootstrap;
  models: NormalizedModel[];
  /** Native thinking shape per model id, needed to translate `thinking` / `thinking_level`. */
  thinkingByModel: Record<string, { type: string; efforts: string[]; modes: string[] }>;
  defaultModelId: string | null;
  defaultThinking: { effort?: string; mode?: string } | null;
}

export const fetchBootstrap = async (): Promise<RawBootstrap> =>
  api<RawBootstrap>(`/bootstrap/${getOrgId()}/app_start`);

/**
 * claude.ai publishes the picker twice. `claude_ai_bootstrap_models_config` (under
 * the *active* membership — memberships[] is not ordered by active org) carries
 * only `inactive` / `overflow` booleans, while `model_selector_config` carries the
 * section, per-model capabilities and the real effort ladder. We drive from
 * `model_selector_config` and treat `section` as authoritative:
 *
 *   section 'main'       → rendered at the top of the picker
 *   section 'overflow'   → rendered under "More models"
 *   section 'deprecated' → not rendered at all  ⇒ is_available: false
 *
 * Verified against the rendered picker: the nine non-deprecated ids are exactly
 * the nine entries the expanded picker shows.
 */
export const parseBootstrap = (raw: RawBootstrap): ClaudeBootstrap => {
  const chatConfig = (raw.model_selector_config ?? []).find(section => section.id === 'chat');
  const rows = chatConfig?.models ?? [];
  const chatState = (raw.model_selector_state ?? []).find(state => state.id === 'chat');
  const defaultModelId = chatState?.model ?? null;
  const tiers = new Map(
    (raw.claude_ai_available_models?.models ?? []).map(model => [model.model_id ?? '', model.minimum_tier ?? null]),
  );

  const thinkingByModel: ClaudeBootstrap['thinkingByModel'] = {};
  const models: NormalizedModel[] = [];

  for (const row of rows) {
    const id = row.id;
    if (!id) continue;

    const thinkingType = row.thinking?.type ?? 'none';
    const efforts = (row.thinking?.effort_options ?? []).map(option => option.id ?? '').filter(Boolean);
    const modes = (row.thinking?.mode_options ?? []).map(option => option.id ?? '').filter(Boolean);
    thinkingByModel[id] = { type: thinkingType, efforts, modes };

    const capabilities = row.capabilities ?? {};
    const tier = tiers.get(id) ?? null;

    models.push({
      id,
      display_name: row.name ?? id,
      description: row.description ?? row.notice_text ?? '',
      is_default: id === defaultModelId,
      is_available: row.section !== 'deprecated',
      requires_subscription: tier && tier !== 'free' ? tier : null,
      context_window: row.hard_limit ?? null,
      capabilities: {
        thinking: {
          supported: thinkingType !== 'none',
          levels: efforts.length > 0 ? efforts : null,
          per_message: true,
        },
        web_search: { supported: capabilities.web_search === true, per_message: true },
        // "compass" is claude.ai's internal name for the Research feature — the
        // composer's Research toggle sets compass_mode and the model config gates
        // it with capabilities.compass.
        deep_research: { supported: capabilities.compass === true },
        vision: { supported: capabilities.mm_images === true },
        // claude.ai publishes no per-model code-interpreter flag: the Analysis
        // (`repl`) tool is offered on every completion. Legacy models carry an
        // all-false capability set and get no tools at all, so key off that.
        code_interpreter: { supported: capabilities.web_search === true },
      },
    });
  }

  return {
    raw,
    models,
    thinkingByModel,
    defaultModelId,
    defaultThinking: chatState?.thinking ?? null,
  };
};

export const getBootstrap = async (): Promise<ClaudeBootstrap> => parseBootstrap(await fetchBootstrap());

// --- Model / thinking selection ---

const listValidIds = (bootstrap: ClaudeBootstrap): string =>
  bootstrap.models
    .filter(model => model.is_available)
    .map(model => model.id)
    .join(', ');

/** Validates `model_id` against the live list BEFORE any request is sent (SPEC §4). */
export const resolveModelId = (bootstrap: ClaudeBootstrap, modelId: string | undefined): string => {
  if (!modelId) {
    const fallback = bootstrap.defaultModelId ?? bootstrap.models.find(model => model.is_available)?.id;
    if (!fallback)
      throw new ToolError(
        'Claude published no selectable models — reload https://claude.ai and try again.',
        'UPSTREAM_ERROR',
        { category: 'internal', retryable: true },
      );
    return fallback;
  }

  const match = bootstrap.models.find(model => model.id === modelId);
  if (!match) throw ToolError.validation(`Unknown model_id "${modelId}". Valid ids: ${listValidIds(bootstrap)}`);
  if (!match.is_available)
    throw ToolError.validation(
      `Model "${modelId}" is deprecated on claude.ai and is not offered by the model picker. Valid ids: ${listValidIds(bootstrap)}`,
    );
  return modelId;
};

/**
 * Claude's native effort ladder is low < medium < high < xhigh < max, and the
 * subset differs per model. The normalized ladder maps by name; when a model does
 * not offer the named step we walk DOWN to the nearest one it does offer, and only
 * walk up when nothing lower exists.
 */
const NATIVE_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const NORMALIZED_TO_NATIVE: Record<ThinkingLevel, string> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
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

export interface ThinkingSelection {
  thinking_mode: string | undefined;
  effort: string | undefined;
}

/**
 * Translates the normalized `thinking` / `thinking_level` pair onto Claude's
 * `thinking_mode` + `effort` completion fields, raising VALIDATION_ERROR rather
 * than silently ignoring a control the model does not have.
 */
export const resolveThinking = (
  bootstrap: ClaudeBootstrap,
  modelId: string,
  thinking: boolean | undefined,
  level: ThinkingLevel | undefined,
): ThinkingSelection => {
  const native = bootstrap.thinkingByModel[modelId] ?? { type: 'none', efforts: [], modes: [] };

  if (native.type === 'none' && (thinking !== undefined || level !== undefined))
    throw ToolError.validation(
      `Model "${modelId}" does not support extended thinking — omit thinking / thinking_level or choose another model.`,
    );

  if (level !== undefined && native.efforts.length === 0)
    throw ToolError.validation(
      `Model "${modelId}" has an on/off thinking toggle with no effort levels — pass thinking:true|false instead of thinking_level. ` +
        'Check list_models().capabilities.thinking.levels.',
    );

  let mode: string | undefined;
  if (thinking !== undefined) {
    const wanted = thinking ? (native.modes.includes('auto') ? 'auto' : 'extended') : 'off';
    if (!native.modes.includes(wanted))
      throw ToolError.validation(
        `Model "${modelId}" does not offer thinking_mode "${wanted}" (it offers: ${native.modes.join(', ') || 'none'}).`,
      );
    mode = wanted;
  }

  const effort = level === undefined ? undefined : mapThinkingLevel(level, native.efforts);
  // Claude ignores `effort` when thinking is off, so do not send a contradiction.
  return { thinking_mode: mode, effort: mode === 'off' ? undefined : effort };
};
