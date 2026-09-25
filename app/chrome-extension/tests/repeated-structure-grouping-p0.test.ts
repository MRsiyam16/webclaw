import { afterEach, describe, expect, it } from 'vitest';
import { inPageDOMPruner } from '../entrypoints/background/tools/browser/dom-indexer';

describe('P0 F3: repeated product actions carry their owning card identity', () => {
  const previousRect = Element.prototype.getBoundingClientRect;
  afterEach(() => {
    Element.prototype.getBoundingClientRect = previousRect;
    document.body.innerHTML = '';
  });

  it('annotates each repeated action with its own product name and price in document order', () => {
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 10,
        y: 10,
        left: 10,
        top: 10,
        right: 210,
        bottom: 180,
        width: 200,
        height: 170,
        toJSON: () => ({}),
      } as DOMRect;
    };
    document.body.innerHTML = `
      <section class="features_items">
        <div class="col-sm-4"><div class="productinfo"><h2>Rs. 1200</h2><p>Regular Fit Straight Jeans</p><a href="/product_details/1">Add to cart</a></div></div>
        <div class="col-sm-4"><div class="productinfo"><h2>Rs. 799</h2><p>Soft Stretch Jeans</p><a href="/product_details/33">Add to cart</a></div></div>
        <div class="col-sm-4"><div class="productinfo"><h2>Rs. 1400</h2><p>Grunt Blue Slim Fit Jeans</p><a href="/product_details/2">Add to cart</a></div></div>
      </section>`;

    const first = inPageDOMPruner({ selector: '.features_items' });
    const actionLines =
      first.treeString?.split('\n').filter((line) => line.includes('link "Add to cart"')) || [];
    expect(actionLines).toHaveLength(3);
    expect(actionLines[0]).toContain('Regular Fit Straight Jeans — Rs. 1200');
    expect(actionLines[1]).toContain('Soft Stretch Jeans — Rs. 799');
    expect(actionLines[2]).toContain('Grunt Blue Slim Fit Jeans — Rs. 1400');
    expect(actionLines.every((line) => /^\[\d+\|e\d+\]/.test(line))).toBe(true);
    expect(new Set(actionLines.map((line) => line.match(/\|([^\]]+)/)?.[1])).size).toBe(3);

    const again = inPageDOMPruner({ selector: '.features_items' });
    const againRefs = again.treeString
      ?.split('\n')
      .filter((line) => line.includes('link "Add to cart"'))
      .map((line) => line.match(/\|([^\]]+)/)?.[1]);
    expect(againRefs).toEqual(actionLines.map((line) => line.match(/\|([^\]]+)/)?.[1]));
  });
});
