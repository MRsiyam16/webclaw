import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { grepTool } from '../entrypoints/background/tools/browser/grep';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';

describe('chrome_grep fallback truncation boundaries', () => {
  beforeEach(() => {
    vi.spyOn(grepTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 901 });
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, fnName: string) => {
      if (fnName === 'inPageDOMPruner')
        return [{ frameId: 0, result: { indexedElements: [], indexMap: {} } }] as any;
      if (fnName === 'inPageExtractDeepPageText')
        return [{ frameId: 0, result: 'Needle\nNeedle\nNeedle' }] as any;
      return [] as any;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { hits: 'Needle\nNeedle', limit: 3, total: 2, truncated: false },
    { hits: 'Needle\nNeedle', limit: 2, total: 2, truncated: false },
    { hits: 'Needle\nNeedle\nNeedle', limit: 2, total: 3, truncated: true },
  ])(
    'reports truncation correctly: $total matches with limit $limit',
    async ({ hits, limit, total, truncated }) => {
      vi.mocked(engine.executeInPage).mockImplementation(async (_target: any, fnName: string) => {
        if (fnName === 'inPageDOMPruner')
          return [{ frameId: 0, result: { indexedElements: [], indexMap: {} } }] as any;
        if (fnName === 'inPageExtractDeepPageText') return [{ frameId: 0, result: hits }] as any;
        return [] as any;
      });
      const result = await grepTool.execute({ query: 'Needle', limit });
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        totalMatches: total,
        returnedCount: Math.min(total, limit),
        truncated,
      });
    },
  );
});
