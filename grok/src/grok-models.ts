import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api } from './grok-api.js';
import type { NormalizedModel, ThinkingLevel } from './tools/normalized-schemas.js';

interface RawMode {
  id?: string;
  title?: string;
  description?: string;
  badgeText?: string;
  availability?: {
    available?: Record<string, never>;
    requiresUpgrade?: { message?: string; minimumSubscriptionTier?: string };
  };
}

interface RawModes {
  modes?: RawMode[];
  defaultModeId?: string;
}

const THINKING_MODES = new Set(['expert', 'heavy']);
export const DEFAULT_THINKING_MODE = 'expert';

const mapMode = (mode: RawMode, defaultModeId: string): NormalizedModel => {
  const id = mode.id ?? '';
  const available = mode.availability?.available !== undefined;
  const isChatMode = id !== 'build';
  return {
    id,
    display_name: mode.title ?? '',
    description: mode.description ?? '',
    is_default: id === defaultModeId,
    is_available: available,
    requires_subscription: available ? null : (mode.availability?.requiresUpgrade?.minimumSubscriptionTier ?? null),
    context_window: null,
    capabilities: {
      thinking: {
        supported: THINKING_MODES.has(id),
        levels: null,
        per_message: true,
      },
      web_search: { supported: isChatMode, per_message: true },
      deep_research: { supported: id === DEFAULT_THINKING_MODE },
      vision: { supported: isChatMode },
      code_interpreter: { supported: isChatMode },
    },
  };
};

export const getModels = async (): Promise<NormalizedModel[]> => {
  const payload = await api<RawModes>('/modes', { method: 'POST', body: { locale: 'en' } });
  const models = (payload.modes ?? [])
    .filter(mode => typeof mode.id === 'string' && mode.id.length > 0)
    .map(mode => mapMode(mode, payload.defaultModeId ?? ''));
  if (models.length === 0)
    throw new ToolError('Grok returned no composer modes. Reload https://grok.com and try again.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return models;
};

const selectable = (models: NormalizedModel[]): NormalizedModel[] => models.filter(model => model.is_available);

const requireSelectableMode = (models: NormalizedModel[], modelId: string): NormalizedModel => {
  const model = models.find(candidate => candidate.id === modelId);
  const valid = selectable(models).map(candidate => candidate.id);
  if (!model)
    throw ToolError.validation(
      `Unknown Grok model "${modelId}". Call list_models for valid ids (${valid.join(', ')}).`,
      'VALIDATION_ERROR',
    );
  if (!model.is_available)
    throw ToolError.validation(
      `Grok lists "${modelId}" but this account cannot select it${model.requires_subscription ? ` (requires ${model.requires_subscription})` : ''}. Available ids: ${valid.join(', ')}.`,
      'VALIDATION_ERROR',
    );
  return model;
};

export interface ModeRequest {
  modelId?: string;
  thinking?: boolean;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
}

export const resolveMode = async (request: ModeRequest): Promise<NormalizedModel> => {
  if (request.tools && request.tools.length > 0)
    throw new ToolError(
      'Grok does not expose an allowlist for its built-in tools. Omit tools; Expert/Auto choose native tools autonomously.',
      'UNSUPPORTED',
      { category: 'validation', retryable: false },
    );
  if (request.thinking === false && request.thinkingLevel !== undefined)
    throw ToolError.validation(
      'thinking:false conflicts with thinking_level. Omit thinking_level or enable thinking.',
      'VALIDATION_ERROR',
    );

  const models = await getModels();
  if (request.modelId) {
    const selected = requireSelectableMode(models, request.modelId);
    if (selected.id === 'auto' && (request.thinking !== undefined || request.thinkingLevel !== undefined))
      throw ToolError.validation(
        'Grok Auto chooses Fast or Expert dynamically, so it cannot guarantee an explicit thinking setting. Omit model_id or select fast/expert directly.',
        'VALIDATION_ERROR',
      );
    const impliesThinking = request.thinking === true || request.thinkingLevel !== undefined;
    if (impliesThinking && !selected.capabilities.thinking.supported)
      throw ToolError.validation(
        `Grok mode "${selected.id}" is not a reasoning mode. Pass model_id:"expert", or omit model_id and use thinking:true.`,
        'VALIDATION_ERROR',
      );
    if (request.thinking === false && selected.capabilities.thinking.supported)
      throw ToolError.validation(
        `Grok mode "${selected.id}" always reasons. Pass model_id:"fast", or omit model_id and use thinking:false.`,
        'VALIDATION_ERROR',
      );
    return selected;
  }

  const desired =
    request.thinking === true || request.thinkingLevel !== undefined
      ? DEFAULT_THINKING_MODE
      : request.thinking === false
        ? 'fast'
        : undefined;
  if (desired) {
    const selected = models.find(model => model.id === desired && model.is_available);
    if (selected) return selected;
    throw ToolError.validation(
      `Grok's "${desired}" mode is not available to this account. Available ids: ${selectable(models)
        .map(model => model.id)
        .join(', ')}.`,
      'VALIDATION_ERROR',
    );
  }

  const fallback = models.find(model => model.is_default && model.is_available) ?? selectable(models)[0];
  if (!fallback)
    throw new ToolError('Grok published no selectable composer mode.', 'UPSTREAM_ERROR', {
      category: 'internal',
      retryable: true,
    });
  return fallback;
};

export const isThinkingMode = (modelId: string): boolean => THINKING_MODES.has(modelId);
