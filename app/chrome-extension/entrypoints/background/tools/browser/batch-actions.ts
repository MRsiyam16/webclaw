import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  resolveToolName,
  type BatchActionItem,
  type BatchActionResult,
  type CaptureNetworkOptions,
} from 'chrome-mcp-shared';
import { DIAGNOSTIC_REFRESH_GUIDANCE, computePerceptiveDelta } from './dom-indexer';
import { executeInPage } from './in-page-engine';
import { waitForPageSettle, waitForNetworkQuiescence } from '@/utils/action-watchdog';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { computeHumanizedPoints } from '@/utils/mouse-trajectory';
import {
  raceCdp as raceCdpBatch,
  DialogOpenedError,
  createDialogInterruptResponse,
} from '@/utils/race-cdp';
import { resolveTargetLocation } from './unified-locator';
import { captureDeltaIfRequested, ensureSnapshotBaseline } from '@/utils/delta-helper';
import { getSubframeViewportOffset } from './interact-index';
import { tabFaviconManager } from './tab-favicon';
import { animateAgentCursor, animateAgentCursorClick } from './agent-cursor';
import { parseUnifiedCoordinate } from '@/utils/coordinate-parser';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import { startActionNetworkCapture } from '@/utils/action-network-capture';
import { performPhysicalFill } from './fill-core';

export interface BatchActionsParams {
  actions: BatchActionItem[];
  tabId?: number;
  windowId?: number;
  waitForSettle?: boolean;
  settleTimeoutMs?: number;
  /** Wait for network requests to settle after actions or batch */
  waitForNetworkQuiescence?: boolean;
  quiescenceTimeoutMs?: number;
  includeDelta?: boolean;
  sessionId?: string;
  sessionContext?: string;
  /** Inline capture of network response triggered during batch execution */
  captureNetwork?: CaptureNetworkOptions;
}

const KEY_ALIASES: Record<string, { key: string; code?: string; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter' },
  return: { key: 'Enter', code: 'Enter' },
  backspace: { key: 'Backspace', code: 'Backspace' },
  delete: { key: 'Delete', code: 'Delete' },
  tab: { key: 'Tab', code: 'Tab' },
  escape: { key: 'Escape', code: 'Escape' },
  esc: { key: 'Escape', code: 'Escape' },
  space: { key: ' ', code: 'Space', text: ' ' },
  pageup: { key: 'PageUp', code: 'PageUp' },
  pagedown: { key: 'PageDown', code: 'PageDown' },
  home: { key: 'Home', code: 'Home' },
  end: { key: 'End', code: 'End' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
};

function resolveKey(token: string): { key: string; code?: string; text?: string } {
  const t = (token || '').toLowerCase();
  if (KEY_ALIASES[t]) return KEY_ALIASES[t];
  if (/^f([1-9]|1[0-2])$/.test(t)) {
    return { key: t.toUpperCase(), code: t.toUpperCase() };
  }
  if (token.length === 1) {
    const upper = token.toUpperCase();
    return { key: token, code: `Key${upper}`, text: token };
  }
  return { key: token, code: token };
}

const KEY_VK_CODES: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Delete: 46,
  Tab: 9,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Meta: 91,
};

function virtualKeyCode(key: string, code?: string): number | undefined {
  if (key in KEY_VK_CODES) return KEY_VK_CODES[key];
  if (/^F([1-9]|1[0-2])$/.test(key)) return 112 + Number(key.slice(1)) - 1;
  if (/^Key[A-Z]$/.test(code || '')) return 65 + (code as string).charCodeAt(3) - 65;
  if (/^Digit[0-9]$/.test(code || '')) return 48 + Number((code as string).slice(5));
  return undefined;
}

interface ModifierDef {
  key: string;
  code: string;
  vk: number;
  mask: number;
}

const MODIFIER_DEFS: Record<string, ModifierDef> = {
  Control: { key: 'Control', code: 'ControlLeft', vk: 17, mask: 2 },
  Meta: { key: 'Meta', code: 'MetaLeft', vk: 91, mask: 4 },
  Alt: { key: 'Alt', code: 'AltLeft', vk: 18, mask: 1 },
  Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16, mask: 8 },
};

const MODIFIER_TOKENS: Record<string, 'Control' | 'Meta' | 'Alt' | 'Shift'> = {
  ctrl: 'Control',
  control: 'Control',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  win: 'Meta',
  windows: 'Meta',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};

export function resolveBatchRefAlias(
  alias: string,
  refs: Map<string, { ref: string; documentToken: number }>,
  currentDocumentToken: number | undefined,
): { ref: string } | { verdict: 'stale_ref'; ref: string } | undefined {
  const captured = refs.get(alias);
  if (!captured) return undefined;
  if (currentDocumentToken === undefined || currentDocumentToken !== captured.documentToken) {
    return { verdict: 'stale_ref', ref: captured.ref };
  }
  return { ref: captured.ref };
}

