import { describe, it, expect, vi } from 'vitest';

/**
 * read_dom used to require `deltaOnly: true` to return diffs. The delta path is
 * now the default: a repeat read that sees a changed DOM returns the delta plus
 * `snapshotId` (so the client knows which baseline the diff is against), while
 * `deltaOnly: false` stays the escape hatch that always returns the full tree.
 */
const el = (index: number, text: string) => ({
  index,
  tagName: 'button',
  text,
  isInteractive: true,
});

async function readDom(tabId: number, elements: any[], args: Record<string, unknown> = {}) {
  const mod = await import('../entrypoints/background/tools/browser/read-dom');
  const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
  const spy = vi.spyOn(engine, 'executeInPage');
  spy.mockResolvedValue([
    {
      frameId: 0,
      result: {
        treeString: elements.map((e) => `[${e.index}] button "${e.text}"`).join('\n'),
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

  const res = await mod.readDOMTool.execute(args as any);
  spy.mockRestore();
  return JSON.parse(res.content[0].text as string);
}

describe('read_dom delta-only default', () => {
  it('returns a delta (not the full tree) when the DOM changed since the last read', async () => {
    const before = [el(1, 'Submit'), el(2, 'Cancel')];
    await readDom(880_001, before); // first read has no baseline -> full tree

    const payload = await readDom(880_001, [...before, el(3, 'Confirm')]);

    expect(payload.isDelta).toBe(true);
    expect(payload.addedCount).toBe(1);
    expect(payload.added.map((e: any) => e.text)).toContain('Confirm');
    expect(payload.snapshotId).toBeTruthy();
  });

  it('deltaOnly: false still returns the full tree', async () => {
    const before = [el(1, 'Submit')];
    await readDom(880_002, before);

    const payload = await readDom(880_002, [...before, el(2, 'Confirm')], { deltaOnly: false });

    expect(payload.isDelta).toBeUndefined();
    expect(payload.treeString).toContain('Confirm');
    expect(payload.snapshotId).toBeTruthy();
  });

  it('returns the full tree when nothing changed and deltaOnly is explicitly false', async () => {
    const els = [el(1, 'Submit')];
    await readDom(880_003, els);

    // `deltaOnly: false` is the escape hatch: an unchanged repeat must still
    // ship the full tree when the caller opts out of the delta protocol.
    const payload = await readDom(880_003, els, { deltaOnly: false });

    expect(payload.treeString).toContain('Submit');
    expect(payload.snapshotId).toBeTruthy();
  });

  it('returns the compact unchanged payload on a default repeat read with an unchanged DOM', async () => {
    const els = [el(1, 'Submit')];
    await readDom(880_005, els); // first read seeds the baseline

    const payload = await readDom(880_005, els); // default: deltaOnly is not passed

    expect(payload.unchanged).toBe(true);
    // A no-change re-read must not ship the full tree.
    expect(payload.treeString).toBeUndefined();
    expect(payload.snapshotId).toBeTruthy();
  });

  it('keeps the compact unchanged response for explicit deltaOnly: true', async () => {
    const els = [el(1, 'Submit')];
    await readDom(880_004, els, { deltaOnly: true });

    const payload = await readDom(880_004, els, { deltaOnly: true });

    expect(payload.unchanged).toBe(true);
    expect(payload.snapshotId).toBeTruthy();
  });

  it('mirrors the new default in the shared schema description', async () => {
    const fs = await import('node:fs');
    const schemas = JSON.parse(
      fs.readFileSync('../../plugins/browserclaw/core_schemas.json', 'utf-8'),
    );
    expect(schemas.chrome_read_dom.inputSchema.properties.deltaOnly.description).toContain(
      'default: true',
    );
  });
});
