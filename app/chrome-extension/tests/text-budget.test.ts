import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { budgetText } from '../entrypoints/background/tools/browser/text-budget';

/** Shared browser tool schemas consumed by the browserclaw plugin / MCP layer. */
const SCHEMAS_PATH = '../../plugins/browserclaw/core_schemas.json';
const schemaFor = (name: string) => JSON.parse(fs.readFileSync(SCHEMAS_PATH, 'utf-8'))[name];

describe('budgetText (hard output budgets)', () => {
  it('truncates on a character boundary and reports the true total', () => {
    const out = budgetText('x'.repeat(200_000), 1000);
    expect(out.text.length).toBeLessThanOrEqual(1000);
    expect(out).toMatchObject({ truncated: true, totalChars: 200_000 });
  });

  it('passes a short text through untruncated', () => {
    const out = budgetText('hello world', 1000);
    expect(out).toMatchObject({ text: 'hello world', truncated: false, totalChars: 11 });
    expect(out.text).toBe('hello world');
  });

  it('defaults to a 120000-character budget', () => {
    const out = budgetText('y'.repeat(200_000));
    expect(out.truncated).toBe(true);
    expect(out.totalChars).toBe(200_000);
    expect(out.text.length).toBeLessThanOrEqual(120_000);
  });
});

const BIG_TREE = Array.from({ length: 4_000 }, (_, i) => `[${i + 1}] button "Row ${i}"`).join('\n');

const SAMPLE = {
  treeString: BIG_TREE,
  elementCount: 4_000,
  interactiveCount: 4_000,
  compressionRatio: 0.9,
  indexMap: { 1: { selector: 'button', tagName: 'button' } },
  indexedElements: [{ index: 1, tagName: 'button', text: 'Row 0', isInteractive: true }],
  pages_up: 0,
  pages_down: 0,
};

async function runReadDom(args: Record<string, unknown> = {}, tabId = 777_001) {
  const mod = await import('../entrypoints/background/tools/browser/read-dom');
  const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
  const spy = vi.spyOn(engine, 'executeInPage');
  spy.mockResolvedValue([{ frameId: 0, result: { ...SAMPLE } }] as any);
  (mod.readDOMTool as any).resolveAffinityTab = async () => ({
    id: tabId,
    url: 'https://x.test',
    title: 'X',
  });

  const res = await mod.readDOMTool.execute(args as any);
  spy.mockRestore();
  return res;
}

describe('read_dom hard output budget', () => {
  it('caps the response at maxChars and reports truncated/totalChars', async () => {
    const res = await runReadDom({ maxChars: 2_000, deltaOnly: false });
    const text = res.content[0].text as string;
    const payload = JSON.parse(text);

    expect(payload.truncated).toBe(true);
    expect(payload.totalChars).toBe(BIG_TREE.length);
    expect(text.length).toBeLessThanOrEqual(2_000);
    // existing fields must keep working
    expect(payload.elementCount).toBe(4_000);
    // interactiveCount counts isInteractive entries in indexedElements (1 here).
    expect(payload.interactiveCount).toBe(1);
    expect(payload.snapshotId).toBeTruthy();
  });

  it('leaves a small response untruncated (no truncated flag)', async () => {
    const mod = await import('../entrypoints/background/tools/browser/read-dom');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const spy = vi.spyOn(engine, 'executeInPage');
    spy.mockResolvedValue([
      { frameId: 0, result: { ...SAMPLE, treeString: '[1] button "Row 0"', elementCount: 1 } },
    ] as any);
    (mod.readDOMTool as any).resolveAffinityTab = async () => ({
      id: 777_002,
      url: 'https://x.test',
      title: 'X',
    });

    const res = await mod.readDOMTool.execute({ deltaOnly: false } as any);
    spy.mockRestore();
    const payload = JSON.parse(res.content[0].text as string);
    expect(payload.truncated).toBeUndefined();
    expect(payload.totalChars).toBeUndefined();
    expect(payload.treeString).toBe('[1] button "Row 0"');
  });

  it('declares maxChars in the read_dom schema', () => {
    const schema = schemaFor('chrome_read_dom');
    expect(schema.inputSchema.properties.maxChars).toBeTruthy();
    expect(schema.inputSchema.properties.maxChars.type).toBe('number');
  });
});

