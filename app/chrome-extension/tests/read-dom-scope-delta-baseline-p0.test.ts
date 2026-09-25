import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';

describe('P0 F1: read_dom keeps request-shaped baselines', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns full scoped content without damaging the unscoped delta baseline', async () => {
    const tabId = 991_401;
    const products = [
      { index: 1, ref: 'e1', tagName: 'button', text: 'Search', isInteractive: true },
      { index: 2, ref: 'e2', tagName: 'a', text: 'Soft Stretch Jeans', isInteractive: true },
      { index: 3, ref: 'e3', tagName: 'button', text: 'Add to cart', isInteractive: true },
    ];
    let changed = false;
    vi.spyOn(engine, 'executeInPage').mockImplementation(
      async (_target: any, _fn: any, args: any[]) => {
        const scoped = Boolean(args?.[0]?.selector || args?.[0]?.scope);
        const current = changed
          ? products.map((item) => (item.index === 3 ? { ...item, text: 'Added' } : item))
          : products;
        const elements = scoped ? current.slice(1) : current;
        return [
          {
            frameId: 0,
            result: {
              treeString: elements
                .map((item) => `[${item.index}] ${item.tagName} "${item.text}"`)
                .join('\n'),
              elementCount: elements.length,
              interactiveCount: elements.length,
              compressionRatio: 0,
              indexMap: {},
              indexedElements: elements,
            },
          },
        ] as any;
      },
    );
    (readDOMTool as any).resolveAffinityTab = async () => ({
      id: tabId,
      url: 'https://shop.test/products',
      title: 'Products',
    });
    const read = async (args: any) =>
      JSON.parse((await readDOMTool.execute({ ...args, tabId } as any)).content[0].text);

    await read({ deltaOnly: true });
    const scoped = await read({ selector: '.features_items form', deltaOnly: true });
    expect(scoped.isDelta).toBeUndefined();
    expect(scoped.removedIndices).toBeUndefined();
    expect(scoped.treeString).toContain('Soft Stretch Jeans');
    changed = true;
    const nextUnscoped = await read({ deltaOnly: true });
    expect(nextUnscoped.isDelta).toBe(true);
    expect(nextUnscoped.modified.map((item: any) => item.index)).toContain(3);
    expect(nextUnscoped.removedIndices).toEqual([]);
  });
});
