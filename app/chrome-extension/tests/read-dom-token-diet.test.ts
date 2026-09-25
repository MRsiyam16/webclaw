import { describe, expect, it, vi } from 'vitest';

async function read(tabId: number, args: Record<string, unknown> = {}) {
  const mod = await import('../entrypoints/background/tools/browser/read-dom');
  const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
  const elements = Array.from({ length: 43 }, (_, i) => ({
    index: i + 1,
    ref: `e${i + 1}`,
    tagName: 'button',
    text: `Button ${i + 1}`,
    isInteractive: true,
  }));
  const spy = vi.spyOn(engine, 'executeInPage').mockResolvedValue([
    {
      frameId: 0,
      result: {
        treeString: elements.map((el) => `[${el.index}] button "${el.text}"`).join('\n'),
        elementCount: elements.length,
        interactiveCount: elements.length,
        compressionRatio: 0.5,
        indexMap: Object.fromEntries(
          elements.map((el) => [
            el.index,
            { selector: `button:nth-child(${el.index})`, tagName: 'button' },
          ]),
        ),
        indexedElements: elements,
        assets: [
          {
            index: 1,
            kind: 'image',
            rect: { x: 0, y: 0, width: 100, height: 100 },
            src: 'https://example.test/p.png',
          },
        ],
      },
    },
  ] as any);
  (mod.readDOMTool as any).resolveAffinityTab = async () => ({
    id: tabId,
    url: 'https://example.test',
    title: 'Test',
  });
  try {
    return JSON.parse((await mod.readDOMTool.execute(args as any)).content[0].text as string);
  } finally {
    spy.mockRestore();
  }
}

describe('read_dom token diet', () => {
  it('caps the default page at 40 elements and permits explicit larger pages', async () => {
    const first = await read(981001, { includeDetails: true });
    expect(first.totalElements).toBe(43);
    expect(first.indexedElements).toHaveLength(40);
    expect(Object.keys(first.indexMap)).toHaveLength(40);
    expect(first.indexMap[41]).toBeUndefined();
    expect(first.nextCursor).toBe(40);
    expect(first.treeString).not.toContain('Button 41');
    const rest = await read(981001, { cursor: 40, includeDetails: true });
    expect(rest.indexedElements.map((el: any) => el.index)).toEqual([41, 42, 43]);
    const full = await read(981001, { limit: 60, deltaOnly: false, includeDetails: true });
    expect(full.indexedElements).toHaveLength(43);
  });

  it('shows guidance once per tab and hides visual assets unless requested', async () => {
    const first = await read(981002);
    expect(first.pipelineHint).toContain('batch_actions');
    expect(first.treeString).not.toContain('[Visual Assets');
    expect(first.assets).toBeUndefined();
    const second = await read(981002, { deltaOnly: false });
    expect(second.pipelineHint).toBeUndefined();
    const withAssets = await read(981002, { deltaOnly: false, includeAssets: true });
    expect(withAssets.treeString).toContain('[Visual Assets');
    expect(withAssets.assets).toHaveLength(1);
  });
});
