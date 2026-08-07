import { ToolError, getCurrentUrl, sleep, waitUntil } from '@opentabs-dev/plugin-sdk';
import type { ModelCatalog } from './chatgpt-models.js';

// ---------------------------------------------------------------------------
// Sending a message on chatgpt.com
// ---------------------------------------------------------------------------
//
// POST /backend-api/f/conversation is gated by OpenAI's Sentinel anti-automation
// layer: without a matching openai-sentinel-{chat-requirements,proof,turnstile}
// header triple it answers 403 "Unusual activity has been detected from your
// device", and those tokens are produced by a proof-of-work plus a Cloudflare
// Turnstile challenge bound to the page session. Verified live: the same body
// the web app sends is rejected when posted directly, with and without the full
// oai-* header set.
//
// So this plugin does not re-implement that gate. It drives the page's OWN
// composer — the app mints its own tokens and performs the send exactly as it
// does for a human. Everything below is DOM automation and is therefore the
// most fragile part of the plugin; every step fails loudly rather than
// returning a plausible empty answer.

const COMPOSER_SELECTOR = '#prompt-textarea';
const SEND_BUTTON_SELECTOR = '[data-testid="send-button"]';
const STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]';
const PRESET_BUTTON_PATTERN = /^(Instant|Medium|High|Extra High|Pro|Auto|Thinking|Light|Standard|Extended|Heavy)$/;

/** The adapter aborts a tool handler at 25s, so stop waiting well before that. */
export const COMPLETION_WAIT_MS = 18_000;

const composerError = (message: string): ToolError =>
  new ToolError(
    `${message} chatgpt.com's send path is driven through the page composer because POST /backend-api/f/conversation ` +
      'is blocked by OpenAI Sentinel; a layout change on chatgpt.com breaks it. See list_capabilities().',
    'UPSTREAM_ERROR',
    { category: 'internal', retryable: true },
  );

const dispatchClick = (element: Element): void => {
  const rect = element.getBoundingClientRect();
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height / 2,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
  };
  element.dispatchEvent(new PointerEvent('pointerover', { ...base, buttons: 0 }));
  element.dispatchEvent(new MouseEvent('mouseover', { ...base, buttons: 0 }));
  element.dispatchEvent(new PointerEvent('pointermove', { ...base, buttons: 0 }));
  element.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
  element.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
  element.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
  element.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
  (element as HTMLElement).click();
};

const menuItems = (): HTMLElement[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="menuitem"],[role="menuitemradio"],[role="option"],[data-radix-collection-item]',
    ),
  );

const labelOf = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();

const findMenuItem = (label: string): HTMLElement | undefined =>
  menuItems().find(item => labelOf(item) === label || labelOf(item).startsWith(label));

const closeMenus = (): void => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};

/**
 * react-router owns the URL. A real navigation would tear down the adapter
 * mid-handler, so route changes go through the router the page already exposes.
 */
const routerNavigate = async (path: string): Promise<void> => {
  const router = (globalThis as { __reactRouterDataRouter?: { navigate?: (to: string) => Promise<unknown> } })
    .__reactRouterDataRouter;
  if (typeof router?.navigate !== 'function')
    throw composerError('chatgpt.com no longer exposes its react-router instance, so the tab cannot be re-routed.');
  await router.navigate(path);
};

export const currentConversationId = (): string | null =>
  /\/c\/([0-9a-fA-F-]{36})/.exec(getCurrentUrl() ?? '')?.[1] ?? null;

/** Routes the tab to the composer for a new chat or an existing conversation. */
export const openComposer = async (conversationId: string | undefined): Promise<void> => {
  const wanted = conversationId ? `/c/${conversationId}` : '/';
  const path = new URL(getCurrentUrl() ?? 'https://chatgpt.com/').pathname;
  if (path !== wanted) await routerNavigate(wanted);
  try {
    await waitUntil(() => document.querySelector(COMPOSER_SELECTOR) !== null, { interval: 250, timeout: 10_000 });
  } catch {
    throw composerError(`The composer (${COMPOSER_SELECTOR}) never appeared after routing to ${wanted}.`);
  }
};

export interface PickerSelection {
  versionLabel: string;
  presetTitle: string;
}

/**
 * Resolves a model slug + native effort onto the (version, preset) pair the
 * picker renders. A slug the picker cannot reach has no selection and is
 * rejected before anything is typed.
 */
export const resolvePickerSelection = (
  catalog: ModelCatalog,
  modelSlug: string,
  effort: string | undefined,
): PickerSelection => {
  for (const version of catalog.pickerVersions) {
    const matches = version.presets.filter(preset => preset.slug === modelSlug);
    if (matches.length === 0) continue;
    const chosen = effort ? matches.find(preset => preset.effort === effort) : matches[0];
    if (!chosen) continue;
    return { versionLabel: version.label, presetTitle: chosen.title };
  }
  // Versions such as o3 have no presets at all: selecting the version is enough.
  const version = catalog.pickerVersions.find(
    candidate => candidate.presets.length === 0 && candidate.id === modelSlug,
  );
  if (version) return { versionLabel: version.label, presetTitle: '' };
  throw ToolError.validation(
    `Model "${modelSlug}"${effort ? ` at effort "${effort}"` : ''} is not reachable from the chatgpt.com picker. ` +
      `Reachable ids: ${catalog.models.map(model => model.id).join(', ')}`,
  );
};

