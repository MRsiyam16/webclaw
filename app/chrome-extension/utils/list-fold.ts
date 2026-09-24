/**
 * SimHash list folding for read_dom's compact output.
 *
 * Compact output ships one line per indexed element. On list/feed/table pages
 * that is dozens of near-identical rows ("Product 1 — in stock", "Product 2 —
 * in stock", …), which is most of the payload for almost none of the
 * information. Each row's text is normalized and fingerprinted with a 64-bit
 * SimHash; CONSECUTIVE rows whose fingerprint similarity is at or above the
 * threshold collapse into the representative's line plus a refs marker that
 * still enumerates every folded element's ref, so no ref is lost.
 *
 * Pure: no DOM and no globals, so it is unit-testable in isolation and safe to
 * call from the extension host.
 */

export interface FoldableNode {
  ref: string;
  tag: string;
  text: string;
}

export interface FoldGroup {
  representative: FoldableNode;
  folded: FoldableNode[];
  count: number;
}

export interface FoldOptions {
  similarity?: number;
}

export interface FoldResult {
  lines: string[];
  groups: FoldGroup[];
}

const DEFAULT_SIMILARITY = 0.8;
const BIT_WIDTH = 64;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Tags whose rows are eligible for folding (role=listitem rows render as `listitem`). */
const LIST_TAGS = new Set(['li', 'listitem', 'row', 'tr']);

/**
 * Fold candidates: lowercase, drop digits, drop punctuation, collapse
 * whitespace. Numbers are dropped because a list of "Product 12" / "Product 13"
 * is the same list as far as structure is concerned — the per-row number is the
 * variation that must NOT defeat folding.
 */
export function normalizeFoldText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[0-9]+/g, ' ')
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\u2010-\u2015\u2212]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fnv1a(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** Word shingles + intra-token character 3-grams, so near-identical rows stay close. */
function shinglesFrom(normalized: string): string[] {
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length === 0) return ['\u0000empty'];
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length <= 3) {
      out.push(token);
      continue;
    }
    out.push(token);
    for (let i = 0; i + 3 <= token.length; i++) out.push(token.slice(i, i + 3));
  }
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]}\u0001${tokens[i + 1]}`);
  return out;
}

/** 64-bit SimHash fingerprint of a text, as a string of 64 '0'/'1' bits. */
export function simhashFingerprint(text: string): string {
  const weights = new Array<number>(BIT_WIDTH).fill(0);
  for (const shingle of shinglesFrom(normalizeFoldText(text))) {
    const hi = fnv1a(shingle, FNV_OFFSET_BASIS);
    const lo = fnv1a(shingle, 0x9e3779b1);
    for (let b = 0; b < 32; b++) {
      weights[b] += ((hi >>> b) & 1) === 1 ? 1 : -1;
      weights[32 + b] += ((lo >>> b) & 1) === 1 ? 1 : -1;
    }
  }
  let bits = '';
  for (let i = 0; i < BIT_WIDTH; i++) bits += weights[i] >= 0 ? '1' : '0';
  return bits;
}

/** 1 = identical fingerprints, 0 = every bit differs. */
export function textSimilarity(a: string, b: string): number {
  const fa = simhashFingerprint(a);
  const fb = simhashFingerprint(b);
  let same = 0;
  for (let i = 0; i < BIT_WIDTH; i++) {
    if (fa[i] === fb[i]) same++;
  }
  return same / BIT_WIDTH;
}

export function isFoldableRow(node: FoldableNode | undefined | null): boolean {
  if (!node) return false;
  return LIST_TAGS.has(String(node.tag ?? '').toLowerCase());
}

/** The rendered line for a single node, in read_dom's compact convention. */
export function renderFoldNode(node: FoldableNode): string {
  const tag = String(node.tag ?? 'element').toLowerCase();
  const text = node.text ? ` "${node.text}"` : '';
  return `[${node.ref}] ${tag}${text}`;
}

/** `(... and N more similar) [refs: e1,e2,…]` — refs enumerate every folded ref. */
export function renderFoldMarker(group: FoldGroup): string {
  const refs = group.folded.map((n) => n.ref).join(',');
  return `(... and ${group.count} more similar) [refs: ${refs}]`;
}

/**
 * Collapse consecutive near-duplicate list rows.
 *
 * @param nodes nodes in document order
 * @param opts.similarity SimHash similarity at/above which rows fold (default 0.8)
 */
export function foldList(nodes: FoldableNode[], opts?: FoldOptions): FoldResult {
  const threshold =
    typeof opts?.similarity === 'number' && Number.isFinite(opts.similarity)
      ? opts.similarity
      : DEFAULT_SIMILARITY;
  const list = Array.isArray(nodes) ? nodes : [];
  const lines: string[] = [];
  const groups: FoldGroup[] = [];

  let i = 0;
  while (i < list.length) {
    const node = list[i];
    if (!isFoldableRow(node)) {
      lines.push(renderFoldNode(node));
      i++;
      continue;
    }

    // Extend the run while each next row is a near-duplicate of the run's
    // representative; the first non-matching row starts a new run.
    const run: FoldableNode[] = [node];
    let j = i + 1;
    while (
      j < list.length &&
      isFoldableRow(list[j]) &&
      textSimilarity(node.text, list[j].text) >= threshold
    ) {
      run.push(list[j]);
      j++;
    }

    if (run.length > 1) {
      const group: FoldGroup = { representative: node, folded: run, count: run.length };
      groups.push(group);
      lines.push(`${renderFoldNode(node)} ${renderFoldMarker(group)}`);
    } else {
      lines.push(renderFoldNode(node));
    }
    i = j;
  }

  return { lines, groups };
}
