import { createErrorResponse, ToolResult } from '../../../../common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, resolveToolName, type CaptureNetworkOptions } from 'chrome-mcp-shared';
import { cdpSessionManager } from '../../../../utils/cdp-session-manager';
import {
  raceCdp,
  DialogOpenedError,
  createDialogInterruptResponse,
  StalePageError,
  createTargetOccludedResponse,
} from '../../../../utils/race-cdp';
import { executeInPage } from './in-page-engine';
import { waitForPageSettle, waitForNetworkQuiescence } from '../../../../utils/action-watchdog';
import {
  inPageArmDeliveryProbe,
  inPageReadDeliveryProbe,
  computePerceptiveDelta,
  INTERACTION_TIMEOUT_MS,
} from './dom-indexer';
import { screenshotContextManager, scaleCoordinates } from '../../../../utils/screenshot-context';
import { computeHumanizedPoints } from '../../../../utils/mouse-trajectory';
import type { CdpEventObserver } from '../../../../utils/cdp-session-manager';
import {
  parseUnifiedCoordinate,
  type PolymorphicCoordinate,
} from '../../../../utils/coordinate-parser';
import { sessionTabAffinity } from '../../../../utils/session-tab-affinity';
import { animateAgentCursor, animateAgentCursorClick } from './agent-cursor';
import { captureDeltaIfRequested, ensureSnapshotBaseline } from '../../../../utils/delta-helper';
import { tabFaviconManager } from './tab-favicon';
import { startActionNetworkCapture } from '../../../../utils/action-network-capture';
import {
  buildResult,
  buildStaleRefResult,
  evaluatePostConditionsWithSettlePoll,
  type ActionEvidence,
  type PostConditionContext,
  type PostConditionSpec,
} from './result-envelope';

/** Bounded in-page read budget for one post-condition settle-poll attempt. */
const POST_CONDITION_READ_TIMEOUT_MS = 1_500;

export interface InteractIndexParams {
  index?: number;
  coordinate?: { x: number; y: number } | PolymorphicCoordinate;
  coordinateSpace?: 'viewport' | 'screenshot';
  points?: Array<{ x: number; y: number } | PolymorphicCoordinate>;
  intervalMs?: number;
  action?: 'click' | 'hover' | 'double_click' | 'right_click' | 'drag';
  path?: Array<{ x: number; y: number }>;
  end?: { index?: number; coordinate?: { x: number; y: number } | PolymorphicCoordinate };
  steps?: number;
  holdMs?: number;
  dnd?: boolean;
  modifiers?: string[];
  tabId?: number;
  windowId?: number;
  waitForSettle?: boolean;
  settleTimeoutMs?: number;
  /** Wait for in-flight network requests to settle after interaction before returning (default: false) */
  waitForNetworkQuiescence?: boolean;
  /** Quiescence timeout in ms (default 2000) */
  quiescenceTimeoutMs?: number;
  humanize?: boolean;
  includeDelta?: boolean;
  sessionId?: string;
  sessionContext?: string;
  /** Internal: skip acquiring the per-tab mutex. Only pass true when the caller
   *  already holds sessionTabAffinity.runSerialized for this tabId (prevents
   *  non-reentrant re-entrant deadlock). Not exposed in the MCP schema. */
  skipLock?: boolean;
  autoSnap?: boolean;
  /** Automatically pierce non-opaque, transient, or presentation backdrop masks */
  pierceOverlay?: boolean;
  /** Inline capture of network response triggered by this interaction in a single RTT */
  captureNetwork?: CaptureNetworkOptions;
  /** Optional post-action assertions; results are reported top-level and via the result envelope. */
  postConditions?: PostConditionSpec[];
}

/**
 * Track last known cursor position per tab for smooth humanized trajectories
 */
const lastMousePosMap = new Map<number, { x: number; y: number }>();

// Register tab removal listener to prevent memory leak
if (typeof chrome !== 'undefined' && chrome?.tabs?.onRemoved?.addListener) {
  try {
    chrome.tabs.onRemoved.addListener((closedTabId: number) => {
      lastMousePosMap.delete(closedTabId);
    });
  } catch {}
}

export { computeHumanizedPoints };

export async function getSubframeViewportOffset(
  tabId: number,
  frameId: number,
): Promise<{ offsetX: number; offsetY: number }> {
  if (!frameId || frameId === 0) return { offsetX: 0, offsetY: 0 };
  try {
    let targetUrl: string | undefined;
    if (typeof chrome !== 'undefined' && chrome.webNavigation?.getFrame) {
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId }).catch(() => null);
      if (frame?.url && frame.url !== 'about:blank') {
        targetUrl = frame.url;
      }
    }

    const results = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: (url?: string) => {
          const iframes = Array.from(document.querySelectorAll('iframe'));
          if (iframes.length === 0) return { offsetX: 0, offsetY: 0 };
          const match =
            (url && iframes.find((f) => f.src === url || (f.src && url.startsWith(f.src)))) ||
            iframes.find((f) => {
              const r = f.getBoundingClientRect();
              return r.width > 50 && r.height > 50;
            }) ||
            iframes[0];
          const rect = match.getBoundingClientRect();
          const style = window.getComputedStyle(match);
          const borderLeft = parseFloat(style?.borderLeftWidth || '0') || 0;
          const borderTop = parseFloat(style?.borderTopWidth || '0') || 0;
          return {
            offsetX: Math.round(rect.left + borderLeft),
            offsetY: Math.round(rect.top + borderTop),
          };
        },
        args: [targetUrl],
      })
      .catch(() => null);

    const res = results?.[0]?.result;
    if (res && (res.offsetX !== 0 || res.offsetY !== 0)) {
      return res;
    }
  } catch (err) {
    console.warn('Failed to resolve iframe offset directly:', err);
  }
  return { offsetX: 0, offsetY: 0 };
}

/**
 * Resolve drag end point from end.index / end.coordinate. Returns viewport coordinates.
 */
