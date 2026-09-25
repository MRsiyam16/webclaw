import { describe, expect, it, vi } from 'vitest';
import { navigateTool } from '../entrypoints/background/tools/browser/common';

describe('navigate download reporting', () => {
  it('treats ERR_ABORTED as a successful download and reports its artifact path', async () => {
    let onError: ((details: any) => void) | undefined;
    let onCreated: ((item: any) => void) | undefined;
    const tab = { id: 71, windowId: 2, url: 'https://example.test/' };
    (globalThis as any).chrome = {
      tabs: {
        query: vi.fn(async () => [tab]),
        get: vi.fn(async () => ({ ...tab, url: 'https://example.test/download/invoice' })),
        update: vi.fn(async () => {
          onError?.({ tabId: 71, frameId: 0, error: 'net::ERR_ABORTED' });
          onCreated?.({ id: 88, tabId: 71, filename: 'C:/Users/test/Downloads/invoice.txt' });
          return tab;
        }),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      webNavigation: {
        onErrorOccurred: {
          addListener: vi.fn((fn) => {
            onError = fn;
          }),
          removeListener: vi.fn(),
        },
      },
      webRequest: { onHeadersReceived: { addListener: vi.fn(), removeListener: vi.fn() } },
      downloads: {
        onCreated: {
          addListener: vi.fn((fn) => {
            onCreated = fn;
          }),
          removeListener: vi.fn(),
        },
        search: vi.fn(async () => [{ id: 88, filename: 'C:/Users/test/Downloads/invoice.txt' }]),
      },
      windows: {
        get: vi.fn(async () => ({ id: 2 })),
        getLastFocused: vi.fn(async () => ({ id: 2 })),
        update: vi.fn(async () => ({})),
      },
      storage: { local: { get: vi.fn(async () => ({})) } },
      runtime: { id: 'test' },
    };

    const out = await navigateTool.execute({
      url: 'https://example.test/download/invoice',
      tabId: 71,
      autoGroup: false,
    } as any);
    const payload = JSON.parse(out.content[0].text as string);
    expect(payload.success).toBe(true);
    expect(payload.download).toEqual({
      filename: 'invoice.txt',
      path: 'C:/Users/test/Downloads/invoice.txt',
      id: 88,
    });
    expect(payload.navigationError).toBeUndefined();
    expect(out.isError).toBe(false);
  });
});
