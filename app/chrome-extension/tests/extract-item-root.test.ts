import { describe, it, expect } from 'vitest';
import { extractFrom, inPageExtract } from '../entrypoints/background/tools/browser/extract';

/**
 * Two live-observed defects on https://books.toscrape.com/catalogue/page-2.html
 * (20 `article.product_pod` rows), reproduced here as a faithful jsdom replica:
 *
 *  1. ITEM-ROOT COLLAPSE — the array tool returned only 2 items:
 *     {"items":[{},{"availability":"In stock","price":12.84}]}
 *     The root picker preferred the DEEPEST repeated sibling group, so the pair
 *     `<p class="price_color">` / `<p class="instock availability">` inside each
 *     card beat the 20 repeated `li > article.product_pod` rows.
 *
 *  2. ATTRIBUTE-BLIND MATCHING — `title` matched nothing, because on that page
 *     the book title lives in an ATTRIBUTE: `<h3><a title="Book Name">`. The
 *     matcher only looked at class/id/name/text.
 *
 * These tests pin: most-properties-satisfied root selection (more items wins a
 * tie), attribute-borne values (title/alt/aria-label/itemprop/heading), one call
 * over a real listing page, and a caller-supplied item selector that PINS the
 * item root.
 */

const book = (n: number) => {
  const title = `Book Number ${n}`;
  const price = (n + 0.84).toFixed(2);
  return `
      <li>
        <article class="product_pod">
          <div class="image_container">
            <a href="catalogue/book-${n}_1000/index.html"><img src="../media/${n}.jpg" alt="${title}" class="thumbnail"></a>
          </div>
          <h3><a href="catalogue/book-${n}_1000/index.html" title="${title}">${title.slice(0, 12)}…</a></h3>
          <div class="product_price">
            <p class="price_color">£${price}</p>
            <p class="instock availability"><i class="icon-ok"></i>\n            In stock</p>
          </div>
        </article>
      </li>`;
};

/** Replica of books.toscrape page-2 shape: 20 rows in `ol.row > li > article.product_pod`. */
const listingPage = (n: number, extra = '') => `
  <div class="container-fluid page">
    <div class="page_inner">
      <header>
        <div class="row header_row">
          <div class="col-sm-8 col-md-9">
            <h1>All products</h1>
          </div>
        </div>
      </header>
      <div class="row">
        <div class="col-sm-8 col-md-9">
          <section>
            <ol class="row">${Array.from({ length: n }, (_, i) => book(i + 1)).join('')}</ol>
          </section>
        </div>
      </div>
    </div>
  </div>${extra}`;

const arraySchema = {
  type: 'array' as const,
  items: {
    type: 'object' as const,
    properties: {
      title: { type: 'string' as const },
      price: { type: 'number' as const },
      availability: { type: 'string' as const },
    },
    required: ['title', 'price'],
  },
};

describe('browser_extract — item-root detection on a real listing page', () => {
  it('picks the repeated CARD rows, not the deepest price/stock pair (20 books)', () => {
    const out = extractFrom(listingPage(20), arraySchema);
    const items = (out.data as { items: Array<Record<string, unknown>> }).items;

    expect(out.error).toBeUndefined();
    expect(Array.isArray(items)).toBe(true);
    // The defect: 2 items (the inner price/stock pair) instead of the 20 rows.
    expect(items.length).toBe(20);

    for (const index of [0, 19]) {
      expect(typeof items[index].title).toBe('string');
      expect((items[index].title as string).length).toBeGreaterThan(0);
      expect(typeof items[index].price).toBe('number');
      expect(typeof items[index].availability).toBe('string');
      expect(items[index].availability).toMatch(/in stock/i);
    }

    // Values come from the RIGHT row (not the first row repeated).
    expect(items[0].title).toBe('Book Number 1');
    expect(items[19].title).toBe('Book Number 20');
    expect(items[0].price).toBe(1.84);
    expect(items[19].price).toBe(20.84);

    expect(out.missing).toEqual([]);

    // Distinct real refs, per item and per field.
    expect(out.sourceRefs['items[0].title']).toMatch(/^e\d+$/);
    expect(out.sourceRefs['items[0].title']).not.toBe(out.sourceRefs['items[0].price']);
    expect(out.sourceRefs['items[19].availability']).toMatch(/^e\d+$/);
    const refs = Object.values(out.sourceRefs);
    expect(refs.length).toBe(60);
    expect(new Set(refs).size).toBe(60);
  });

  it('prefers the group with MORE items when property scores tie', () => {
    // Two candidate groups both cover {title, price}: an outer 6-row list and an
    // inner 2-row sub-list. The outer one must win.
    const inner = `
      <section>
        <ol class="row">${Array.from({ length: 6 }, (_, i) => book(i + 1)).join('')}</ol>
        <ul class="related">
          <li><span class="title">Side A</span><span class="price_color">£1.00</span></li>
          <li><span class="title">Side B</span><span class="price_color">£2.00</span></li>
        </ul>
      </section>`;

    const out = extractFrom(inner, {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, price: { type: 'number' } },
      },
    });
    const items = (out.data as { items: Array<Record<string, unknown>> }).items;

    expect(items.length).toBe(6);
    expect(items[5].title).toBe('Book Number 6');
  });
});

