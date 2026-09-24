import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  inPageDOMPruner,
  getIsolatedIndexMap,
  getIndexFingerprintMap,
  getPersistentRefMap,
  findIndexedElement,
  resolveIndexedElementForAction,
  getCurrentIndexedElements,
  INTERACTION_TIMEOUT_MS,
  NAVIGATION_TIMEOUT_MS,
} from '../entrypoints/background/tools/browser/dom-indexer';
import {
  buildResult,
  buildStaleRefResult,
} from '../entrypoints/background/tools/browser/result-envelope';

/**
 * stale_ref recovery.
 *
 * Before this contract a target whose node was replaced in place decayed into a
 * prose string starting "ACTION REQUIRED: ..." (or was silently dropped): the
 * caller burned a whole timeout and never learned the ref was stale. Now the
 * locator signals staleness, and the tool answers with a structured stale_ref
 * verdict carrying the page's CURRENT refs so the caller can retry immediately.
 */

const stubRects = (): typeof Element.prototype.getBoundingClientRect => {
  const prev = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 110,
      bottom: 60,
      width: 100,
      height: 50,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return prev;
};

/** Prune the current DOM and return the persistent ref minted for `id`. */
const pruneRefFor = (id: string): string | undefined => {
  const res = inPageDOMPruner();
  const el = (res.indexedElements as any[]).find((e) => e.attributes?.id === id);
  return el?.ref;
};

/** Replace the node behind `ref` with an unrelated one, as a re-render would. */
const replaceNodeBehindRef = (ref: string): void => {
  const node = findIndexedElement(ref);
  node?.remove();
  const replacement = document.createElement('button');
  replacement.id = 'totally-different-node';
  replacement.textContent = 'Nothing like the original';
  document.body.appendChild(replacement);
};

describe('stale_ref recovery with fresh refs', () => {
  let prevRect: typeof Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    prevRect = stubRects();
    getIsolatedIndexMap().clear();
    getIndexFingerprintMap().clear();
    getPersistentRefMap().clear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = prevRect;
    document.body.innerHTML = '';
  });

  it('(a) a replaced ref yields verdict stale_ref with non-empty fresh refs and does not throw', () => {
    document.body.innerHTML =
      '<button id="target-btn">Delete Account</button><button id="keep-btn">Keep Alive</button>';
    const ref = pruneRefFor('target-btn');
    expect(ref).toBeTruthy();
    expect(findIndexedElement(ref!)).toBeTruthy();

    replaceNodeBehindRef(ref!);

    let outcome: ReturnType<typeof resolveIndexedElementForAction> | undefined;
    expect(() => {
      outcome = resolveIndexedElementForAction(ref!);
    }).not.toThrow();

    expect(outcome!.element).toBeNull();
    expect(outcome!.stale?.code).toBe('stale_ref');
    expect(outcome!.stale!.message).toContain(ref!);

    const envelope = buildStaleRefResult({
      index: ref!,
      message: outcome!.stale!.message,
      freshRefs: outcome!.stale!.freshRefs,
    });

    expect(envelope.verdict).toBe('stale_ref');
    expect(envelope.outcome).toContain('stale ref');
    expect(envelope.postConditions).toEqual([]);
    expect(envelope.recovery?.code).toBe('stale_ref');
    expect(envelope.recovery!.freshRefs.length).toBeGreaterThan(0);
  });

  it('(b) the fresh refs are immediately usable against the same page', () => {
    document.body.innerHTML =
      '<button id="target-btn">Delete Account</button><button id="keep-btn">Keep Alive</button>';
    const ref = pruneRefFor('target-btn');
    expect(ref).toBeTruthy();

    replaceNodeBehindRef(ref!);

    const freshRefs = getCurrentIndexedElements();
    expect(freshRefs.length).toBeGreaterThan(0);

    const freshNode = findIndexedElement(freshRefs[0].ref);
    expect(freshNode).toBeTruthy();
    expect(freshNode instanceof Element).toBe(true);

    // The stale signal carries the same retry-able refs.
    const signal = resolveIndexedElementForAction(ref!).stale;
    expect(signal!.freshRefs.length).toBeGreaterThan(0);
    expect(findIndexedElement(signal!.freshRefs[0].ref)).toBeTruthy();
  });

  it('(c) exposes a 10s interaction budget and a distinct 30s navigation budget', () => {
    expect(INTERACTION_TIMEOUT_MS).toBe(10_000);
    expect(NAVIGATION_TIMEOUT_MS).toBe(30_000);
    expect(INTERACTION_TIMEOUT_MS).not.toBe(NAVIGATION_TIMEOUT_MS);
  });

  it('(d) a successful action still returns its normal, non-stale verdict', () => {
    document.body.innerHTML = '<button id="keep-btn">Keep Alive</button>';
    const ref = pruneRefFor('keep-btn');
    expect(ref).toBeTruthy();

    const outcome = resolveIndexedElementForAction(ref!);
    expect(outcome.element).not.toBeNull();
    expect(outcome.stale).toBeUndefined();

    const ok = buildResult({
      evidence: {
        committed: true,
        urlChanged: false,
        previousUrl: 'https://example.test/a',
        currentUrl: 'https://example.test/a',
      },
      postConditions: [],
    });
    expect(ok.verdict).toBe('applied_unverified');
    expect(ok.recovery).toBeUndefined();
  });
});
