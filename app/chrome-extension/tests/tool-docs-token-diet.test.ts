import { describe, expect, it } from 'vitest';
import { toolDocsTool } from '../entrypoints/background/tools/browser/tool-docs';

describe('tool_docs explains compact response protocols on demand', () => {
  it('documents pagination, delta, asset opt-in, and grep fallback in perceive docs', async () => {
    const result = await toolDocsTool.execute({ category: 'perceive' });
    const text = result.content[0].text as string;
    expect(text).toContain('includeAssets');
    expect(text).toContain('cursor');
    expect(text).toContain('fallbackUsed');
    expect(text).toContain('batch_actions');
    expect(text).toContain('never invented');
  });
});
