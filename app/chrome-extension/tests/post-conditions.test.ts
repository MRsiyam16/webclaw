import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { evaluatePostConditions } from '../entrypoints/background/tools/browser/result-envelope';
import { fillIndexTool } from '../entrypoints/background/tools/browser/fill-index';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';

describe('Post-conditions: evaluatePostConditions + fill_index wiring', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('evaluatePostConditions (reference + one per condition type)', () => {
    // Reference test from the task contract.
    it('value_equals reports expected/actual/evidence on a mismatch', () => {
      const r = evaluatePostConditions([{ condition: 'value_equals', expected: 'Neo4j' }], {
        readBackValue: 'Cypher',
        url: 'https://en.wikipedia.org/wiki/Neo4j',
      });
      expect(r[0]).toMatchObject({
        condition: 'value_equals',
        expected: 'Neo4j',
        actual: 'Cypher',
        passed: false,
      });
      expect(r[0].evidence).toBeDefined();
    });

    it('value_equals passes when the read-back matches (JSON equality)', () => {
      const r = evaluatePostConditions([{ condition: 'value_equals', expected: 'Neo4j' }], {
        readBackValue: 'Neo4j',
      });
      expect(r[0].passed).toBe(true);
      expect(r[0].evidence).toMatchObject({ readBackValue: 'Neo4j' });
    });

    it('element_exists reflects ctx.elementExists', () => {
      const yes = evaluatePostConditions([{ condition: 'element_exists', expected: true }], {
        elementExists: true,
      });
      expect(yes[0].passed).toBe(true);
      const no = evaluatePostConditions([{ condition: 'element_exists', expected: true }], {
        elementExists: false,
      });
      expect(no[0]).toMatchObject({ actual: false, passed: false });
      expect(no[0].evidence).toBeDefined();
    });

    it('text_present uses include semantics and carries a matched snippet as evidence', () => {
      const r = evaluatePostConditions([{ condition: 'text_present', expected: 'Neo4j' }], {
        pageText: 'Graph databases: Neo4j is a popular native graph store.',
      });
      expect(r[0].actual).toBe(true);
      expect(r[0].passed).toBe(true);
      expect(typeof r[0].evidence).toBe('string');
      expect(String(r[0].evidence)).toContain('Neo4j');

      const miss = evaluatePostConditions([{ condition: 'text_present', expected: 'Cassandra' }], {
        pageText: 'Graph databases: Neo4j is a popular native graph store.',
      });
      expect(miss[0]).toMatchObject({ actual: false, passed: false });
      expect(miss[0].evidence).toBeDefined();
    });

    it('url_matches supports exact equality and /regex/ literals', () => {
      const exact = evaluatePostConditions(
        [{ condition: 'url_matches', expected: 'https://example.com/a' }],
        { url: 'https://example.com/a' },
      );
      expect(exact[0].passed).toBe(true);

      const exactMiss = evaluatePostConditions(
        [{ condition: 'url_matches', expected: 'https://example.com/a' }],
        { url: 'https://example.com/b' },
      );
      expect(exactMiss[0].passed).toBe(false);

      const re = evaluatePostConditions(
        [{ condition: 'url_matches', expected: '/\\/wiki\\/Neo4j$/' }],
        { url: 'https://en.wikipedia.org/wiki/Neo4j' },
      );
      expect(re[0].passed).toBe(true);

      const reMiss = evaluatePostConditions(
        [{ condition: 'url_matches', expected: '/\\/wiki\\/Cypher$/' }],
        { url: 'https://en.wikipedia.org/wiki/Neo4j' },
      );
      expect(reMiss[0].passed).toBe(false);
    });

    it('list_count_delta compares the numeric delta with count evidence', () => {
      const r = evaluatePostConditions([{ condition: 'list_count_delta', expected: 2 }], {
        listCountBefore: 3,
        listCountAfter: 5,
      });
      expect(r[0].actual).toBe(2);
      expect(r[0].passed).toBe(true);
      expect(r[0].evidence).toMatchObject({ listCountBefore: 3, listCountAfter: 5, delta: 2 });

      const miss = evaluatePostConditions([{ condition: 'list_count_delta', expected: 2 }], {
        listCountBefore: 5,
        listCountAfter: 5,
      });
      expect(miss[0]).toMatchObject({ actual: 0, passed: false });
    });

    it('element_state compares the reported state string', () => {
      const r = evaluatePostConditions([{ condition: 'element_state', expected: 'present' }], {
        elementState: 'present',
      });
      expect(r[0].passed).toBe(true);
      expect(r[0].evidence).toMatchObject({ elementState: 'present' });

      const miss = evaluatePostConditions([{ condition: 'element_state', expected: 'present' }], {
        elementState: 'detached',
      });
      expect(miss[0]).toMatchObject({ actual: 'detached', passed: false });
    });

    // The 'fill whose committed read disagrees' case, straight through the evaluator.
    it('a fill whose committed read disagrees fails value_equals', () => {
      const r = evaluatePostConditions([{ condition: 'value_equals', expected: 'Neo4j' }], {
        readBackValue: 'Cypher',
        url: 'https://en.wikipedia.org/wiki/Neo4j',
      });
      expect(r[0].passed).toBe(false);
      expect(r[0].expected).toBe('Neo4j');
      expect(r[0].actual).toBe('Cypher');
      expect(r[0].evidence).toMatchObject({ readBackValue: 'Cypher' });
    });
  });

  describe('fill_index wiring (additive to the legacy response)', () => {
    function mockFillHarness() {
      const mockTab = { id: 301, url: 'https://example.com/cypher' };
      (globalThis as any).chrome = {
        tabs: {
          query: vi.fn(async () => [mockTab]),
          get: vi.fn(async () => mockTab),
        },
        storage: {
          session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
        },
      };

      vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
        async (_target: any, fnName: string) => {
          if (fnName === 'inPageVerifyInputCommitment') {
            return [{ result: { committed: true, currentValue: 'Cypher' } }] as any;
          }
          if (fnName === 'inPageGetElementCoordinates') {
            return [{ result: { success: true, x: 10, y: 10, tagName: 'input' } }] as any;
          }
          return [{ result: { success: true, committed: true } }] as any;
        },
      );
      return mockTab;
    }

    it('keeps every legacy top-level field and adds postConditions/verdict/outcome/evidence', async () => {
      mockFillHarness();

      const res = await fillIndexTool.execute({
        index: 1,
        text: 'Neo4j',
        tabId: 301,
        waitForSettle: false,
        postConditions: [{ condition: 'value_equals', expected: 'Neo4j' }],
      });

      expect(res.isError).toBe(false);
      const parsed = JSON.parse((res.content[0] as any).text);

      // Legacy fields survive untouched (Hyrum's Law).
      expect(parsed.success).toBe(true);
      expect(parsed.committed).toBe(true);
      expect(parsed.index).toBe(1);
      expect(parsed.filledText).toBe('Neo4j');
      expect(parsed.previousUrl).toBe('https://example.com/cypher');
      expect(parsed.currentUrl).toBe('https://example.com/cypher');
      expect(parsed.urlChanged).toBe(false);
      expect(parsed).toHaveProperty('isTrusted');
      expect(parsed).toHaveProperty('method');

      // New envelope fields.
      expect(Array.isArray(parsed.postConditions)).toBe(true);
      expect(parsed.postConditions[0]).toMatchObject({
        condition: 'value_equals',
        expected: 'Neo4j',
        actual: 'Cypher',
        passed: false,
      });
      expect(parsed.postConditions[0].evidence).toBeDefined();
      expect(parsed.verdict).toBe('failed');
      expect(typeof parsed.outcome).toBe('string');
      expect(parsed.evidence).toBeDefined();
    });

    it('without postConditions the response is unchanged (no new keys)', async () => {
      mockFillHarness();

      const res = await fillIndexTool.execute({
        index: 1,
        text: 'Neo4j',
        tabId: 301,
        waitForSettle: false,
      });

      expect(res.isError).toBe(false);
      const parsed = JSON.parse((res.content[0] as any).text);
      expect(parsed.postConditions).toBeUndefined();
      expect(parsed.verdict).toBeUndefined();
      expect(parsed.evidence).toBeUndefined();
      expect(parsed.committed).toBe(true);
    });
  });
});
