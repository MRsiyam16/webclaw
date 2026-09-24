import { describe, it, expect, vi } from 'vitest';
import { TOOL_SCHEMAS } from 'chrome-mcp-shared';

/**
 * chrome_read_dom used to return three copies of the same page data
 * (treeString + indexMap + indexedElements) pretty-printed with a 2-space
 * indent — ~7x the payload for the same information, and indexMap was almost
 * entirely non-unique ("button" for 100 of 109 entries). The default response
 * is now the pruned tree plus counters, compact-encoded.
 */
const SAMPLE = {
  treeString: '[1] <button id="a">Go</button>\n[2] <input type="email">',
  elementCount: 2,
  interactiveCount: 2,
  compressionRatio: 0.9,
  indexMap: {
    1: { selector: 'button', tagName: 'button' },
    2: { selector: 'input', tagName: 'input' },
  },
  indexedElements: [
    { index: 1, tagName: 'button', text: 'Go', attributes: { id: 'a' }, isInteractive: true },
    { index: 2, tagName: 'input', attributes: { type: 'email' }, isInteractive: true },
  ],
  pages_up: 0,
  pages_down: 0,
  scrollInfo: { pages_up: 0, pages_down: 0 },
};

async function runReadDom(args: Record<string, unknown> = {}) {
  const mod = await import('../entrypoints/background/tools/browser/read-dom');
  const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
  const spy = vi.spyOn(engine, 'executeInPage');
  spy.mockResolvedValue([{ frameId: 0, result: { ...SAMPLE } }] as any);
  (mod.readDOMTool as any).resolveAffinityTab = async () => ({
    id: 1,
    url: 'https://x.test',
    title: 'X',
  });

  const res = await mod.readDOMTool.execute(args as any);
  spy.mockRestore();
  return JSON.parse(res.content[0].text as string);
}

describe('chrome_read_dom payload shape', () => {
  it('omits the bulky detail blocks by default', async () => {
    const payload = await runReadDom();

    expect(payload.treeString).toContain('[1] <button');
    expect(payload.indexedElements).toBeUndefined();
    expect(payload.indexMap).toBeUndefined();
    expect(payload.interactiveCount).toBe(2);
    expect(payload.totalElements).toBe(2);
  });

  it('returns the detail blocks when includeDetails is set', async () => {
    const payload = await runReadDom({ includeDetails: true });

    expect(Array.isArray(payload.indexedElements)).toBe(true);
    expect(payload.indexedElements).toHaveLength(2);
    expect(payload.indexMap).toBeTruthy();
  });

  it('encodes compact JSON, not the 2-space pretty form', async () => {
    const mod = await import('../entrypoints/background/tools/browser/read-dom');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const spy = vi.spyOn(engine, 'executeInPage');
    spy.mockResolvedValue([{ frameId: 0, result: { ...SAMPLE } }] as any);
    (mod.readDOMTool as any).resolveAffinityTab = async () => ({
      id: 1,
      url: 'https://x.test',
      title: 'X',
    });

    const res = await mod.readDOMTool.execute({} as any);
    const text = res.content[0].text as string;
    spy.mockRestore();

    expect(text.startsWith('{"')).toBe(true);
    expect(text.includes('\n  "')).toBe(false);
  });

  it('is a smaller payload than the pre-change shape for the same page', async () => {
    const payload = await runReadDom();
    const compact = JSON.stringify(payload);
    const legacyShape = JSON.stringify(
      { ...payload, indexedElements: SAMPLE.indexedElements, indexMap: SAMPLE.indexMap },
      null,
      2,
    );

    expect(compact.length).toBeLessThan(legacyShape.length);
  });

  it('declares includeDetails in the tool schema', () => {
    const schema = TOOL_SCHEMAS.find((t: any) => t.name === 'chrome_read_dom') as any;
    expect(schema).toBeTruthy();
    expect(schema.inputSchema.properties.includeDetails).toBeTruthy();
    expect(schema.inputSchema.properties.includeDetails.type).toBe('boolean');
  });

  it('remaps subframe visual asset indices sequentially without colliding with main frame asset indices', async () => {
    const mod = await import('../entrypoints/background/tools/browser/read-dom');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const spy = vi.spyOn(engine, 'executeInPage');

    const mainResult = {
      ...SAMPLE,
      assets: [
        {
          index: 1,
          kind: 'img',
          rect: { x: 10, y: 10, width: 100, height: 100 },
          src: 'https://example.com/a.png',
        },
      ],
    };
    const subframeResult = {
      ...SAMPLE,
      assets: [
        {
          index: 1,
          kind: 'img',
          rect: { x: 5, y: 5, width: 50, height: 50 },
          src: 'https://sub.example.com/b.png',
        },
      ],
    };

    spy.mockImplementation(async (_target, funcName) => {
      if (funcName === 'inPageReindexFrame') return [{ result: { success: true } }];
      return [
        { frameId: 0, result: mainResult },
        { frameId: 99, result: subframeResult },
      ] as any;
    });

    (mod.readDOMTool as any).resolveAffinityTab = async () => ({
      id: 1,
      url: 'https://x.test',
      title: 'X',
    });

    // The asset lines only exist in the full tree, so this case opts out of
    // the now-default delta read (which returns the diff, not the tree).
    const res = await mod.readDOMTool.execute({ includeDetails: true, deltaOnly: false } as any);
    spy.mockRestore();

    const payload = JSON.parse(res.content[0].text as string);
    expect(payload.treeString).toContain('[asset 1]');
    expect(payload.treeString).toContain('[asset 2]');
    expect(payload.treeString).not.toContain('[asset 1] img 50x50');
  });
});
