/**
 * browser_extract — schema-typed extraction over a document/HTML root.
 *
 * Contract:
 *  - extractFrom(root, schema) -> { data, missing, sourceRefs, error? }
 *  - sourceRefs values must match /^e\d+$/
 *  - property lookup order: [data-field="key"] -> #key -> [name="key"] -> [itemprop="key"]
 *    -> an attribute NAMED "key" (e.g. `<a title="Book Name">` for `title`, `alt`, `aria-label`)
 *    -> class name -> property selector -> a card heading (title-ish keys) -> label text
 *  - labels resolve via `for` -> element, else a wrapped form control inside the label
 *  - inputs/textarea/select read `value` (select: selected option value/text)
 *  - other elements read textContent (trimmed)
 *  - declared numeric types coerce ('£51.77' -> 51.77); a present-but-uncoercible value -> missing
 *  - keys with no source element are reported in `missing`, never invented into data
 *
 * Provenance (per VALUE, never constant):
 *  - sourceRefs[key] is the ref of the element the value was READ FROM. Two values
 *    read from two different elements therefore carry two different refs.
 *  - an element's own `data-ref` is honoured; otherwise the ref is that element's
 *    stable 1-based index in document order (`e<index>`), skipping any index
 *    already claimed by an explicit data-ref.
 *
 * Repeated items (arrays):
 *  - {"type":"array","items":{"type":"object","properties":{...}}} extracts EVERY
 *    repeated item in one call -> { data: { items: [ {...}, ... ] } } with
 *    per-value refs keyed by path (`items[0].title`).
 *  - item roots are discovered by scoring repeated sibling groups on how many
 *    DECLARED PROPERTIES they can supply across their items; the highest score wins,
 *    a score tie goes to the group with MORE items (never to the deepest group),
 *    remaining ties to the shallowest group. `selector`, when passed, PINS the item
 *    roots to every element it matches (escape hatch).
 *  - an item that cannot yield a declared property keeps it absent and records the
 *    path (`items[3].price`) in `missing` — never invents a value.
 *
 * Loud failures:
 *  - an unsupported schema shape (non-object/non-array root, nested array-of-arrays,
 *    an object property declared as a nested array/object, an array schema that
 *    matches no repeated items) returns a STRUCTURED error in the result:
 *    { data: {}, missing: [...], sourceRefs: {}, error: '<one line>' }.
 *    It never returns a silent empty.
 *
 * Ref minting: an element's own `data-ref` is honoured; otherwise its document-order
 * index is used (`e<n>`), bumped past any ref already used in the document.
 *
 * NOTE: this module must stay free of background-only imports (chrome APIs,
 * BaseBrowserToolExecutor, ...) because entrypoints/inpage-engine.ts bundles it
 * into the page-side IIFE. The callable tool surface lives in extract-tool.ts.
 */

export interface JsonSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  /** Optional explicit CSS selector fallback, tried after the contract lookup order. */
  selector?: string;
  /** Present only on nested (unsupported) property schemas; used to fail loudly. */
  items?: unknown;
  properties?: Record<string, JsonSchemaProperty>;
}

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaArray {
  type: 'array';
  items?: { type?: string; properties?: Record<string, JsonSchemaProperty>; required?: string[] };
}

export type JsonSchema = JsonSchemaObject | JsonSchemaArray;

export interface ExtractResult {
  data: Record<string, unknown>;
  missing: string[];
  sourceRefs: Record<string, string>;
  /** One-line reason the schema shape could not be honoured. Absent on success. */
  error?: string;
}

type RootInput = ParentNode | string;

