import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fillIndexTool } from '../entrypoints/background/tools/browser/fill-index';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';

/**
 * DEFECT A1 (observed live on Wikipedia search):
 *
 * chrome_fill_index typed 'Neo4j' into the search box, pressEnter submitted it
 * (committed:true, isTrusted:true, urlChanged:true) and the engine reported
 * success — yet the returned post-conditions came back
 * [{condition:'value_equals',expected:'Neo4j',actual:'',passed:false}] with
 * verdict 'failed', because the re-read ran AFTER the navigation and therefore
 * read the NEW page's empty search input.
 *
 * A failing assertion must never be reported for an action the engine itself
 * observed succeeding.
 */
function mockFillHarness(options: {
  startUrl: string;
  navigatedUrl: string;
  /** value the element held when the engine verified the commitment (pre-nav). */
  committedRead: string;
  /** value the SAME index resolves to once the page navigated (post-nav). */
  postNavRead: string;
}) {
  let navOccurred = false;
  (globalThis as any).chrome = {
    tabs: {
      query: vi.fn(async () => [{ id: 501, url: options.startUrl }]),
      get: vi.fn(async () => ({
        id: 501,
        url: navOccurred ? options.navigatedUrl : options.startUrl,
      })),
    },
    storage: {
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
    },
  };

  vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
    async (_target: any, fnName: string) => {
      // Any typing/submit dispatch means the commitment has landed and the
      // submit may navigate from here on.
      if (fnName === 'inPageFillIndex' || fnName === 'inPageDispatchInputEvents') {
        navOccurred = true;
      }
      if (fnName === 'inPageVerifyInputCommitment') {
        return [
          {
            result: {
              committed: true,
              currentValue: navOccurred ? options.postNavRead : options.committedRead,
            },
          },
        ] as any;
      }
      if (fnName === 'inPageGetElementCoordinates') {
        return [
          { result: { success: true, x: 10, y: 10, tagName: 'input', inputType: 'search' } },
        ] as any;
      }
      return [{ result: { success: true, committed: true } }] as any;
    },
  );
}

describe('fill_index post-conditions survive navigation (DEFECT A1)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not report value_equals as failed when the submit navigated the page', async () => {
    mockFillHarness({
      startUrl: 'https://en.wikipedia.org/wiki/Main_Page',
      navigatedUrl: 'https://en.wikipedia.org/wiki/Neo4j',
      committedRead: 'Neo4j',
      // The live defect: after navigation the same index is the NEW page's
      // search input, which is empty. That read is not evidence about our fill.
      postNavRead: '',
    });

    const res = await fillIndexTool.execute({
      index: 1,
      text: 'Neo4j',
      pressEnter: true,
      tabId: 501,
      waitForSettle: false,
      postConditions: [{ condition: 'value_equals', expected: 'Neo4j' }],
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);

    // The submit really happened (legacy fields untouched).
    expect(parsed.success).toBe(true);
    expect(parsed.committed).toBe(true);
    expect(parsed.urlChanged).toBe(true);
    expect(parsed.previousUrl).toBe('https://en.wikipedia.org/wiki/Main_Page');
    expect(parsed.currentUrl).toBe('https://en.wikipedia.org/wiki/Neo4j');

    const cond = parsed.postConditions[0];
    expect(cond.condition).toBe('value_equals');
    expect(cond.expected).toBe('Neo4j');
    expect(cond.passed).toBe(true);
    expect(cond.actual).toBe('Neo4j');
    // The evidence must say the assertion was resolved from the pre-navigation
    // commitment read, not from the post-navigation DOM.
    expect(cond.evidence).toMatchObject({ navigated: true, preNavReadBack: 'Neo4j' });
    expect(cond.evidence.postNavReadBack).toBe('');

    // The verdict must reflect the real outcome, not 'failed'.
    expect(parsed.verdict).not.toBe('failed');
    expect(parsed.verdict).toBe('applied');
  });

  it('still fails value_equals for a genuine mismatch with no navigation (honesty guard)', async () => {
    mockFillHarness({
      startUrl: 'https://example.com/cypher',
      navigatedUrl: 'https://example.com/cypher',
      committedRead: 'Cypher',
      postNavRead: 'Cypher',
    });

    const res = await fillIndexTool.execute({
      index: 1,
      text: 'Neo4j',
      tabId: 501,
      waitForSettle: false,
      postConditions: [{ condition: 'value_equals', expected: 'Neo4j' }],
    });

    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.urlChanged).toBe(false);
    const cond = parsed.postConditions[0];
    expect(cond.passed).toBe(false);
    expect(cond.expected).toBe('Neo4j');
    expect(cond.actual).toBe('Cypher');
    expect(cond.evidence.readBackValue).toBe('Cypher');
    expect(parsed.verdict).toBe('failed');
  });
});