describe('get_markdown hard output budget', () => {
  it('caps markdown output at maxLength', async () => {
    const mod = await import('../entrypoints/background/tools/browser/get-markdown');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const spy = vi.spyOn(engine, 'executeInPage');
    spy.mockResolvedValue([{ frameId: 0, result: 'm'.repeat(50_000) }] as any);
    (mod.getMarkdownTool as any).resolveAffinityTab = async () => ({
      id: 777_003,
      url: 'https://x.test',
      title: 'X',
    });

    const res = await mod.getMarkdownTool.execute({ maxLength: 500 } as any);
    spy.mockRestore();
    const text = res.content[0].text as string;
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).toContain('truncated');
    expect(text).toContain('50000');
  });

  it('passes markdown through untruncated when under the budget', async () => {
    const mod = await import('../entrypoints/background/tools/browser/get-markdown');
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const spy = vi.spyOn(engine, 'executeInPage');
    spy.mockResolvedValue([{ frameId: 0, result: '# Title\n\nBody' }] as any);
    (mod.getMarkdownTool as any).resolveAffinityTab = async () => ({
      id: 777_004,
      url: 'https://x.test',
      title: 'X',
    });

    const res = await mod.getMarkdownTool.execute({} as any);
    spy.mockRestore();
    expect(res.content[0].text).toBe('# Title\n\nBody');
  });

  it('declares selector and maxLength in the get_markdown schema', () => {
    const schema = schemaFor('chrome_get_markdown');
    expect(schema.inputSchema.properties.selector).toBeTruthy();
    expect(schema.inputSchema.properties.selector.type).toBe('string');
    expect(schema.inputSchema.properties.maxLength).toBeTruthy();
    expect(schema.inputSchema.properties.maxLength.type).toBe('number');
  });
});

describe('budgetText hard invariant: text.length <= maxChars for every maxChars >= 0', () => {
  const SOURCE = 'abcdefghij'; // length 10
  const EMOJI = '😀'.repeat(5); // 5 astral chars, 10 code units

  const expectBounded = (
    out: ReturnType<typeof budgetText>,
    maxChars: number,
    original: string,
  ) => {
    expect(out.text.length).toBeLessThanOrEqual(maxChars);
    expect(out.totalChars).toBe(original.length);
  };

  it('maxChars 0 yields an empty text (never the full original)', () => {
    const out = budgetText(SOURCE, 0);
    expectBounded(out, 0, SOURCE);
    expect(out.text).toBe('');
    expect(out.truncated).toBe(true);
  });

  it('text length exactly == maxChars passes through untruncated', () => {
    const out = budgetText(SOURCE, SOURCE.length);
    expectBounded(out, SOURCE.length, SOURCE);
    expect(out.text).toBe(SOURCE);
    expect(out.truncated).toBe(false);
    expect(out.totalChars).toBe(10);
  });

  it('length == maxChars + 1 truncates within the cap', () => {
    const out = budgetText(SOURCE, SOURCE.length + 1);
    expectBounded(out, SOURCE.length + 1, SOURCE);
    expect(out.text).toBe(SOURCE);
    expect(out.truncated).toBe(false);
  });

  it('a maxChars smaller than the notice drops the notice instead of exceeding the cap', () => {
    const out = budgetText(SOURCE, 9);
    expectBounded(out, 9, SOURCE);
    expect(out.truncated).toBe(true);
    expect(out.text).not.toContain('[truncated');
  });

  it('cuts an emoji string on a boundary without splitting a surrogate pair', () => {
    for (const max of [0, 1, 2, 3, 4, 8, 9, 11]) {
      const out = budgetText(EMOJI, max);
      expectBounded(out, max, EMOJI);
      expect(out.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(out.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it('leaves a text shorter than maxChars untouched', () => {
    const out = budgetText('short', 1000);
    expectBounded(out, 1000, 'short');
    expect(out.text).toBe('short');
    expect(out.truncated).toBe(false);
  });

  it('keeps the large-text case bounded and non-finite caps untruncated', () => {
    const big = budgetText('x'.repeat(200_000), 1000);
    expect(big.text.length).toBeLessThanOrEqual(1000);
    expect(big.totalChars).toBe(200_000);
    expect(big.truncated).toBe(true);

    const unbounded = budgetText(SOURCE, Number.NaN);
    expect(unbounded).toMatchObject({ text: SOURCE, truncated: false, totalChars: 10 });
  });
});