/** Coerce a raw string to the declared JSON Schema type. Returns undefined when uncoercible. */
function coerce(raw: string | undefined, type: JsonSchemaProperty['type']): unknown {
  const text = (raw ?? '').trim();
  if (text.length === 0) return undefined;

  switch (type) {
    case 'number':
    case 'integer': {
      // Strip currency symbols, thousands separators and stray glyphs.
      const cleaned = text.replace(/[^0-9.eE+-]/g, '').replace(/,/g, '');
      if (cleaned.length === 0 || !/[0-9]/.test(cleaned)) return undefined;
      const num = Number(cleaned);
      if (!Number.isFinite(num)) return undefined;
      return type === 'integer' ? Math.trunc(num) : num;
    }
    case 'boolean': {
      const lowered = text.toLowerCase();
      if (['true', '1', 'yes', 'y', 'on'].includes(lowered)) return true;
      if (['false', '0', 'no', 'n', 'off'].includes(lowered)) return false;
      return undefined;
    }
    case 'string':
    default:
      return text;
  }
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Match an attribute exactly, falling back to a normalized (case/separator-insensitive) compare. */
function findByAttr(root: ParentNode, attr: string, key: string): Element | null {
  return allByAttr(root, attr, key)[0] ?? null;
}

/** Every element matching an attribute, exact matches first, then normalized (loose) ones. */
function allByAttr(root: ParentNode, attr: string, key: string): Element[] {
  const target = normalizeKey(key);
  const exact: Element[] = [];
  const loose: Element[] = [];
  for (const el of Array.from(root.querySelectorAll(`[${attr}]`))) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    if (value === key) exact.push(el);
    else if (normalizeKey(value).includes(target)) loose.push(el);
  }
  return [...exact, ...loose];
}

function findById(root: ParentNode, id: string): Element | null {
  for (const el of Array.from(root.querySelectorAll('[id]'))) {
    if (el.id === id) return el;
  }
  return null;
}

/** Match an element by class name (contains key, case/separator-insensitive). */
function findByClass(root: ParentNode, key: string): Element | null {
  return allByClass(root, key)[0] ?? null;
}

function allByClass(root: ParentNode, key: string): Element[] {
  const target = normalizeKey(key);
  if (target.length === 0) return [];
  const out: Element[] = [];
  for (const el of Array.from(root.querySelectorAll('[class]'))) {
    const classes = (el.getAttribute('class') ?? '').split(/\s+/);
    if (classes.some((c) => normalizeKey(c).includes(target))) out.push(el);
  }
  return out;
}

function toRoot(root: RootInput): ParentNode {
  if (typeof root !== 'string') return root;
  const doc = new DOMParser().parseFromString(root, 'text/html');
  return doc.body;
}

/** Read an element's current value: form controls use `.value`, everything else uses text. */
function readValue(el: Element, type: JsonSchemaProperty['type']): unknown {
  const tag = el.tagName.toLowerCase();
  let raw: string | undefined;

  if (tag === 'select') {
    const select = el as HTMLSelectElement;
    raw = select.value || select.options?.[select.selectedIndex]?.text;
  } else if (tag === 'input' || tag === 'textarea') {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    if (field instanceof HTMLInputElement && field.type === 'checkbox') {
      return type === 'boolean' ? field.checked : field.checked ? 'true' : 'false';
    }
    raw = field.value;
  } else {
    raw = el.textContent ?? '';
  }

  const coerced = coerce(raw, type);
  if (coerced === undefined) return undefined;
  // A form control with a declared boolean type still yields the coerced boolean.
  if (type === 'boolean') return coerced;
  return coerced;
}

function findByLabel(root: ParentNode, key: string): Element | null {
  const target = normalizeKey(key);
  const labels = Array.from(root.querySelectorAll('label'));
  for (const label of labels) {
    const text = normalizeKey(label.textContent ?? '');
    if (!text.includes(target)) continue;

    const forId = label.getAttribute('for');
    if (forId) {
      const byId = findById(root, forId);
      if (byId) return byId;
    }
    const wrapped = label.querySelector('input, textarea, select');
    if (wrapped) return wrapped as Element;
    // A text label without an associated control is not a trustworthy field
    // value: its text may include an entire card or page container.
    return null;
  }
  return null;
}

const REF_RE = /^e\d+$/;

/**
 * Refs are the element's position in document order (1-based), so every element
 * has its OWN ref instead of a shared constant. Order maps are cached per
 * document, which keeps refs stable across repeated extractions of the same page.
 */
const orderCache = new WeakMap<Document, Map<Element, number>>();
const reservedCache = new WeakMap<Document, Set<string>>();

