import { describe, it, expect } from 'vitest';
import { toolDocsTool } from '../entrypoints/background/tools/browser/tool-docs';

/**
 * Tier-3 power tools (chrome_javascript, chrome_cdp_execute) live only in the
 * `full` profile, so the default profile could never reach them. chrome_tool_docs
 * now has a `power` category that discloses them, and only unlocks them for the
 * session when the caller explicitly opts in with activateForSession:true.
 */
const POWER_TOOLS = ['chrome_javascript', 'chrome_cdp_execute'];
const EXISTING_CATEGORIES = [
  'navigate',
  'perceive',
  'act',
  'observe',
  'manage',
  'crawl',
  'diagnose',
  'network',
];

const textOf = (res: any): string => res.content.map((c: any) => c.text).join('\n');

describe('tool_docs power category (tier 3, per-session activation)', () => {
  it('(a) category "power" lists both javascript and cdp_execute', async () => {
    const res = await toolDocsTool.execute({ category: 'power' } as any);
    const text = textOf(res);

    expect(res.isError).toBe(false);
    for (const name of POWER_TOOLS) {
      expect(text, `${name} must be documented under power`).toContain(name);
    }
  });

  it('(b) activateForSession:true reports activation and carries the risk warning', async () => {
    const res: any = await toolDocsTool.execute({
      category: 'power',
      activateForSession: true,
    } as any);
    const text = textOf(res);

    expect(res.isError).toBe(false);
    expect(text.toLowerCase()).toContain('activated for this session');
    // The warning must name the concrete capabilities that make this tier risky.
    expect(text.toLowerCase()).toContain('document.cookie');
    expect(text.toLowerCase()).toContain('input');

    expect(res.metadata).toMatchObject({ riskTier: 3, activatedForSession: true });
    expect(res.metadata.tools).toEqual(expect.arrayContaining(POWER_TOOLS));
  });

  it('(c) without activateForSession:true the power tools are NOT activated', async () => {
    const res: any = await toolDocsTool.execute({ category: 'power' } as any);
    const text = textOf(res).toLowerCase();

    expect(res.isError).toBe(false);
    expect(res.metadata?.activatedForSession).toBe(false);
    expect(text).toContain('not activated');
    expect(text).toContain('activateforsession:true');
    // The docs and the warning are still returned.
    expect(text).toContain('document.cookie');
  });

  it('(d) the existing categories still resolve unchanged', async () => {
    for (const category of EXISTING_CATEGORIES) {
      const res: any = await toolDocsTool.execute({ category } as any);

      expect(res.isError, `${category} must still resolve`).toBe(false);
      expect(textOf(res)).toContain(`[${category}]`);
    }
  });
});