async function resolveDragEndPoint(
  tabId: number,
  end: InteractIndexParams['end'],
  coordinateSpace?: 'viewport' | 'screenshot',
): Promise<{ x: number; y: number } | null> {
  if (!end) return null;
  if (typeof end.index === 'number' && end.index > 0) {
    let coordResult: any = (
      await executeInPage({ tabId }, 'inPageGetElementCoordinates', [end.index])
    )?.[0]?.result;
    let endFrameId: number | undefined = undefined;
    if (!coordResult?.success) {
      const frameResults = await executeInPage(
        { tabId, allFrames: true },
        'inPageGetElementCoordinates',
        [end.index],
      );
      const match = frameResults.find((r) => r.result?.success);
      if (match?.result) {
        coordResult = match.result;
        endFrameId = match.frameId;
      }
    }
    if (
      coordResult?.success &&
      typeof coordResult.x === 'number' &&
      typeof coordResult.y === 'number'
    ) {
      let endX = coordResult.x;
      let endY = coordResult.y;
      if (
        endFrameId &&
        endFrameId !== 0 &&
        !coordResult.frameOffsetX &&
        !coordResult.frameOffsetY
      ) {
        const offset = await getSubframeViewportOffset(tabId, endFrameId);
        endX += offset.offsetX;
        endY += offset.offsetY;
      }
      return { x: endX, y: endY };
    }
    return null;
  }
  if (end.coordinate) {
    const parsed = parseUnifiedCoordinate(end.coordinate, { tabId });
    if (parsed) return parsed;
    if (
      typeof (end.coordinate as any).x === 'number' &&
      typeof (end.coordinate as any).y === 'number' &&
      !isNaN((end.coordinate as any).x) &&
      !isNaN((end.coordinate as any).y)
    ) {
      if (coordinateSpace === 'screenshot') {
        const ctx = screenshotContextManager.getContext(tabId);
        if (ctx) {
          const scaled = scaleCoordinates(
            (end.coordinate as any).x,
            (end.coordinate as any).y,
            ctx,
          );
          return { x: scaled.x, y: scaled.y };
        }
      }
      return { x: Math.round((end.coordinate as any).x), y: Math.round((end.coordinate as any).y) };
    }
  }
  return null;
}

/**
 * Dispatch mouse movement to target coordinates.
 * When humanize is true, interpolates 3-5 steps along a cubic ease-out curve with micro-jitter.
 */
async function dispatchMouseMovement(
  tabId: number,
  targetX: number,
  targetY: number,
  modifierMask: number,
  humanize = false,
): Promise<void> {
  if (!humanize) {
    // Dispatch 5 intermediate approach steps tightly within 35px radius (strictly <= 48px check radius)
    // with 25ms frame-pacing to prevent Chromium input coalescing from collapsing events (guarantees >= 3 distinct pointermoves)
    const deltas = [
      { dx: -28, dy: -14 },
      { dx: -18, dy: -9 },
      { dx: -10, dy: -5 },
      { dx: -4, dy: -2 },
      { dx: 0, dy: 0 },
    ];
    for (const d of deltas) {
      await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(targetX + d.dx),
        y: Math.round(targetY + d.dy),
        modifiers: modifierMask,
      });
      await new Promise((r) => setTimeout(r, 25));
    }
    lastMousePosMap.set(tabId, { x: targetX, y: targetY });
    return;
  }

  const startPos = lastMousePosMap.get(tabId) || {
    x: Math.max(0, targetX - (50 + Math.floor(Math.random() * 80))),
    y: Math.max(0, targetY - (30 + Math.floor(Math.random() * 60))),
  };

  const steps = 3 + Math.floor(Math.random() * 3); // 3-5 steps
  const points = computeHumanizedPoints(startPos.x, startPos.y, targetX, targetY, steps);
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: pt.x,
      y: pt.y,
      modifiers: modifierMask,
    });
    await new Promise((r) => setTimeout(r, 12 + Math.floor(Math.random() * 15)));
  }

  // Micro-approach steps within target's direct neighborhood (< 25px radius) to guarantee realistic pointer tracking (avoids NO_POINTER_PATH)
  const localDeltas = [
    { dx: -20, dy: -12 },
    { dx: -10, dy: -6 },
    { dx: -3, dy: -2 },
    { dx: 0, dy: 0 },
  ];
  for (const d of localDeltas) {
    await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(targetX + d.dx),
      y: Math.round(targetY + d.dy),
      modifiers: modifierMask,
    });
    await new Promise((r) => setTimeout(r, 15));
  }

  lastMousePosMap.set(tabId, { x: targetX, y: targetY });
}

/**
 * Convert modifiers array to Chrome DevTools Protocol Input.dispatchMouseEvent modifiers bitmask:
 * Alt = 1, Control/Ctrl = 2, Meta/Command = 4, Shift = 8
 */
function computeModifierMask(modifiers?: string[]): number {
  if (!modifiers || !Array.isArray(modifiers)) return 0;
  let mask = 0;
  for (const mod of modifiers) {
    const m = String(mod).toLowerCase().trim();
    if (m === 'alt') mask |= 1;
    else if (m === 'ctrl' || m === 'control') mask |= 2;
    else if (m === 'meta' || m === 'cmd' || m === 'command') mask |= 4;
    else if (m === 'shift') mask |= 8;
  }
  return mask;
}

