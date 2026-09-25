import { actionHistoryManager } from '@/utils/action-history-manager';
import { executeInPage } from './in-page-engine';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { raceCdp, DialogOpenedError, StalePageError } from '@/utils/race-cdp';
import { animateAgentCursor, animateAgentCursorClick } from './agent-cursor';
import { getSubframeViewportOffset } from './interact-index';
import { computeHumanizedPoints } from '@/utils/mouse-trajectory';
import { resolveTargetLocation } from './unified-locator';
import { sessionTabAffinity, type TabHandoverInfo } from '@/utils/session-tab-affinity';
import { resolveToolName } from 'chrome-mcp-shared';
import { dispatchNativeSelectAll } from './keyboard';
import { snapshotCacheManager } from '@/utils/snapshot-cache-manager';
export { getNativeValueSetter, getNativeCheckedSetter } from './fast-snapshot';

export class FocusVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FocusVerificationError';
  }
}

export interface PhysicalFillOptions {
  tabId: number;
  /** Numeric index from read_dom, or string ref, or CSS selector */
  target: number | string;
  text: string;
  selector?: string;
  ref?: string | number;
  clear?: boolean;
  pressEnter?: boolean;
  submit?: boolean;
  preferComposer?: boolean;
  sessionId?: string;
  sessionContext?: string;
}

export interface PhysicalFillResult {
  success: boolean;
  committed: boolean;
  index?: number;
  ref?: string | number;
  selector?: string;
  filledText: string;
  isTrusted: boolean;
  method: 'cdp_native' | 'cdp_key_by_key' | 'synthetic_inpage' | 'widget_native';
  tagName?: string;
  inputType?: string;
  isComposer?: boolean;
  isEditor?: boolean;
  isSearch?: boolean;
  submitButtonState?: {
    found: boolean;
    text?: string;
    index?: number;
  };
  submitted?: boolean;
  submitMethod?: 'click' | 'pressEnter';
  submittedButtonIndex?: number;
  submitResult?: any;
  disambiguationWarning?: string;
  diagnostics?: string;
  error?: string;
  resolutionPath?: string;
  tabHandover?: TabHandoverInfo;
  autoSubmitHandled?: boolean;
}

/**
 * Unified Physical Typing Engine Core
 *
 * Harmonizes fill-index, fill-form, form-pipeline, and batch fill onto a single
 * industrial-grade typing primitive. Supports:
 * - Humanized micro-trajectory cursor animation
 * - Cross-platform Deep Reset protocol (beforeinput + native Backspace)
 * - Multiline paragraph break preservation
 * - True Input Commitment verification with reactive debounce
 * - Key-by-key CDP typing fallback for complex reactive frameworks (React/Vue/Draft.js)
 * - Special HTML5 widget native dispatch (select/date/color/checkbox/radio/file)
 * - 1-Turn auto-submit execution
 */
