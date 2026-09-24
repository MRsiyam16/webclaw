import { describe, it, expect, vi } from 'vitest';
import { TOOL_NAMES, TOOL_SCHEMAS, TOOL_NAME_TO_CATEGORY } from 'chrome-mcp-shared';
import { extractTool } from '../entrypoints/background/tools/browser/extract-tool';

/**
 * browser_extract must be a real, advertised tool — not just an internal
 * engine. The extractor (extractFrom) existed and the plugin surface declared
 * it, but it was absent from TOOL_SCHEMAS, so tools/list never advertised it and
 * no executor handled a call. These tests pin the declared-vs-implemented
 * surface (the invariant tool-surface-parity.test.ts enforces repo-wide) plus
 * the honest-missing contract at the tool boundary.
 */
describe('browser_extract is a callable, advertised tool', () => {
  it('is declared in TOOL_SCHEMAS with a matching executor (parity surface)', async () => {
    const schema: any = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.EXTRACT);

    expect(TOOL_NAMES.BROWSER.EXTRACT).toBe('chrome_extract');
    expect(schema, 'chrome_extract must be declared in TOOL_SCHEMAS').toBeTruthy();
    expect(schema.inputSchema.required).toContain('schema');
    expect(schema.inputSchema.properties.selector).toBeTruthy();

    // The description must state the return shape and the never-invented rule.
    expect(schema.description).toMatch(/missing/);
    expect(schema.description).toMatch(/never invented/i);

    // The declared constant must be referenced by an implementation file the
    // parity test scans (entrypoints/background/tools/browser/*.ts).
    const fs = await import('node:fs');
    const src = fs.readFileSync('entrypoints/background/tools/browser/extract-tool.ts', 'utf-8');
    expect(src).toContain('TOOL_NAMES.BROWSER.EXTRACT');

    // Read-like tier-2 tool: it must be categorised, or tool-profiles parity fails.
    expect(TOOL_NAME_TO_CATEGORY[TOOL_NAMES.BROWSER.EXTRACT]).toBe('perceive');

    // The executor is the declared tool.
    expect(extractTool.name).toBe(TOOL_NAMES.BROWSER.EXTRACT);
  });

  it('requires `schema`', async () => {
    const res: any = await extractTool.execute({} as any);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/schema/);
  });

  it('runs extraction in the page and reports an absent field in `missing`', async () => {
    const engine = await import('../entrypoints/background/tools/browser/in-page-engine');
    const spy = vi.spyOn(engine, 'executeInPage');
    vi.spyOn(extractTool as any, 'resolveAffinityTab').mockResolvedValue({
      id: 123,
      url: 'https://example.com',
    });

    document.body.innerHTML = `
      <article>
        <h3 data-ref="e1" data-field="title">A Light in the Attic</h3>
        <p data-ref="e2">£51.77</p>
      </article>`;

    // The in-page entrypoint must do the DOM work; here we execute the real
    // page function against the fixture document instead of a live tab.
    spy.mockImplementation(async (_target: any, fnName: string, args: any[]) => {
      if (fnName === 'inPageExtract') {
        const { inPageExtract } = await import('../entrypoints/background/tools/browser/extract');
        return [{ frameId: 0, result: inPageExtract(args[0], args[1]) }] as any;
      }
      return [] as any;
    });

    const res: any = await extractTool.execute({
      schema: {
        type: 'object',
        properties: { title: { type: 'string' }, price: { type: 'number' } },
        required: ['title'],
      },
    });

    expect(res.isError).toBe(false);
    const fnCall = spy.mock.calls.find((c) => c[1] === 'inPageExtract');
    expect(fnCall, 'extraction must run in the page via executeInPage').toBeTruthy();

    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.data.title).toBe('A Light in the Attic');
    // 'price' has no source element -> reported missing, never invented.
    expect(parsed.missing).toContain('price');
    expect(parsed.data).not.toHaveProperty('price');
    expect(parsed.sourceRefs.title).toBe('e1');
  });
});