describe('browser_extract — attribute-borne property values', () => {
  it('resolves title from a title= attribute when there is no class/id/data-field', () => {
    const html = `
      <ul>
        <li class="card"><h3><a href="/a" title="Alpha Title">Alpha…</a></h3><span class="price_color">£9.99</span></li>
        <li class="card"><h3><a href="/b" title="Beta Title">Beta…</a></h3><span class="price_color">£8.50</span></li>
      </ul>`;

    const out = extractFrom(html, {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, price: { type: 'number' } },
        required: ['title'],
      },
    });
    const items = (out.data as { items: Array<Record<string, unknown>> }).items;

    // The whole innerText blob ("Alpha…") must NOT be preferred over the attribute.
    expect(items.length).toBe(2);
    expect(items[0].title).toBe('Alpha Title');
    expect(items[1].title).toBe('Beta Title');
    expect(out.missing).toEqual([]);
  });

  it('falls back to the card heading text, then alt / aria-label / itemprop', () => {
    const html = `
      <div class="grid">
        <article class="card"><h2>Heading Only</h2><span class="price_color">£1.00</span></article>
        <article class="card"><img alt="Alt Only" src="/x.jpg"><span class="price_color">£2.00</span></article>
        <article class="card"><span aria-label="Aria Only">ignored</span><span class="price_color">£3.00</span></article>
        <article class="card"><span itemprop="title">Itemprop Only</span><span class="price_color">£4.00</span></article>
      </div>`;

    const objectOut = extractFrom(html, {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, price: { type: 'number' } },
      },
    });
    const items = (objectOut.data as { items: Array<Record<string, unknown>> }).items;

    expect(items.length).toBe(4);
    expect(items[0].title).toBe('Heading Only');
    expect(items[1].title).toBe('Alt Only');
    expect(items[2].title).toBe('Aria Only');
    expect(items[3].title).toBe('Itemprop Only');
  });

  it('still resolves a plain object schema scoped to a card whose title is an attribute', () => {
    const html = `
      <article class="product_pod">
        <h3><a href="/a" title="Solo Book">Solo…</a></h3>
        <p class="price_color">£22.50</p>
      </article>`;

    const out = extractFrom(html, {
      type: 'object',
      properties: { title: { type: 'string' }, price: { type: 'number' } },
    });

    expect(out.data.title).toBe('Solo Book');
    expect(out.data.price).toBe(22.5);
    expect(out.sourceRefs.title).not.toBe(out.sourceRefs.price);
  });
});

describe('browser_extract — explicit item-root selector', () => {
  it('pins the item root when `selector` matches the repeated cards', () => {
    document.body.innerHTML = `
      <div>
        <ul class="decoy"><li><span class="title">Decoy</span></li></ul>
        ${listingPage(3)}
      </div>`;

    const out = inPageExtract(arraySchema, 'ol.row > li');

    const items = (out.data as { items: Array<Record<string, unknown>> }).items;
    expect(out.error).toBeUndefined();
    expect(items.length).toBe(3);
    expect(items[0].title).toBe('Book Number 1');
    expect(items[2].title).toBe('Book Number 3');
  });

  it('fails loudly when the explicit item selector matches nothing', () => {
    document.body.innerHTML = listingPage(2);

    const out = inPageExtract(arraySchema, '.no-such-card');

    expect(typeof out.error).toBe('string');
    expect(out.error).toMatch(/selector/i);
  });
});