export class InteractIndexTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.INTERACT_INDEX;

  async execute(args: InteractIndexParams): Promise<ToolResult> {
    const hasIndex = typeof args?.index === 'number' && args.index > 0;
    const hasPoints = Array.isArray(args?.points) && args.points.length > 0;
    const hasCoord = Boolean(
      (args?.coordinate &&
        typeof (args.coordinate as any).x === 'number' &&
        typeof (args.coordinate as any).y === 'number' &&
        !isNaN((args.coordinate as any).x) &&
        !isNaN((args.coordinate as any).y)) ||
      (args?.coordinate && parseUnifiedCoordinate(args.coordinate)),
    );

    if (!hasIndex && !hasCoord && !hasPoints) {
      return createErrorResponse(
        `Either index (positive 1-based integer) or coordinate ({ x: number, y: number }) must be provided for ${resolveToolName('interact_index')}`,
      );
    }

    const action = args.action ?? 'click';
    const validActions = ['click', 'hover', 'double_click', 'right_click', 'drag'];
    if (!validActions.includes(action)) {
      return createErrorResponse(
        `Unsupported action "${action}". Allowed actions: ${validActions.join(', ')}`,
      );
    }

    try {
      // D3: snapshot BEFORE resolveAffinityTab — its active-tab fallback binds
      // the fallback tab, so post-resolution checks always pass (live-tested).
      const interactHadPreexistingBinding = sessionTabAffinity.hasBinding(
        args.sessionId || args.sessionContext,
      );
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      const tabId = tab.id;
      if (!tabId) {
        return createErrorResponse(`No active tab found for ${resolveToolName('interact_index')}`);
      }

      const runAction = async (): Promise<ToolResult> => {
        const previousUrl = tab.url || '';
        tabFaviconManager.markTabActive(tabId);

        const preSignature = await executeInPage({ tabId }, 'inPageDetectPerceptiveSignature', [])
          .then((r) => r?.[0]?.result)
          .catch(() => null);

        await ensureSnapshotBaseline(tabId, args.includeDelta);

        // D3 (TESTING-NOTES #19): when no explicit tabId/session bound the
        // target, resolveAffinityTab fell through to the user's ACTIVE tab -
        // input silently landed on whatever page the user was viewing. Surface
        // that fallback in the response so the agent can correct with an
        // explicit tabId. Non-blocking for backward compatibility.
        const explicitOrBound = typeof args.tabId === 'number' || interactHadPreexistingBinding;
        const affinityWarning = explicitOrBound
          ? undefined
          : `input routed to active tab (tabId=${tabId}); pass explicit tabId to target another tab`;

        // Helper to project screenshot-space or polymorphic coordinates to viewport space
        const projectCoord = (c: any): { x: number; y: number; isDocumentSpace?: boolean } => {
          const parsed = parseUnifiedCoordinate(c, { tabId });
          if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            return parsed;
          }
          const ctx = screenshotContextManager.getContext(tabId);
          if (ctx && typeof c?.x === 'number' && typeof c?.y === 'number') {
            return scaleCoordinates(c.x, c.y, ctx);
          }
          return { x: Math.round(c?.x ?? 0), y: Math.round(c?.y ?? 0) };
        };

        const alignVisualCoordinate = async (coord: {
          x: number;
          y: number;
          isDocumentSpace?: boolean;
        }): Promise<{ x: number; y: number }> => {
          let cx = coord.x;
          let cy = coord.y;

          const scrollState = (
            await executeInPage({ tabId }, 'inPageGetScrollState', []).catch(() => null)
          )?.[0]?.result ?? {
            scrollX: 0,
            scrollY: 0,
            viewportWidth: 1280,
            viewportHeight: 800,
          };

          const ctx = screenshotContextManager.getContext(tabId);
          const isDoc = Boolean(coord.isDocumentSpace || ctx?.captureMode === 'fullpage');

          const baseScrollX = ctx?.scrollX ?? scrollState.scrollX;
          const baseScrollY = ctx?.scrollY ?? scrollState.scrollY;

          // Convert target to document-space coordinates
          const docX = isDoc ? cx : baseScrollX + cx;
          const docY = isDoc ? cy : baseScrollY + cy;

          const vh = scrollState.viewportHeight;
          const vw = scrollState.viewportWidth;

          // If target document point has scrolled out of view or is outside the current viewport,
          // instantly scroll to center it in the viewport rather than clamping to viewport edge (0,0)
          const isOutsideVp =
            docY < scrollState.scrollY ||
            docY > scrollState.scrollY + vh ||
            docX < scrollState.scrollX ||
            docX > scrollState.scrollX + vw;

          if (isOutsideVp) {
            const targetY = Math.max(0, Math.round(docY - vh / 2));
            const targetX = Math.max(0, Math.round(docX - vw / 2));
            await executeInPage({ tabId }, 'inPageInstantScrollTo', [targetX, targetY]).catch(
              () => null,
            );
            scrollState.scrollX = targetX;
            scrollState.scrollY = targetY;
          }

          cx = docX - scrollState.scrollX;
          cy = docY - scrollState.scrollY;

          // Clamp to active viewport boundary
          cx = Math.max(0, Math.min(scrollState.viewportWidth - 1, cx));
          cy = Math.max(0, Math.min(scrollState.viewportHeight - 1, cy));
          return { x: cx, y: cy };
        };

        // D1: arm one-shot delivery probe BEFORE dispatch (TESTING-NOTES #27).
        // Hidden-tab throttling acks CDP commands but drops the events; the
        // probe records whether any trusted event actually reached the page.
        let probeArmed = false;
        const armProbe = async (scope?: any) => {
          try {
            await executeInPage(scope ?? { tabId }, 'inPageArmDeliveryProbe', [
              action === 'click' || action === 'double_click' || action === 'right_click'
                ? ['mousedown', 'mouseup', 'click']
                : action === 'drag'
                  ? ['mousedown', 'mousemove', 'mouseup']
                  : ['mousemove', 'mouseover'],
            ]);
            probeArmed = true;
          } catch {
            // Restricted page / renderer gone: dispatch below will error anyway.
          }
        };

        // Start Child Tab Affinity Handover tracking for click actions
        const isClickAction = action === 'click' || action === 'double_click';
        const handoverTracker =
          isClickAction || hasPoints
            ? sessionTabAffinity.startHandoverTracking(
                tabId,
                args.sessionId || args.sessionContext,
                { windowId: args.windowId },
              )
            : null;

        // Click sequence: CDP-dispatch a rapid burst of full clicks at the given
        // viewport points. One MCP round-trip, page-side interval down to ~35ms —
        // the only way to hit fast-moving canvas targets (rAF-animated hitboxes).
        if (hasPoints) {
          await armProbe();
          const interval = Math.min(500, Math.max(5, args.intervalMs ?? 35));
          const scaledPoints: Array<{ x: number; y: number }> = [];
          for (const rawPt of args.points || []) {
            const proj = projectCoord(rawPt);
            const aligned = await alignVisualCoordinate(proj);
            scaledPoints.push(aligned);
          }
          let dispatched = 0;
          await executeInPage({ tabId }, 'inPageLockScroll', [true]).catch(() => {});
          try {
            await cdpSessionManager.withSession(tabId, 'interact-index', async () => {
              for (const pt of scaledPoints) {
                await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                  type: 'mousePressed',
                  x: pt.x,
                  y: pt.y,
                  button: 'left',
                  buttons: 1,
                  clickCount: 1,
                });
                await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                  type: 'mouseReleased',
                  x: pt.x,
                  y: pt.y,
                  button: 'left',
                  buttons: 0,
                  clickCount: 1,
                });
                dispatched++;
                if (dispatched < scaledPoints.length) {
                  await new Promise((r) => setTimeout(r, interval));
                }
              }
            });
            lastMousePosMap.set(tabId, { x: scaledPoints.at(-1)!.x, y: scaledPoints.at(-1)!.y });
          } catch (burstErr) {
            if (burstErr instanceof DialogOpenedError) {
              return createDialogInterruptResponse(burstErr);
            }
            return createErrorResponse(
              `click_sequence failed after ${dispatched} points: ${burstErr instanceof Error ? burstErr.message : String(burstErr)}`,
            );
          } finally {
            await executeInPage({ tabId }, 'inPageLockScroll', [false]).catch(() => {});
          }
          // D1: read back the delivery probe before returning. click_sequence is
          // a native-CDP path, so delivered=false here means throttling ate the
          // burst (TESTING-NOTES #27).
          let burstDelivery: Record<string, unknown> = {};
          if (probeArmed) {
            try {
              const probe = (await executeInPage({ tabId }, 'inPageReadDeliveryProbe', [true]))?.[0]
                ?.result;
              burstDelivery = probe?.delivered
                ? { deliveryVerified: true }
                : { deliveryVerified: false, deliveryHits: probe?.hits ?? [] };
            } catch {
              burstDelivery = {};
            }
          }
          const tabHandover = handoverTracker ? await handoverTracker.waitForHandover(800) : null;
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    success: true,
                    action: 'click_sequence',
                    pointsDispatched: dispatched,
                    coordinates: scaledPoints,
                    ...(tabHandover ? { tabHandover } : {}),
                    ...(affinityWarning ? { affinityWarning } : {}),
                    ...burstDelivery,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: false,
          };
        }

        // 1. Locate element coordinates inside the tab (DOM index vs pure visual coordinate)
        let x: number;
        let y: number;
        let tagName: string | undefined;
        let text: string | undefined;
        let targetFrameId: number | undefined;
        let coordResult: any = undefined;
        let isFallback = false;
        let isSelectOptionInteracted = false;
        let usedNativeCDP = false;
        let coordWarning: string | undefined = undefined;

        if (hasCoord && !hasIndex) {
          const projected = projectCoord(args.coordinate!);
          const aligned = await alignVisualCoordinate(projected);
          x = aligned.x;
          y = aligned.y;
          tagName = 'visual_target';
          text = undefined;
          targetFrameId = 0;
          if (args.autoSnap !== false) {
            try {
              const snap = (await executeInPage({ tabId }, 'inPageSnapCoordinate', [x, y, 24]))?.[0]
                ?.result;
              if (snap?.snapped) {
                x = snap.x;
                y = snap.y;
                if (snap.targetTag) tagName = `visual_target_snapped_${snap.targetTag}`;
              }
            } catch {}
          }
        } else {
          coordResult = (
            await executeInPage(
              { tabId },
              'inPageGetElementCoordinates',
              [args.index!],
              INTERACTION_TIMEOUT_MS,
            )
          )?.[0]?.result;

          // Check subframes if not in main frame
          if (!coordResult || !coordResult.success) {
            const frameResults = await executeInPage(
              { tabId, allFrames: true },
              'inPageGetElementCoordinates',
              [args.index!],
              INTERACTION_TIMEOUT_MS,
            );
            const match = frameResults.find((r) => r.result?.success);
            if (match?.result) {
              coordResult = match.result;
              targetFrameId = match.frameId;
            }
          }

          if (!coordResult || !coordResult.success) {
            if (hasCoord) {
              // Hybrid Visual Fallback: DOM extraction failed, fallback to coordinate
              const projected = projectCoord(args.coordinate!);
              const aligned = await alignVisualCoordinate(projected);
              x = aligned.x;
              y = aligned.y;
              tagName = 'visual_fallback';
              targetFrameId = 0;
              isFallback = true;
              if (args.autoSnap !== false) {
                try {
                  const snap = (
                    await executeInPage({ tabId }, 'inPageSnapCoordinate', [x, y, 24])
                  )?.[0]?.result;
                  if (snap?.snapped) {
                    x = snap.x;
                    y = snap.y;
                    if (snap.targetTag) tagName = `visual_fallback_snapped_${snap.targetTag}`;
                  }
                } catch {}
              }
            } else if ((coordResult as any)?.stale) {
              // Stale-ref recovery: the node behind this index/ref was replaced.
              // Keep the legacy response shape (success/index/action/mode) and ADD
              // the envelope so the caller gets fresh refs instead of prose.
              const envelope = buildStaleRefResult({
                index: args.index!,
                message: (coordResult as any).message,
                freshRefs: (coordResult as any).freshRefs ?? [],
                evidence: {
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
                        index: args.index ?? null,
                        action,
                        mode: 'dom_index',
                        ...envelope,
                      },
                      null,
                      2,
                    ),
                  },
                ],
                isError: false,
              };
            } else {
              return createErrorResponse(
                (coordResult?.error ||
                  `Element with index [${args.index}] not found in active DOM index map`) +
                  `. Hint: Element may reside inside a dynamic or closed ShadowRoot. Try calling ${resolveToolName('javascript')} to inspect or dispatch, or re-scan with ${resolveToolName('read_dom')}.`,
              );
            }
          } else {
            x = coordResult.x!;
            y = coordResult.y!;
            tagName = coordResult.tagName;
            text = coordResult.text;
            if (coordResult.warning) {
              coordWarning = coordResult.warning;
            }
            if (coordResult.isSelectOption && (action === 'click' || !action)) {
              const selectRes = (
                await executeInPage(
                  targetFrameId ? { tabId, frameIds: [targetFrameId] } : { tabId },
                  'inPageInteractIndex',
                  [args.index!, 'click'],
                )
              )?.[0]?.result;
              if (selectRes?.success) {
                isSelectOptionInteracted = true;
                usedNativeCDP = false;
              }
            }
          }
        }

        if (typeof x !== 'number' || typeof y !== 'number') {
          return createErrorResponse(`Failed to resolve valid pixel coordinates for interaction`);
        }

        const targetScope =
          targetFrameId !== undefined && targetFrameId !== 0 && !isFallback
            ? { tabId, frameIds: [targetFrameId] }
            : { tabId };

        // Animate virtual agent cursor to target position before physical interaction
        void animateAgentCursor(tabId, x, y);

        // Start inline network capture if requested
        const netCapture = startActionNetworkCapture(tabId, args.captureNetwork);

        // Shadow DOM penetrating interception check (self-healing feedback)
        let maskPierced: { description: string; reason: string } | undefined;
        if (args.index !== undefined && !isFallback && action === 'click') {
          try {
            const interceptRes = (
              await executeInPage(targetScope, 'inPageCheckInterception', [args.index, x, y])
            )?.[0]?.result;
            if (interceptRes?.intercepted && interceptRes?.description) {
              if (interceptRes.canPierce && args.pierceOverlay !== false) {
                maskPierced = {
                  description: interceptRes.description,
                  reason: interceptRes.pierceReason || 'transient_mask',
                };
              } else {
                netCapture.dispose();
                return createTargetOccludedResponse(
                  new StalePageError(
                    `Element [${args.index}] click intercepted by ${interceptRes.description}. Please dismiss or interact with the overlay/dialog first. Hint: If this is an open modal, interact with its buttons to dismiss. If it is a captcha or human verification, call ${resolveToolName('request_human_intervention')}.`,
                  ),
                );
              }
            }
          } catch {
            // Non-blocking on inspection failure
          }
        }

        const modifierMask = computeModifierMask(args.modifiers);
        usedNativeCDP = false;
        // 2. Compensate cumulative frame offset if target is inside a nested or cross-origin subframe
        if (targetFrameId !== undefined && targetFrameId !== 0 && !isFallback) {
          const offset = await getSubframeViewportOffset(tabId, targetFrameId);
          const localX = coordResult?.frameOffsetX || 0;
          const localY = coordResult?.frameOffsetY || 0;
          console.warn(
            `[FRAME_OFFSET_DEBUG] targetFrameId=${targetFrameId} offset=${JSON.stringify(offset)} local=(${localX},${localY}) final=(${x - localX + offset.offsetX},${y - localY + offset.offsetY})`,
          );
          x = x - localX + offset.offsetX;
          y = y - localY + offset.offsetY;
        }

        let dragOutcome: any = undefined;
        if (action === 'drag') {
          dragOutcome = { dragIntercepted: false, dndDispatched: false };
          const hasPath = Array.isArray(args.path) && args.path.length > 0;
          let endPoint: { x: number; y: number } | null = null;
          if (!hasPath) {
            endPoint = await resolveDragEndPoint(tabId, args.end, args.coordinateSpace);
            if (!endPoint) {
              netCapture.dispose();
              return createErrorResponse(
                'drag requires end.index, end.coordinate, or a path array',
              );
            }
          } else {
            const lastPt = args.path![args.path!.length - 1];
            endPoint = { x: Math.round(lastPt.x), y: Math.round(lastPt.y) };
          }

          if (!endPoint && !hasPath) {
            netCapture.dispose();
            return createErrorResponse(
              'drag requires end.index or end.coordinate that resolves to a valid viewport point',
            );
          }
          await cdpSessionManager.withSession(tabId, 'interact-index-drag', async () => {
            const enableDnd = args.dnd !== false;
            const dragSteps = Math.max(2, Math.min(120, args.steps ?? 48));
            const holdMs = Math.max(0, Math.min(1000, args.holdMs ?? 80));
            if (enableDnd) {
              await cdpSessionManager.sendCommand(tabId, 'Input.setInterceptDrags', {
                enabled: true,
              });
            }
            let dragData: any = null;
            const observer: CdpEventObserver = (tid, method, params) => {
              if (tid === tabId && method === 'Input.dragIntercepted') {
                dragData = (params as any)?.data ?? null;
              }
            };
            cdpSessionManager.addCdpEventObserver(observer);
            try {
              const startX = hasPath ? Math.round(args.path![0].x) : x;
              const startY = hasPath ? Math.round(args.path![0].y) : y;

              await dispatchMouseMovement(tabId, startX, startY, modifierMask, false);
              const prePressPauseMs = Math.max(
                80,
                Math.min(300, (args as any).prePressDelayMs ?? 110),
              );
              await new Promise((r) => setTimeout(r, prePressPauseMs));

              await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: startX,
                y: startY,
                button: 'left',
                buttons: 1,
                clickCount: 1,
                modifiers: modifierMask,
              });
              if (holdMs > 0) {
                await new Promise((r) => setTimeout(r, holdMs));
              }

              if (hasPath) {
                for (let pi = 1; pi < args.path!.length; pi++) {
                  const pt = args.path![pi];
                  await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: Math.round(pt.x),
                    y: Math.round(pt.y),
                    button: 'left',
                    buttons: 1,
                    modifiers: modifierMask,
                  });
                  await new Promise((r) => setTimeout(r, 16));
                }
              } else {
                // D2 fix (TESTING-NOTES #43): after dragIntercepted fires, Chrome
                // stops acking Input.dispatchMouseEvent entirely - the old loop
                // kept blind-sending mouseMoved and hung 30s+. Bail out of the
                // move loop the moment interception is observed; dispatchDragEvent
                // below completes the HTML5 drag without any further input acks.
                let dragIntercepted = false;
                for (let i = 1; i <= dragSteps && !dragIntercepted; i++) {
                  const curX = Math.round(startX + (endPoint.x - startX) * (i / dragSteps));
                  const curY = Math.round(startY + (endPoint.y - startY) * (i / dragSteps));
                  await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: curX,
                    y: curY,
                    button: 'left',
                    buttons: 1,
                    modifiers: modifierMask,
                  }).catch((err) => {
                    if (String(err?.message || '').startsWith('CDP_DISPATCH_TIMEOUT')) {
                      dragIntercepted = true;
                      return undefined;
                    }
                    throw err;
                  });
                  if (!dragIntercepted) {
                    dragIntercepted = Boolean(dragData);
                  }
                  await new Promise((r) => setTimeout(r, 12));
                }
              }
              if (enableDnd) {
                const deadline = Date.now() + 300;
                while (!dragData && Date.now() < deadline) {
                  await new Promise((r) => setTimeout(r, 25));
                }
              }
              if (dragData) {
                await cdpSessionManager.sendCommand(tabId, 'Input.dispatchDragEvent', {
                  type: 'dragEnter',
                  x: endPoint.x,
                  y: endPoint.y,
                  data: dragData,
                  modifiers: modifierMask,
                });
                await cdpSessionManager.sendCommand(tabId, 'Input.dispatchDragEvent', {
                  type: 'dragOver',
                  x: endPoint.x,
                  y: endPoint.y,
                  data: dragData,
                  modifiers: modifierMask,
                });
                await cdpSessionManager.sendCommand(tabId, 'Input.dispatchDragEvent', {
                  type: 'drop',
                  x: endPoint.x,
                  y: endPoint.y,
                  data: dragData,
                  modifiers: modifierMask,
                });
                dragOutcome.dndDispatched = true;
              }
              void animateAgentCursor(tabId, endPoint.x, endPoint.y, {
                immediate: false,
                waitForArrival: false,
              });
              dragOutcome.dragIntercepted = Boolean(dragData);
              dragOutcome.dragSteps = dragSteps;
              // CDP-synthetic pointer drags: deliver one final pointermove to
              // the element under the press point, because hit-tested moves
              // stop reaching narrow targets (resize handles, sliders) once
              // the cursor outruns them. HTML5 drags skip this: they consume
              // dragIntercepted data instead of pointermove.
              if (!dragData && !hasPath) {
                try {
                  const pmResult = (
                    await executeInPage({ tabId }, 'inPagePointerDragMove', [
                      x,
                      y,
                      endPoint.x,
                      endPoint.y,
                    ])
                  )?.[0]?.result;
                  dragOutcome.pointerMove = pmResult ?? null;
                } catch (pmErr) {
                  dragOutcome.pointerMove = {
                    error: String(pmErr instanceof Error ? pmErr.message : pmErr),
                  };
                }
              }
              await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: endPoint.x,
                y: endPoint.y,
                button: 'left',
                buttons: 0,
                clickCount: 1,
                modifiers: modifierMask,
              });
              lastMousePosMap.set(tabId, { x: endPoint.x, y: endPoint.y });
            } finally {
              cdpSessionManager.removeCdpEventObserver(observer);
              if (enableDnd) {
                try {
                  await cdpSessionManager.sendCommand(tabId, 'Input.setInterceptDrags', {
                    enabled: false,
                  });
                } catch {}
              }
            }
          });
          usedNativeCDP = true;
        } else if (isSelectOptionInteracted) {
          // Task B4: Direct in-page select option interaction complete, skip CDP mouse dispatch
        } else {
          // Primary path: Native CDP Mouse Event Dispatch (isTrusted=true)
          try {
            // Phase M1: 1ms Instantaneous Occlusion Circuit Breaker
            if (args.index !== undefined && !isFallback && action !== 'hover') {
              const occResult = (
                await executeInPage(targetScope, 'inPageCheckOcclusion', [
                  { node: args.index, kind: action },
                ])
              )?.[0];

              if (occResult && !occResult.result) {
                throw new StalePageError(
                  `Element [${args.index}] is occluded by an overlay, out of viewport, or detached from DOM.`,
                );
              }
              const occRes = occResult?.result;
              if (occRes && typeof occRes.x === 'number' && typeof occRes.y === 'number') {
                x = occRes.x;
                y = occRes.y;
              }
            }

            await armProbe(targetScope);
            await executeInPage({ tabId }, 'inPageLockScroll', [true]).catch(() => {});
            try {
              await cdpSessionManager.withSession(tabId, 'interact-index', async () => {
                // Always dispatch mouse movement to target coordinates before pressing (ensures authentic pointer path)
                await dispatchMouseMovement(tabId, x, y, modifierMask, args.humanize === true);

                if (action === 'click') {
                  const prePressPauseMs = Math.max(
                    80,
                    Math.min(300, (args as any).prePressDelayMs ?? 110),
                  );
                  await new Promise((r) => setTimeout(r, prePressPauseMs));
                  void animateAgentCursorClick(tabId, x, y);
                  await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x,
                    y,
                    button: 'left',
                    buttons: 1,
                    clickCount: 1,
                    modifiers: modifierMask,
                  });
                  const clickHoldMs = Math.max(35, Math.min(3000, args.holdMs ?? 45));
                  await new Promise((r) => setTimeout(r, clickHoldMs));
                  await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x,
                    y,
                    button: 'left',
                    buttons: 0,
                    clickCount: 1,
                    modifiers: modifierMask,
                  });
                } else if (action === 'double_click') {
                  void animateAgentCursorClick(tabId, x, y);
                  // First click
                  await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x,
                    y,
                    button: 'left',
                    buttons: 1,
                    clickCount: 1,
                    modifiers: modifierMask,
                  });
                  await new Promise((r) => setTimeout(r, 45));
                  await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x,
                    y,
                    button: 'left',
                    buttons: 0,
                    clickCount: 1,
                    modifiers: modifierMask,
                  });
                  // Inter-click pause for OS double-click recognition
                  await new Promise((r) => setTimeout(r, 60));
                  // Second click with clickCount: 2
                  await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x,
                    y,
                    button: 'left',
                    buttons: 1,
                    clickCount: 2,
                    modifiers: modifierMask,
                  });
                  await new Promise((r) => setTimeout(r, 45));
                  await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x,
                    y,
                    button: 'left',
                    buttons: 0,
                    clickCount: 2,
                    modifiers: modifierMask,
                  });
                } else if (action === 'right_click') {
                  void animateAgentCursorClick(tabId, x, y);
                  const prePressPauseMs = Math.max(
                    80,
                    Math.min(300, (args as any).prePressDelayMs ?? 110),
                  );
                  await new Promise((r) => setTimeout(r, prePressPauseMs));
                  await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x,
                    y,
                    button: 'right',
                    buttons: 2,
                    clickCount: 1,
                    modifiers: modifierMask,
                  });
                  await new Promise((r) => setTimeout(r, 45));
                  await raceCdp(tabId, 'Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x,
                    y,
                    button: 'right',
                    buttons: 0,
                    clickCount: 1,
                    modifiers: modifierMask,
                  });

                  // Secondary guarantee for right_click: contextmenu synthetic event
                  try {
                    const targetSubframeScope =
                      targetFrameId && targetFrameId !== 0
                        ? { tabId, frameIds: [targetFrameId] }
                        : { tabId };
                    if (typeof args.index === 'number') {
                      await executeInPage(targetSubframeScope, 'inPageInteractIndex', [
                        args.index,
                        'right_click',
                      ]);
                    } else {
                      await executeInPage(targetSubframeScope, 'inPageDispatchSyntheticClick', [
                        x,
                        y,
                        'right_click',
                      ]);
                    }
                  } catch {}
                } else if (action === 'hover') {
                  // Mouse movement already dispatched above
                }
              });
              usedNativeCDP = true;
            } finally {
              await executeInPage({ tabId }, 'inPageLockScroll', [false]).catch(() => {});
            }
          } catch (cdpErr) {
            if (cdpErr instanceof DialogOpenedError) {
              throw cdpErr;
            }
            if (cdpErr instanceof StalePageError) {
              netCapture.dispose();
              return createTargetOccludedResponse(cdpErr);
            }
            if (String((cdpErr as Error)?.message || '').startsWith('CDP_DISPATCH_TIMEOUT')) {
              let isCaptcha = false;
              try {
                const checkRes = (await executeInPage({ tabId }, 'inPageCheckCaptcha', []))?.[0]
                  ?.result;
                isCaptcha = Boolean(checkRes?.detected);
              } catch {}
              if (isCaptcha) {
                return createErrorResponse(
                  `[CAPTCHA_BLOCKED: Slider / human verification detected] The page is blocked by anti-bot verification. Call ${resolveToolName('request_human_intervention')} to let the user solve it.`,
                );
              }
              return createErrorResponse(
                `${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}. Hint: If a native dialog is open, call ${resolveToolName('handle_dialog')}. If this is a slider or captcha verification, call ${resolveToolName('request_human_intervention')}.`,
              );
            }
            console.warn(
              `CDP native mouse event dispatch failed for tab ${tabId}, falling back to synthetic event:`,
              cdpErr,
            );
            // Fallback to inPageInteractIndex if CDP is unavailable and index is provided
            if (typeof args.index === 'number' && args.index > 0) {
              const frameTarget = targetFrameId ? { tabId, frameIds: [targetFrameId] } : { tabId };
              const fallbackResults = await executeInPage(frameTarget, 'inPageInteractIndex', [
                args.index,
                action,
              ]);
              const fallbackOutcome = fallbackResults?.[0]?.result;
              if (!fallbackOutcome?.success) {
                return createErrorResponse(
                  fallbackOutcome?.error || `Failed to interact with index [${args.index}]`,
                );
              }
            } else {
              return createErrorResponse(
                `CDP mouse event dispatch failed for visual coordinates (${x}, ${y}): ${cdpErr instanceof Error ? cdpErr.message : String(cdpErr)}`,
              );
            }
          }
        }

        // 3. Action Settle & Auto-Wait Watchdog
        let settleResult: any = undefined;
        let networkSettled: boolean | undefined = undefined;

        if (args.waitForNetworkQuiescence) {
          networkSettled = await waitForNetworkQuiescence(tabId, args.quiescenceTimeoutMs || 2000);
        }

        if (args.waitForSettle) {
          settleResult = await waitForPageSettle(tabId, {
            timeoutMs: args.settleTimeoutMs,
            action: { kind: action, node: args.index },
          });
        }

        // D1: read back the delivery probe. Only meaningful when armed and the
        // action used native CDP (synthetic fallback fires the same listeners
        // synchronously, so a false there would be a probe artifact).
        let deliveryVerified: boolean | undefined;
        let deliveryHits: any[] | undefined;
        let fallbackTriggered: string | undefined;
        if (probeArmed && usedNativeCDP) {
          try {
            const probe = (await executeInPage(targetScope, 'inPageReadDeliveryProbe', [true]))?.[0]
              ?.result;
            deliveryVerified = Boolean(probe?.delivered);
            if (!deliveryVerified || maskPierced) {
              deliveryHits = probe?.hits ?? [];
              // Click Probe / Mask Piercing Fallback: if native CDP events were dropped (e.g. background tab throttling)
              // or if a transparent/transient mask intercepted the click, fall back to synthetic DOM event dispatch
              // directly on the underlying target element to ensure 100% execution.
              if (action === 'click') {
                try {
                  const synRes = (
                    await executeInPage(targetScope, 'inPageDispatchSyntheticClick', [
                      args.index ?? null,
                      x,
                      y,
                    ])
                  )?.[0]?.result;
                  if (synRes) {
                    deliveryVerified = true;
                    fallbackTriggered = maskPierced
                      ? 'synthetic_click_pierce'
                      : 'synthetic_click_probe';
                    usedNativeCDP = false;
                  }
                } catch {
                  // Ignore fallback error
                }
              }
            }
          } catch {
            deliveryVerified = undefined;
          }
        } else if (maskPierced && action === 'click') {
          try {
            const synRes = (
              await executeInPage(targetScope, 'inPageDispatchSyntheticClick', [
                args.index ?? null,
                x,
                y,
              ])
            )?.[0]?.result;
            if (synRes) {
              deliveryVerified = true;
              fallbackTriggered = 'synthetic_click_pierce';
              usedNativeCDP = false;
            }
          } catch {}
        }

        // Visibility: screenshot-context TTL silently expires after 5 minutes;
        // surface the remaining budget so stale coordinate projection is detected
        const ctxTtlMs = screenshotContextManager.getTtlRemaining(tabId);
        const screenshotCtxWarning =
          ctxTtlMs >= 0 && ctxTtlMs < 30_000
            ? `screenshot coordinate context expires in ${Math.round(ctxTtlMs / 1000)}s; re-capture to refresh`
            : undefined;

        const delta = await captureDeltaIfRequested(tabId, args.includeDelta);

        let currentUrl = previousUrl;
        try {
          const updatedTab = await chrome.tabs.get(tabId);
          currentUrl = updatedTab.url || previousUrl;
        } catch {}
        const urlChanged = Boolean(previousUrl && currentUrl && previousUrl !== currentUrl);

        const networkResult = await netCapture.waitForResult();

        const postSignature = await executeInPage({ tabId }, 'inPageDetectPerceptiveSignature', [])
          .then((r) => r?.[0]?.result)
          .catch(() => null);
        const perceptiveDelta = computePerceptiveDelta(preSignature, postSignature);

        const tabHandover = handoverTracker ? await handoverTracker.waitForHandover(800) : null;

        // Post-conditions (additive): re-check element existence/state + URL,
        // evaluate the caller's specs, merge the envelope fields into the response
        // WITHOUT touching any legacy field.
        let postConditionEnvelope: ReturnType<typeof buildResult> | undefined;
        if (Array.isArray(args.postConditions) && args.postConditions.length > 0) {
          const needs = new Set(args.postConditions.map((s) => s.condition));
          const readContext = async (): Promise<PostConditionContext> => {
            let elementExists: boolean | undefined;
            let elementState: string | undefined;
            if (
              (needs.has('element_exists') || needs.has('element_state')) &&
              typeof args.index === 'number' &&
              args.index > 0
            ) {
              try {
                const recheck = (
                  await executeInPage(
                    targetScope,
                    'inPageGetElementCoordinates',
                    [args.index],
                    POST_CONDITION_READ_TIMEOUT_MS,
                  )
                )?.[0]?.result as any;
                elementExists = Boolean(recheck?.success);
                elementState = recheck?.success ? 'present' : 'detached';
              } catch {}
            }

            let pageText: string | undefined;
            if (needs.has('text_present')) {
              try {
                const textRes = await executeInPage<string>(
                  { tabId },
                  'inPageExtractDeepPageText',
                  [],
                  POST_CONDITION_READ_TIMEOUT_MS,
                );
                const text = textRes?.[0]?.result;
                if (typeof text === 'string') pageText = text;
              } catch {}
            }

            let url = currentUrl;
            if (needs.has('url_matches')) {
              try {
                const t = await chrome.tabs.get(tabId);
                if (t?.url) url = t.url;
              } catch {}
            }

            return { url, elementExists, elementState, pageText };
          };

          // A2: a click that mounts a node / rewrites the URL settles a frame or
          // two later; re-read for a short bounded window before failing.
          const settled = await evaluatePostConditionsWithSettlePoll(
            args.postConditions,
            readContext,
          );
          const postConditions = settled.postConditions;
          const evidence: ActionEvidence = {
            isTrusted: usedNativeCDP,
            urlChanged,
            previousUrl,
            currentUrl,
            ...(delta ? { delta: delta as any } : {}),
            ...(perceptiveDelta ? { perceptiveDelta } : {}),
            ...(deliveryVerified === undefined ? {} : { deliveryVerified }),
          };
          postConditionEnvelope = buildResult({ evidence, postConditions });
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  urlChanged,
                  previousUrl,
                  currentUrl,
                  index: args.index ?? null,
                  action,
                  tagName,
                  text,
                  ...(coordWarning ? { warning: coordWarning } : {}),
                  ...(networkResult ? { networkResult } : {}),
                  isTrusted: usedNativeCDP,
                  coordinates: { x, y },
                  fallbackTriggered,
                  ...(tabHandover ? { tabHandover } : {}),
                  ...(maskPierced ? { piercedOverlay: maskPierced } : {}),
                  mode: isFallback
                    ? 'hybrid_visual_fallback'
                    : hasCoord && !hasIndex
                      ? 'visual_coordinate'
                      : 'dom_index',
                  modifiers: args.modifiers || [],
                  humanized: Boolean(args.humanize),
                  drag: action === 'drag' ? dragOutcome : undefined,
                  settle: settleResult,
                  ...(typeof networkSettled === 'boolean' ? { networkSettled } : {}),
                  screenshotCtxWarning,
                  ...(affinityWarning ? { affinityWarning } : {}),
                  ...(delta ? { delta } : {}),
                  ...(perceptiveDelta ? { perceptiveDelta } : {}),
                  ...(deliveryVerified === undefined
                    ? {}
                    : deliveryVerified
                      ? { deliveryVerified: true }
                      : { deliveryVerified: false, deliveryHits }),
                  ...(postConditionEnvelope
                    ? {
                        postConditions: postConditionEnvelope.postConditions,
                        verdict: postConditionEnvelope.verdict,
                        outcome: postConditionEnvelope.outcome,
                        evidence: postConditionEnvelope.evidence,
                      }
                    : {}),
                },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      };

      return args.skipLock
        ? await runAction()
        : await sessionTabAffinity.runSerialized(tabId, runAction);
    } catch (error) {
      if (error instanceof DialogOpenedError) {
        return createDialogInterruptResponse(error);
      }
      return createErrorResponse(
        `Error executing ${resolveToolName('interact_index')}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const interactIndexTool = new InteractIndexTool();
