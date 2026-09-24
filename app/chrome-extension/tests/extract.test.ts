import { describe, it, expect } from 'vitest';
import { extractFrom } from '../entrypoints/background/tools/browser/extract';

// Fixture mirrors the locked contract: declared fields + data-ref source attribution.
const fixture = `
<article>
  <h3 data-ref="e1" data-field="title">A Light in the Attic</h3>
  <p data-ref="e2">£51.77</p>
</article>`;

describe('browser_extract (schema-typed, source-attributed)', () => {
  it('extracts declared fields with source refs and honest gaps', () => {
    const out = extractFrom(fixture, {
      type: 'object',
      properties: {
        title: { type: 'string' },
        price: { type: 'number' },
      },
      required: ['title'],
    });

    expect(out.data.title).toBe('A Light in the Attic');
    // 'price' has no source element -> missing, never hallucinated
    expect(out.missing).toContain('price');
    expect(out.sourceRefs.title).toBe('e1');
    expect(out.data).not.toHaveProperty('price');
  });

  it('sends a present-but-uncoercible value to missing instead of data', () => {
    const bad = `
    <div>
      <span data-ref="e1" data-field="title">Widget</span>
      <span data-ref="e2" data-field="price">not a number</span>
    </div>`;

    const out = extractFrom(bad, {
      type: 'object',
      properties: {
        title: { type: 'string' },
        price: { type: 'number' },
      },
      required: ['title', 'price'],
    });

    expect(out.data.title).toBe('Widget');
    expect(out.data).not.toHaveProperty('price');
    expect(out.missing).toContain('price');
    expect(out.sourceRefs).not.toHaveProperty('price');
  });

  it('coerces boolean-typed fields', () => {
    const html = `
    <div>
      <span data-ref="e1" data-field="inStock">yes</span>
      <span data-ref="e2" data-field="discontinued">false</span>
    </div>`;

    const out = extractFrom(html, {
      type: 'object',
      properties: {
        inStock: { type: 'boolean' },
        discontinued: { type: 'boolean' },
      },
    });

    expect(out.data.inStock).toBe(true);
    expect(out.data.discontinued).toBe(false);
    expect(out.missing).toEqual([]);
  });

  it('returns empty data/missing when the schema declares no properties', () => {
    const out = extractFrom(fixture, { type: 'object', properties: {} });

    expect(out.data).toEqual({});
    expect(out.missing).toEqual([]);
    expect(out.sourceRefs).toEqual({});
  });

  it('finds a source by data-field key and reads input values', () => {
    const html = `
    <form>
      <label for="qty">Quantity</label>
      <input id="qty" data-field="quantity" value="7" />
      <span data-ref="e9">in stock</span>
    </form>`;

    const out = extractFrom(html, {
      type: 'object',
      properties: {
        quantity: { type: 'number' },
      },
    });

    expect(out.data.quantity).toBe(7);
    expect(out.missing).toEqual([]);
    expect(out.sourceRefs.quantity).toMatch(/^e\d+$/);
  });
});
