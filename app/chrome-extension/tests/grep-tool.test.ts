import { describe, it, expect, vi } from 'vitest';
import { grepTool } from '../entrypoints/background/tools/browser/grep';

describe('GrepTool (chrome_grep)', () => {
  it('counts all fallback text hits even when returned matches are limited', async () => {
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    vi.spyOn(grepTool as any, 'resolveAffinityTab').mockResolvedValue({ id: 123 });
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, fnName: string) => {
      if (fnName === 'inPageDOMPruner')
        return [{ frameId: 0, result: { indexedElements: [], indexMap: {} } }] as any;
      if (fnName === 'inPageExtractDeepPageText')
        return [{ frameId: 0, result: 'Pause\nPause\nPause' }] as any;
      return [] as any;
    });
    const result = await grepTool.execute({ query: 'Pause', limit: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalMatches).toBe(3);
    expect(parsed.returnedCount).toBe(1);
    expect(parsed.truncated).toBe(true);
  });

  it('fails with validation error when query is empty', async () => {
    const res = await grepTool.execute({ query: '' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('query parameter is required');
  });

  it('reports invalid regex gracefully', async () => {
    // Mock resolveAffinityTab
    vi.spyOn(grepTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 123,
      url: 'https://example.com',
    });
    const res = await grepTool.execute({ query: '[invalid-regex(', isRegex: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid regular expression');
  });

  it('matches placeholder and aria-label attributes across multi-frame hierarchy', async () => {
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const spy = vi.spyOn(engine, 'executeInPage');
    vi.spyOn(grepTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 123,
      url: 'https://example.com',
    });

    spy.mockImplementation(async (target: any, fnName: string, args: any) => {
      if (fnName === 'inPageDOMPruner') {
        return [
          {
            frameId: 0,
            result: {
              elementCount: 1,
              interactiveCount: 1,
              indexedElements: [
                {
                  index: 1,
                  tagName: 'input',
                  role: 'textbox',
                  text: '',
                  isInteractive: true,
                  attributes: { placeholder: 'Search products' },
                },
              ],
              indexMap: { 1: { selector: '#search', tagName: 'input' } },
            },
          },
          {
            frameId: 42,
            result: {
              elementCount: 1,
              interactiveCount: 1,
              indexedElements: [
                {
                  index: 1,
                  tagName: 'button',
                  role: 'button',
                  text: '',
                  isInteractive: true,
                  attributes: { 'aria-label': 'Submit payment' },
                },
              ],
              indexMap: { 1: { selector: '#pay', tagName: 'button' } },
            },
          },
        ] as any;
      }
      if (fnName === 'inPageReindexFrame') {
        return [{ frameId: target.frameIds[0], result: true }] as any;
      }
      return [] as any;
    });

    const res = await grepTool.execute({ query: 'payment' });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.totalMatches).toBe(1);
    // Subframe element should be reindexed from 1 to 2
    expect(parsed.matches[0].index).toBe(2);
    expect(parsed.matches[0].tagName).toBe('button');

    // Verify inPageReindexFrame was NOT called (read-only search must not mutate subframe index maps)
    const reindexCall = spy.mock.calls.find((c) => c[1] === 'inPageReindexFrame');
    expect(reindexCall).toBeUndefined();

    spy.mockRestore();
  });
});