function orderMap(doc: Document): Map<Element, number> {
  const cached = orderCache.get(doc);
  if (cached) return cached;

  const map = new Map<Element, number>();
  const rootEl = doc.documentElement;
  if (rootEl) {
    map.set(rootEl, 1);
    let n = 1;
    for (const el of Array.from(rootEl.querySelectorAll('*'))) {
      n += 1;
      map.set(el, n);
    }
  }
  orderCache.set(doc, map);
  return map;
}

/** Explicit data-ref values present in the document — never handed to another element. */
function reservedRefs(doc: Document): Set<string> {
  const cached = reservedCache.get(doc);
  if (cached) return cached;

  const used = new Set<string>();
  for (const node of Array.from(doc.querySelectorAll('[data-ref]'))) {
    const value = node.getAttribute('data-ref');
    if (value && REF_RE.test(value)) used.add(value);
  }
  reservedCache.set(doc, used);
  return used;
}

function refFor(el: Element): string {
  const own = el.getAttribute('data-ref');
  if (own && REF_RE.test(own)) return own;

  const doc = el.ownerDocument;
  if (!doc) return 'e1';

  const reserved = reservedRefs(doc);
  let index = orderMap(doc).get(el) ?? 0;
  if (index === 0) {
    // Detached / not yet in the document tree: fall back to the next free index.
    index = 1;
  }
  while (reserved.has(`e${index}`)) index += 1;
  return `e${index}`;
}

interface Located {
  el: Element;
  ref: string;
  /** When set, the value is read from this attribute instead of the element text. */
  attr?: string;
}

/** Heading-ish keys whose value a card's own heading (or alt/aria-label) can supply. */
const HEADING_KEYS = new Set([
  'title',
  'name',
  'heading',
  'headline',
  'caption',
  'label',
  'subject',
  'productname',
  'booktitle',
]);
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';
/** How many ancestor levels the "nearest ancestor card heading" fallback may climb. */
const HEADING_ANCESTOR_DEPTH = 3;

/**
 * An attribute whose NAME equals the declared key (case/separator-insensitive),
 * e.g. key `title` -> `<a title="Book Name">`, key `alt` -> `<img alt="…">`.
 * The value is read from that attribute, never from the element's innerText.
 */
function attributeNameHit(el: Element, key: string): string | undefined {
  const target = normalizeKey(key);
  if (target.length === 0) return undefined;
  for (const attr of Array.from(el.attributes)) {
    if (normalizeKey(attr.name) === target && attr.value.trim().length > 0) return attr.name;
  }
  return undefined;
}

/** Elements carrying an exact `itemprop="<key>"`; microdata `content` wins over text. */
function allByItemprop(root: ParentNode, key: string): SourceHit[] {
  const target = normalizeKey(key);
  if (target.length === 0) return [];
  const out: SourceHit[] = [];
  for (const el of Array.from(root.querySelectorAll('[itemprop]'))) {
    const value = el.getAttribute('itemprop');
    if (!value || normalizeKey(value) !== target) continue;
    out.push(el.hasAttribute('content') ? { el, attr: 'content' } : { el });
  }
  return out;
}

interface SourceHit {
  el: Element;
  attr?: string;
}

/** The readable text of a hit — an attribute value is short, an innerText blob is not. */
function hitLength(hit: SourceHit): number {
  const raw = hit.attr ? (hit.el.getAttribute(hit.attr) ?? '') : (hit.el.textContent ?? '');
  return raw.trim().length;
}

/** Prefer the SHORTEST matching source inside a tier (an attribute over an innerText blob). */
function byShortest(hits: SourceHit[]): SourceHit[] {
  return hits
    .map((hit, index) => ({ hit, index, len: hitLength(hit) }))
    .sort((a, b) => (a.len === b.len ? a.index - b.index : a.len - b.len))
    .map((entry) => entry.hit);
}

/**
 * The nearest heading for a heading-ish key: inside the scope first, then up to a
 * few ancestor "card" levels, then non-empty `alt` / `aria-label` attributes.
 */
