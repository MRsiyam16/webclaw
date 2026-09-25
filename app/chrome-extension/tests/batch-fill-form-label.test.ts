import { describe, expect, it, vi } from 'vitest';
import { batchActionsTool } from '../entrypoints/background/tools/browser/batch-actions';
import * as fillCore from '../entrypoints/background/tools/browser/fill-core';

describe('batch fill_form label descriptors', () => {
  it('resolves a visible label and returns applied verdict with selector, without returning field value', async () => {
    (globalThis as any).chrome = {
      tabs: { get: vi.fn().mockResolvedValue({ id: 10, url: 'https://example.com' }) },
    };
    (batchActionsTool as any).safeExecuteScript = vi
      .fn()
      .mockImplementation(async (_tab: number, request: any) => {
        if (String(request.func).includes('performance.timeOrigin')) return [{ result: 1 }];
        if (request.args?.[0] === 'Password')
          return [{ result: { verdict: 'resolved', selector: '#password', source: 'label' } }];
        return [{ result: 1 }];
      });
    vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
      filledText: 'secret123',
    } as any);

    const result = await batchActionsTool.execute({
      tabId: 10,
      actions: [{ type: 'fill_form', fields: [{ label: 'Password', value: 'secret123' }] } as any],
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].output.fields[0]).toMatchObject({
      success: true,
      verdict: 'applied',
      selector: '#password',
    });
    expect(result.content[0].text).not.toContain('secret123');
  });

  it('accepts a visible-label-to-value map as well as descriptor arrays', async () => {
    (globalThis as any).chrome = {
      tabs: { get: vi.fn().mockResolvedValue({ id: 10, url: 'https://example.com' }) },
    };
    (batchActionsTool as any).safeExecuteScript = vi
      .fn()
      .mockImplementation(async (_tab: number, request: any) =>
        request.args?.[0] === 'Country'
          ? [{ result: { verdict: 'resolved', selector: '#country', source: 'label' } }]
          : [{ result: 1 }],
      );
    vi.spyOn(fillCore, 'performPhysicalFill').mockResolvedValue({
      success: true,
      committed: true,
    } as any);
    const result = await batchActionsTool.execute({
      tabId: 10,
      actions: [{ type: 'fill_form', fields: { Country: 'United States' } } as any],
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].output.fields[0]).toMatchObject({
      verdict: 'applied',
      selector: '#country',
    });
  });

  it('fails closed on an ambiguous label without attempting to fill', async () => {
    (globalThis as any).chrome = {
      tabs: { get: vi.fn().mockResolvedValue({ id: 10, url: 'https://example.com' }) },
    };
    (batchActionsTool as any).safeExecuteScript = vi
      .fn()
      .mockImplementation(async (_tab: number, request: any) => {
        if (String(request.func).includes('performance.timeOrigin')) return [{ result: 1 }];
        if (request.args?.[0] === 'Email')
          return [{ result: { verdict: 'failed', reason: 'ambiguous' } }];
        return [{ result: 1 }];
      });
    const fill = vi.spyOn(fillCore, 'performPhysicalFill');

    const result = await batchActionsTool.execute({
      tabId: 10,
      actions: [
        { type: 'fill_form', fields: [{ label: 'Email', value: 'private@example.com' }] } as any,
      ],
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].error).toContain('ambiguous');
    expect(fill).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain('private@example.com');
  });
});
