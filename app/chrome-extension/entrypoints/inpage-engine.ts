/**
 * In-Page Engine - Inject Script Entry Point
 *
 * chrome.scripting.executeScript({ func }) serializes only the function body,
 * so in-page entrypoints referencing module-scope helpers (dom-indexer's
 * wrapElement / getIsolatedIndexMap / findIndexedElement / ...) crash with
 * ReferenceError in the page's isolated world - silently breaking the whole
 * indexing toolchain in release builds (read_dom / interact_index / fill_index
 * / screenshot SoM / dropdown options).
 *
 * Every in-page entrypoint is registered here on a namespace object; the
 * background injects this bundled file via chrome.scripting.executeScript
 * { files } and dispatches entrypoints by name - see
 * entrypoints/background/tools/browser/in-page-engine.ts.
 *
 * Build output: .output/chrome-mv3/inpage-engine.js (self-contained IIFE)
 */

import {
  inPageDOMPruner,
  inPageReindexFrame,
  inPageRealignHighlights,
  inPageScrollToIndex,
  inPageGetElementCoordinates,
  inPageArmDeliveryProbe,
  inPageReadDeliveryProbe,
  inPageGetFrameOrigin,
  inPageGetIndexCropRect,
  inPageGetAssetImage,
  inPageGetLinks,
  inPagePointerDragMove,
  inPageInteractIndex,
  inPageFocusIndex,
  inPageFillIndex,
  inPageExtractDropdownOptions,
  inPageExtractMarkdown,
  inPageLocateBySelector,
  inPageLocateByText,
  inPageFindSmartScrollTarget,
  inPagePerformSmartScroll,
  inPageCheckInterception,
  inPageDispatchSyntheticClick,
  inPageSnapCoordinate,
  detectEditorSemantics,
  getStickyOcclusionMargins,
  inPageDetectConfirmationTrap,
  inPageDeepResetElement,
  inPageVerifyInputCommitment,
  inPageDetectPerceptiveSignature,
  inPageQueryChoiceCandidates,
  inPageInsertMedia,
  inPageGetScrollState,
  inPageInstantScrollTo,
  inPageLockScroll,
  inPageExtractDeepPageText,
  deepElementFromPoint,
  querySelectorAllDeep,
  querySelectorDeep,
  inPageDismissOverlays,
  inPageVerifyActiveElement,
  inPageSelectCustomCombobox,
  inPageScrollUntilFound,
  inPageEnsureModalFocus,
  inPageDispatchInputEvents,
} from './background/tools/browser/dom-indexer';
import { inPageExtract } from './background/tools/browser/extract';
import { inPageWaitForDOMSettle } from '../utils/action-watchdog';
import {
  fastSnapshot,
  inPageCheckOcclusion,
  getNativeValueSetter,
  getClawFastCache,
} from './background/tools/browser/fast-snapshot';

export default defineUnlistedScript(() => {
  // Versioned idempotency guard. executeInPage re-injects this 81KB bundle on
  // every call; without the guard each injection rebuilds the IIFE and resets
  // module-scope state (notably dom-indexer's safeClickPoint map, which then
  // reads back empty on the next tool call). Keyed on a version string rather
  // than a boolean so a rebuilt extension still replaces the old namespace.
  // Bump when entrypoints are added/changed: the guard replaces the whole
  // namespace only when the version string differs, so a stale page-side
  // engine (surviving extension reloads in the same tab) would otherwise keep
  // missing newly registered entrypoints.
  const ENGINE_VERSION = '2026-09-24.1';
  const g = globalThis as any;
  if (g.__MCP_INPAGE__ && g.__MCP_INPAGE_VERSION__ === ENGINE_VERSION) {
    return;
  }
  g.__MCP_INPAGE_VERSION__ = ENGINE_VERSION;

  // Initialize single-point global window.__clawFast
  const clawFast = getClawFastCache();
  clawFast.snapshot = fastSnapshot;

  (globalThis as any).__MCP_INPAGE__ = {
    inPageDOMPruner,
    inPageReindexFrame,
    inPageRealignHighlights,
    inPageScrollToIndex,
    inPageGetElementCoordinates,
    inPageArmDeliveryProbe,
    inPageReadDeliveryProbe,
    inPageGetFrameOrigin,
    inPageGetIndexCropRect,
    inPageGetAssetImage,
    inPageGetLinks,
    inPagePointerDragMove,
    inPageInteractIndex,
    inPageFocusIndex,
    inPageFillIndex,
    inPageExtractDropdownOptions,
    inPageExtractMarkdown,
    inPageLocateBySelector,
    inPageLocateByText,
    inPageFindSmartScrollTarget,
    inPagePerformSmartScroll,
    inPageCheckInterception,
    inPageDispatchSyntheticClick,
    inPageSnapCoordinate,
    inPageWaitForDOMSettle,
    detectEditorSemantics,
    getStickyOcclusionMargins,
    inPageDetectConfirmationTrap,
    inPageDeepResetElement,
    inPageVerifyInputCommitment,
    inPageDetectPerceptiveSignature,
    inPageQueryChoiceCandidates,
    inPageInsertMedia,
    inPageGetScrollState,
    inPageInstantScrollTo,
    inPageLockScroll,
    inPageExtractDeepPageText,
    deepElementFromPoint,
    querySelectorAllDeep,
    querySelectorDeep,
    inPageDismissOverlays,
    inPageVerifyActiveElement,
    inPageSelectCustomCombobox,
    inPageScrollUntilFound,
    inPageEnsureModalFocus,
    inPageDispatchInputEvents,
    inPageExtract,
    inPageFastSnapshot: fastSnapshot,
    snapshot: fastSnapshot,
    inPageCheckOcclusion,
    getNativeValueSetter,
  };
});
