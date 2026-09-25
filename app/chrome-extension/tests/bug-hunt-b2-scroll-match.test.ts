import { describe, expect, it, vi } from 'vitest';
import { inPageScrollUntilFound } from '../entrypoints/background/tools/browser/dom-indexer';

describe('B2 scroll_until_found match selection', () => {
  it('returns the smallest matching descendant instead of its broad ancestor', async () => {
    document.body.innerHTML = '<main><div>Intro <span id="match">Ghana</span> details</div></main>';
    for (const el of [
      document.querySelector('main')!,
      document.querySelector('div')!,
      document.querySelector('span')!,
    ]) {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 100,
        bottom: 40,
        width: 100,
        height: 40,
        toJSON() {},
      } as DOMRect);
    }
    Element.prototype.scrollIntoView = vi.fn();
    const result = await inPageScrollUntilFound({ query: 'Ghana', maxSteps: 1, settleMs: 50 });
    expect(result.found).toBe(true);
    expect(result.tagName).toBe('span');
    expect(result.text).toBe('Ghana');
  });
});
