import { actionHistoryManager } from '@/utils/action-history-manager';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, resolveToolName } from 'chrome-mcp-shared';
import { executeInPage } from './in-page-engine';
import { computePerceptiveDelta, INTERACTION_TIMEOUT_MS } from './dom-indexer';
import { waitForPageSettle } from '@/utils/action-watchdog';
import {
  raceCdp,
  DialogOpenedError,
  createDialogInterruptResponse,
  StalePageError,
  createTargetOccludedResponse,
} from '@/utils/race-cdp';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import { animateAgentCursor, animateAgentCursorClick } from './agent-cursor';
import { captureDeltaIfRequested, ensureSnapshotBaseline } from '@/utils/delta-helper';
import { getSubframeViewportOffset } from './interact-index';
import { tabFaviconManager } from './tab-favicon';
import { computeHumanizedPoints } from '@/utils/mouse-trajectory';
import { performPhysicalFill } from './fill-core';
import {
  buildResult,
  buildStaleRefResult,
  evaluatePostConditions,
  type ActionEvidence,
  type PostConditionSpec,
} from './result-envelope';

export interface FillIndexParams {
  index: number;
  text?: string;
  value?: string;
  clear?: boolean;
  pressEnter?: boolean;
  submit?: boolean;
  tabId?: number;
  windowId?: number;
  waitForSettle?: boolean;
  settleTimeoutMs?: number;
  includeDelta?: boolean;
  sessionId?: string;
  sessionContext?: string;
  /** Optional post-action assertions; results are reported top-level and via the result envelope. */
  postConditions?: PostConditionSpec[];
}

