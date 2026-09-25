import { describe, expect, it, vi } from 'vitest';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';

describe('batch select value assertions', () => {
  it('asserts and returns the selected value and label instead of the options text', async () => {
    (batchActionsTool as any).resolveAffinityTab = vi
      .fn()
      .mockResolvedValue({ id: 1, url: 'https://example.test/' });
    (globalThis as any).chrome = {
      tabs: { get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.test/' }) },
    };
    (batchActionsTool as any).safeExecuteScript = vi.fn().mockResolvedValue([
      {
        result: {
          found: true,
          visible: true,
          text: '10',
          value: '10',
          selectedValue: '10',
          selectedText: '10',
          disabled: false,
          ariaDisabled: false,
        },
      },
    ]);

    const result = await batchActionsTool.execute({
      tabId: 1,
      actions: [
        {
          type: 'assert',
          selector: '#days',
          property: 'value',
          expectedText: '10',
          condition: 'equals',
        } as any,
      ],
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.assertions[0].passed).toBe(true);
    expect(body.results[0].output).toMatchObject({
      value: '10',
      selectedValue: '10',
      selectedText: '10',
    });
    expect(body.results[0].output.actualText).not.toContain('\n1\n2\n');
  });
});
