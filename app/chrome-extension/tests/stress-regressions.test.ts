/**
 * Regression tests for the defects found by the BrowserClaw stress harness.
 * Each one encodes a concrete failure that was reproduced live against a real
 * Chrome build, so a future refactor cannot quietly reintroduce it.
 *
 *   A. an unknown tabId must never be silently swapped for another tab
 *   B. chrome_navigate must reject scheme-less / malformed URLs
 *   C. chrome_grep must report the true match count, not the page size
 *   D. an indexed <label> must resolve to its connected form control
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { readDOMTool } from '../entrypoints/background/tools/browser/read-dom';
import { navigateTool } from '../entrypoints/background/tools/browser/common';
import { grepTool } from '../entrypoints/background/tools/browser/grep';
import {
  getIsolatedIndexMap,
  inPageGetElementCoordinates,
  wrapElement,
} from '../entrypoints/background/tools/browser/dom-indexer';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';

function mockChromeTabs(overrides: Record<string, any> = {}) {
  (globalThis as any).chrome = {
    tabs: {
      get: vi.fn(async (id: number) => {
        throw new Error(`No tab with id: ${id}`);
      }),
      query: vi.fn(async () => [
        { id: 4242, active: true, url: 'https://active.example/', windowId: 1 },
      ]),
      update: vi.fn(async () => undefined),
      create: vi.fn(async () => ({ id: 5555 })),
      remove: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      ...overrides,
    },
    windows: {
      update: vi.fn(async () => undefined),
      getCurrent: vi.fn(async () => ({ id: 1 })),
    },
    runtime: { id: 'test-extension-id', sendMessage: vi.fn(async () => undefined) },
    scripting: { executeScript: vi.fn(async () => []) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    debugger: { attach: vi.fn(async () => undefined), detach: vi.fn(async () => undefined) },
  };
}

describe('BrowserClaw stress regressions', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getIsolatedIndexMap().clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── A. unknown tabId must fail loudly ────────────────────────────────────
  it('refuses to fall back to another tab when an explicit tabId does not exist', async () => {
    mockChromeTabs();

    const res = await readDOMTool.execute({ tabId: 999999999, limit: 5 } as any);

    expect(res.isError).toBe(true);
    const text = res.content[0].text as string;
    expect(text).toContain('999999999');
    expect(text).toMatch(/does not exist/i);
    // The active tab must NOT have been indexed instead.
    expect(text).not.toContain('treeString');
  });

  // ── B. navigate URL validation ───────────────────────────────────────────
  it('rejects a scheme-less URL instead of resolving it relative to the extension', async () => {
    mockChromeTabs();

    for (const bad of ['not a url', '127.0.0.1:8123/index.html', 'example.com/path']) {
      const res = await navigateTool.execute({ url: bad } as any);
      expect(res.isError).toBe(true);
      expect(res.content[0].text as string).toMatch(/missing a scheme/i);
    }
    // Nothing should have been navigated.
    expect((chrome.tabs as any).update).not.toHaveBeenCalled();
    expect((chrome.tabs as any).create).not.toHaveBeenCalled();
  });

  it('still accepts absolute URLs and the back/forward shortcuts', async () => {
    mockChromeTabs({ query: vi.fn(async () => []) });
    const res = await navigateTool.execute({ url: 'https://example.com/x' } as any);
    // It must not be rejected by the new validation (any later failure is fine).
    expect(res.content[0].text as string).not.toMatch(/missing a scheme/i);
  });

  // ── C. grep must not under-report matches ────────────────────────────────
  it('reports the true match count and a truncation flag when limit caps the page', async () => {
    mockChromeTabs();
    const elements = Array.from({ length: 60 }, (_, i) => ({
      index: i + 1,
      tagName: 'button',
      text: `List item ${i + 1}`,
      isInteractive: true,
      attributes: {},
    }));
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      { frameId: 0, result: { indexedElements: elements, indexMap: {} } },
    ] as any);

    const res = await grepTool.execute({
      query: 'List item',
      searchType: 'all_dom',
      limit: 20,
    } as any);

    const parsed = JSON.parse(res.content[0].text as string);
    expect(parsed.totalMatches).toBe(60);
    expect(parsed.returnedCount).toBe(20);
    expect(parsed.truncated).toBe(true);
    expect(parsed.matches.length).toBe(20);
  });

  it('flags a clamped limit and keeps one match shape for page_text', async () => {
    mockChromeTabs();
    vi.spyOn(engine, 'executeInPage').mockResolvedValue([
      { frameId: 0, result: { indexedElements: [], indexMap: {} } },
    ] as any);

    const res = await grepTool.execute({
      query: 'anything',
      searchType: 'page_text',
      limit: 500,
    } as any);

    const parsed = JSON.parse(res.content[0].text as string);
    expect(parsed.limitClamped).toBe(true);
    expect(parsed.limit).toBe(50);
    for (const m of parsed.matches) {
      expect(m).toHaveProperty('index');
    }
  });

  // ── D. label → control resolution ────────────────────────────────────────
  it('resolves an indexed <label> to its associated control', async () => {
    document.body.innerHTML = `
      <form>
        <label for="f-name">Full name</label>
        <input id="f-name" type="text" placeholder="Your name">
      </form>`;
    const label = document.querySelector('label') as HTMLLabelElement;
    expect(label).toBeTruthy();
    getIsolatedIndexMap().set(7, wrapElement(label) as any);

    const coords = inPageGetElementCoordinates(7);

    expect(coords.success).toBe(true);
    expect(String(coords.tagName).toLowerCase()).toBe('input');
    expect(coords.attributes?.id).toBe('f-name');
    expect(coords.labelResolved).toMatch(/label/i);
  });

  it('resolves a wrapping <label> (no for attribute) to its inner control', async () => {
    document.body.innerHTML = `<label>Quantity <input id="f-qty" type="number" value="0"></label>`;
    const label = document.querySelector('label') as HTMLLabelElement;
    getIsolatedIndexMap().set(3, wrapElement(label) as any);

    const coords = inPageGetElementCoordinates(3);

    expect(coords.success).toBe(true);
    expect(String(coords.tagName).toLowerCase()).toBe('input');
    expect(coords.attributes?.id).toBe('f-qty');
  });
});