export async function performPhysicalFill(
  options: PhysicalFillOptions,
): Promise<PhysicalFillResult> {
  const { tabId, target, preferComposer } = options;
  const textToFill = String(options.text ?? '');
  const clear = options.clear;
  const pressEnter = options.pressEnter === true;
  const submit = options.submit === true;
  const sessionId = options.sessionId || options.sessionContext;

  // Arm handover tracker at the very start of physical fill so any navigation/tab derivation
  // triggered by pressEnter, typing, or auto-submit is reliably captured without races.
  const handoverTracker =
    pressEnter || submit ? sessionTabAffinity.startHandoverTracking(tabId, sessionId) : null;

  const isNumericIndex =
    typeof target === 'number' || (typeof target === 'string' && /^\d+$/.test(target));
  let numericIndex = isNumericIndex
    ? typeof target === 'number'
      ? target
      : parseInt(target, 10)
    : undefined;
  const explicitSelector = options.selector;
  const isExplicitRef =
    typeof target === 'string' && (target.startsWith('ref_') || target.startsWith('e'));
  const effectiveSelector =
    explicitSelector || (!isNumericIndex && !isExplicitRef ? String(target) : undefined);
  const selectorOrRef = !isNumericIndex ? String(target) : effectiveSelector;

  let targetX: number | undefined;
  let targetY: number | undefined;
  let targetFrameId = 0;
  let coords: any = null;
  let resolutionPath: string | undefined;
  let disambiguationWarning: string | undefined;

  // 1. Resolve target coordinates and metadata
  if (numericIndex !== undefined && numericIndex > 0) {
    const coordRes = await executeInPage({ tabId }, 'inPageGetElementCoordinates', [numericIndex]);
    coords = coordRes?.[0]?.result;
    if (!coords?.success) {
      const frameResults = await executeInPage(
        { tabId, allFrames: true },
        'inPageGetElementCoordinates',
        [numericIndex],
      );
      const match = frameResults.find((r) => r.result?.success);
      if (match?.result) {
        coords = match.result;
        targetFrameId = match.frameId ?? 0;
        if (coords.warning) {
          disambiguationWarning = disambiguationWarning
            ? `${disambiguationWarning}; ${coords.warning}`
            : coords.warning;
        }
        if (coords.scopeHash && typeof numericIndex === 'number') {
          snapshotCacheManager.isScopeValid(tabId, numericIndex, coords.scopeHash);
        }
        if (targetFrameId !== 0) {
          const offset = await getSubframeViewportOffset(tabId, targetFrameId);
          const localX = coords?.frameOffsetX || 0;
          const localY = coords?.frameOffsetY || 0;
          coords.x = coords.x - localX + offset.offsetX;
          coords.y = coords.y - localY + offset.offsetY;
        }
      }
    }
    // If numeric index lookup failed on dynamic page, fallback to selector resolution
    if (!coords?.success && effectiveSelector) {
      const loc = await resolveTargetLocation(tabId, {
        ref: selectorOrRef,
        selector: effectiveSelector,
        preferComposer,
      });
      if (loc.success) {
        if (typeof loc.index === 'number' && loc.index > 0) {
          numericIndex = loc.index;
        }
        coords = {
          success: true,
          x: loc.x,
          y: loc.y,
          value: loc.value,
          tagName: loc.tagName,
          inputType: loc.inputType,
          role: loc.role,
          isComposer: loc.isComposer,
          isEditor: loc.isEditor,
          isSearch: loc.isSearch,
          attributes: loc.attributes,
          frameId: loc.frameId,
        };
        targetFrameId = loc.frameId ?? 0;
        resolutionPath = 'selector_drift_recovery';
      }
    }

    if (coords?.success && typeof coords.x === 'number' && typeof coords.y === 'number') {
      targetX = coords.x;
      targetY = coords.y;
    }
    resolutionPath = resolutionPath || 'numeric_index';
  } else if (selectorOrRef || effectiveSelector) {
    const loc = await resolveTargetLocation(tabId, {
      ref: selectorOrRef,
      selector: effectiveSelector,
      preferComposer,
    });
    if (loc.success) {
      if (typeof loc.index === 'number' && loc.index > 0) {
        numericIndex = loc.index;
      }
      coords = {
        success: true,
        x: loc.x,
        y: loc.y,
        value: loc.value,
        tagName: loc.tagName,
        inputType: loc.inputType,
        role: loc.role,
        isComposer: loc.isComposer,
        isEditor: loc.isEditor,
        isSearch: loc.isSearch,
        attributes: loc.attributes,
        frameId: loc.frameId,
      };
      targetFrameId = loc.frameId ?? 0;
      targetX = loc.x;
      targetY = loc.y;
      resolutionPath = loc.resolutionPath || 'unified_locator';
    }
  }

  // 2. Special widget handling (select, custom combobox/listbox, color, date, range, time, checkbox, radio, file)
  const isEditableComboboxInput =
    coords?.tagName?.toLowerCase() === 'input' &&
    !Object.prototype.hasOwnProperty.call(coords?.attributes ?? {}, 'readonly') &&
    coords?.attributes?.['aria-readonly'] !== 'true';
  const isCustomCombobox =
    !isEditableComboboxInput &&
    (coords?.role === 'combobox' ||
      coords?.role === 'listbox' ||
      coords?.attributes?.role === 'combobox' ||
      coords?.attributes?.role === 'listbox' ||
      coords?.attributes?.['aria-haspopup'] === 'listbox');

  const isSpecialWidget =
    coords?.tagName === 'select' ||
    isCustomCombobox ||
    coords?.inputType === 'color' ||
    coords?.inputType === 'date' ||
    coords?.inputType === 'range' ||
    coords?.inputType === 'time' ||
    coords?.inputType === 'datetime-local' ||
    coords?.inputType === 'month' ||
    coords?.inputType === 'week' ||
    coords?.inputType === 'checkbox' ||
    coords?.inputType === 'radio' ||
    coords?.inputType === 'file';

  if (isSpecialWidget) {
    if (isCustomCombobox) {
      let comboRes: any = null;
      if (numericIndex !== undefined && numericIndex > 0) {
        const res = await executeInPage(
          targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
          'inPageSelectCustomCombobox',
          [numericIndex, undefined, textToFill],
        );
        comboRes = res?.[0]?.result;
      } else if (selectorOrRef) {
        const res = await executeInPage(
          targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
          'inPageSelectCustomCombobox',
          [undefined, selectorOrRef, textToFill],
        );
        comboRes = res?.[0]?.result;
      }

      const resObj: PhysicalFillResult = {
        success: comboRes?.success !== false && comboRes?.committed !== false,
        committed: comboRes?.committed ?? comboRes?.success !== false,
        index: numericIndex,
        ref: options.target,
        selector: selectorOrRef,
        filledText: comboRes?.selectedText || textToFill,
        isTrusted: false,
        method: 'widget_native',
        tagName: coords?.tagName || 'div',
        inputType: 'combobox',
        resolutionPath,
        diagnostics: comboRes?.error || comboRes?.diagnostics,
        error:
          comboRes?.success === false
            ? comboRes?.error || 'Custom combobox selection failed'
            : undefined,
      };

      if (submit && resObj.success) {
        await handleAutoSubmit(tabId, resObj, sessionId, targetFrameId);
      }
      if (handoverTracker) {
        const handover = await handoverTracker.waitForHandover(800);
        if (handover) {
          resObj.tabHandover = handover;
        }
      }
      return resObj;
    }

    let outcome: any = null;
    if (numericIndex !== undefined && numericIndex > 0) {
      const res = await executeInPage(
        targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
        'inPageFillIndex',
        [numericIndex, textToFill, clear !== false],
      );
      outcome = res?.[0]?.result;

      // Verification
      let vRes: any = null;
      try {
        const verify = await executeInPage(
          targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
          'inPageVerifyInputCommitment',
          [numericIndex, textToFill],
        );
        vRes = verify?.[0]?.result;
      } catch {}

      if (vRes?.submitButtonState) {
        outcome = outcome || {};
        outcome.submitButtonState = vRes.submitButtonState;
      }
    } else if (selectorOrRef) {
      const selRes = await executeInPage(
        targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
        'inPageFillSelectorWidget',
        [selectorOrRef, textToFill, clear !== false],
      ).catch(async () => {
        // Fallback for selector widget
        return await chrome.scripting.executeScript({
          target: targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
          func: (sel: string, val: string, shouldClear: boolean) => {
            const el = document.querySelector(sel);
            if (!el) return { success: false, error: `Selector "${sel}" not found` };
            if (typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();

            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement?.prototype || {},
              'value',
            )?.set;
            const nativeCheckboxSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement?.prototype || {},
              'checked',
            )?.set;
            const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement?.prototype || {},
              'value',
            )?.set;

            if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
              const isTruthy =
                val === 'true' ||
                val === '1' ||
                val === 'checked' ||
                val === 'on' ||
                (val !== 'false' && val !== '0' && val !== 'off' && Boolean(val));
              if (nativeCheckboxSetter) nativeCheckboxSetter.call(el, isTruthy);
              else el.checked = isTruthy;
            } else if (el instanceof HTMLInputElement && nativeInputValueSetter) {
              if (shouldClear) nativeInputValueSetter.call(el, '');
              nativeInputValueSetter.call(el, val);
            } else if (el instanceof HTMLTextAreaElement && nativeTextAreaValueSetter) {
              if (shouldClear) nativeTextAreaValueSetter.call(el, '');
              nativeTextAreaValueSetter.call(el, val);
            } else if (el instanceof HTMLSelectElement) {
              let matched = false;
              for (const opt of Array.from(el.options)) {
                if (opt.value === val || opt.text === val || opt.text.trim() === val.trim()) {
                  el.value = opt.value;
                  matched = true;
                  break;
                }
              }
              if (!matched) el.value = val;
            } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              if (shouldClear) (el as any).value = '';
              (el as any).value = val;
            } else {
              (el as any).value = val;
            }

            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            return { success: true, filledText: val };
          },
          args: [selectorOrRef, textToFill, clear !== false],
        });
      });
      outcome = selRes?.[0]?.result;
    }

    const resObj: PhysicalFillResult = {
      success: outcome?.success !== false,
      committed: outcome?.committed ?? outcome?.success !== false,
      index: numericIndex,
      ref: options.target,
      selector: selectorOrRef,
      filledText: textToFill,
      isTrusted: false,
      method: 'widget_native',
      tagName: coords?.tagName,
      inputType: coords?.inputType,
      submitButtonState: outcome?.submitButtonState,
      resolutionPath,
      diagnostics: outcome?.diagnostics || outcome?.error,
    };

    if (submit && resObj.success) {
      await handleAutoSubmit(tabId, resObj, sessionId, targetFrameId);
    }
    if (handoverTracker) {
      const handover = await handoverTracker.waitForHandover(800);
      if (handover) {
        resObj.tabHandover = handover;
      }
    }
    return resObj;
  }

  // 3. Disambiguation check (Search input vs multi-line post text)
  const isSearchTarget = Boolean(
    coords?.isSearch ||
    coords?.inputType === 'search' ||
    /(search|query|find|sousuo|搜索|查找)/i.test(
      `${coords?.attributes?.name || ''} ${coords?.attributes?.id || ''} ${coords?.attributes?.['aria-label'] || ''} ${coords?.attributes?.placeholder || ''}`,
    ),
  );
  const isMultiLineOrPostText =
    textToFill.includes('\n') ||
    textToFill.length > 60 ||
    /(http|#|@|tweet|post|reply|thread)/i.test(textToFill);

  if (isSearchTarget && isMultiLineOrPostText) {
    const searchNotice = `[Input Disambiguation Notice] Targeted element [${target}] appears to be a search input (searchbox), but the filled text looks like a multi-line post or comment. If you intended to post or reply, verify with ${resolveToolName('read_dom')} to target the [composer] element instead.`;
    disambiguationWarning = disambiguationWarning
      ? `${disambiguationWarning}; ${searchNotice}`
      : searchNotice;
    console.warn(`[performPhysicalFill] ${disambiguationWarning}`);
  }

  // 4. Try CDP native mouse click + Input.insertText (isTrusted: true)
  let outcome: any = null;
  let filledViaCdp = false;
  let fillMethod: 'cdp_native' | 'cdp_key_by_key' = 'cdp_native';

  if (coords?.success && typeof targetX === 'number' && typeof targetY === 'number') {
    void animateAgentCursor(tabId, targetX, targetY);
    void animateAgentCursorClick(tabId, targetX, targetY);

    const isKnownEmpty =
      (typeof coords.value === 'string' && coords.value === '') ||
      (coords.value === undefined && (!coords.text || coords.text.trim() === ''));

    if (typeof coords.value === 'string' && numericIndex !== undefined) {
      actionHistoryManager.pushAction(tabId, {
        type: 'fill',
        index: numericIndex,
        prevValue: coords.value,
        timestamp: Date.now(),
      });
    }

    let verification: any = null;
    const isSingleLineInput =
      coords?.tagName === 'input' &&
      coords?.inputType !== 'search' &&
      !coords?.isComposer &&
      !coords?.isEditor;

    // Phase M1 Instantaneous Occlusion Circuit Breaker & Live Target Re-resolution
    if (numericIndex !== undefined && numericIndex > 0) {
      const occResult = (
        await executeInPage(
          targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
          'inPageCheckOcclusion',
          [{ node: numericIndex, kind: 'fill' }],
        )
      )?.[0];
      if (occResult && !occResult.result) {
        // If occlusion check failed on index, attempt selector re-resolution if available
        if (effectiveSelector) {
          try {
            const freshLoc = await resolveTargetLocation(tabId, {
              ref: selectorOrRef,
              selector: effectiveSelector,
              preferComposer,
            });
            if (
              freshLoc.success &&
              typeof freshLoc.x === 'number' &&
              typeof freshLoc.y === 'number'
            ) {
              targetX = freshLoc.x;
              targetY = freshLoc.y;
              if (typeof freshLoc.index === 'number') numericIndex = freshLoc.index;
            } else {
              throw new StalePageError(
                `Element target [${numericIndex}] is occluded by an overlay, out of viewport, or detached from DOM.`,
              );
            }
          } catch (e) {
            if (e instanceof StalePageError) throw e;
            throw new StalePageError(
              `Element target [${numericIndex}] is occluded by an overlay, out of viewport, or detached from DOM.`,
            );
          }
        } else {
          throw new StalePageError(
            `Element target [${numericIndex}] is occluded by an overlay, out of viewport, or detached from DOM.`,
          );
        }
      }
      const occRes = occResult?.result;
      if (occRes && typeof occRes.x === 'number' && typeof occRes.y === 'number') {
        targetX = occRes.x;
        targetY = occRes.y;
      }
    } else if (effectiveSelector || selectorOrRef) {
      try {
        const freshLoc = await resolveTargetLocation(tabId, {
          ref: selectorOrRef,
          selector: effectiveSelector,
          preferComposer,
        });
        if (freshLoc.success && typeof freshLoc.x === 'number' && typeof freshLoc.y === 'number') {
          targetX = freshLoc.x;
          targetY = freshLoc.y;
          if (typeof freshLoc.index === 'number') numericIndex = freshLoc.index;
        }
      } catch {}
    }

    try {
      await cdpSessionManager.withSession(tabId, 'fill-core', async () => {
        // Humanized micro-trajectory
        const startX = Math.max(0, targetX! - (40 + Math.floor(Math.random() * 50)));
        const startY = Math.max(0, targetY! - (25 + Math.floor(Math.random() * 40)));
        const points = computeHumanizedPoints(startX, startY, targetX!, targetY!, 3);
        for (const pt of points) {
          await raceCdp(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: pt.x,
            y: pt.y,
          });
          await new Promise((r) => setTimeout(r, 10));
        }

        // Mouse click to focus
        await raceCdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: targetX,
          y: targetY,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        await new Promise((r) => setTimeout(r, 35));
        await raceCdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: targetX,
          y: targetY,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });

        // Click settling pause for composers
        await new Promise((r) => setTimeout(r, 50));

        // Active Element Focus Guard: strictly verify via in-page check that document.activeElement is target
        const focusCheck = (
          await executeInPage(
            targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
            'inPageVerifyActiveElement',
            [numericIndex, effectiveSelector || selectorOrRef],
          )
        )?.[0]?.result;

        if (focusCheck && focusCheck.isFocused === false) {
          throw new FocusVerificationError(
            focusCheck.error ||
              `Focus verification failed: target element [${target}] could not be focused (activeElement is <${focusCheck.activeTag || 'unknown'}>). Aborting typing to prevent misdirected input.`,
          );
        }

        // Deep reset with native SelectAll command (Task B3)
        if (clear === true || (clear !== false && !isKnownEmpty)) {
          if (numericIndex !== undefined) {
            try {
              await executeInPage(
                targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
                'inPageDeepResetElement',
                [numericIndex],
              );
            } catch {}
          }
          await dispatchNativeSelectAll(tabId).catch(() => {});
          await raceCdp(tabId, 'Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            windowsVirtualKeyCode: 8,
            key: 'Backspace',
            code: 'Backspace',
          });
          await raceCdp(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            windowsVirtualKeyCode: 8,
            key: 'Backspace',
            code: 'Backspace',
          });
        }

        // Insert text
        if (textToFill) {
          const lines = String(textToFill).split(/\r?\n/);
          if (lines.length > 1 && !isSingleLineInput) {
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line.length > 0) {
                await raceCdp(tabId, 'Input.insertText', { text: line });
                await new Promise((r) => setTimeout(r, 15));
              }
              if (i < lines.length - 1) {
                await raceCdp(tabId, 'Input.dispatchKeyEvent', {
                  type: 'rawKeyDown',
                  windowsVirtualKeyCode: 13,
                  nativeVirtualKeyCode: 13,
                  key: 'Enter',
                  code: 'Enter',
                  text: '\r',
                  unmodifiedText: '\r',
                });
                await raceCdp(tabId, 'Input.dispatchKeyEvent', {
                  type: 'keyUp',
                  windowsVirtualKeyCode: 13,
                  nativeVirtualKeyCode: 13,
                  key: 'Enter',
                  code: 'Enter',
                });
                await new Promise((r) => setTimeout(r, 25));
              }
            }
          } else {
            await raceCdp(tabId, 'Input.insertText', { text: String(textToFill) });
          }

          // Synthetic bubbling input & change pair to guarantee framework reactive states see update
          try {
            await executeInPage(
              targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
              'inPageDispatchInputEvents',
              [numericIndex],
            ).catch(() => {});
          } catch {}
        }

        // Settle React/Vue microtasks
        await new Promise((r) => setTimeout(r, 40));

        // True Input Commitment verification
        if (numericIndex !== undefined) {
          try {
            const vRes = await executeInPage(
              targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
              'inPageVerifyInputCommitment',
              [numericIndex, textToFill],
            );
            verification = vRes?.[0]?.result;
          } catch {}

          if (textToFill && verification && verification.committed === false) {
            await new Promise((r) => setTimeout(r, 60));
            try {
              const retryRes = await executeInPage(
                targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
                'inPageVerifyInputCommitment',
                [numericIndex, textToFill],
              );
              if (retryRes?.[0]?.result?.committed) {
                verification = retryRes[0].result;
              }
            } catch {}
          }

          // Reactive failure fallback to CDP key-by-key typing
          if (textToFill && verification && verification.committed === false) {
            console.warn(
              `[performPhysicalFill] Reactive state commitment failed after insertText for [${target}]. Retrying with key-by-key typing...`,
            );
            for (const char of textToFill) {
              if (char === '\n') {
                if (isSingleLineInput) continue;
                await raceCdp(tabId, 'Input.dispatchKeyEvent', {
                  type: 'rawKeyDown',
                  windowsVirtualKeyCode: 13,
                  nativeVirtualKeyCode: 13,
                  key: 'Enter',
                  code: 'Enter',
                  text: '\r',
                  unmodifiedText: '\r',
                });
                await raceCdp(tabId, 'Input.dispatchKeyEvent', {
                  type: 'keyUp',
                  windowsVirtualKeyCode: 13,
                  nativeVirtualKeyCode: 13,
                  key: 'Enter',
                  code: 'Enter',
                });
              } else if (char === '\r') {
                continue;
              } else {
                await raceCdp(tabId, 'Input.dispatchKeyEvent', {
                  type: 'keyDown',
                  text: char,
                  unmodifiedText: char,
                  key: char,
                });
                await raceCdp(tabId, 'Input.dispatchKeyEvent', {
                  type: 'keyUp',
                  key: char,
                });
              }
              await new Promise((r) => setTimeout(r, 8));
            }
            fillMethod = 'cdp_key_by_key';
            await new Promise((r) => setTimeout(r, 50));

            try {
              const vRes2 = await executeInPage(
                targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
                'inPageVerifyInputCommitment',
                [numericIndex, textToFill],
              );
              verification = vRes2?.[0]?.result;
            } catch {}
          }

          if (textToFill && verification && verification.committed === false) {
            throw new Error(
              `True Input Commitment failed: ${verification.diagnostics || 'Reactive state did not update'}`,
            );
          }
        }

        // pressEnter if requested
        if (pressEnter) {
          await raceCdp(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter',
            code: 'Enter',
            text: '\r',
            unmodifiedText: '\r',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
          await raceCdp(tabId, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
        }
      });

      outcome = {
        success: true,
        committed: true,
        index: numericIndex,
        ref: options.target,
        selector: selectorOrRef,
        filledText: textToFill,
        isTrusted: true,
        method: fillMethod,
        tagName: coords?.tagName,
        inputType: coords?.inputType,
        isComposer: coords?.isComposer,
        isEditor: coords?.isEditor,
        isSearch: coords?.isSearch,
        submitButtonState: verification?.submitButtonState,
        disambiguationWarning,
        resolutionPath,
        ...(pressEnter ? { submitted: true, submitMethod: 'pressEnter' } : {}),
      };
      filledViaCdp = true;
    } catch (cdpErr) {
      if (cdpErr instanceof FocusVerificationError) {
        return {
          success: false,
          committed: false,
          index: numericIndex,
          ref: options.target,
          selector: selectorOrRef,
          filledText: textToFill,
          isTrusted: false,
          method: 'cdp_native',
          error: cdpErr.message,
          diagnostics: cdpErr.message,
          resolutionPath,
        };
      }
      if (cdpErr instanceof DialogOpenedError) {
        throw cdpErr;
      }
      if (cdpErr instanceof StalePageError) {
        throw cdpErr;
      }
      console.warn(
        `[performPhysicalFill] CDP native fill failed on target [${target}], falling back to inPageFillIndex:`,
        cdpErr,
      );
    }
  }

  // 5. Fallback to in-page synthetic fill
  if (!filledViaCdp) {
    if (numericIndex !== undefined && numericIndex > 0) {
      const results = await executeInPage({ tabId }, 'inPageFillIndex', [
        numericIndex,
        textToFill,
        clear !== false,
        pressEnter,
      ]);
      outcome = results?.[0]?.result;
      if (!outcome || !outcome.success) {
        const frameResults = await executeInPage({ tabId, allFrames: true }, 'inPageFillIndex', [
          numericIndex,
          textToFill,
          clear !== false,
          pressEnter,
        ]);
        const match = frameResults.find((r) => r.result?.success);
        if (match?.result) outcome = match.result;
      }
      if (outcome && typeof outcome === 'object') {
        outcome.index = numericIndex;
        outcome.ref = options.target;
        outcome.filledText = textToFill;
        outcome.method = 'synthetic_inpage';
        outcome.isTrusted = false;
        outcome.resolutionPath = resolutionPath;

        let fallbackVerify: any = null;
        try {
          const vRes = await executeInPage(
            targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
            'inPageVerifyInputCommitment',
            [numericIndex, textToFill],
          );
          fallbackVerify = vRes?.[0]?.result;
        } catch {}

        if (textToFill && fallbackVerify && fallbackVerify.committed === false) {
          outcome.committed = false;
          outcome.diagnostics = fallbackVerify.diagnostics;
          outcome.submitButtonState = fallbackVerify.submitButtonState;
        } else {
          outcome.committed = true;
          if (fallbackVerify?.submitButtonState) {
            outcome.submitButtonState = fallbackVerify.submitButtonState;
          }
        }
      }
    } else if (selectorOrRef) {
      // In-page synthetic fallback for selector/ref targets
      try {
        const selRes = await chrome.scripting.executeScript({
          target: targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
          func: (sel: string, val: string, shouldClear: boolean) => {
            const el = document.querySelector(sel);
            if (!el) return { success: false, error: `Selector "${sel}" not found` };
            if (typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();

            const isContentEditable =
              (el as HTMLElement).isContentEditable ||
              el.getAttribute('contenteditable') === 'true' ||
              el.getAttribute('contenteditable') === '';

            if (isContentEditable) {
              const editEl = el as HTMLElement;
              editEl.focus();
              if (shouldClear) {
                const doc = editEl.ownerDocument || document;
                const selObj = (doc.defaultView || window).getSelection();
                const range = doc.createRange();
                range.selectNodeContents(editEl);
                selObj?.removeAllRanges();
                selObj?.addRange(range);
                try {
                  doc.execCommand('delete', false);
                } catch {}
                editEl.innerText = '';
              }
              let inserted = false;
              try {
                inserted = document.execCommand('insertText', false, val);
              } catch {}
              if (!inserted) {
                editEl.innerText = val;
              }
              editEl.dispatchEvent(
                new InputEvent('input', {
                  bubbles: true,
                  composed: true,
                  inputType: 'insertText',
                  data: val,
                }),
              );
              editEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
              return { success: true, filledText: val };
            }

            const getNativeSetter = (element: any, prop: string) => {
              let proto = Object.getPrototypeOf(element);
              while (proto) {
                const desc = Object.getOwnPropertyDescriptor(proto, prop);
                if (desc?.set) return desc.set;
                proto = Object.getPrototypeOf(proto);
              }
              return null;
            };

            const nativeValSetter = getNativeSetter(el, 'value');
            const nativeChkSetter = getNativeSetter(el, 'checked');

            if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
              const isTruthy =
                val === 'true' ||
                val === '1' ||
                val === 'checked' ||
                val === 'on' ||
                (val !== 'false' && val !== '0' && val !== 'off' && Boolean(val));
              if (nativeChkSetter) nativeChkSetter.call(el, isTruthy);
              else el.checked = isTruthy;
            } else if (el instanceof HTMLSelectElement) {
              let matched = false;
              for (const opt of Array.from(el.options)) {
                if (opt.value === val || opt.text === val || opt.text.trim() === val.trim()) {
                  el.value = opt.value;
                  matched = true;
                  break;
                }
              }
              if (!matched) el.value = val;
            } else if (nativeValSetter) {
              if (shouldClear) nativeValSetter.call(el, '');
              nativeValSetter.call(el, val);
            } else {
              if (shouldClear) (el as any).value = '';
              (el as any).value = val;
            }

            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            return { success: true, filledText: val };
          },
          args: [selectorOrRef, textToFill, clear !== false],
        });
        const scriptResult = selRes?.[0]?.result;
        if (scriptResult && typeof scriptResult === 'object') {
          outcome = {
            ...scriptResult,
            ref: options.target,
            selector: selectorOrRef,
            filledText: textToFill,
            method: 'synthetic_inpage',
            isTrusted: false,
            resolutionPath: resolutionPath || 'synthetic_selector',
            committed: scriptResult.success === true,
          };
        }
      } catch (selErr) {
        outcome = {
          success: false,
          error: `Selector fill error: ${selErr instanceof Error ? selErr.message : String(selErr)}`,
        };
      }
    }
  }

  if (!outcome || !outcome.success || outcome.committed === false) {
    handoverTracker?.cancel();
    return {
      success: false,
      committed: false,
      index: numericIndex,
      ref: options.target,
      selector: selectorOrRef,
      filledText: textToFill,
      isTrusted: false,
      method: 'synthetic_inpage',
      error:
        outcome?.error ||
        outcome?.diagnostics ||
        `Failed to commit text into element target [${target}]`,
      diagnostics: outcome?.diagnostics,
      resolutionPath,
    };
  }

  const resObj: PhysicalFillResult = {
    success: true,
    committed: true,
    index: numericIndex,
    ref: options.target,
    selector: selectorOrRef,
    filledText: textToFill,
    isTrusted: Boolean(outcome.isTrusted),
    method: outcome.method || 'cdp_native',
    tagName: coords?.tagName || outcome.tagName,
    inputType: coords?.inputType || outcome.inputType,
    isComposer: coords?.isComposer || outcome.isComposer,
    isEditor: coords?.isEditor || outcome.isEditor,
    isSearch: coords?.isSearch || outcome.isSearch,
    submitButtonState: outcome.submitButtonState,
    submitted: outcome.submitted,
    submitMethod: outcome.submitMethod,
    disambiguationWarning,
    resolutionPath,
  };

  // 6. Handle auto-submit if requested (and not already submitted via pressEnter)
  if (submit && resObj.success && !resObj.submitted) {
    await handleAutoSubmit(tabId, resObj, sessionId, targetFrameId);
  }

  if (handoverTracker) {
    const handover = await handoverTracker.waitForHandover(800);
    if (handover) {
      resObj.tabHandover = handover;
    }
  }

  return resObj;
}