export class FillIndexTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL_INDEX;

  async execute(args: FillIndexParams): Promise<ToolResult> {
    if (typeof args?.index !== 'number' || args.index <= 0) {
      return createErrorResponse('Index parameter must be a positive 1-based integer');
    }

    const textToFill = args.text ?? args.value ?? '';

    // D3: snapshot BEFORE resolveAffinityTab — its active-tab fallback binds
    // the fallback tab, so a post-resolution check would always see a
    // "valid" binding and never warn (verified by live testing).
    const sidForWarning = args.sessionId || args.sessionContext;
    const hadPreexistingBinding = sessionTabAffinity.hasBinding(sidForWarning);

    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id) {
        return createErrorResponse(`No active tab found for ${resolveToolName('fill_index')}`);
      }
      const targetTabId: number = tab.id;

      return await sessionTabAffinity.runSerialized(targetTabId, async () => {
        const previousUrl = tab.url || '';
        tabFaviconManager.markTabActive(targetTabId);

        const preSignature = await executeInPage(
          { tabId: targetTabId },
          'inPageDetectPerceptiveSignature',
          [],
        )
          .then((r) => r?.[0]?.result)
          .catch(() => null);

        await ensureSnapshotBaseline(targetTabId, args.includeDelta);

        // D3 (TESTING-NOTES #19): surface active-tab fallback in the response.
        const fillIdxAffinityWarning =
          typeof args.tabId === 'number'
            ? undefined
            : hadPreexistingBinding
              ? undefined
              : `input routed to active tab (tabId=${targetTabId}); pass explicit tabId to target another tab`;

        const fillResult = await performPhysicalFill({
          tabId: targetTabId,
          target: args.index,
          text: textToFill,
          clear: args.clear,
          pressEnter: args.pressEnter,
          submit: args.submit,
          sessionId: args.sessionId,
          sessionContext: args.sessionContext,
        });

        if (!fillResult.success || fillResult.committed === false) {
          // Stale-ref recovery: probe the locator once (bounded by the fast
          // interaction budget). A node that was replaced must answer with fresh
          // refs for an immediate retry, not a prose error that costs a timeout.
          const staleProbe = await executeInPage(
            { tabId: targetTabId },
            'inPageGetElementCoordinates',
            [args.index],
            INTERACTION_TIMEOUT_MS,
          )
            .then((r) => r?.[0]?.result as any)
            .catch(() => null);

          if (staleProbe?.stale) {
            const envelope = buildStaleRefResult({
              index: args.index,
              message: staleProbe.message,
              freshRefs: staleProbe.freshRefs ?? [],
              evidence: {
                committed: false,
                urlChanged: false,
                previousUrl,
                currentUrl: previousUrl,
              },
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      success: false,
                      index: args.index,
                      ...(fillResult as any),
                      ...envelope,
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: false,
            };
          }

          return createErrorResponse(
            (fillResult.error ||
              fillResult.diagnostics ||
              `Failed to commit text into element with index [${args.index}]`) +
              `. Hint: If the element is within a ShadowRoot or custom rich-text composer, verify with ${resolveToolName('read_dom')} or try clicking directly.`,
          );
        }

        const outcome: any = { ...fillResult };

        const shouldWaitSettle =
          args.waitForSettle ||
          (args.pressEnter === true && args.waitForSettle !== false) ||
          (args.submit === true && args.waitForSettle !== false);
        if (shouldWaitSettle) {
          const settleResult = await waitForPageSettle(targetTabId, {
            timeoutMs: args.settleTimeoutMs,
            action: { kind: 'fill', node: args.index },
          });
          (outcome as any).settle = settleResult;
        }

        if (fillIdxAffinityWarning) {
          (outcome as any).affinityWarning = fillIdxAffinityWarning;
        }

        const delta = await captureDeltaIfRequested(targetTabId, args.includeDelta);
        if (delta) {
          (outcome as any).delta = delta;
        }

        let currentUrl = previousUrl;
        try {
          const updatedTab = await chrome.tabs.get(targetTabId);
          currentUrl = updatedTab.url || previousUrl;
        } catch {}
        let urlChanged = Boolean(previousUrl && currentUrl && previousUrl !== currentUrl);

        // Automatic Submit Button Click Integration:
        // On modern SPA search inputs (Taobao, JD, Google, Baidu), typing text triggers an
        // autocomplete suggestion dropdown that consumes physical Enter keypresses without
        // submitting the form. When submit: true (or when pressEnter: true is set and a submit
        // button is detected in submitButtonState), if the input is a search box or within a
        // form with a detected submit button, automatically dispatch a native click to the
        // detected submit button in the same turn if the URL hasn't changed.
        const hasDetectedSubmitBtn =
          outcome.submitButtonState?.found &&
          typeof (outcome.submitButtonState as any).index === 'number';
        const isSearchOrForm = Boolean(
          outcome.isSearch ||
          outcome.inputType === 'search' ||
          outcome.submitButtonState?.found ||
          (outcome.tagName === 'input' && !outcome.isComposer && !outcome.isEditor),
        );

        const submitAlreadyHandled = Boolean(
          args.submit === true &&
          outcome.autoSubmitHandled &&
          (outcome.submitted || outcome.submitMethod === 'click'),
        );

        if (
          !urlChanged &&
          !submitAlreadyHandled &&
          (args.submit === true || args.pressEnter === true) &&
          hasDetectedSubmitBtn &&
          isSearchOrForm &&
          outcome.submitMethod !== 'click'
        ) {
          const btnIdx = (outcome.submitButtonState as any).index;
          const btnTxt = outcome.submitButtonState.text || 'Submit';
          console.log(
            `[${resolveToolName('fill_index')}] Autocomplete consumed Enter or submit requested without URL change; auto-clicking detected submit button [${btnIdx}] ("${btnTxt}")`,
          );
          try {
            const { interactIndexTool } = await import('./interact-index');
            const clickRes = await interactIndexTool.execute({
              index: btnIdx,
              action: 'click',
              tabId: targetTabId,
              skipLock: true,
              sessionId: args.sessionId || args.sessionContext,
              waitForSettle: args.waitForSettle !== false,
              settleTimeoutMs: args.settleTimeoutMs,
            });
            let submitSummary: any = (clickRes?.content?.[0] as any)?.text;
            try {
              submitSummary = JSON.parse(submitSummary);
            } catch {}
            outcome.submitted = true;
            outcome.submitMethod = 'click';
            outcome.submittedButtonIndex = btnIdx;
            outcome.submitResult = submitSummary || { success: true };
            outcome.autoSubmitFallbackApplied = true;
            if (submitSummary?.tabHandover) {
              outcome.tabHandover = submitSummary.tabHandover;
            }

            // Re-check URL after auto-submit click
            try {
              const postClickTab = await chrome.tabs.get(targetTabId);
              currentUrl = postClickTab.url || currentUrl;
              urlChanged = Boolean(previousUrl && currentUrl && previousUrl !== currentUrl);
            } catch {}
          } catch (autoClickErr) {
            console.warn(
              `[${resolveToolName('fill_index')}] Failed to auto-click submit button:`,
              autoClickErr,
            );
          }
        }

        if (args.submit === true || args.pressEnter === true) {
          if (outcome.submitted === undefined) {
            outcome.submitted = true;
            outcome.submitMethod = outcome.submitMethod || 'pressEnter';
          }
        }

        (outcome as any).urlChanged = urlChanged;
        (outcome as any).previousUrl = previousUrl;
        (outcome as any).currentUrl = currentUrl;

        const postSignature = await executeInPage(
          { tabId: targetTabId },
          'inPageDetectPerceptiveSignature',
          [],
        )
          .then((r) => r?.[0]?.result)
          .catch(() => null);
        const perceptiveDelta = computePerceptiveDelta(preSignature, postSignature);
        if (perceptiveDelta) {
          (outcome as any).perceptiveDelta = perceptiveDelta;
        }

        (outcome as any).pressEnter = Boolean(
          args.pressEnter || (args.submit && (outcome as any).submitMethod === 'pressEnter'),
        );
        if (args.pressEnter === true || (outcome as any).submitMethod === 'pressEnter') {
          (outcome as any).pressEnterDispatched = true;
        }

        if (
          outcome.submitButtonState?.found &&
          typeof (outcome.submitButtonState as any).index === 'number'
        ) {
          const btnIdx = (outcome.submitButtonState as any).index;
          const btnTxt = outcome.submitButtonState.text || 'Submit';
          (outcome as any).submitButtonIndex = btnIdx;
          (outcome as any).submitButtonText = btnTxt;
          if (!args.submit && !outcome.submitted) {
            (outcome as any).nextActionHint =
              `Submit button detected at index [${btnIdx}] ("${btnTxt}"). 1-Turn Optimal Paradigm: Use ${resolveToolName('fill_index')}({ index: ${args.index}, text: '...', submit: true }), pass pressEnter: true, or use ${resolveToolName('batch_actions')}([{type: 'fill', index: ${args.index}, text: '...'}, {type: 'click', index: ${btnIdx}}]) to eliminate extra turns.`;
          }
        } else if (!args.pressEnter && !args.submit && !outcome.submitted) {
          (outcome as any).nextActionHint =
            `1-Turn Optimal Paradigm: Pass submit: true or pressEnter: true to ${resolveToolName('fill_index')}, or use ${resolveToolName('batch_actions')} to pipeline fill and submit in 1 turn.`;
        }

        // Post-conditions (additive): re-read the committed value + current URL,
        // evaluate the caller's specs, and merge the envelope fields onto the
        // existing response WITHOUT touching any legacy field.
        if (Array.isArray(args.postConditions) && args.postConditions.length > 0) {
          let readBackValue: string | undefined;
          try {
            const verifyRes = await executeInPage(
              { tabId: targetTabId },
              'inPageVerifyInputCommitment',
              [args.index, textToFill],
            );
            const vRes = verifyRes?.[0]?.result as any;
            if (vRes && typeof vRes.currentValue === 'string') readBackValue = vRes.currentValue;
          } catch {}

          const postConditions = evaluatePostConditions(args.postConditions, {
            readBackValue,
            url: currentUrl,
          });
          const evidence: ActionEvidence = {
            committed: fillResult.committed === true,
            method: fillResult.method,
            isTrusted: fillResult.isTrusted,
            urlChanged,
            previousUrl,
            currentUrl,
            ...(delta ? { delta: delta as any } : {}),
            ...(perceptiveDelta ? { perceptiveDelta } : {}),
          };
          const envelope = buildResult({ evidence, postConditions });
          (outcome as any).postConditions = envelope.postConditions;
          (outcome as any).verdict = envelope.verdict;
          (outcome as any).outcome = envelope.outcome;
          (outcome as any).evidence = envelope.evidence;
        }

        const seen = new WeakSet();
        const safeText = JSON.stringify(outcome, (_key, value) => {
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
          }
          return value;
        });

        return {
          content: [
            {
              type: 'text',
              text: safeText,
            },
          ],
          isError: false,
        };
      });
    } catch (error) {
      if (error instanceof DialogOpenedError) {
        return createDialogInterruptResponse(error);
      }
      if (error instanceof StalePageError || (error as any)?.code === 'target_occluded') {
        return createTargetOccludedResponse(error as any);
      }
      return createErrorResponse(
        `Error executing ${resolveToolName('fill_index')}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const fillIndexTool = new FillIndexTool();
