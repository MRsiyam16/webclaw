import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fillIndexTool } from '../entrypoints/background/tools/browser/fill-index';
import { interactIndexTool } from '../entrypoints/background/tools/browser/interact-index';
import * as inPageEngine from '../entrypoints/background/tools/browser/in-page-engine';
import { sessionTabAffinity } from '../utils/session-tab-affinity';

/**
 * DEFECT B (observed live during benchmarking):
 *
 * A chrome_fill_index call with NO explicit tabId was routed to the ACTIVE tab
 * — a different test page — typed into it, and reported success:true with no
 * warning. Silent wrong-tab action is a correctness and safety problem.
 *
 * Contract: a session-scoped call must either target the tab that session read
 * (reported as resolvedTabId) or fail loudly with a structured ambiguous_tab
 * error. It must never fall back to "whatever is active".
 */
const ACTIVE_TAB = { id: 902, url: 'https://other-test-page.example/' };

function mockTabLayer(options: { knownTabs: number[] }) {
  (globalThis as any).chrome = {
    tabs: {
      // The user's active tab is a DIFFERENT page — the exact hazard.
      query: vi.fn(async () => [ACTIVE_TAB]),
      get: vi.fn(async (id: number) => {
        if (options.knownTabs.includes(id)) {
          return { id, url: `https://session-tab-${id}.example/read` };
        }
        throw new Error(`No tab with id: ${id}`);
      }),
    },
    storage: {
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
    },
  };
}

function mockInPage() {
  const calls: { fnName: string; tabId?: number }[] = [];
  vi.spyOn(inPageEngine, 'executeInPage').mockImplementation(
    async (target: any, fnName: string) => {
      calls.push({ fnName, tabId: target?.tabId });
      if (fnName === 'inPageGetElementCoordinates') {
        return [
          { result: { success: true, x: 10, y: 10, tagName: 'input', inputType: 'text' } },
        ] as any;
      }
      if (fnName === 'inPageVerifyInputCommitment') {
        return [{ result: { committed: true, currentValue: 'hello' } }] as any;
      }
      return [{ result: { success: true, committed: true } }] as any;
    },
  );
  return calls;
}

describe('fill/interact never act on an unspecified tab (DEFECT B)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    sessionTabAffinity.clearAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionTabAffinity.clearAll();
  });

  it('fill_index: no tabId and no session tab -> structured ambiguous_tab error and NO action', async () => {
    mockTabLayer({ knownTabs: [] });
    const calls = mockInPage();

    const res = await fillIndexTool.execute({
      index: 1,
      text: 'hello',
      sessionId: 'sess-no-read',
    });

    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.error).toBe('ambiguous_tab');
    expect(parsed.message).toBe(
      'no tabId and no tab read in this session; pass tabId explicitly',
    );
    expect(parsed.resolvedTabId).toBeNull();

    // Nothing may have been typed anywhere — not into the user's active tab.
    expect(calls.filter((c) => c.fnName === 'inPageFillIndex')).toEqual([]);
    expect(calls.filter((c) => c.tabId === ACTIVE_TAB.id)).toEqual([]);
  });

  it('fill_index: uses the tab the session read and reports resolvedTabId', async () => {
    mockTabLayer({ knownTabs: [77] });
    const calls = mockInPage();
    sessionTabAffinity.setAffinity('sess-read-77', 77);

    const res = await fillIndexTool.execute({
      index: 1,
      text: 'hello',
      sessionId: 'sess-read-77',
      waitForSettle: false,
    });

    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.resolvedTabId).toBe(77);
    // Every in-page action went to the session tab, never to the active tab.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.tabId === 77)).toBe(true);
  });

  it('interact_index: no tabId and no session tab -> structured ambiguous_tab error and NO action', async () => {
    mockTabLayer({ knownTabs: [] });
    const calls = mockInPage();

    const res = await interactIndexTool.execute({
      index: 1,
      action: 'click',
      sessionId: 'sess-no-read-interact',
    });

    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.error).toBe('ambiguous_tab');
    expect(parsed.resolvedTabId).toBeNull();
    expect(calls.filter((c) => c.tabId === ACTIVE_TAB.id)).toEqual([]);
  });

  it('interact_index: uses the tab the session read and reports resolvedTabId', async () => {
    mockTabLayer({ knownTabs: [88] });
    const calls = mockInPage();
    sessionTabAffinity.setAffinity('sess-read-88', 88);

    const res = await interactIndexTool.execute({
      index: 1,
      action: 'click',
      sessionId: 'sess-read-88',
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.tabId === 88)).toBe(true);
    if (!res.isError) {
      const parsed = JSON.parse((res.content[0] as any).text);
      expect(parsed.resolvedTabId).toBe(88);
    }
  });

  it('fill_index: an explicit tabId is echoed back as resolvedTabId', async () => {
    mockTabLayer({ knownTabs: [55] });
    mockInPage();

    const res = await fillIndexTool.execute({
      index: 1,
      text: 'hello',
      tabId: 55,
      waitForSettle: false,
    });

    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.resolvedTabId).toBe(55);
  });
});