/**
 * Executes 1-turn auto-submit via detected submit button click or physical Enter key.
 */
async function handleAutoSubmit(
  tabId: number,
  result: PhysicalFillResult,
  sessionId?: string,
  targetFrameId = 0,
): Promise<void> {
  result.autoSubmitHandled = true;
  if (result.submitted) return;

  if (result.submitButtonState?.found && typeof result.submitButtonState.index === 'number') {
    const btnIdx = result.submitButtonState.index;
    try {
      // P1: Rich-text editor (Draft.js/ProseMirror/React) reactive settle polling:
      // Wait for button to transition from disabled to enabled (up to 450ms, polling every 50ms)
      try {
        await chrome.scripting.executeScript({
          target: targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
          func: (idx: number) => {
            return new Promise<void>((resolve) => {
              const start = Date.now();
              function check() {
                const isolatedMap = (globalThis as any)[
                  Symbol.for('__browser_use_isolated_index_map__')
                ];
                const entry = isolatedMap?.get(idx);
                const el = typeof entry?.deref === 'function' ? entry.deref() : entry;
                if (el) {
                  const disabled =
                    el.disabled === true ||
                    el.getAttribute('aria-disabled') === 'true' ||
                    el.classList.contains('disabled') ||
                    el.style.pointerEvents === 'none';
                  if (!disabled || Date.now() - start > 450) {
                    resolve();
                    return;
                  }
                } else if (Date.now() - start > 450) {
                  resolve();
                  return;
                }
                setTimeout(check, 50);
              }
              check();
            });
          },
          args: [btnIdx],
        });
      } catch {}

      const { interactIndexTool } = await import('./interact-index');
      const clickPromise = interactIndexTool.execute({
        index: btnIdx,
        action: 'click',
        tabId,
        skipLock: true,
        sessionId,
        waitForSettle: false,
      });
      const timeoutPromise = new Promise<{ content: any[] }>((resolve) =>
        setTimeout(
          () =>
            resolve({
              content: [{ type: 'text', text: JSON.stringify({ success: true, timedOut: true }) }],
            }),
          4000,
        ),
      );
      const clickRes = (await Promise.race([clickPromise, timeoutPromise])) as any;
      let submitSummary: any = (clickRes?.content?.[0] as any)?.text;
      try {
        submitSummary = JSON.parse(submitSummary);
      } catch {}
      result.submitted = true;
      result.submitMethod = 'click';
      result.submittedButtonIndex = btnIdx;
      result.submitResult = submitSummary || { success: true };
      if (submitSummary?.tabHandover) {
        result.tabHandover = submitSummary.tabHandover;
      }
      return;
    } catch (clickErr) {
      console.warn(
        '[performPhysicalFill] Auto-submit click failed, falling back to Enter:',
        clickErr,
      );
    }
  }

  // Fallback to Enter key
  try {
    await cdpSessionManager.withSession(tabId, 'auto-submit', async () => {
      await raceCdp(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        text: '\r',
        unmodifiedText: '\r',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await raceCdp(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    });
    result.submitted = true;
    result.submitMethod = 'pressEnter';
  } catch {
    // If CDP fails, fallback to in-page synthetic Enter
    try {
      if (typeof result.index === 'number' && result.index > 0) {
        await executeInPage(
          targetFrameId !== 0 ? { tabId, frameIds: [targetFrameId] } : { tabId },
          'inPageFillIndex',
          [result.index, '', false, true],
        );
      }
      result.submitted = true;
      result.submitMethod = 'pressEnter';
    } catch {}
  }
}