function headingFallbacks(root: ParentNode, key: string): SourceHit[] {
  if (!HEADING_KEYS.has(normalizeKey(key))) return [];
  const hits: SourceHit[] = [];

  const own = root.querySelector(HEADING_SELECTOR);
  if (own) hits.push({ el: own });

  let node: Element | null = (root as Element)?.parentElement ?? null;
  for (let depth = 0; node && depth < HEADING_ANCESTOR_DEPTH; depth += 1) {
    // Only the ancestor's OWN heading (a direct child), never a heading that
    // belongs to a sibling card.
    const heading = Array.from(node.children).find((child) => /^H[1-6]$/.test(child.tagName));
    if (heading) {
      hits.push({ el: heading });
      break;
    }
    node = node.parentElement;
  }

  for (const el of Array.from(root.querySelectorAll('[alt]'))) {
    if (el.getAttribute('alt')?.trim()) hits.push({ el, attr: 'alt' });
  }
  for (const el of Array.from(root.querySelectorAll('[aria-label]'))) {
    if (el.getAttribute('aria-label')?.trim()) hits.push({ el, attr: 'aria-label' });
  }

  return hits;
}

/** Every element that could source `key`, in contract lookup-priority order. */
function allSourceHits(root: ParentNode, key: string, prop: JsonSchemaProperty): SourceHit[] {
  const tiers: SourceHit[][] = [];
  const seen = new Set<Element>();
  const dedupe = (hits: SourceHit[]): SourceHit[] =>
    hits.filter((hit) => (seen.has(hit.el) ? false : (seen.add(hit.el), true)));

  // 1. Explicit field markers.
  tiers.push(
    [findByAttr(root, 'data-field', key), findById(root, key), findByAttr(root, 'name', key)]
      .filter((el): el is Element => Boolean(el))
      .map((el) => ({ el })),
  );

  // 2. Microdata declaration.
  tiers.push(allByItemprop(root, key));

  // 3. Attribute-NAME match: <a title="Book Name"> supplies `title`, alt supplies `alt`, ...
  const attrHits: SourceHit[] = [];
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const attr = attributeNameHit(el, key);
    if (attr) attrHits.push({ el, attr });
  }
  tiers.push(byShortest(attrHits));

  // 4. Class-name match (the historical tier) — shortest readable text wins inside it.
  tiers.push(byShortest(allByClass(root, key).map((el) => ({ el }))));

  // 5. Caller-declared per-property selector.
  if (prop?.selector) {
    const el = root.querySelector(prop.selector);
    tiers.push(el ? [{ el }] : []);
  }

  // 6. Heading / alt / aria-label fallback for heading-ish keys.
  tiers.push(headingFallbacks(root, key));

  // 7. Label text.
  const labelled = findByLabel(root, key);
  tiers.push(labelled ? [{ el: labelled }] : []);

  return tiers.flatMap(dedupe);
}

/** Fields the source hit provides a value from — attribute-borne when `attr` is set. */
function readHit(hit: Located, type: JsonSchemaProperty['type']): unknown {
  if (hit.attr) return coerce(hit.el.getAttribute(hit.attr) ?? '', type);
  return readValue(hit.el, type);
}

function findSource(root: ParentNode, key: string, prop: JsonSchemaProperty): Located | null {
  const hit = allSourceHits(root, key, prop)[0];
  if (!hit) return null;
  return { el: hit.el, ref: refFor(hit.el), attr: hit.attr };
}

/** Extract one declared property from `scope`, writing into the shared result. */
function extractProperty(
  scope: ParentNode,
  key: string,
  prop: JsonSchemaProperty,
  path: string,
  out: { data: Record<string, unknown>; missing: string[]; sourceRefs: Record<string, string> },
): void {
  const found = findSource(scope, key, prop ?? {});
  if (!found) {
    out.missing.push(path);
    return;
  }

  const value = readHit(found, prop?.type);
  if (value === undefined) {
    out.missing.push(path);
    return;
  }

  out.data[key] = value;
  out.sourceRefs[path] = found.ref;
}

interface FieldExtract {
  data: Record<string, unknown>;
  missing: string[];
  sourceRefs: Record<string, string>;
}

/** Extract every declared property of an object schema, scoped to `scope`. */
function extractFields(scope: ParentNode, schema: JsonSchemaObject, prefix: string): FieldExtract {
  const out: FieldExtract = { data: {}, missing: [], sourceRefs: {} };
  const properties = schema?.properties ?? {};

  for (const [key, prop] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    extractProperty(scope, key, prop ?? {}, path, out);
  }

  return out;
}

