import { ToolError, sleep } from '@opentabs-dev/plugin-sdk';
import type { NormalizedModel, ThinkingLevel } from './tools/normalized-schemas.js';

const MODE_TEST_ID = /^composer-chat-mode-(.+)-button$/;
const MODE_SMART = 'smart';
const MODE_REASONING = 'reasoning';
const MODE_SEARCH = 'search';

const splitLabel = (label: string, fallback: string): { name: string; description: string } => {
  const separator = label.indexOf('. ');
  if (separator < 0) return { name: label || fallback, description: '' };
  return { name: label.slice(0, separator), description: label.slice(separator + 2) };
};

/** Opens the live composer picker briefly so model ids, labels and availability come from the current site. */
export const getModels = async (): Promise<NormalizedModel[]> => {
  const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')).find(
    button => MODE_TEST_ID.test(button.dataset.testid ?? ''),
  );
  if (!trigger)
    throw ToolError.validation(
      'Copilot has no mode picker on this page. Open https://copilot.microsoft.com/ or a chat, then retry.',
      'VALIDATION_ERROR',
    );

  const wasOpen = trigger.getAttribute('aria-expanded') === 'true';
  if (!wasOpen) {
    trigger.click();
    await sleep(50);
  }

  try {
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"][data-testid^="composer-chat-mode-"]'),
    );
    const models = buttons.flatMap(button => {
      const match = (button.dataset.testid ?? '').match(MODE_TEST_ID);
      if (!match?.[1]) return [];
      const id = match[1];
      const label = splitLabel(button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '', id);
      const isReasoning = id === MODE_REASONING;
      const isSearch = id === MODE_SEARCH;
      return [
        {
          id,
          display_name: label.name,
          description: label.description,
          is_default: id === MODE_SMART,
          is_available: !button.disabled && button.getAttribute('aria-disabled') !== 'true',
          requires_subscription: button.disabled ? 'COPILOT_PRO' : null,
          context_window: null,
          capabilities: {
            thinking: { supported: isReasoning, levels: isReasoning ? null : null, per_message: true },
            web_search: { supported: true, per_message: isSearch },
            deep_research: { supported: id === MODE_SMART },
            vision: { supported: true },
            code_interpreter: { supported: false },
          },
        } satisfies NormalizedModel,
      ];
    });
    if (models.length === 0)
      throw new ToolError('Copilot opened its mode picker but published no recognizable entries.', 'UPSTREAM_ERROR', {
        category: 'internal',
        retryable: true,
      });
    return models;
  } finally {
    if (!wasOpen && trigger.getAttribute('aria-expanded') === 'true') trigger.click();
  }
};

export interface ModeRequest {
  modelId?: string;
  thinking?: boolean;
  thinkingLevel?: ThinkingLevel;
  search?: boolean;
  tools?: string[];
}

/** Resolves normalized controls onto Copilot's mutually-exclusive native mode picker. */
export const resolveMode = async (request: ModeRequest): Promise<string> => {
  if (request.tools !== undefined && request.tools.length > 0)
    throw ToolError.validation(
      `Copilot exposes no per-message tool allowlist, so tools=${JSON.stringify(request.tools)} cannot be honoured.`,
      'VALIDATION_ERROR',
    );
  if (request.thinking === true && request.search === true)
    throw ToolError.validation(
      'Copilot cannot select Think deeper and Search simultaneously because they are distinct native modes.',
      'VALIDATION_ERROR',
    );

  const models = await getModels();
  const available = models.filter(model => model.is_available);
  const validIds = available.map(model => model.id);
  let implied: string | undefined;
  if (request.thinking === true || request.thinkingLevel !== undefined) implied = MODE_REASONING;
  if (request.search === true) implied = MODE_SEARCH;

  const selected = request.modelId ?? implied ?? MODE_SMART;
  if (!validIds.includes(selected))
    throw ToolError.validation(
      `Unknown or unavailable Copilot mode "${selected}". Valid ids: ${validIds.join(', ')}.`,
      'VALIDATION_ERROR',
    );
  if (request.modelId && implied && request.modelId !== implied)
    throw ToolError.validation(
      `model_id "${request.modelId}" conflicts with the requested ${implied === MODE_REASONING ? 'thinking' : 'search'} control.`,
      'VALIDATION_ERROR',
    );
  if (request.thinking === false && selected === MODE_REASONING)
    throw ToolError.validation('model_id "reasoning" conflicts with thinking:false.', 'VALIDATION_ERROR');
  if (request.search === false && selected === MODE_SEARCH)
    throw ToolError.validation('model_id "search" conflicts with search:false.', 'VALIDATION_ERROR');
  return selected;
};

export const resolveResearchModel = async (modelId: string | undefined): Promise<void> => {
  const models = await getModels();
  const selected = modelId ?? MODE_SMART;
  if (!models.some(model => model.id === selected && model.is_available))
    throw ToolError.validation(
      `Unknown or unavailable Copilot mode "${selected}". Valid ids: ${models
        .filter(model => model.is_available)
        .map(model => model.id)
        .join(', ')}.`,
      'VALIDATION_ERROR',
    );
  if (selected !== MODE_SMART)
    throw ToolError.validation(
      `Copilot Deep Research always uses its dedicated native "research" mode; model_id "${selected}" cannot be honoured. Omit model_id or pass "smart" as the default-mode compatibility value.`,
      'VALIDATION_ERROR',
    );
};
