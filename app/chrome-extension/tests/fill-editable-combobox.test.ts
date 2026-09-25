import { afterEach, describe, expect, it, vi } from 'vitest';
import { performPhysicalFill } from '../entrypoints/background/tools/browser/fill-core';
import * as engine from '../entrypoints/background/tools/browser/in-page-engine';
import { cdpSessionManager } from '../utils/cdp-session-manager';

describe('physical fill ARIA combobox routing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fills an editable input combobox as text without selecting a suggestion', async () => {
    vi.spyOn(cdpSessionManager, 'withSession').mockImplementation(
      async (_tab: number, _owner: string, fn: any) => fn(),
    );
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, name: string) => {
      if (name === 'inPageGetElementCoordinates')
        return [
          {
            result: {
              success: true,
              x: 2,
              y: 2,
              tagName: 'input',
              role: 'combobox',
              inputType: 'text',
              attributes: {},
            },
          },
        ] as any;
      if (name === 'inPageVerifyInputCommitment') return [{ result: { committed: true } }] as any;
      return [{ result: { success: true, committed: true } }] as any;
    });
    const result = await performPhysicalFill({
      tabId: 42,
      target: 1,
      text: 'search words',
      clear: true,
    });
    expect(result.success).toBe(true);
    expect(
      engine.executeInPage.mock.calls.some((call) => call[1] === 'inPageSelectCustomCombobox'),
    ).toBe(false);
  });

  it('preserves append and Enter options on the editable input path', async () => {
    vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, name: string) => {
      if (name === 'inPageGetElementCoordinates')
        return [
          {
            result: {
              success: true,
              x: 2,
              y: 2,
              tagName: 'input',
              role: 'combobox',
              inputType: 'text',
              attributes: {},
            },
          },
        ] as any;
      return [{ result: { success: true, committed: true } }] as any;
    });
    vi.spyOn(cdpSessionManager, 'withSession').mockRejectedValue(new Error('CDP unavailable'));
    await performPhysicalFill({
      tabId: 42,
      target: 1,
      text: ' appended',
      clear: false,
      pressEnter: true,
    });
    const fillCall = engine.executeInPage.mock.calls.find((call) => call[1] === 'inPageFillIndex');
    expect(fillCall?.[2]).toEqual([1, ' appended', false, true]);
  });

  it.each([{ readonly: '' }, { readonly: 'readonly' }, { 'aria-readonly': 'true' }])(
    'keeps readonly comboboxes on the option selection path: %j',
    async (attributes) => {
      vi.spyOn(engine, 'executeInPage').mockImplementation(async (_target: any, name: string) => {
        if (name === 'inPageGetElementCoordinates')
          return [
            {
              result: {
                success: true,
                x: 2,
                y: 2,
                tagName: 'input',
                role: 'combobox',
                attributes,
              },
            },
          ] as any;
        if (name === 'inPageSelectCustomCombobox')
          return [{ result: { success: true, committed: true, selectedText: 'Choice' } }] as any;
        return [] as any;
      });
      const result = await performPhysicalFill({ tabId: 42, target: 1, text: 'Choice' });
      expect(result.method).toBe('widget_native');
      expect(
        engine.executeInPage.mock.calls.some(
          (call) =>
            call[1] === 'inPageSelectCustomCombobox' &&
            call[2]?.[0] === 1 &&
            call[2]?.[2] === 'Choice',
        ),
      ).toBe(true);
    },
  );
});
