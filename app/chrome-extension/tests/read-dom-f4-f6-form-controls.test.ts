import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inPageDOMPruner,
  inPageDetectPerceptiveSignature,
  renderCompactElementLine,
} from '../entrypoints/background/tools/browser/dom-indexer';

function rect(left = 10, top = 10, width = 120, height = 32) {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top };
}

function setRect(el: Element, bounds = rect()) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(bounds as DOMRect);
}

describe('read_dom card occlusion and form control visibility', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('does not mark card actions occluded by their own overlay and keeps document order', () => {
    const card = document.createElement('div');
    card.className = 'col-sm-4';
    const action = document.createElement('button');
    action.textContent = 'Add to cart';
    const heading = document.createElement('h2');
    heading.textContent = 'Soft Stretch Jeans';
    const overlay = document.createElement('div');
    overlay.className = 'product-overlay';
    card.append(action, heading, overlay);
    document.body.append(card);
    setRect(action, rect(10, 100));
    setRect(heading, rect(10, 10));
    setRect(overlay, rect(10, 10, 120, 120));
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(overlay);

    const result = inPageDOMPruner({ flattenCards: false });
    const actionLine = result.treeString.indexOf('Add to cart');
    const headingLine = result.treeString.indexOf('Soft Stretch Jeans');
    const indexedAction = result.indexedElements?.find((el) => el.text === 'Add to cart');

    expect(indexedAction?.isOccluded).not.toBe(true);
    expect(actionLine).toBeLessThan(headingLine);
  });

  it('indexes neutral text inputs and gives activeInputs the indexed element ref', () => {
    const input = document.createElement('input');
    input.type = 'search';
    input.name = 'search';
    input.placeholder = 'Search Product';
    document.body.append(input);
    setRect(input);

    const result = inPageDOMPruner();
    const indexedInput = result.indexedElements?.find((el) => el.attributes.name === 'search');
    const activeInput = inPageDetectPerceptiveSignature().activeInputs.find(
      (entry) => entry.name === 'search',
    );
    const indexedRef = (indexedInput as typeof indexedInput & { ref?: string })?.ref;

    expect(indexedInput).toBeDefined();
    expect(indexedRef).toMatch(/^e\d+$/);
    expect(activeInput?.ref).toBe(indexedRef);
  });

  it('renders selected select state and explicit radio/checkbox checked state', () => {
    const select = document.createElement('select');
    select.innerHTML = '<option value="">Choose</option><option value="10">10</option>';
    select.value = '10';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = false;
    document.body.append(select, checkbox);
    setRect(select);
    setRect(checkbox);

    const result = inPageDOMPruner();
    const selectLine = renderCompactElementLine(
      result.indexedElements!.find((el) => el.tagName === 'select')!,
    );
    const checkboxLine = renderCompactElementLine(
      result.indexedElements!.find((el) => el.tagName === 'input')!,
    );

    expect(selectLine).toContain('value="10"');
    expect(selectLine).toContain('selectedValue="10"');
    expect(selectLine).toContain('selectedText="10"');
    expect(checkboxLine).toContain('checked=false');
  });
});
