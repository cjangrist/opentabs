import { api } from './chatgpt-api.js';

interface RawSystemHint {
  system_hint?: string;
  name?: string;
  description?: string;
  short_label?: string;
  action_label?: string;
  required_conversation_modes?: string[];
}

interface RawSystemHintsResponse {
  system_hints?: RawSystemHint[];
}

export const DEEP_RESEARCH_HINT = 'plugin:connector_openai_deep_research';

/**
 * The composer's "+" menu is built from /backend-api/system_hints. Whether Deep
 * research exists for this account is therefore a live fact, not an assumption —
 * `mode=plugins` is where chatgpt.com publishes it.
 */
export const fetchSystemHints = async (mode: 'basic' | 'plugins'): Promise<RawSystemHint[]> => {
  const data = await api<RawSystemHintsResponse>('/system_hints', { query: { mode } });
  return data.system_hints ?? [];
};

export interface DeepResearchAvailability {
  supported: boolean;
  label: string | null;
}

export const getDeepResearchAvailability = async (): Promise<DeepResearchAvailability> => {
  const hints = await fetchSystemHints('plugins');
  const hint = hints.find(candidate => candidate.system_hint === DEEP_RESEARCH_HINT);
  return { supported: hint !== undefined, label: hint?.action_label ?? hint?.name ?? null };
};
