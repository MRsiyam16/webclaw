import { describe, expect, it, vi } from 'vitest';
import { navigateTool } from '../entrypoints/background/tools/browser/common';

describe('B3 navigate HTTP failures', () => {
  it('includes a completed HTTP error status and marks the result unsuccessful', async () => {
    let completed: ((details: any) => void) | undefined;
    let headers: ((details: any) => void) | undefined;
    const tab = { id: 71, windowId: 2, url: 'https://old.example/' };
    (globalThis as any).chrome = {
      tabs: {
        query: vi.fn(async () => [tab]),
        get: vi.fn(async () => ({ ...tab, url: 'https://httpbin.org/status/404' })),
        update: vi.fn(async () => {
          completed?.({ tabId: 71, frameId: 0, statusCode: 200 });
          headers?.({
            tabId: 999,
            type: 'main_frame',
            statusCode: 200,
            url: 'https://unrelated.example/',
          });
          headers?.({
            tabId: 71,
            type: 'sub_frame',
            statusCode: 200,
            url: 'https://httpbin.org/status/404',
          });
          headers?.({
            tabId: 71,
            type: 'main_frame',
            statusCode: 404,
            url: 'https://httpbin.org/status/404',
          });
          return tab;
        }),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      webNavigation: {
        onCompleted: {
          addListener: vi.fn((fn) => {
            completed = fn;
          }),
          removeListener: vi.fn(),
        },
        onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      webRequest: {
        onHeadersReceived: {
          addListener: vi.fn((fn) => {
            headers = fn;
          }),
          removeListener: vi.fn(),
        },
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
      url: 'https://httpbin.org/status/404',
      tabId: 71,
      autoGroup: false,
    } as any);
    const payload = JSON.parse(out.content[0].text as string);
    expect(payload.statusCode).toBe(404);
    expect(payload.success).toBe(false);
    expect(out.isError).toBe(true);
    expect(
      (globalThis as any).chrome.webRequest.onHeadersReceived.removeListener,
    ).toHaveBeenCalled();
  });
});
