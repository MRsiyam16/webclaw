import { describe, expect, it, vi } from 'vitest';
import { budgetText } from '../entrypoints/background/tools/browser/text-budget';
import { markdownOutline } from '../entrypoints/background/tools/browser/get-markdown';
import { viewportCaptureSize } from '../entrypoints/background/tools/browser/screenshot';
import { scrollUntilFoundTool } from '../entrypoints/background/tools/browser/scroll-until-found';

describe('token efficiency defaults', () => {
  it('builds an outline from headings and table shapes', () => {
    expect(markdownOutline('# Page\n\n## Details\n\n| A | B |\n|---|---|\n| x | y |')).toBe(
      '# Page\n## Details\nTable: 2 columns, 1 data rows',
    );
  });

  it('keeps markdown budget at 40k and reports true source length', () => {
    const out = budgetText('x'.repeat(50_000), 40_000);
    expect(out.text.length).toBeLessThanOrEqual(40_000);
    expect(out.totalChars).toBe(50_000);
    expect(out.text).toContain('50000');
  });

  it('defaults unscoped markdown extraction to fit and applies the 40k cap', async () => {
    const { getMarkdownTool } =
      await import('../entrypoints/background/tools/browser/get-markdown');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const spy = vi
      .spyOn(engine, 'executeInPage')
      .mockResolvedValue([{ frameId: 0, result: 'm'.repeat(50_000) }] as any);
    (getMarkdownTool as any).resolveAffinityTab = async () => ({ id: 882 });
    const result = await getMarkdownTool.execute({} as any);
    const callArgs = spy.mock.calls[0][2] as unknown[];
    spy.mockRestore();
    expect(callArgs).toEqual([true, true]);
    expect(result.content[0].text.length).toBeLessThanOrEqual(40_000);
    expect(result.content[0].text).toContain('50000');
  });

  it('scales viewport-only capture to at most 800px wide and preserves aspect ratio', () => {
    expect(viewportCaptureSize(1440, 900)).toEqual({ width: 800, height: 500 });
    expect(viewportCaptureSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(viewportCaptureSize(1440, 900, 1200)).toEqual({ width: 1200, height: 750 });
  });

  it('stops asking the page to scroll once the bottom is reached', async () => {
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const spy = vi.spyOn(engine, 'executeInPage');
    (scrollUntilFoundTool as any).resolveAffinityTab = async () => ({ id: 881 });
    spy.mockImplementation(async (_tab: any, fn: string) =>
      fn === 'inPageScrollUntilFound'
        ? [
            {
              frameId: 0,
              result: { found: false, stepsTaken: 1, scrolledPx: 800, message: 'not found' },
            },
          ]
        : [{ frameId: 0, result: { canScrollDown: false } }],
    ) as any;
    const response = await scrollUntilFoundTool.execute({
      query: 'not present',
      maxSteps: 25,
    } as any);
    const payload = JSON.parse(response.content[0].text as string);
    expect(payload).toMatchObject({
      found: false,
      reason: 'bottom_reached',
      stepsTaken: 1,
      closestMatches: [],
    });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
