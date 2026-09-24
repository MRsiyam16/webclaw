import { describe, it, expect, vi } from 'vitest';
import { foldList, textSimilarity, type FoldableNode } from '../utils/list-fold';

/**
 * read_dom's compact output ships one line per indexed element. On list/feed
 * pages that is dozens of near-identical rows ("Product 1 …", "Product 2 …"),
 * which is most of the payload for almost none of the information. foldList
 * fingerprints each row's normalized text with SimHash and collapses
 * CONSECUTIVE near-duplicates into one line plus a refs marker.
 */

const li = (ref: string, text: string): FoldableNode => ({ ref, tag: 'li', text });

describe('foldList — SimHash list folding', () => {
  it('(a) collapses 48 list items (47 near-duplicates) to 2 lines', () => {
    const items: FoldableNode[] = [];
    for (let i = 1; i <= 47; i++) {
      items.push(li(`e${i}`, `Product ${i} — in stock, ships today`));
    }
    items.push(li('e48', 'Free returns within 30 days for members'));

    const result = foldList(items);

    expect(items).toHaveLength(48);
    expect(result.lines).toHaveLength(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].count).toBe(47);
    expect(result.lines[1]).toBe('[e48] li "Free returns within 30 days for members"');
  });

  it('(b) emits the exact `(... and N more similar) [refs: ...]` marker', () => {
    const items = [li('e1', 'Item 1'), li('e2', 'Item 2'), li('e3', 'Item 3')];

    const result = foldList(items);

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toBe('[e1] li "Item 1" (... and 3 more similar) [refs: e1,e2,e3]');
  });

  it('(c) lists EVERY folded ref in the marker, representative included', () => {
    const refs = ['e10', 'e11', 'e12', 'e13', 'e14'];
    const items = refs.map((ref, i) => li(ref, `Row ${i + 1}`));

    const result = foldList(items);
    const markerRefs = /\[refs: ([^\]]+)\]/.exec(result.lines[0])?.[1].split(',');

    expect(markerRefs).toEqual(refs);
    expect(result.groups[0].folded.map((n) => n.ref)).toEqual(refs);
    expect(result.groups[0].representative.ref).toBe('e10');
  });

  it('(d) does not fold genuinely different items', () => {
    const items = [
      li('e1', 'Bicycle'),
      li('e2', 'Coffee beans'),
      li('e3', 'Running shoes'),
      li('e4', 'Bonsai tree'),
    ];

    const result = foldList(items);

    expect(result.lines).toHaveLength(4);
    expect(result.groups).toHaveLength(0);
    expect(result.lines).toEqual([
      '[e1] li "Bicycle"',
      '[e2] li "Coffee beans"',
      '[e3] li "Running shoes"',
      '[e4] li "Bonsai tree"',
    ]);
  });

  it('(e) respects a custom similarity threshold', () => {
    const a = li('e1', 'Wireless headphones — noise cancelling, black');
    const b = li('e2', 'Wireless headphones — noise cancelling, white');
    const sim = textSimilarity(a.text, b.text);

    expect(sim).toBeGreaterThanOrEqual(0.8);
    expect(sim).toBeLessThan(1);

    expect(foldList([a, b]).lines).toHaveLength(1);
    expect(foldList([a, b], { similarity: 0.999 }).lines).toHaveLength(2);
    expect(foldList([a, b], { similarity: sim + 0.01 }).lines).toHaveLength(2);
  });

  it('folds only consecutive runs, not scattered duplicates', () => {
    const items = [
      li('e1', 'Shoe 1'),
      li('e2', 'A totally different row about shipping'),
      li('e3', 'Shoe 3'),
    ];

    const result = foldList(items);

    expect(result.lines).toHaveLength(3);
    expect(result.groups).toHaveLength(0);
  });

  it('leaves non-list-item nodes unfolded', () => {
    const items: FoldableNode[] = [
      { ref: 'e1', tag: 'button', text: 'Buy 1' },
      { ref: 'e2', tag: 'button', text: 'Buy 2' },
    ];

    const result = foldList(items);

    expect(result.lines).toHaveLength(2);
    expect(result.groups).toHaveLength(0);
  });

  it('wires folding into read_dom compact output (and not into the full tree)', async () => {
    const mod = await import('../entrypoints/background/tools/browser/read-dom');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const elements = [
      { index: 1, tagName: 'li', text: 'Product 1', isInteractive: true },
      { index: 2, tagName: 'li', text: 'Product 2', isInteractive: true },
      { index: 3, tagName: 'li', text: 'Product 3', isInteractive: true },
      { index: 4, tagName: 'li', text: 'Contact support about shipping', isInteractive: true },
    ];
    const spy = vi.spyOn(engine, 'executeInPage');
    spy.mockResolvedValue([
      {
        frameId: 0,
        result: {
          treeString: elements.map((e) => `[${e.index}] li "${e.text}"`).join('\n'),
          elementCount: elements.length,
          interactiveCount: elements.length,
          compressionRatio: 0.5,
          indexMap: {},
          indexedElements: elements,
        },
      },
    ] as any);
    (mod.readDOMTool as any).resolveAffinityTab = async () => ({
      id: 990_777,
      url: 'https://x.test',
      title: 'X',
    });

    const compact = JSON.parse(
      (await mod.readDOMTool.execute({ format: 'compact' } as any)).content[0].text as string,
    );
    spy.mockRestore();

    expect(compact.treeString.split('\n')).toHaveLength(2);
    expect(compact.treeString).toContain('(... and 3 more similar) [refs: e1,e2,e3]');
    expect(compact.treeString.startsWith('[1] li "Product 1"')).toBe(true);
    expect(compact.treeString).toContain('[4] li "Contact support about shipping"');

    // The full-tree path (format: 'html') must stay unfolded.
    const htmlSpy = vi.spyOn(engine, 'executeInPage');
    htmlSpy.mockResolvedValue([
      {
        frameId: 0,
        result: {
          treeString: elements.map((e) => `[${e.index}] li "${e.text}"`).join('\n'),
          elementCount: elements.length,
          interactiveCount: elements.length,
          compressionRatio: 0.5,
          indexMap: {},
          indexedElements: elements,
        },
      },
    ] as any);
    (mod.readDOMTool as any).resolveAffinityTab = async () => ({
      id: 990_778,
      url: 'https://x.test',
      title: 'X',
    });
    const html = JSON.parse(
      (await mod.readDOMTool.execute({ format: 'html', deltaOnly: false } as any)).content[0]
        .text as string,
    );
    htmlSpy.mockRestore();

    expect(html.treeString.split('\n')).toHaveLength(4);
    expect(html.treeString).not.toContain('more similar');
  });
});
