import { describe, it, expect } from 'vitest';
import { buildStaleRefFillResponse } from '../entrypoints/background/tools/browser/fill-index';
import { buildStaleRefResult } from '../entrypoints/background/tools/browser/result-envelope';

/**
 * Live finding: chrome_fill_index on a stale target answered with the CORRECT
 * structured verdict (stale_ref + recovery.freshRefs) but ALSO still carried
 * the legacy prose in its `error` field:
 *
 *   "Element with index [169] not found in active DOM index map. ACTION
 *    REQUIRED: Please call 'chrome_read_dom' to refresh the index tree before
 *    re-attempting interaction"
 *
 * The merged plan replaces that prose path with the structured recovery — the
 * two must not be emitted side by side.
 */

const LEGACY_PROSE =
  "Element with index [169] not found in active DOM index map. ACTION REQUIRED: Please call 'chrome_read_dom' to refresh the index tree before re-attempting interaction";

describe('chrome_fill_index stale_ref response', () => {
  it('carries the structured stale_ref recovery and NO legacy ACTION REQUIRED prose', () => {
    const index = 169;
    // Exactly what performPhysicalFill hands back on a stale target.
    const fillResult: Record<string, unknown> = {
      success: false,
      committed: false,
      index,
      ref: 'e169',
      selector: undefined,
      filledText: 'hello',
      isTrusted: false,
      method: 'synthetic_inpage',
      error: LEGACY_PROSE,
      diagnostics: LEGACY_PROSE,
    };
    const envelope = buildStaleRefResult({
      index,
      message:
        'ref/index [169] failed every resolution tier (persistent ref map, __clawFast snapshot, fingerprint re-match, deep selector); the node behind it was replaced or removed',
      freshRefs: [{ ref: 'e170' }] as any,
    });

    const res = buildStaleRefFillResponse({ index, fillResult, envelope });
    const text = res.content[0].text as string;

    expect(text).not.toContain('ACTION REQUIRED');
    expect(text).not.toContain('refresh the index tree');

    const body = JSON.parse(text);
    expect(body.verdict).toBe('stale_ref');
    expect(body.recovery.code).toBe('stale_ref');
    expect(body.recovery.freshRefs.length).toBeGreaterThan(0);
    // Hyrum's law: the legacy field names survive the change.
    for (const key of [
      'success',
      'index',
      'ref',
      'filledText',
      'isTrusted',
      'method',
      'committed',
      'verdict',
      'outcome',
      'evidence',
      'postConditions',
    ]) {
      expect(body).toHaveProperty(key);
    }
    // The error field, if present, is the structured message — never the prose.
    if ('error' in body) expect(body.error).toBe(body.recovery.message);
  });

  it('replaces any locator error with the structured message on the stale path', () => {
    const index = 7;
    const fillResult: Record<string, unknown> = {
      success: false,
      committed: false,
      error: 'Focus verification failed: target element [7] (<div>) is not active',
    };
    const envelope = buildStaleRefResult({
      index,
      message: 'ref/index [7] is stale',
      freshRefs: [] as any,
    });
    const res = buildStaleRefFillResponse({ index, fillResult, envelope });
    const body = JSON.parse(res.content[0].text as string);
    expect(body.verdict).toBe('stale_ref');
    expect(body.error).toBe('ref/index [7] is stale');
  });
});