import { afterEach, describe, expect, it } from 'vitest';
import {
  findIndexedElement,
  inPageDOMPruner,
} from '../entrypoints/background/tools/browser/dom-indexer';

describe('P0 F2: stable refs are printed for each visible element', () => {
  const previousRect = Element.prototype.getBoundingClientRect;
  afterEach(() => {
    Element.prototype.getBoundingClientRect = previousRect;
    document.body.innerHTML = '';
  });

  it('prints index/ref pairs and preserves a ref across scopes for action resolution', () => {
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 5,
        y: 5,
        left: 5,
        top: 5,
        right: 105,
        bottom: 45,
        width: 100,
        height: 40,
        toJSON: () => ({}),
      } as DOMRect;
    };
    document.body.innerHTML =
      '<header><button id="outside">Cart</button></header><main id="cart"><button id="checkout">Proceed to Checkout</button></main>';

    const full = inPageDOMPruner();
    const checkout = full.indexedElements?.find(
      (item) => item.attributes?.id === 'checkout',
    ) as any;
    expect(full.treeString).toMatch(/^\[\d+\|e\d+\]/m);
    expect(
      full.treeString
        ?.split('\n')
        .filter(Boolean)
        .every((line) => /^\[\d+\|e\d+\]/.test(line)),
    ).toBe(true);

    const scoped = inPageDOMPruner({ selector: '#cart' });
    const scopedCheckout = scoped.indexedElements?.find(
      (item) => item.attributes?.id === 'checkout',
    ) as any;
    expect(scopedCheckout.ref).toBe(checkout.ref);
    expect(findIndexedElement(scopedCheckout.ref)).toBe(document.querySelector('#checkout'));
  });
});
