import { describe, it, expect, vi } from 'vitest';
import type { BatchActionItem, BatchActionResult } from 'chrome-mcp-shared';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';

describe('Batch Actions Assert & Extract Pipeline', () => {
  it('supports declaring assert and extract actions in BatchActionItem', () => {
    const assertAction: BatchActionItem = {
      type: 'assert',
      index: 1,
      expectedText: 'Success',
      condition: 'contains',
      abortOnFailure: true,
    };

    const extractAction: BatchActionItem = {
      type: 'extract',
      index: 2,
      property: 'text',
      variableName: 'orderId',
    };

    expect(assertAction.type).toBe('assert');
    expect(assertAction.expectedText).toBe('Success');
    expect(extractAction.type).toBe('extract');
    expect(extractAction.variableName).toBe('orderId');

    const doubleClickAction: BatchActionItem = {
      type: 'double_click',
      index: 5,
    };
    const rightClickAction: BatchActionItem = {
      type: 'right_click',
      index: 6,
    };
    expect(doubleClickAction.type).toBe('double_click');
    expect(rightClickAction.type).toBe('right_click');
  });

  it('verifies BatchActionResult includes extractedData and assertions', () => {
    const res: BatchActionResult = {
      success: true,
      completedActions: 2,
      totalActions: 2,
      extractedData: { orderId: 'ORD-12345' },
      assertions: [{ actionIndex: 0, passed: true, condition: 'contains' }],
      results: [
        { actionIndex: 0, success: true },
        { actionIndex: 1, success: true },
      ],
    };

    expect(res.extractedData?.orderId).toBe('ORD-12345');
    expect(res.assertions?.[0].passed).toBe(true);
  });

  it('executes assert and extract pipeline on batchActionsTool', async () => {
    (batchActionsTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: 1,
      url: 'https://example.com/app',
    });
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com/app' }),
      },
    };
    (batchActionsTool as any).safeExecuteScript = vi
      .fn()
      .mockResolvedValueOnce([
        { result: { found: true, visible: true, text: 'Order #999', value: '' } },
      ])
      .mockResolvedValueOnce([{ result: 'Order #999' }]);

    const res = await batchActionsTool.execute({
      tabId: 1,
      actions: [
        {
          type: 'assert',
          selector: '#order-status',
          expectedText: 'Order #999',
          condition: 'equals',
        },
        {
          type: 'extract',
          selector: '#order-status',
          property: 'text',
          variableName: 'confirmedOrder',
        },
      ],
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.completedActions).toBe(2);
    expect(parsed.extractedData?.confirmedOrder).toBe('Order #999');
    expect(parsed.assertions?.[0].passed).toBe(true);
  });

  it('polls text assertions and reads descendant text when the element value is empty', async () => {
    (batchActionsTool as any).resolveAffinityTab = vi.fn().mockResolvedValue({
      id: 1,
      url: 'https://example.com/app',
    });
    (globalThis as any).chrome = {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com/app' }),
      },
    };
    const safeExecuteScript = vi
      .fn()
      .mockResolvedValueOnce([{ result: { found: true, visible: true, text: '', value: '' } }])
      .mockResolvedValueOnce([
        {
          result: {
            found: true,
            visible: true,
            text: 'Pera Nai Chill',
            value: '',
          },
        },
      ]);
    (batchActionsTool as any).safeExecuteScript = safeExecuteScript;

    const res = await batchActionsTool.execute({
      tabId: 1,
      actions: [
        {
          type: 'assert',
          selector: 'a#video-title',
          expectedText: 'Pera Nai Chill',
          condition: 'contains',
          timeoutMs: 100,
        },
      ],
    });

    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.assertions?.[0].passed).toBe(true);
    expect(parsed.results[0].output.actualText).toBe('Pera Nai Chill');
    expect(safeExecuteScript).toHaveBeenCalledTimes(2);
  });
});
