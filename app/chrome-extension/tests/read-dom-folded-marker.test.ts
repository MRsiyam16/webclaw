import { describe, it, expect, vi } from 'vitest';

/**
 * Compact read_dom list folding — merged marker emission.
 *
 * Live finding: on a page whose 20 list titles were DISTINCT, no folding was
 * expected, so the merged marker `(... and N more similar) [refs: ...]` could
 * not be confirmed. This test drives read_dom's real compact path with a
 * GENUINELY repetitive list and asserts the merged marker is emitted with the
 * refs of every folded row.
 *
 * The count/refs convention is the one pinned by list-fold.test.ts (b)/(c):
 * N is the run length and `refs` enumerates every row in the run, the
 * representative included.
 */

const listRow = (index: number, text: string) => ({
  index,
  tagName: 'li',
  role: 'listitem',
  text,
  isInteractive: true,
  attributes: {},
  rect: { x: 0, y: index * 20, width: 320, height: 18 },
});

type ReadResult = { treeString?: string; indexedElements?: any[]; elementCount?: number };

async function readDom(
  tabId: number,
  elements: any[],
  extraTree: string[] = [],
): Promise<ReadResult> {
  const mod = await import('../entrypoints/background/tools/browser/read-dom');
  const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
  const { renderCompactElementLine } =
    await import('../entrypoints/background/tools/browser/dom-indexer');

  const spy = vi.spyOn(engine, 'executeInPage');
  spy.mockResolvedValue([
    {
      frameId: 0,
      result: {
        treeString: [...elements.map((e) => renderCompactElementLine(e as any)), ...extraTree].join(
          '\n',
        ),
        elementCount: elements.length,
        interactiveCount: elements.length,
        compressionRatio: 0.5,
        indexMap: {},
        indexedElements: elements,
      },
    },
  ] as any);
  (mod.readDOMTool as any).resolveAffinityTab = async () => ({
    id: tabId,
    url: 'https://shop.test/list',
    title: 'List',
  });

  const res = await mod.readDOMTool.execute({ deltaOnly: false, limit: 100 } as any);
  spy.mockRestore();
  return JSON.parse(res.content[0].text as string) as ReadResult;
}

const listitemLines = (tree: string) => tree.split('\n').filter((l) => l.includes('listitem'));

describe('read_dom compact list folding', () => {
  it('folds 48 near-identical rows into the merged marker with every folded ref', async () => {
    const elements = Array.from({ length: 48 }, (_, i) =>
      listRow(i + 1, `Product ${i + 1} - in stock`),
    );
    const payload = await readDom(990_101, elements);
    const tree = payload.treeString || '';

    const match = /\(\.\.\. and (\d+) more similar\) \[refs: ([^\]]+)\]/.exec(tree);
    expect(match).not.toBeNull();
    const refs = match![2].split(',');
    expect(match![1]).toBe('48');
    expect(refs).toHaveLength(48);
    expect(refs[0]).toBe('e1');
    expect(refs[refs.length - 1]).toBe('e48');

    // 48 rows collapse to a single listitem line: the representative + marker.
    expect(listitemLines(tree)).toHaveLength(1);
    expect(listitemLines(tree)[0]).toBe(
      `[1] listitem "Product 1 - in stock" (... and 48 more similar) [refs: ${refs.join(',')}]`,
    );
  });

  it('leaves genuinely distinct rows unfolded (no false positive)', async () => {
    const titles = ['Bicycle', 'Coffee beans', 'Desk lamp', 'Rain jacket', 'Sourdough', 'Toolbox'];
    const elements = titles.map((text, i) => listRow(i + 1, text));
    const payload = await readDom(990_102, elements);
    const tree = payload.treeString || '';

    expect(tree).not.toContain('more similar');
    expect(listitemLines(tree)).toHaveLength(6);
  });

  it('folds a repetitive run that ends the list, leaving the one-off row alone', async () => {
    const elements = [
      listRow(1, 'A one-off heading'),
      listRow(2, 'Product 1 - in stock'),
      listRow(3, 'Product 2 - in stock'),
      listRow(4, 'Product 3 - in stock'),
    ];
    const payload = await readDom(990_103, elements);
    const tree = payload.treeString || '';

    expect(tree).toContain('(... and 3 more similar) [refs: e2,e3,e4]');
    expect(tree).toContain('A one-off heading');
    expect(listitemLines(tree)).toHaveLength(2);
  });

  it('coexists with the pre-existing virtualization marker (which passes through)', async () => {
    const elements = Array.from({ length: 4 }, (_, i) =>
      listRow(i + 1, `Product ${i + 1} - in stock`),
    );
    const virtual =
      '~ [virtualized: 20 similar offscreen items in <li> folded (scroll down or use selector to reveal)]';
    const payload = await readDom(990_104, elements, [virtual]);
    const tree = payload.treeString || '';

    // The pruner's virtualization marker line is untouched...
    expect(tree.split('\n').filter((l) => l.includes('[virtualized:'))).toEqual([virtual]);
    // ...and the merged folded marker is emitted on the surviving row's line.
    expect(tree).toContain('(... and 4 more similar) [refs: e1,e2,e3,e4]');
  });
});