/** True when `el` is inside `root`. */
function isWithin(root: ParentNode, el: Element): boolean {
  const container = root as unknown as { contains?: (node: Node) => boolean };
  if (typeof container.contains === 'function') return container.contains(el);
  return true;
}

/** Depth of an element from the document root, used to prefer the innermost repetition. */
function levelOf(el: Element): number {
  let level = 0;
  let node: Element | null = el;
  while (node?.parentElement) {
    level += 1;
    node = node.parentElement;
  }
  return level;
}

interface ItemRootCandidate {
  roots: Element[];
  /** Declared properties this group can actually supply across its items. */
  score: number;
  count: number;
  level: number;
}

/** How many declared properties a candidate item group can supply across its items. */
function groupScore(group: Element[], properties: Record<string, JsonSchemaProperty>): number {
  let score = 0;
  for (const [key, prop] of Object.entries(properties)) {
    const supplied = group.some((item) => {
      const hit = findSource(item, key, prop ?? {});
      return hit ? readHit(hit, prop?.type) !== undefined : false;
    });
    if (supplied) score += 1;
  }
  return score;
}

/** Rank candidates: most properties supplied > most items > shallowest. */
function betterCandidate(next: ItemRootCandidate, best: ItemRootCandidate | null): boolean {
  if (!best) return true;
  if (next.score !== best.score) return next.score > best.score;
  if (next.count !== best.count) return next.count > best.count;
  return next.level < best.level;
}

/**
 * Discover the repeated item roots for an array schema. Candidate repeated sibling
 * groups (>=2 same-tag siblings) are scored by HOW MANY DECLARED PROPERTIES they can
 * supply across their items; the best score wins, ties go to the group with MORE
 * items (never to the deepest group — which is what collapsed a 20-row listing into
 * the inner price/stock pair). An explicit selector, when given, pins the roots.
 */
function findItemRoots(
  root: ParentNode,
  properties: Record<string, JsonSchemaProperty>,
  itemSelector?: string,
): { roots: Element[]; error?: string } {
  if (itemSelector) {
    const pinned = Array.from(root.querySelectorAll(itemSelector));
    if (pinned.length === 0) {
      return {
        roots: [],
        error: `unsupported array schema: explicit item selector "${itemSelector}" matched no item elements`,
      };
    }
    return { roots: pinned };
  }

  const candidates: Element[] = [];

  for (const [key, prop] of Object.entries(properties)) {
    for (const hit of allSourceHits(root, key, prop ?? {})) {
      if (!candidates.includes(hit.el)) candidates.push(hit.el);
    }
  }

  if (candidates.length === 0) return { roots: [] };

  const groupCache = new Map<Element, Map<string, Element[]>>();
  let best: ItemRootCandidate | null = null;

  const consider = (group: Element[]): void => {
    if (group.length < 2) return;
    const candidate: ItemRootCandidate = {
      roots: group,
      score: groupScore(group, properties),
      count: group.length,
      level: levelOf(group[0]),
    };
    if (betterCandidate(candidate, best)) best = candidate;
  };

  for (const candidate of candidates) {
    let node: Element | null = candidate.parentElement;
    while (node && isWithin(root, node)) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;

      let byTag = groupCache.get(parent);
      if (!byTag) {
        byTag = new Map<string, Element[]>();
        groupCache.set(parent, byTag);
      }
      let group = byTag.get(node.tagName);
      if (!group) {
        group = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        byTag.set(node.tagName, group);
      }
      consider(group);

      node = parent;
    }
  }

  // `best` is written inside the `consider` closure, so TS control flow cannot
  // narrow it here — read it through an explicit annotation.
  const picked = best as ItemRootCandidate | null;
  return { roots: picked?.roots ?? [] };
}

function emptyResult(error: string, missing: string[] = []): ExtractResult {
  return { data: {}, missing, sourceRefs: {}, error };
}

/** One-line reason a schema shape cannot be honoured. */
function unsupportedRootError(schemaType: unknown): string {
  const shown = typeof schemaType === 'string' ? schemaType : String(schemaType);
  return `unsupported schema root type "${shown}": chrome_extract supports {"type":"object"} and {"type":"array","items":{"type":"object"}}`;
}