function parseKeyCombo(rawKey: string): {
  keyDef: { key: string; code?: string; text?: string };
  modifierDefs: ModifierDef[];
  modifiersMask: number;
} {
  const parts = (rawKey || '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  const modifierDefs: ModifierDef[] = [];
  let modifiersMask = 0;
  let mainToken = rawKey || '';
  if (parts.length > 1) {
    mainToken = parts[parts.length - 1];
    for (let i = 0; i < parts.length - 1; i++) {
      const modName = MODIFIER_TOKENS[parts[i].toLowerCase()];
      if (!modName) throw new Error('Unsupported key combo part: ' + parts[i]);
      modifierDefs.push(MODIFIER_DEFS[modName]);
      modifiersMask |= MODIFIER_DEFS[modName].mask;
    }
  }
  return { keyDef: resolveKey(mainToken), modifierDefs, modifiersMask };
}

export class BatchActionsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.BATCH_ACTIONS;

  async execute(args: BatchActionsParams): Promise<ToolResult> {
    const actions = args?.actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      return createErrorResponse('actions parameter must be a non-empty array of actions');
    }

    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id) {
        return createErrorResponse(`No active tab found for ${resolveToolName('batch_actions')}`);
      }
      const tabId = tab.id;
      tabFaviconManager.markTabActive(tabId);

      return await sessionTabAffinity.runSerialized(tabId, async () => {
        const initialUrl = tab.url || '';
        const actionResults: Array<{
          actionIndex: number;
          success: boolean;
          error?: string;
          output?: any;
        }> = [];
        const extractedData: Record<string, string> = {};
        const assertions: Array<{
          actionIndex: number;
          passed: boolean;
          condition?: string;
          error?: string;
        }> = [];
        let interruptedReason: string | undefined;
        let allowNavigationAfterWait = false;
        // Names produced by extract are batch-local aliases. A document token
        // prevents a ref from resolving against a new document after navigation.
        const batchRefs = new Map<string, { ref: string; documentToken: number }>();
        const getDocumentToken = async (): Promise<number | undefined> => {
          const result = await this.safeExecuteScript(tabId, {
            target: { tabId },
            func: () => performance.timeOrigin,
          }).catch(() => [] as any);
          return typeof result?.[0]?.result === 'number' ? result[0].result : undefined;
        };

        let spaDriftNotice: string | undefined;

        let isMac = false;
        try {
          const platform = await chrome.runtime.getPlatformInfo();
          isMac = platform?.os === 'mac';
        } catch {}

        const batchNetCapture = startActionNetworkCapture(tabId, args.captureNetwork);

        const preSignature = await executeInPage({ tabId }, 'inPageDetectPerceptiveSignature', [])
          .then((r) => r?.[0]?.result)
          .catch(() => null);

        await ensureSnapshotBaseline(tabId, args.includeDelta);

        for (let i = 0; i < actions.length; i++) {
          const item = actions[i];
          if (typeof item.ref === 'string' && batchRefs.has(item.ref)) {
            const currentDocumentToken = await getDocumentToken();
            const resolved = resolveBatchRefAlias(item.ref, batchRefs, currentDocumentToken)!;
            if ('verdict' in resolved) {
              actionResults.push({
                actionIndex: i,
                success: false,
                error: `stale_ref: batch ref "${item.ref}" belongs to a previous page document`,
                output: resolved,
              });
              if (item.abortOnFailure !== false) {
                interruptedReason = `Action ${i} (${item.type}) failed with stale_ref`;
                batchNetCapture.dispose();
                break;
              }
              continue;
            }
            item.ref = resolved.ref;
          }
          if (item && typeof item === 'object') {
            if (
              typeof (item as any).index === 'string' &&
              /^-?\d+$/.test((item as any).index.trim())
            ) {
              item.index = parseInt((item as any).index.trim(), 10);
            }
            if (typeof (item as any).pressEnter === 'string') {
              item.pressEnter = (item as any).pressEnter.trim() === 'true';
            }
            if (typeof (item as any).submit === 'string') {
              (item as any).submit = (item as any).submit.trim() === 'true';
            }
            if (typeof (item as any).clear === 'string') {
              item.clear = (item as any).clear.trim() === 'true';
            }
          }
          const itemNetCapture = startActionNetworkCapture(tabId, item.captureNetwork);

          // Runtime URL drift guard: verify URL has not navigated to a different origin
          const currentTab = await chrome.tabs.get(tabId).catch(() => null);
          if (!currentTab) {
            interruptedReason = `Tab was closed during batch execution`;
            batchNetCapture.dispose();
            break;
          }
          if (
            currentTab.url !== initialUrl &&
            !allowNavigationAfterWait &&
            (item as any).type !== 'waitForUrl' &&
            (item as any).type !== 'waitForSelector'
          ) {
            let sameOrigin = false;
            try {
              const initOrigin = new URL(initialUrl).origin;
              const curOrigin = currentTab.url ? new URL(currentTab.url).origin : '';
              if (initOrigin === curOrigin && curOrigin !== '') {
                sameOrigin = true;
              }
            } catch {}

            if (!sameOrigin) {
              interruptedReason = `Page URL changed or tab navigated to different origin during batch execution (from "${initialUrl}" to "${currentTab.url}")`;
              batchNetCapture.dispose();
              break;
            } else {
              // SPA path/hash navigation within the same origin: do not abort
              spaDriftNotice = `SPA navigation detected within origin (from "${initialUrl}" to "${currentTab.url}")`;
            }
          }

          try {
            // Precise scheduling: optional absolute epoch-ms deadline per action
            if (typeof item.at === 'number' && item.at > Date.now()) {
              await new Promise((resolve) => setTimeout(resolve, item.at! - Date.now()));
            }

            let stepOutput: any;

            switch (item.type) {
              case 'click':
              case 'double_click':
              case 'right_click':
              case 'hover': {
                const rawCoord =
                  item.coordinate ??
                  (item as any).coordinates ??
                  (typeof item.x === 'number' && typeof item.y === 'number'
                    ? { x: item.x, y: item.y }
                    : undefined);

                const loc = await resolveTargetLocation(tabId, {
                  ref: item.ref ?? item.index,
                  selector: item.selector,
                  text: item.text,
                  coordinate: rawCoord,
                });

                if (!loc.success) {
                  throw new Error(
                    loc.error ||
                      `Action ${i} of type '${item.type}' target not found. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
                  );
                }

                let targetX = loc.x;
                let targetY = loc.y;
                const targetFrameId = loc.frameId ?? 0;

                if (targetFrameId !== 0) {
                  const offset = await getSubframeViewportOffset(tabId, targetFrameId);
                  const localX = (loc as any)?.frameOffsetX || 0;
                  const localY = (loc as any)?.frameOffsetY || 0;
                  targetX = targetX - localX + offset.offsetX;
                  targetY = targetY - localY + offset.offsetY;
                }

                // Interception check & mask piercing
                let maskPierced: { description: string; reason: string } | undefined;
                const targetIndex =
                  typeof item.index === 'number'
                    ? item.index
                    : typeof item.ref === 'number'
                      ? item.ref
                      : undefined;

                if (targetIndex !== undefined && item.type === 'click') {
                  try {
                    const interceptRes = (
                      await executeInPage({ tabId }, 'inPageCheckInterception', [
                        targetIndex,
                        targetX,
                        targetY,
                      ])
                    )?.[0]?.result;
                    if (interceptRes?.intercepted && interceptRes?.description) {
                      if (interceptRes.canPierce && item.pierceOverlay !== false) {
                        maskPierced = {
                          description: interceptRes.description,
                          reason: interceptRes.pierceReason || 'transient_mask',
                        };
                      } else {
                        throw new Error(
                          `Action ${i} click intercepted by ${interceptRes.description}. Please dismiss or interact with the overlay/dialog first.`,
                        );
                      }
                    }
                  } catch (e: any) {
                    if (e.message?.includes('intercepted')) throw e;
                  }
                }

                void animateAgentCursor(tabId, targetX, targetY, {
                  waitForArrival: false,
                });
                if (
                  item.type === 'click' ||
                  item.type === 'double_click' ||
                  item.type === 'right_click'
                ) {
                  void animateAgentCursorClick(tabId, targetX, targetY);
                }
                await cdpSessionManager.withSession(tabId, 'batch-actions-mouse', async () => {
                  // Humanized micro-trajectory to bypass anti-bot path listeners
                  const startX = Math.max(0, targetX - (40 + Math.floor(Math.random() * 50)));
                  const startY = Math.max(0, targetY - (25 + Math.floor(Math.random() * 40)));
                  const points = computeHumanizedPoints(startX, startY, targetX, targetY, 3);
                  for (const pt of points) {
                    await raceCdpBatch(tabId, 'Input.dispatchMouseEvent', {
                      type: 'mouseMoved',
                      x: pt.x,
                      y: pt.y,
                    });
                    await new Promise((r) => setTimeout(r, 10));
                  }

                  if (item.type === 'click') {
                    await raceCdpBatch(tabId, 'Input.dispatchMouseEvent', {
                      type: 'mousePressed',
                      x: targetX,
                      y: targetY,
                      button: 'left',
                      buttons: 1,
                      clickCount: 1,
                    });
                    await new Promise((r) => setTimeout(r, 35));
                    await raceCdpBatch(tabId, 'Input.dispatchMouseEvent', {
                      type: 'mouseReleased',
                      x: targetX,
                      y: targetY,
                      button: 'left',
                      buttons: 0,
                      clickCount: 1,
                    });
                    if (maskPierced) {
                      try {
                        await executeInPage({ tabId }, 'inPageDispatchSyntheticClick', [
                          targetIndex ?? null,
                          targetX,
                          targetY,
                        ]);
                      } catch {}
                    }
                  } else if (item.type === 'double_click') {
                    await raceCdpBatch(tabId, 'Input.dispatchMouseEvent', {
                      type: 'mousePressed',
                      x: targetX,
                      y: targetY,
                      button: 'left',
                      buttons: 1,
                      clickCount: 1,
                    });
                    await new Promise((r) => setTimeout(r, 35));
                    await raceCdpBatch(tabId, 'Input.dispatchMouseEvent', {
                      type: 'mouseReleased',
                      x: targetX,
                      y: targetY,
                      button: 'left',
                      buttons: 0,
                      clickCount: 1,
                    });
                    await new Promise((r) => setTimeout(r, 40));
                    await raceCdpBatch(tabId, 'Input.dispatchMouseEvent', {
                      type: 'mousePressed',
                      x: targetX,
                      y: targetY,
                      button: 'left',
                      buttons: 1,
                      clickCount: 2,
                    });
                    await raceCdpBatch(tabId, 'Input.dispatchMouseEvent', {
                      type: 'mouseReleased',
                      x: targetX,
                      y: targetY,
                      button: 'left',
                      buttons: 0,
                      clickCount: 2,
                    });
                  } else if (item.type === 'right_click') {
                    try {
                      const rightClickTarget =
                        targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId };
                      if (typeof item.index === 'number' && item.index > 0) {
                        await executeInPage(rightClickTarget, 'inPageInteractIndex', [
                          item.index,
                          'right_click',
                        ]);
                      } else {
                        await executeInPage(rightClickTarget, 'inPageDispatchSyntheticClick', [
                          null,
                          targetX,
                          targetY,
                          'right_click',
                        ]);
                      }
                    } catch {}
                  }
                });

                stepOutput = {
                  x: targetX,
                  y: targetY,
                  action: item.type,
                  [item.type]: true,
                  tagName: loc.tagName,
                  text: loc.text,
                  isTrusted: item.type !== 'right_click' && !maskPierced,
                  ...(maskPierced ? { piercedOverlay: maskPierced } : {}),
                };
                break;
              }

              case 'fill': {
                if (
                  typeof item.index !== 'number' &&
                  typeof item.ref === 'undefined' &&
                  !item.selector
                ) {
                  throw new Error(
                    `Action ${i} of type 'fill' requires 'ref', 'index', or 'selector' parameter`,
                  );
                }
                const targetRef = item.ref ?? item.index ?? item.selector;
                const text = item.text ?? item.value ?? '';

                if (i > 0) {
                  // Dynamic settling: allow framework DOM mutations / re-render from preceding action to settle
                  await new Promise((r) => setTimeout(r, 60));
                }

                const fillRes = await performPhysicalFill({
                  tabId,
                  target: targetRef!,
                  text,
                  clear: item.clear,
                  pressEnter: item.pressEnter,
                  submit: item.submit,
                  preferComposer: item.preferComposer,
                  sessionId: args.sessionId,
                  sessionContext: args.sessionContext,
                });

                if (!fillRes.success || fillRes.committed === false) {
                  throw new Error(
                    fillRes.error ||
                      fillRes.diagnostics ||
                      `Fill failed on [${targetRef}]. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
                  );
                }

                stepOutput = {
                  success: true,
                  committed: true,
                  index: fillRes.index,
                  ref: fillRes.ref,
                  selector: fillRes.selector,
                  filledText: text,
                  isTrusted: fillRes.isTrusted,
                  method: fillRes.method,
                  tagName: fillRes.tagName,
                  isComposer: fillRes.isComposer,
                  isEditor: fillRes.isEditor,
                  isSearch: fillRes.isSearch,
                  submitButtonState: fillRes.submitButtonState,
                  ...(fillRes.submitted
                    ? {
                        submitted: true,
                        submitMethod: fillRes.submitMethod,
                        submitResult: fillRes.submitResult,
                      }
                    : {}),
                  ...(fillRes.disambiguationWarning
                    ? { disambiguationWarning: fillRes.disambiguationWarning }
                    : {}),
                };
                break;
              }

              case 'fill_form': {
                const suppliedFields = (item as any).fields;
                const fields = Array.isArray(suppliedFields)
                  ? suppliedFields
                  : suppliedFields && typeof suppliedFields === 'object'
                    ? Object.entries(suppliedFields).map(([label, value]) => ({ label, value }))
                    : [];
                if (fields.length === 0) {
                  throw new Error(
                    `Action ${i} of type 'fill_form' requires non-empty 'fields' array or label-to-value map`,
                  );
                }
                const fillFormResults: any[] = [];
                for (let f = 0; f < fields.length; f++) {
                  const field = fields[f];
                  let resolvedSelector: string | undefined = field.selector;
                  let target = field.ref ?? field.index ?? field.selector;
                  const textVal = String(field.value ?? field.text ?? '');
                  if (!target && typeof field.label === 'string' && field.label.trim()) {
                    try {
                      const found = await this.safeExecuteScript(tabId, {
                        target: { tabId },
                        func: (label: string, formSelector?: string) => {
                          const norm = (s: string) =>
                            s.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
                          let scope: ParentNode = document;
                          if (formSelector) {
                            try {
                              const form = document.querySelector(formSelector);
                              if (!form) return { verdict: 'failed', reason: 'form_not_found' };
                              scope = form;
                            } catch {
                              return { verdict: 'failed', reason: 'invalid_form_selector' };
                            }
                          }
                          const wanted = norm(label);
                          const controls = Array.from(
                            scope.querySelectorAll(
                              'input,textarea,select,[contenteditable="true"]',
                            ),
                          ) as HTMLElement[];
                          const associated = controls.filter((el) => {
                            const id = el.id;
                            return (
                              !!id &&
                              Array.from(scope.querySelectorAll('label[for]')).some(
                                (l) =>
                                  (l as HTMLLabelElement).htmlFor === id &&
                                  norm(l.textContent || '') === wanted,
                              )
                            );
                          });
                          const labelAncestor = controls.filter((el) => {
                            const l = el.closest('label');
                            return !!l && norm(l.textContent || '') === wanted;
                          });
                          const labelMatches = [...new Set([...associated, ...labelAncestor])];
                          const sources: Array<[string, (el: HTMLElement) => string | null]> = [
                            ['aria-label', (el) => el.getAttribute('aria-label')],
                            ['placeholder', (el) => el.getAttribute('placeholder')],
                            ['name', (el) => el.getAttribute('name')],
                            ['id', (el) => el.id || null],
                          ];
                          let match: HTMLElement | undefined;
                          let source = 'label';
                          if (labelMatches.length) {
                            if (labelMatches.length !== 1)
                              return { verdict: 'failed', reason: 'ambiguous' };
                            match = labelMatches[0];
                          } else {
                            for (const [kind, read] of sources) {
                              const matches = controls.filter((el) => {
                                const v = read(el);
                                return v !== null && norm(v) === wanted;
                              });
                              if (matches.length) {
                                if (matches.length !== 1)
                                  return { verdict: 'failed', reason: 'ambiguous', source: kind };
                                match = matches[0];
                                source = kind;
                                break;
                              }
                            }
                          }
                          if (!match) return { verdict: 'failed', reason: 'not_found' };
                          const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                          const selector = match.id
                            ? `#${CSS.escape(match.id)}`
                            : match.getAttribute('name')
                              ? `${match.tagName.toLowerCase()}[name="${esc(match.getAttribute('name')!)}"]`
                              : match.getAttribute('aria-label')
                                ? `${match.tagName.toLowerCase()}[aria-label="${esc(match.getAttribute('aria-label')!)}"]`
                                : match.getAttribute('placeholder')
                                  ? `${match.tagName.toLowerCase()}[placeholder="${esc(match.getAttribute('placeholder')!)}"]`
                                  : '';
                          if (!selector) return { verdict: 'failed', reason: 'no_safe_selector' };
                          const scopedSelector = formSelector
                            ? `${formSelector} ${selector}`
                            : selector;
                          try {
                            if (document.querySelectorAll(scopedSelector).length !== 1)
                              return { verdict: 'failed', reason: 'ambiguous' };
                          } catch {
                            return { verdict: 'failed', reason: 'no_safe_selector' };
                          }
                          return { verdict: 'resolved', selector: scopedSelector, source };
                        },
                        args: [field.label, field.formSelector ?? (item as any).formSelector],
                      });
                      const resolution = found?.[0]?.result;
                      if (resolution?.verdict === 'resolved') {
                        resolvedSelector = resolution.selector;
                        target = resolvedSelector;
                      } else {
                        fillFormResults.push({
                          fieldIndex: f,
                          success: false,
                          verdict: 'failed',
                          label: field.label,
                          error:
                            resolution?.reason === 'ambiguous'
                              ? 'Field label is ambiguous'
                              : 'Field could not be resolved',
                        });
                        continue;
                      }
                    } catch {
                      fillFormResults.push({
                        fieldIndex: f,
                        success: false,
                        verdict: 'failed',
                        label: field.label,
                        error: 'Field could not be resolved',
                      });
                      continue;
                    }
                  }
                  if (!target) {
                    fillFormResults.push({
                      fieldIndex: f,
                      success: false,
                      verdict: 'failed',
                      error: 'Field locator failed: missing ref, index, or selector',
                    });
                    continue;
                  }
                  if (f > 0) {
                    // Dynamic settling: allow framework DOM mutations / re-render from previous field to settle
                    await new Promise((r) => setTimeout(r, 60));
                  }
                  try {
                    const fillRes = await performPhysicalFill({
                      tabId,
                      target,
                      text: textVal,
                      clear: field.clear,
                      selector: resolvedSelector,
                      ref: field.ref ?? field.index,
                      sessionId: args.sessionId,
                      sessionContext: args.sessionContext,
                    });
                    fillFormResults.push({
                      fieldIndex: f,
                      success: fillRes.success && fillRes.committed !== false,
                      verdict:
                        fillRes.success && fillRes.committed !== false ? 'applied' : 'failed',
                      committed: fillRes.committed,
                      ref: field.ref ?? field.index,
                      selector: resolvedSelector,
                      resolutionPath: fillRes.resolutionPath,
                      error: fillRes.error
                        ? String(fillRes.error).replace(textVal, '[redacted]')
                        : fillRes.diagnostics,
                    });
                  } catch (fillErr) {
                    fillFormResults.push({
                      fieldIndex: f,
                      success: false,
                      verdict: 'failed',
                      ref: field.ref ?? field.index,
                      selector: resolvedSelector,
                      error: String(fillErr instanceof Error ? fillErr.message : fillErr).replace(
                        textVal,
                        '[redacted]',
                      ),
                    });
                  }
                }
                const allFieldsPassed = fillFormResults.every((r) => r.success);
                stepOutput = {
                  success: allFieldsPassed,
                  fields: fillFormResults,
                };
                if (!allFieldsPassed && item.abortOnFailure !== false) {
                  const failedDesc = fillFormResults
                    .filter((r) => !r.success)
                    .map((r) => `field ${r.fieldIndex} [${r.ref ?? r.selector}]: ${r.error}`)
                    .join('; ');
                  throw new Error(
                    `Batch fill_form failed on ${failedDesc}. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
                  );
                }
                break;
              }

              case 'scroll': {
                const targetRef = item.ref ?? item.index;
                const targetIndex =
                  typeof targetRef === 'number'
                    ? targetRef
                    : typeof targetRef === 'string' && /^\d+$/.test(targetRef)
                      ? parseInt(targetRef, 10)
                      : undefined;

                if (typeof targetIndex === 'number' && targetIndex > 0) {
                  const scrollRes = await executeInPage({ tabId }, 'inPageScrollToIndex', [
                    targetIndex,
                  ]);
                  let scrolled = Boolean(scrollRes?.[0]?.result);
                  if (!scrolled) {
                    const frameResults = await executeInPage(
                      { tabId, allFrames: true },
                      'inPageScrollToIndex',
                      [targetIndex],
                    );
                    scrolled = Boolean(frameResults.some((r) => r.result));
                  }
                  if (!scrolled) {
                    throw new Error(
                      `Element with index [${targetIndex}] not found for scroll. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
                    );
                  }
                  stepOutput = { scrolledIndex: targetIndex };
                  break;
                }

                const rawAmount = Math.abs(item.amount ?? 500);
                // Honour all four directions. Previously deltaX was hard-coded to 0
                // and only up/down were mapped, so horizontal scrolls silently
                // turned into vertical ones.
                const isHorizontal = item.direction === 'left' || item.direction === 'right';
                const amount =
                  item.direction === 'up' || item.direction === 'left' ? -rawAmount : rawAmount;
                const deltaX = isHorizontal ? amount : 0;
                const deltaY = isHorizontal ? 0 : amount;
                let cdpScrolled = false;
                try {
                  const rawCoord =
                    item.coordinate ??
                    (item as any).coordinates ??
                    (typeof item.x === 'number' && typeof item.y === 'number'
                      ? { x: item.x, y: item.y }
                      : undefined);
                  const parsedCoord = rawCoord ? parseUnifiedCoordinate(rawCoord, { tabId }) : null;
                  const scrollX = parsedCoord?.x ?? 500;
                  const scrollY = parsedCoord?.y ?? 400;
                  await cdpSessionManager.withSession(tabId, 'batch-actions-scroll', async () => {
                    await raceCdpBatch(tabId, 'Input.dispatchMouseEvent', {
                      type: 'mouseWheel',
                      x: scrollX,
                      y: scrollY,
                      deltaX,
                      deltaY,
                    });
                    cdpScrolled = true;
                  });
                } catch (scrollErr) {
                  if (scrollErr instanceof DialogOpenedError) {
                    throw scrollErr;
                  }
                }

                if (!cdpScrolled) {
                  await this.safeExecuteScript(tabId, {
                    target: { tabId },
                    func: (dx, dy) => {
                      window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
                    },
                    args: [deltaX, deltaY],
                  });
                }
                stepOutput = {
                  scrolled: amount,
                  direction: item.direction ?? 'down',
                  deltaX,
                  deltaY,
                  method: cdpScrolled ? 'cdp_wheel' : 'window_scroll_by',
                };
                break;
              }

              case 'wait': {
                const waitMs = Math.min(item.durationMs ?? 500, 10000);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                stepOutput = { waitedMs: waitMs };
                break;
              }

              case 'key':
              case 'press_key': {
                const { keyDef, modifierDefs, modifiersMask } = parseKeyCombo(item.key || 'Enter');
                const vk = virtualKeyCode(keyDef.key, keyDef.code);
                await cdpSessionManager.withSession(tabId, 'batch-actions', async () => {
                  if (!modifierDefs.length && keyDef.text && keyDef.text.length === 1) {
                    try {
                      await raceCdpBatch(tabId, 'Input.insertText', { text: keyDef.text });
                    } catch {
                      await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                        type: 'keyDown',
                        key: keyDef.key,
                        code: keyDef.code,
                        text: keyDef.text,
                        windowsVirtualKeyCode: vk,
                      });
                      await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                        type: 'keyUp',
                        key: keyDef.key,
                        code: keyDef.code,
                        windowsVirtualKeyCode: vk,
                      });
                    }
                  } else if (!modifierDefs.length) {
                    // keyDown (not rawKeyDown) so browser default actions fire:
                    // Tab focus traversal, Enter button activation, Escape dialog
                    // dismissal all rely on the keydown default behavior. Enter
                    // additionally needs text='\r' to generate the keypress that
                    // triggers activation (matches Puppeteer semantics).
                    await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                      type: 'keyDown',
                      key: keyDef.key,
                      code: keyDef.code,
                      text: keyDef.key === 'Enter' ? '\r' : undefined,
                      windowsVirtualKeyCode: vk,
                    });
                    await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                      type: 'keyUp',
                      key: keyDef.key,
                      code: keyDef.code,
                      windowsVirtualKeyCode: vk,
                    });
                  } else {
                    let heldMask = 0;
                    for (const mod of modifierDefs) {
                      heldMask |= mod.mask;
                      await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                        type: 'rawKeyDown',
                        key: mod.key,
                        code: mod.code,
                        windowsVirtualKeyCode: mod.vk,
                        modifiers: heldMask,
                      });
                    }
                    await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                      type: 'rawKeyDown',
                      key: keyDef.key,
                      code: keyDef.code,
                      windowsVirtualKeyCode: vk,
                      modifiers: modifiersMask,
                    });
                    await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                      type: 'keyUp',
                      key: keyDef.key,
                      code: keyDef.code,
                      windowsVirtualKeyCode: vk,
                      modifiers: modifiersMask,
                    });
                    for (let i = modifierDefs.length - 1; i >= 0; i--) {
                      const mod = modifierDefs[i];
                      await raceCdpBatch(tabId, 'Input.dispatchKeyEvent', {
                        type: 'keyUp',
                        key: mod.key,
                        code: mod.code,
                        windowsVirtualKeyCode: mod.vk,
                        modifiers: heldMask,
                      });
                      heldMask &= ~mod.mask;
                    }
                  }
                });
                stepOutput = { pressedKey: keyDef.key, modifiers: modifiersMask };
                break;
              }

              case 'assert': {
                const condition = item.condition || 'contains';
                const expected = item.expectedText ?? '';
                const timeoutMs = typeof item.timeoutMs === 'number' ? item.timeoutMs : 300;
                const deadline = Date.now() + Math.max(0, timeoutMs);

                let actualText = '';
                let actualValue = '';
                let selectedValue: string | undefined;
                let selectedText: string | undefined;
                let isVisible = false;
                let disabled = false;
                let ariaDisabled = false;
                let validity: { valid: boolean } | undefined = undefined;
                let invalidReason: string | undefined = undefined;
                let checked: boolean | undefined = undefined;
                let selected: boolean | undefined = undefined;
                let passed = false;

                const targetRef = item.ref ?? item.index;
                const targetIndex =
                  typeof targetRef === 'number'
                    ? targetRef
                    : typeof targetRef === 'string' && /^\d+$/.test(targetRef)
                      ? parseInt(targetRef, 10)
                      : undefined;

                while (true) {
                  if (typeof targetIndex === 'number' && targetIndex > 0) {
                    const res = await executeInPage({ tabId }, 'inPageGetElementCoordinates', [
                      targetIndex,
                    ]);
                    let coords = res?.[0]?.result;
                    if (!coords?.success) {
                      const frameResults = await executeInPage(
                        { tabId, allFrames: true },
                        'inPageGetElementCoordinates',
                        [targetIndex],
                      );
                      const match = frameResults.find((r) => r.result?.success);
                      if (match?.result) coords = match.result;
                    }
                    if (coords?.success) {
                      isVisible = true;
                      actualText = String(coords.text || coords.value || '');
                      actualValue = String(coords.value ?? '');
                      disabled = Boolean(coords.disabled);
                      ariaDisabled = Boolean(coords.ariaDisabled);
                      validity = coords.validity;
                      invalidReason = coords.invalidReason;
                      checked = coords.checked;
                      selected = coords.selected;
                    } else {
                      isVisible = false;
                      actualText = '';
                      disabled = false;
                      ariaDisabled = false;
                      validity = undefined;
                      invalidReason = undefined;
                      checked = undefined;
                      selected = undefined;
                    }
                  } else if (item.selector) {
                    const selFunc = (sel: string) => {
                      function queryDeep(
                        selector: string,
                        root: ParentNode = document,
                      ): Element | null {
                        if (!root || !selector) return null;
                        if (selector.includes('>>>') || selector.includes('/deep/')) {
                          const parts = selector
                            .split(/>>>|\/deep\//)
                            .map((s) => s.trim())
                            .filter(Boolean);
                          let cur: ParentNode[] = [root];
                          for (let i = 0; i < parts.length; i++) {
                            const p = parts[i];
                            const next: Element[] = [];
                            for (const c of cur) {
                              const res = queryDeep(p, c);
                              if (res) next.push(res);
                            }
                            if (i === parts.length - 1) return next[0] || null;
                            const nextCtx: ParentNode[] = [];
                            for (const n of next) {
                              const sr = n.shadowRoot || (n as any).__shadowRoot;
                              if (sr) nextCtx.push(sr);
                              else nextCtx.push(n);
                            }
                            cur = nextCtx;
                            if (cur.length === 0) return null;
                          }
                        }
                        try {
                          const direct = root.querySelector(selector);
                          if (direct) return direct;
                        } catch {}
                        const all = root.querySelectorAll('*');
                        for (let i = 0; i < all.length; i++) {
                          const sr = all[i].shadowRoot || (all[i] as any).__shadowRoot;
                          if (sr) {
                            const found = queryDeep(selector, sr);
                            if (found) return found;
                          }
                        }
                        return null;
                      }
                      const el = queryDeep(sel);
                      if (!el) return { found: false };
                      const rect = el.getBoundingClientRect();
                      const visible =
                        rect.width > 0 &&
                        rect.height > 0 &&
                        window.getComputedStyle(el).visibility !== 'hidden' &&
                        window.getComputedStyle(el).display !== 'none';
                      const isAriaInvalid = el.getAttribute('aria-invalid') === 'true';
                      const valObj = (el as any).validity;
                      const validity = valObj
                        ? { valid: isAriaInvalid ? false : Boolean(valObj.valid) }
                        : isAriaInvalid
                          ? { valid: false }
                          : undefined;
                      const invalidReason =
                        (el as any).validationMessage ||
                        (isAriaInvalid ? 'aria-invalid' : undefined);
                      return {
                        found: true,
                        visible,
                        text:
                          el instanceof HTMLSelectElement
                            ? el.value
                            : ((el as HTMLElement).innerText ?? el.textContent ?? ''),
                        value: 'value' in el ? String((el as HTMLInputElement).value ?? '') : '',
                        selectedValue: el instanceof HTMLSelectElement ? el.value : undefined,
                        selectedText:
                          el instanceof HTMLSelectElement
                            ? (el.selectedOptions[0]?.text ?? '')
                            : undefined,
                        disabled: Boolean((el as any).disabled || el.hasAttribute('disabled')),
                        ariaDisabled: el.getAttribute('aria-disabled') === 'true',
                        validity,
                        invalidReason,
                        checked:
                          typeof (el as any).checked === 'boolean'
                            ? (el as any).checked
                            : el.getAttribute('aria-checked') === 'true'
                              ? true
                              : el.getAttribute('aria-checked') === 'false'
                                ? false
                                : undefined,
                        selected:
                          typeof (el as any).selected === 'boolean'
                            ? (el as any).selected
                            : el.getAttribute('aria-selected') === 'true'
                              ? true
                              : el.getAttribute('aria-selected') === 'false'
                                ? false
                                : undefined,
                      };
                    };
                    const selRes = await this.safeExecuteScript(tabId, {
                      target: { tabId },
                      func: selFunc,
                      args: [item.selector],
                    });
                    let data = selRes?.[0]?.result as any;
                    if (!data?.found) {
                      const frameResults = await this.safeExecuteScript(tabId, {
                        target: { tabId, allFrames: true },
                        func: selFunc,
                        args: [item.selector],
                      });
                      const match = frameResults.find((r: any) => r.result?.found);
                      if (match?.result) data = match.result;
                    }
                    if (data?.found) {
                      isVisible = Boolean(data.visible);
                      selectedValue = data.selectedValue;
                      selectedText = data.selectedText;
                      actualValue = String(
                        (item as any).property === 'selectedText'
                          ? (data.selectedText ?? '')
                          : (item as any).property === 'selectedValue'
                            ? (data.selectedValue ?? '')
                            : (data.value ?? ''),
                      );
                      actualText = String(
                        (item as any).property === 'selectedText'
                          ? (data.selectedText ?? '')
                          : (item as any).property === 'selectedValue'
                            ? (data.selectedValue ?? '')
                            : data.text || data.value || '',
                      );
                      disabled = Boolean(data.disabled);
                      ariaDisabled = Boolean(data.ariaDisabled);
                      validity = data.validity;
                      invalidReason = data.invalidReason;
                      checked = data.checked;
                      selected = data.selected;
                    } else {
                      isVisible = false;
                      actualText = '';
                      disabled = false;
                      ariaDisabled = false;
                      validity = undefined;
                      invalidReason = undefined;
                      checked = undefined;
                      selected = undefined;
                    }
                  }

                  switch (condition) {
                    case 'visible':
                      passed = isVisible;
                      break;
                    case 'not_visible':
                      passed = !isVisible;
                      break;
                    case 'enabled':
                      passed = isVisible && !disabled && !ariaDisabled;
                      break;
                    case 'disabled':
                      passed = disabled || ariaDisabled;
                      break;
                    case 'valid':
                      passed = validity ? validity.valid : !invalidReason;
                      break;
                    case 'invalid':
                      passed = validity ? !validity.valid : Boolean(invalidReason);
                      break;
                    case 'checked':
                      passed = checked !== undefined ? Boolean(checked) : Boolean(selected);
                      break;
                    case 'unchecked':
                      passed = checked !== undefined ? !checked : !selected;
                      break;
                    case 'matches':
                      try {
                        passed = new RegExp(expected).test(actualValue || actualText);
                      } catch {
                        passed = false;
                      }
                      break;
                    case 'equals':
                      passed = (actualValue || actualText).trim() === expected.trim();
                      break;
                    case 'not_contains':
                      passed = !actualText.includes(expected);
                      break;
                    case 'contains':
                    default:
                      passed = actualText.includes(expected);
                      break;
                  }

                  if (passed || Date.now() >= deadline) break;
                  const remaining = deadline - Date.now();
                  if (remaining <= 0) break;
                  await new Promise((r) => setTimeout(r, Math.min(50, remaining)));
                }

                assertions.push({
                  actionIndex: i,
                  passed,
                  condition,
                  error: passed
                    ? undefined
                    : `Assertion failed: expected "${expected}" with condition "${condition}", got "${actualText}" (visible=${isVisible}, disabled=${disabled || ariaDisabled}, valid=${validity ? validity.valid : !invalidReason}, checked=${checked})`,
                });

                if (!passed && item.abortOnFailure !== false) {
                  throw new Error(
                    `Assertion failed at action ${i}: condition "${condition}" not met for expected "${expected}". Actual: "${actualText}"`,
                  );
                }

                stepOutput = {
                  asserted: true,
                  passed,
                  condition,
                  actualText,
                  value: actualValue,
                  selectedValue,
                  selectedText,
                  isVisible,
                  disabled,
                  ariaDisabled,
                  valid: validity ? validity.valid : !invalidReason,
                  invalidReason,
                  checked,
                  selected,
                };
                break;
              }

              case 'waitForSelector': {
                const selector = String((item as any).selector || '');
                if (!selector) throw new Error('waitForSelector requires selector');
                const timeoutMs = Math.max(
                  0,
                  Math.min(30000, Number((item as any).timeoutMs ?? 5000)),
                );
                const deadline = Date.now() + timeoutMs;
                let found = false;
                while (Date.now() <= deadline) {
                  const result = await this.safeExecuteScript(tabId, {
                    target: { tabId },
                    func: (sel: string) => {
                      try {
                        return Boolean(document.querySelector(sel));
                      } catch {
                        return false;
                      }
                    },
                    args: [selector],
                  });
                  found = Boolean(result?.[0]?.result);
                  if (found) break;
                  await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))),
                  );
                }
                if (!found) throw new Error(`Timed out waiting for selector: ${selector}`);
                stepOutput = { waitedForSelector: selector, found: true };
                allowNavigationAfterWait = true;
                break;
              }

              case 'waitForUrl': {
                const pattern = String((item as any).url || (item as any).urlPattern || '');
                if (!pattern) throw new Error('waitForUrl requires url or urlPattern');
                const timeoutMs = Math.max(
                  0,
                  Math.min(30000, Number((item as any).timeoutMs ?? 5000)),
                );
                const deadline = Date.now() + timeoutMs;
                let matchedUrl = '';
                let urlMatched = false;
                while (Date.now() <= deadline) {
                  const current = await chrome.tabs.get(tabId).catch(() => null);
                  matchedUrl = current?.url || '';
                  let matched = matchedUrl === pattern;
                  if (!matched) {
                    try {
                      matched = new RegExp(pattern).test(matchedUrl);
                    } catch {
                      matched = matchedUrl.includes(pattern);
                    }
                  }
                  if (matched) {
                    urlMatched = true;
                    break;
                  }
                  await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))),
                  );
                  matchedUrl = '';
                }
                if (!urlMatched) throw new Error(`Timed out waiting for URL: ${pattern}`);
                stepOutput = { waitedForUrl: pattern, currentUrl: matchedUrl };
                allowNavigationAfterWait = true;
                break;
              }

              case 'extract': {
                let extractedValue = '';
                let capturedRef: string | undefined;
                const documentToken = await getDocumentToken();
                let targetInTopFrame = false;
                const prop = item.property || 'text';
                const targetRef = item.ref ?? item.index;
                const targetIndex =
                  typeof targetRef === 'number'
                    ? targetRef
                    : typeof targetRef === 'string' && /^\d+$/.test(targetRef)
                      ? parseInt(targetRef, 10)
                      : undefined;

                if (typeof targetIndex === 'number' && targetIndex > 0) {
                  const res = await executeInPage({ tabId }, 'inPageGetElementCoordinates', [
                    targetIndex,
                  ]);
                  let coords = res?.[0]?.result;
                  targetInTopFrame = Boolean(coords?.success);
                  if (!coords?.success) {
                    const frameResults = await executeInPage(
                      { tabId, allFrames: true },
                      'inPageGetElementCoordinates',
                      [targetIndex],
                    );
                    const match = frameResults.find((r) => r.result?.success);
                    if (match?.result) coords = match.result;
                  }
                  if (coords?.success) {
                    if (prop === 'attribute') {
                      const attrName = item.attributeName || '';
                      const attrs = (coords as any).attributes || {};
                      extractedValue = attrs[attrName] ?? attrs[attrName.toLowerCase()] ?? '';
                    } else if (prop === 'value') {
                      extractedValue = String(coords.value ?? '');
                    } else {
                      extractedValue = String(coords.text ?? '');
                    }
                  }
                } else if (item.selector) {
                  const extractFunc = (sel: string, p: string, attr?: string) => {
                    function queryDeep(
                      selector: string,
                      root: ParentNode = document,
                    ): Element | null {
                      if (!root || !selector) return null;
                      if (selector.includes('>>>') || selector.includes('/deep/')) {
                        const parts = selector
                          .split(/>>>|\/deep\//)
                          .map((s) => s.trim())
                          .filter(Boolean);
                        let cur: ParentNode[] = [root];
                        for (let i = 0; i < parts.length; i++) {
                          const sub = parts[i];
                          const next: Element[] = [];
                          for (const c of cur) {
                            const res = queryDeep(sub, c);
                            if (res) next.push(res);
                          }
                          if (i === parts.length - 1) return next[0] || null;
                          const nextCtx: ParentNode[] = [];
                          for (const n of next) {
                            const sr = n.shadowRoot || (n as any).__shadowRoot;
                            if (sr) nextCtx.push(sr);
                            else nextCtx.push(n);
                          }
                          cur = nextCtx;
                          if (cur.length === 0) return null;
                        }
                      }
                      try {
                        const direct = root.querySelector(selector);
                        if (direct) return direct;
                      } catch {}
                      const all = root.querySelectorAll('*');
                      for (let i = 0; i < all.length; i++) {
                        const sr = all[i].shadowRoot || (all[i] as any).__shadowRoot;
                        if (sr) {
                          const found = queryDeep(selector, sr);
                          if (found) return found;
                        }
                      }
                      return null;
                    }
                    const el = queryDeep(sel);
                    if (!el) return null;
                    const ref = (globalThis as any)[
                      Symbol.for('__browser_use_persistent_ref_map__')
                    ]?.mint?.(el);
                    if (p === 'attribute' && attr)
                      return { value: el.getAttribute(attr) ?? '', ref };
                    if (p === 'value') return { value: (el as HTMLInputElement).value ?? '', ref };
                    return { value: (el as HTMLElement).innerText ?? el.textContent ?? '', ref };
                  };
                  const selRes = await this.safeExecuteScript(tabId, {
                    target: { tabId },
                    func: extractFunc,
                    args: [item.selector, prop, item.attributeName || ''],
                  });
                  let val = selRes?.[0]?.result;
                  targetInTopFrame = val !== null && val !== undefined;
                  if (val === null || val === undefined) {
                    const frameResults = await this.safeExecuteScript(tabId, {
                      target: { tabId, allFrames: true },
                      func: extractFunc,
                      args: [item.selector, prop, item.attributeName || ''],
                    });
                    const match = frameResults.find(
                      (r: any) => r.result !== null && r.result !== undefined,
                    );
                    if (match) val = match.result;
                  }
                  extractedValue = String(val?.value ?? val ?? '');
                  capturedRef =
                    targetInTopFrame && typeof val?.ref === 'string' && /^e\d+$/.test(val.ref)
                      ? val.ref
                      : undefined;
                }

                if (
                  !capturedRef &&
                  targetInTopFrame &&
                  typeof targetIndex === 'number' &&
                  targetIndex > 0
                ) {
                  const refResult = await this.safeExecuteScript(tabId, {
                    target: { tabId },
                    func: (index: number) => {
                      const entry = (globalThis as any)[
                        Symbol.for('__browser_use_isolated_index_map__')
                      ]?.get?.(index);
                      const el = entry && typeof entry.deref === 'function' ? entry.deref() : entry;
                      const map = (globalThis as any)[
                        Symbol.for('__browser_use_persistent_ref_map__')
                      ];
                      return el && map?.mint ? map.mint(el) : undefined;
                    },
                    args: [targetIndex],
                  });
                  const ref = refResult?.[0]?.result;
                  if (typeof ref === 'string' && /^e\d+$/.test(ref)) capturedRef = ref;
                }

                const varName = item.variableName || `var_${i}`;
                extractedData[varName] = extractedValue;
                stepOutput = {
                  extracted: true,
                  variableName: varName,
                  value: extractedValue,
                  property: prop,
                  ...(capturedRef ? { ref: capturedRef } : {}),
                };
                if (capturedRef && documentToken !== undefined)
                  batchRefs.set(varName, { ref: capturedRef, documentToken });
                break;
              }

              default:
                throw new Error(`Unsupported batch action type: ${(item as any).type}`);
            }

            if (item.waitForNetworkQuiescence) {
              const qTimeout = item.quiescenceTimeoutMs || args.quiescenceTimeoutMs || 2000;
              const netSettled = await waitForNetworkQuiescence(tabId, qTimeout);
              if (typeof stepOutput === 'object' && stepOutput !== null) {
                stepOutput.networkSettled = netSettled;
              }
            }

            if (item.waitForSettle) {
              const itemSettle = await waitForPageSettle(tabId, {
                timeoutMs: item.settleTimeoutMs,
              });
              if (typeof stepOutput === 'object' && stepOutput !== null) {
                stepOutput.settle = itemSettle;
              }
            }

            const itemNetResult = await itemNetCapture.waitForResult();
            if (itemNetResult) {
              stepOutput = {
                ...(typeof stepOutput === 'object' && stepOutput !== null ? stepOutput : {}),
                networkResult: itemNetResult,
              };
            }

            actionResults.push({
              actionIndex: i,
              success: stepOutput?.success !== false && stepOutput?.passed !== false,
              output: stepOutput,
            });
          } catch (stepErr) {
            itemNetCapture.dispose();
            batchNetCapture.dispose();
            if (stepErr instanceof DialogOpenedError) {
              return createDialogInterruptResponse(stepErr);
            }
            actionResults.push({
              actionIndex: i,
              success: false,
              error: stepErr instanceof Error ? stepErr.message : String(stepErr),
            });
            interruptedReason = `Action ${i} (${item.type}) failed`;
            break;
          }
        }

        let networkSettled: boolean | undefined;
        if (args.waitForNetworkQuiescence) {
          networkSettled = await waitForNetworkQuiescence(tabId, args.quiescenceTimeoutMs || 2000);
        }

        let batchSettle: any = undefined;
        if (args.waitForSettle) {
          batchSettle = await waitForPageSettle(tabId, { timeoutMs: args.settleTimeoutMs });
        }

        const delta = await captureDeltaIfRequested(tabId, args.includeDelta);

        let currentUrl = initialUrl;
        try {
          const updatedTab = await chrome.tabs.get(tabId);
          currentUrl = updatedTab.url || initialUrl;
        } catch {}
        const urlChanged = Boolean(initialUrl && currentUrl && initialUrl !== currentUrl);

        if (interruptedReason) {
          batchNetCapture.dispose();
        }
        const batchNetResult = await batchNetCapture.waitForResult();

        const postSignature = await executeInPage({ tabId }, 'inPageDetectPerceptiveSignature', [])
          .then((r) => r?.[0]?.result)
          .catch(() => null);
        const perceptiveDelta = computePerceptiveDelta(preSignature, postSignature);

        const totalCompleted = actionResults.filter((r) => r.success).length;
        const batchResult: BatchActionResult & {
          spaDriftNotice?: string;
          networkSettled?: boolean;
          perceptiveDelta?: any;
        } = {
          success: totalCompleted === actions.length,
          completedActions: totalCompleted,
          totalActions: actions.length,
          urlChanged,
          previousUrl: initialUrl,
          currentUrl,
          results: actionResults,
          interruptedReason,
          settle: batchSettle,
          spaDriftNotice,
          ...(batchNetResult ? { networkResult: batchNetResult } : {}),
          ...(typeof networkSettled === 'boolean' ? { networkSettled } : {}),
          ...(Object.keys(extractedData).length > 0 ? { extractedData } : {}),
          ...(assertions.length > 0 ? { assertions } : {}),
          ...(delta ? { delta } : {}),
          ...(perceptiveDelta ? { perceptiveDelta } : {}),
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(batchResult),
            },
          ],
          isError: !batchResult.success,
        };
      });
    } catch (error) {
      if (error instanceof DialogOpenedError) {
        return createDialogInterruptResponse(error);
      }
      return createErrorResponse(
        `Error executing chrome_batch_actions: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const batchActionsTool = new BatchActionsTool();
