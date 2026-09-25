import { describe, expect, it, vi } from 'vitest';

const el = (index: number, text: string) => ({
  index,
  ref: `e${index}`,
  tagName: 'button',
  text,
  isInteractive: true,
});

async function readDom(tabId: number, args: Record<string, unknown>) {
  const mod = await import('../entrypoints/background/tools/browser/read-dom');
  const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
  const elements = [el(1, 'Submit'), el(2, 'Cancel'), el(3, 'Confirm')];
  const spy = vi.spyOn(engine, 'executeInPage').mockResolvedValue([
    {
      frameId: 0,
      result: {
        treeString: elements.map((item) => `[${item.index}] button "${item.text}"`).join('\n'),
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
    url: 'https://x.test',
    title: 'X',
  });

  try {
    const result = await mod.readDOMTool.execute(args as any);
    return JSON.parse(result.content[0].text as string);
  } finally {
    spy.mockRestore();
  }
}

describe('read_dom default delta request shape', () => {
  it('returns the requested second page when cursor changes on an unchanged DOM', async () => {
    const tabId = 881_001;
    await readDom(tabId, { cursor: 0, limit: 1, includeDetails: true });

    const payload = await readDom(tabId, { cursor: 1, limit: 1, includeDetails: true });

    expect(payload.unchanged).toBeUndefined();
    expect(payload.cursor).toBe(1);
    expect(payload.indexedElements.map((item: any) => item.index)).toEqual([2]);
    expect(payload.treeString).toContain('Cancel');
    expect(payload.treeString).not.toContain('Submit');
  });

  it('returns a new full-format request when the DOM is unchanged', async () => {
    const tabId = 881_002;
    await readDom(tabId, { format: 'compact' });

    const payload = await readDom(tabId, { format: 'full' });

    expect(payload.unchanged).toBeUndefined();
    expect(payload.treeString).toContain('Submit');
  });
});