export function extractFrom(
  rootInput: RootInput,
  schema: JsonSchema,
  itemSelector?: string,
): ExtractResult {
  const root = toRoot(rootInput);

  const rawSchema = schema as unknown as { type?: unknown; properties?: unknown; items?: unknown };
  const declaredType =
    typeof rawSchema?.type === 'string'
      ? rawSchema.type
      : rawSchema && typeof rawSchema === 'object' && 'properties' in rawSchema
        ? 'object'
        : undefined;

  // ── Loud failure: root shape ────────────────────────────────────────────────
  if (declaredType !== 'object' && declaredType !== 'array') {
    return emptyResult(unsupportedRootError(declaredType ?? schema?.type));
  }

  // ── Array root: repeated-item extraction ────────────────────────────────────
  if (declaredType === 'array') {
    const items = rawSchema.items as
      | { type?: unknown; properties?: Record<string, JsonSchemaProperty>; required?: string[] }
      | undefined;

    if (!items || typeof items !== 'object') {
      return emptyResult('unsupported array schema: "items" must describe an object');
    }
    if (items.type === 'array' || Array.isArray((items as { items?: unknown }).items)) {
      return emptyResult('unsupported nested arrays: an array of arrays is not supported');
    }
    if (items.type !== undefined && items.type !== 'object') {
      return emptyResult(
        `unsupported array items type "${String(items.type)}": array items must be {"type":"object"}`,
      );
    }

    const itemSchema: JsonSchemaObject = {
      type: 'object',
      properties: items.properties ?? {},
      required: items.required,
    };

    const roots = findItemRoots(root, itemSchema.properties, itemSelector);
    if (roots.error) {
      return emptyResult(roots.error);
    }
    if (roots.roots.length === 0) {
      return emptyResult(
        'unsupported array schema: no repeated item elements matched the declared properties',
      );
    }

    const data: Record<string, unknown> = {};
    const missing: string[] = [];
    const sourceRefs: Record<string, string> = {};

    data.items = roots.roots.map((itemRoot, index) => {
      const extracted = extractFields(itemRoot, itemSchema, `items[${index}]`);
      missing.push(...extracted.missing);
      Object.assign(sourceRefs, extracted.sourceRefs);
      return extracted.data;
    });

    return { data, missing, sourceRefs };
  }

  // ── Object root ─────────────────────────────────────────────────────────────
  const properties = (rawSchema.properties ?? {}) as Record<string, JsonSchemaProperty>;

  for (const [key, prop] of Object.entries(properties)) {
    const nestedType = (prop as { type?: unknown })?.type;
    if (nestedType === 'array' || nestedType === 'object' || (prop as { items?: unknown })?.items) {
      // Nested constructs would silently come back empty; fail loudly instead.
      const shown = nestedType === 'object' ? 'object' : 'array';
      return emptyResult(
        `unsupported nested ${shown} at property "${key}": declare the array as the schema root, e.g. {"type":"array","items":{"type":"object"}}`,
        [key],
      );
    }
  }

  return extractFields(root, { type: 'object', properties }, '');
}

/**
 * In-page entrypoint. The extraction engine needs DOMParser / a live document,
 * and the background is an MV3 service worker where neither exists — so this
 * runs inside the page (registered on __MCP_INPAGE__ by entrypoints/
 * inpage-engine.ts and dispatched by executeInPage). It delegates to
 * extractFrom, so there is one implementation of the extraction contract.
 *
 * @param schema JSON Schema describing the fields to extract (required)
 * @param selector optional CSS selector. For an ARRAY root it is the ITEM root
 *   selector: every element it matches becomes one item (a caller-visible escape
 *   hatch when auto-detection picks the wrong repetition). For an object root it
 *   scopes extraction to the first matching subtree.
 */
export function inPageExtract(schema: JsonSchema, selector?: string): ExtractResult {
  const isArrayRoot = (schema as { type?: unknown } | undefined)?.type === 'array';
  if (selector && isArrayRoot) {
    return extractFrom(document, schema, selector);
  }

  const root: ParentNode = selector
    ? (document.querySelector(selector) ?? document.body ?? document.documentElement)
    : document;
  return extractFrom(root, schema);
}

export default extractFrom;