const openPresetMenu = async (): Promise<void> => {
  closeMenus();
  await sleep(400);
  const button = Array.from(document.querySelectorAll('button')).find(candidate =>
    PRESET_BUTTON_PATTERN.test(labelOf(candidate)),
  );
  if (!button) throw composerError('The composer no longer shows an intelligence-preset button.');
  dispatchClick(button);
  try {
    await waitUntil(() => findMenuItem('Advanced') !== undefined, { interval: 250, timeout: 6000 });
  } catch {
    throw composerError('The intelligence-preset menu never rendered its "Advanced" section.');
  }
};

const clickMenuItem = async (label: string, expectAfter: string): Promise<void> => {
  const item = findMenuItem(label);
  if (!item)
    throw composerError(
      `The preset menu no longer offers "${label}" — it shows: ${menuItems().map(labelOf).join(' / ')}`,
    );
  dispatchClick(item);
  try {
    await waitUntil(() => findMenuItem(expectAfter) !== undefined, { interval: 250, timeout: 6000 });
  } catch {
    throw composerError(
      `"${expectAfter}" never appeared after clicking "${label}" — the picker shows: ${menuItems().map(labelOf).join(' / ')}`,
    );
  }
};

/**
 * Drives the picker so the next send uses `selection`.
 *
 * The menu is two levels deep: "Advanced" expands into a Model row and an
 * Effort row, and each of those opens its own submenu. Version and preset are
 * therefore selected in two separate passes over the menu.
 */
export const applyPickerSelection = async (selection: PickerSelection): Promise<void> => {
  await openPresetMenu();
  await clickMenuItem('Advanced', 'Model');
  await clickMenuItem('Model', selection.versionLabel);
  dispatchClick(findMenuItem(selection.versionLabel) as HTMLElement);
  await sleep(1200);

  if (selection.presetTitle) {
    await openPresetMenu();
    await clickMenuItem('Advanced', 'Effort');
    await clickMenuItem('Effort', selection.presetTitle);
    dispatchClick(findMenuItem(selection.presetTitle) as HTMLElement);
    await sleep(1200);
  }
  closeMenus();
  await sleep(400);
};

/**
 * Writes the prompt into the ProseMirror editor.
 *
 * `execCommand('insertText')` mutates the DOM without ProseMirror noticing (the
 * send button stays hidden), so the text is delivered as a synthetic paste —
 * ProseMirror reads `clipboardData` and never checks `isTrusted`.
 */
export const setComposerText = async (text: string): Promise<void> => {
  const editor = document.querySelector<HTMLElement>(COMPOSER_SELECTOR);
  if (!editor) throw composerError('The composer element is missing.');
  editor.focus();
  const selection = getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', text);
  editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  try {
    await waitUntil(() => document.querySelector(SEND_BUTTON_SELECTOR) !== null, { interval: 200, timeout: 6000 });
  } catch {
    throw composerError('The send button never became available after writing the prompt into the composer.');
  }
};

export const submitComposer = (): void => {
  const button = document.querySelector<HTMLElement>(SEND_BUTTON_SELECTOR);
  if (!button) throw composerError('The send button disappeared before the prompt could be submitted.');
  dispatchClick(button);
};

/**
 * Waits for the send to be accepted. For a new chat that is the URL gaining a
 * conversation id; for a follow-up it is the composer emptying and the stop
 * button appearing.
 */
export const waitForSendAccepted = async (existingConversationId: string | undefined): Promise<string> => {
  if (!existingConversationId) {
    try {
      await waitUntil(() => currentConversationId() !== null, { interval: 300, timeout: 20_000 });
    } catch {
      throw composerError('chatgpt.com never routed to a conversation URL after the prompt was submitted.');
    }
    return currentConversationId() as string;
  }
  try {
    await waitUntil(
      () =>
        document.querySelector(STOP_BUTTON_SELECTOR) !== null ||
        (document.querySelector(COMPOSER_SELECTOR)?.textContent ?? '').trim().length === 0,
      { interval: 300, timeout: 15_000 },
    );
  } catch {
    throw composerError('chatgpt.com never started generating after the prompt was submitted.');
  }
  return existingConversationId;
};

/** True while the page is still streaming a reply. */
export const isGenerating = (): boolean => document.querySelector(STOP_BUTTON_SELECTOR) !== null;

export const waitForGenerationToSettle = async (budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isGenerating()) return true;
    await sleep(500);
  }
  return !isGenerating();
};
