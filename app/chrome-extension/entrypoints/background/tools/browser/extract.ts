/**
 * browser_extract — schema-typed extraction over a document/HTML root.
 *
 * Contract:
 *  - extractFrom(root, schema) -> { data, missing, sourceRefs }
 *  - sourceRefs values must match /^e\d+$/
 *  - property lookup order: [data-field="key"] -> #key -> [name="key"] -> label(text contains key)
 *  - labels resolve via `for` -> element, else a wrapped form control inside the label
 *  - inputs/textarea/select read `value` (select: selected option value/text)
 *  - other elements read textContent (trimmed)
 *  - declared numeric types coerce ('£51.77' -> 51.77); a present-but-uncoercible value -> missing
 *  - keys with no source element are reported in `missing`, never invented into data
 *
 * Ref minting: an element's own `data-ref` is honoured; otherwise a stable `e<n>`
 * counter is minted, skipping any ref already used in the document.
 */

export interface JsonSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  /** Optional explicit CSS selector fallback, tried after the contract lookup order. */
  selector?: string;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface ExtractResult {
  data: Record<string, unknown>;
  missing: string[];
  sourceRefs: Record<string, string>;
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
  const target = normalizeKey(key);
  let loose: Element | null = null;
  for (const el of Array.from(root.querySelectorAll(`[${attr}]`))) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    if (value === key) return el;
    if (!loose && normalizeKey(value).includes(target)) loose = el;
  }
  return loose;
}

function findById(root: ParentNode, id: string): Element | null {
  for (const el of Array.from(root.querySelectorAll('[id]'))) {
    if (el.id === id) return el;
  }
  return null;
}

/** Match an element by class name (contains key, case/separator-insensitive). */
function findByClass(root: ParentNode, key: string): Element | null {
  const target = normalizeKey(key);
  if (target.length === 0) return null;
  for (const el of Array.from(root.querySelectorAll('[class]'))) {
    const classes = (el.getAttribute('class') ?? '').split(/\s+/);
    if (classes.some((c) => normalizeKey(c).includes(target))) return el;
  }
  return null;
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
    return label as Element;
  }
  return null;
}

interface Located {
  el: Element;
  ref: string;
}

const REF_RE = /^e\d+$/;

function findSource(root: ParentNode, key: string, prop: JsonSchemaProperty): Located | null {
  const candidates: Element[] = [];

  const byDataField = findByAttr(root, 'data-field', key);
  if (byDataField) candidates.push(byDataField);

  const byId = findById(root, key);
  if (byId) candidates.push(byId);

  const byName = findByAttr(root, 'name', key);
  if (byName) candidates.push(byName);

  const byClass = findByClass(root, key);
  if (byClass) candidates.push(byClass);

  if (prop?.selector) {
    const explicit = root.querySelector(prop.selector);
    if (explicit) candidates.push(explicit);
  }

  const byLabel = findByLabel(root, key);
  if (byLabel) candidates.push(byLabel);

  const el = candidates.find((c) => c !== null) ?? null;
  if (!el) return null;

  return { el, ref: refFor(root, el) };
}

function collectUsedRefs(root: ParentNode): Set<string> {
  const used = new Set<string>();
  for (const node of Array.from(root.querySelectorAll('[data-ref]'))) {
    const value = node.getAttribute('data-ref');
    if (value) used.add(value);
  }
  return used;
}

function refFor(root: ParentNode, el: Element): string {
  const own = el.getAttribute('data-ref');
  if (own && REF_RE.test(own)) return own;

  const used = collectUsedRefs(root);
  let n = 1;
  while (used.has(`e${n}`)) n += 1;
  return `e${n}`;
}

export function extractFrom(rootInput: RootInput, schema: JsonSchema): ExtractResult {
  const root = toRoot(rootInput);

  const data: Record<string, unknown> = {};
  const missing: string[] = [];
  const sourceRefs: Record<string, string> = {};

  const properties = schema?.properties ?? {};

  for (const [key, prop] of Object.entries(properties)) {
    const found = findSource(root, key, prop ?? {});
    if (!found) {
      missing.push(key);
      continue;
    }

    const value = readValue(found.el, prop?.type);
    if (value === undefined) {
      missing.push(key);
      continue;
    }

    data[key] = value;
    sourceRefs[key] = found.ref;
  }

  return { data, missing, sourceRefs };
}

export default extractFrom;
