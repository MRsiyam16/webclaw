import { describe, it, expect } from 'vitest';
import { extractFrom } from '../entrypoints/background/tools/browser/extract';

/**
 * Two live-observed defects in browser_extract:
 *  1. DEGENERATE provenance — every field of a multi-property schema reported the
 *     same opaque ref ("e1"), i.e. the item-context ref, not the element each
 *     value was actually read from.
 *  2. NO array support — a {"type":"array","items":{...}} schema returned
 *     {"data":{},"missing":[],"sourceRefs":{}} with no error, so a 40-row listing
 *     could not be extracted in one call and unsupported shapes failed silently.
 *
 * These tests pin real, per-value source refs and repeated-item extraction, with
 * LOUD structured errors for shapes the extractor does not support.
 */

describe('browser_extract — real per-value source refs', () => {
  it('attributes each value to the element it was read from (distinct refs)', () => {
    // No data-ref on either element: the module must mint its own, distinct refs.
    const fixture = `
    <article>
      <h1 class="title">In Her Wake</h1>
      <p class="price_color">£12.84</p>
    </article>`;

    const out = extractFrom(fixture, {
      type: 'object',
      properties: { title: { type: 'string' }, price: { type: 'number' } },
    });

    expect(out.data.title).toBe('In Her Wake');
    expect(out.data.price).toBe(12.84);
    expect(out.missing).toEqual([]);

    // The defect: both came back as the same opaque "e1".
    expect(out.sourceRefs.title).toMatch(/^e\d+$/);
    expect(out.sourceRefs.price).toMatch(/^e\d+$/);
    expect(out.sourceRefs.title).not.toBe(out.sourceRefs.price);
  });

  it('keeps minted refs stable across repeated extractions', () => {
    const fixture = `
    <article>
      <h1 class="title">In Her Wake</h1>
      <p class="price_color">£12.84</p>
    </article>`;

    const schema = {
      type: 'object' as const,
      properties: { title: { type: 'string' as const }, price: { type: 'number' as const } },
    };

    const first = extractFrom(fixture, schema);
    const second = extractFrom(fixture, schema);

    expect(second.sourceRefs).toEqual(first.sourceRefs);
  });

  it('honours an explicit data-ref and never reuses it for another element', () => {
    const fixture = `
    <article>
      <h1 class="title">In Her Wake</h1>
      <p class="price_color" data-ref="e2">£12.84</p>
    </article>`;

    const out = extractFrom(fixture, {
      type: 'object',
      properties: { title: { type: 'string' }, price: { type: 'number' } },
    });

    expect(out.sourceRefs.price).toBe('e2');
    expect(out.sourceRefs.title).toMatch(/^e\d+$/);
    expect(out.sourceRefs.title).not.toBe('e2');
  });
});

describe('browser_extract — repeated-item (array) extraction', () => {
  const card = (i: number, withPrice = true) => `
  <article class="product_pod">
    <h3 class="title">Book ${i}</h3>
    ${withPrice ? `<p class="price_color">£${i + 1}.00</p>` : ''}
  </article>`;

  const catalogue = (n: number) =>
    `<div class="catalogue">${Array.from({ length: n }, (_, i) => card(i)).join('')}</div>`;

  const arraySchema = {
    type: 'array' as const,
    items: {
      type: 'object' as const,
      properties: { title: { type: 'string' as const }, price: { type: 'number' as const } },
      required: ['title', 'price'],
    },
  };

  it('extracts every repeated item in one call (40 rows)', () => {
    const out = extractFrom(catalogue(40), arraySchema);

    expect(out.error).toBeUndefined();
    const items = (out.data as { items: Array<Record<string, unknown>> }).items;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(40);
    expect(items[0]).toEqual({ title: 'Book 0', price: 1 });
    expect(items[39]).toEqual({ title: 'Book 39', price: 40 });
    expect(out.missing).toEqual([]);

    // Per-item, per-value provenance paths.
    expect(out.sourceRefs['items[0].title']).toMatch(/^e\d+$/);
    expect(out.sourceRefs['items[12].title']).toMatch(/^e\d+$/);
    expect(out.sourceRefs['items[39].price']).toMatch(/^e\d+$/);
    const spot = [
      out.sourceRefs['items[0].title'],
      out.sourceRefs['items[12].title'],
      out.sourceRefs['items[39].price'],
    ];
    expect(new Set(spot).size).toBe(3);

    // Distinct ref per value across the whole page: no constant provenance.
    const refs = Object.values(out.sourceRefs);
    expect(refs.length).toBe(80);
    expect(new Set(refs).size).toBe(80);
  });

  it('records an item that cannot yield a required property in `missing` (never invents)', () => {
    const html = `<div class="catalogue">${card(0)}${card(1, false)}${card(2)}</div>`;

    const out = extractFrom(html, arraySchema);

    const items = (out.data as { items: Array<Record<string, unknown>> }).items;
    expect(items.length).toBe(3);
    expect(items[1]).toEqual({ title: 'Book 1' });
    expect(items[1]).not.toHaveProperty('price');
    expect(out.missing).toContain('items[1].price');
    expect(out.sourceRefs['items[1].price']).toBeUndefined();
    expect(out.missing).not.toContain('items[0].price');
  });

  it('fails loudly when the array schema matches no repeated items', () => {
    const out = extractFrom('<div><span class="title">lonely</span></div>', arraySchema);

    expect(typeof out.error).toBe('string');
    expect(out.error).toMatch(/array/i);
    expect((out.data as { items?: unknown[] }).items ?? []).toHaveLength(0);
  });
});

describe('browser_extract — loud errors for unsupported shapes', () => {
  const objectSchema = {
    type: 'object' as const,
    properties: { title: { type: 'string' as const } },
  };

  it('reports a non-object/non-array root schema instead of returning a silent empty', () => {
    const out = extractFrom('<div><h1 class="title">x</h1></div>', {
      type: 'string',
      properties: { title: { type: 'string' } },
    } as any);

    expect(typeof out.error).toBe('string');
    expect(out.error).toMatch(/string/);
    expect(out.data).toEqual({});
  });

  it('reports a nested array-of-arrays schema', () => {
    const out = extractFrom('<div><span class="title">x</span></div>', {
      type: 'array',
      items: { type: 'array', items: objectSchema },
    } as any);

    expect(typeof out.error).toBe('string');
    expect(out.error).toMatch(/nested/i);
  });

  it('reports an object property declared as a nested array', () => {
    const out = extractFrom('<div><span class="title">x</span></div>', {
      type: 'object',
      properties: { books: { type: 'array' } },
    } as any);

    expect(typeof out.error).toBe('string');
    expect(out.error).toMatch(/books/);
    expect(out.missing).toContain('books');
  });
});
