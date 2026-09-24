import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fillIndexTool } from '../entrypoints/background/tools/browser/fill-index';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';

/**
 * DEFECT A2 (observed live on the hostile fixture):
 *
 * After a successful submit the page flips its marker inside the submit
 * handler. The returned post-condition {condition:'text_present',
 * expected:'SUBMITTED:Hermes Benchmark'} came back passed:false with
 * actual:false and empty evidence — the read happened before the page updated.
 * A post-condition needs a short settle window before it may declare failure.
 */
const MARKER = 'SUBMITTED:Hermes Benchmark';

function mockFillHarness(options: { flipAfterFirstTextReadMs?: number } = {}) {
  let markerVisible = false;
  let textReads = 0;

  (globalThis as any).chrome = {
    tabs: {
      query: vi.fn(async () => [{ id: 601, url: 'https://fixture.example/hostile' }]),
      get: vi.fn(async () => ({ id: 601, url: 'https://fixture.example/hostile' })),
    },
    storage: {
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
    },
  };

  vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
    async (_target: any, fnName: string) => {
      if (fnName === 'inPageExtractDeepPageText') {
        textReads += 1;
        // The fixture flips its marker in the submit handler, i.e. a tick AFTER
        // the action returned: the first read necessarily precedes the update.
        if (
          textReads === 1 &&
          typeof options.flipAfterFirstTextReadMs === 'number'
        ) {
          setTimeout(() => {
            markerVisible = true;
          }, options.flipAfterFirstTextReadMs);
        }
        return [
          {
            result: markerVisible
              ? `hostile fixture ${MARKER}`
              : 'hostile fixture idle',
          },
        ] as any;
      }
      if (fnName === 'inPageVerifyInputCommitment') {
        return [{ result: { committed: true, currentValue: 'query' } }] as any;
      }
      if (fnName === 'inPageGetElementCoordinates') {
        return [{ result: { success: true, x: 10, y: 10, tagName: 'input' } }] as any;
      }
      return [{ result: { success: true, committed: true } }] as any;
    },
  );
}

describe('post-conditions settle-poll before reporting failure (DEFECT A2)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes text_present when the page flips its marker a tick after the submit', async () => {
    mockFillHarness({ flipAfterFirstTextReadMs: 50 });

    const res = await fillIndexTool.execute({
      index: 1,
      text: 'query',
      pressEnter: true,
      tabId: 601,
      waitForSettle: false,
      postConditions: [{ condition: 'text_present', expected: MARKER }],
    });

    const parsed = JSON.parse((res.content[0] as any).text);
    const cond = parsed.postConditions[0];
    expect(cond.passed).toBe(true);
    expect(cond.actual).toBe(true);
    // The poll must be visible in the evidence, and bounded.
    expect(cond.evidence.attempts).toBeGreaterThan(1);
    expect(cond.evidence.attempts).toBeLessThanOrEqual(4);
    expect(cond.evidence.waitedMs).toBeLessThanOrEqual(800);
    expect(parsed.verdict).toBe('applied');
  });

  it('still fails (and reports the real evidence) when the text never appears', async () => {
    mockFillHarness({});

    const started = Date.now();
    const res = await fillIndexTool.execute({
      index: 1,
      text: 'query',
      pressEnter: true,
      tabId: 601,
      waitForSettle: false,
      postConditions: [{ condition: 'text_present', expected: MARKER }],
    });
    const elapsed = Date.now() - started;

    const parsed = JSON.parse((res.content[0] as any).text);
    const cond = parsed.postConditions[0];
    expect(cond.passed).toBe(false);
    expect(cond.actual).toBe(false);
    expect(cond.evidence.attempts).toBe(4);
    expect(cond.evidence.waitedMs).toBe(600);
    expect(parsed.verdict).toBe('failed');
    // Bounded: the whole settle window must stay well under the 800ms budget
    // (+ the rest of the fill), not spin.
    expect(elapsed).toBeLessThan(3000);
  });

  it('adds no settle latency to non-pollable conditions (value_equals)', async () => {
    mockFillHarness({});

    const started = Date.now();
    const res = await fillIndexTool.execute({
      index: 1,
      text: 'query',
      tabId: 601,
      waitForSettle: false,
      postConditions: [{ condition: 'value_equals', expected: 'query' }],
    });
    const elapsed = Date.now() - started;

    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.postConditions[0].passed).toBe(true);
    expect(parsed.postConditions[0].evidence.attempts).toBeUndefined();
    expect(elapsed).toBeLessThan(800);
  });
});
