import { describe, expect, it, vi } from 'vitest';

describe('read_dom indexed-element pagination', () => {
  it('counts and pages indexed elements while keeping context and folded refs page-local', async () => {
    const mod = await import('../entrypoints/background/tools/browser/read-dom');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const elements = [
      ...Array.from({ length: 6 }, (_, i) => ({
        index: i + 1,
        ref: `e${i + 1}`,
        tagName: 'li',
        text: `Product ${i + 1}`,
        isInteractive: true,
      })),
      { index: 7, ref: 'e7', tagName: 'button', text: 'Checkout', isInteractive: true },
    ];
    const spy = vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      {
        frameId: 0,
        result: {
          treeString: [
            '[frame 0]',
            ...elements.map((el) => `[${el.index}] ${el.tagName} "${el.text}"`),
            '[asset 1] img 20x20 @(1,1)',
          ].join('\n'),
          elementCount: elements.length,
          interactiveCount: elements.length,
          compressionRatio: 0.5,
          indexMap: {},
          indexedElements: elements,
        },
      },
    ] as any);
    (mod.readDOMTool as any).resolveAffinityTab = async () => ({
      id: 991_111,
      url: 'https://x.test',
      title: 'X',
    });

    const read = async (cursor: number) =>
      JSON.parse(
        (
          await mod.readDOMTool.execute({
            format: 'compact',
            deltaOnly: false,
            includeDetails: true,
            cursor,
            limit: 2,
          } as any)
        ).content[0].text as string,
      );

    try {
      const first = await read(0);
      const second = await read(2);
      const third = await read(4);
      const fourth = await read(6);

      expect(first.totalElements).toBe(7);
      expect(first.indexedElements.map((el: any) => el.index)).toEqual([1, 2]);
      expect(first.nextCursor).toBe(2);
      expect(second.indexedElements.map((el: any) => el.index)).toEqual([3, 4]);
      expect(second.nextCursor).toBe(4);
      expect(third.indexedElements.map((el: any) => el.index)).toEqual([5, 6]);
      expect(third.nextCursor).toBe(6);
      expect(fourth.indexedElements.map((el: any) => el.index)).toEqual([7]);
      expect(fourth.hasMore).toBe(false);

      for (const page of [first, second, third, fourth]) {
        expect(page.treeString).toContain('[frame 0]');
        expect(page.treeString).toContain('[asset 1]');
      }
      expect(first.treeString).toContain('[refs: e1,e2]');
      expect(second.treeString).toContain('[refs: e3,e4]');
      expect(third.treeString).toContain('[refs: e5,e6]');
      expect(fourth.treeString).toContain('[7] button');
    } finally {
      spy.mockRestore();
    }
  });
});
