import {
  resolveToolName,
  type IndexedElement,
  type PageAsset,
  type PrunedDOMTreeResult,
  type ScrollUntilFoundOptions,
  type ScrollUntilFoundResult,
} from 'chrome-mcp-shared';

/**
 * Standard structured self-healing guidance when an element is not found or expired
 */
export const DIAGNOSTIC_REFRESH_GUIDANCE = `ACTION REQUIRED: Please call '${resolveToolName('read_dom')}' to refresh the index tree before re-attempting interaction`;

/**
 * Isolated symbol to store element index map in the extension's execution context.
 * Prevents polluting global window scope and prevents host page hijacking.
 * Stored as WeakRef to prevent Detached DOM Trees in Blink C++ memory.
 */
const ISOLATED_INDEX_MAP_KEY = Symbol.for('__browser_use_isolated_index_map__');

export function derefElement(entry: any): Element | null {
  if (!entry) return null;
  if (typeof entry.deref === 'function') {
    return entry.deref() ?? null;
  }
  return (entry as Element) ?? null;
}

export function wrapElement(el: Element): any {
  if (typeof WeakRef !== 'undefined') {
    return new WeakRef(el);
  }
  return el;
}

export function getIsolatedIndexMap(): Map<number, any> {
  if (!(globalThis as any)[ISOLATED_INDEX_MAP_KEY]) {
    (globalThis as any)[ISOLATED_INDEX_MAP_KEY] = new Map<number, any>();
  }
  return (globalThis as any)[ISOLATED_INDEX_MAP_KEY];
}

/**
 * Mapping from DOM Element to its verified unoccluded safe click point
 * computed during 9-point grid occlusion sampling.
 *
 * Pinned to globalThis under a registered symbol for the same reason as the
 * isolated index map above: the in-page engine is injected as a file, and a
 * module-scope WeakMap is rebuilt whenever that file re-executes, silently
 * dropping the occlusion-safe click point between chrome_read_dom (writer) and
 * chrome_interact_index (reader) — which degraded clicks back to the geometric
 * centre of partially covered elements.
 */
const SAFE_CLICK_POINT_KEY = Symbol.for('__browser_use_safe_click_point_map__');

function getSafeClickPointMap(): WeakMap<
  Element,
  { x: number; y: number; offsetX: number; offsetY: number }
> {
  const g = globalThis as any;
  if (!g[SAFE_CLICK_POINT_KEY]) {
    g[SAFE_CLICK_POINT_KEY] = new WeakMap<
      Element,
      { x: number; y: number; offsetX: number; offsetY: number }
    >();
  }
  return g[SAFE_CLICK_POINT_KEY];
}

export const safeClickPointWeakMap = getSafeClickPointMap();

/**
 * Shadow DOM and composed tree traversal helpers.
 * These enable penetrating Shadow DOM boundaries to find the true interactive target.
 */
export function composedParent(element: Element | null): Element | null {
  if (!element) return null;
  if ((element as any).assignedSlot) return (element as any).assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode ? element.getRootNode() : null;
  return root && root.nodeType === 11 ? (root as ShadowRoot).host : null;
}

export function composedChildren(element: Element): Element[] {
  if (!element) return [];
  if (element.tagName.toUpperCase() === 'SLOT') {
    const assigned = (element as HTMLSlotElement).assignedElements?.({ flatten: true }) || [];
    if (assigned.length > 0) return assigned;
  }
  const container = (element as HTMLElement).shadowRoot || element;
  return Array.from(container.children || []) as Element[];
}

/**
 * Checks whether an ancestor node contains a descendant across open and composed shadow boundaries.
 */
export function composedContains(ancestor: Node | null, descendant: Node | null): boolean {
  if (!ancestor || !descendant) return false;
  let cur: Element | null =
    descendant instanceof Element ? descendant : (descendant.parentElement as Element | null);
  while (cur) {
    if (cur === ancestor) return true;
    cur = composedParent(cur);
  }
  return false;
}

export function hitElementAtPoint(target: Element, x: number, y: number): Element | null {
  const deep = deepElementFromPoint(x, y);
  if (!deep) return null;
  if (deep === target || composedContains(target, deep) || composedContains(deep, target)) {
    return deep;
  }
  return deep;
}

export function interceptingElementAtPoint(target: Element, x: number, y: number): Element | null {
  const hitElement = hitElementAtPoint(target, x, y);
  if (!hitElement) return null;

  let current: Element | null = hitElement;
  while (current && current !== target) current = composedParent(current);
  if (current === target) return null;

  current = target;
  while (current && current !== hitElement) current = composedParent(current);
  if (current === hitElement) return null; // It's the target itself or inside it

  return hitElement;
}

export function describeHitTarget(element: Element): string {
  let modal: Element | null = element;
  while (modal) {
    const role = modal.getAttribute?.('role');
    const ariaModal = modal.getAttribute?.('aria-modal');
    if (role === 'dialog' || ariaModal === 'true') {
      const name =
        modal.getAttribute?.('aria-label') ||
        modal.getAttribute?.('aria-labelledby') ||
        modal.querySelector?.('h1,h2,h3,h4,h5,h6')?.textContent?.trim();
      return name ? `dialog "${name}"` : 'dialog';
    }
    modal = composedParent(modal);
  }

  const tag = element.tagName.toLowerCase();
  const id = element.id ? ` id="${element.id}"` : '';
  const classAttr =
    typeof element.className === 'string' && element.className.trim()
      ? ` class="${element.className.trim()}"`
      : '';
  const roleAttr = element.getAttribute?.('role') ? ` role="${element.getAttribute('role')}"` : '';
  return `<${tag}${id}${classAttr}${roleAttr}>`;
}

/**
 * Whitelist check for interactive SVG nodes (e.g. icons, clickable vectors).
 * Prevents non-standard interactive SVG elements from being pruned as decorative.
 */
export function isInteractiveSvgNode(el: Element, style?: CSSStyleDeclaration): boolean {
  if (!el || (typeof Element !== 'undefined' && !(el instanceof Element) && !(el as any).tagName))
    return false;
  const tag = (el.tagName || '').toLowerCase();
  const isSvg =
    tag === 'svg' ||
    /^(path|g|rect|circle|line|polygon|polyline|ellipse|text|tspan|use|image)$/i.test(tag) ||
    el.namespaceURI === 'http://www.w3.org/2000/svg' ||
    (typeof el.closest === 'function' && Boolean(el.closest('svg')));
  if (!isSvg) return false;

  if (
    /^(defs|clippath|mask|pattern|lineargradient|radialgradient|filter|metadata|style|title|desc)$/i.test(
      tag,
    )
  ) {
    return false;
  }
  const role = el.getAttribute?.('role')?.toLowerCase();
  if (role && /^(button|link|checkbox|menuitem|tab|switch)$/.test(role)) return true;
  if (
    el.hasAttribute?.('onclick') ||
    el.hasAttribute?.('onmousedown') ||
    typeof (el as any).onclick === 'function'
  )
    return true;
  const tabIndex =
    typeof (el as HTMLElement).tabIndex === 'number' ? (el as HTMLElement).tabIndex : -1;
  if (
    tabIndex >= 0 ||
    (el.hasAttribute?.('tabindex') && !el.getAttribute('tabindex')?.startsWith('-'))
  )
    return true;
  if (style && (style.cursor === 'pointer' || /grab|grabbing|move/i.test(style.cursor)))
    return true;
  if (typeof el.getAttributeNames === 'function') {
    for (const name of el.getAttributeNames()) {
      if (
        /^data-(action|click|target|toggle|trigger|handler|command|interactive|button|nav|href|url|route|press|event)/i.test(
          name,
        )
      ) {
        return true;
      }
    }
  }
  const id = (el.id || el.getAttribute?.('id') || '').trim();
  if (id !== '') {
    // Exclude auto-generated machine SVG IDs (e.g. clip0_123, paint0_linear, path123, rect45)
    const isGenerated =
      /^(clip|paint|mask|gradient|linear|radial|pattern|filter|path|svg|layer|group|rect|circle|ellipse|shape|icon|image)[-_0-9a-z]*$/i.test(
        id,
      ) || /^[0-9a-f]{8,}$/i.test(id);
    if (!isGenerated) return true;
  }
  if (el.hasAttribute?.('aria-haspopup') || el.hasAttribute?.('aria-expanded')) return true;
  return false;
}

/**
 * Pierce open or closed ShadowRoot using chrome.dom.openOrClosedShadowRoot when available,
 * falling back to native el.shadowRoot.
 */
export function getShadowRoot(node: Node | null | undefined): ShadowRoot | null {
  if (!node || (typeof Element !== 'undefined' && !(node instanceof Element))) return null;
  try {
    if (typeof chrome !== 'undefined' && chrome?.dom?.openOrClosedShadowRoot) {
      const sr = chrome.dom.openOrClosedShadowRoot(node as HTMLElement);
      if (sr) return sr;
    }
  } catch {}
  return (node as Element).shadowRoot || null;
}

/**
 * Check if a node is an autonomous or customized Web Component custom element.
 */
export function isCustomElement(node: Node | null | undefined): boolean {
  if (!node || (typeof Element !== 'undefined' && !(node instanceof Element))) return false;
  const tag = ((node as Element).tagName || '').toLowerCase();
  return tag.includes('-') || Boolean((node as Element).getAttribute?.('is'));
}

/**
 * Resolves the true visual element at (x, y) by descending through all open and closed ShadowRoot boundaries.
 */
export function deepElementFromPoint(
  x: number,
  y: number,
  startRoot?: Document | ShadowRoot | Element,
): Element | null {
  const doc: Document | null =
    (startRoot &&
      ((startRoot as any).ownerDocument ||
        ((startRoot as any).nodeType === 9 ? (startRoot as Document) : null))) ||
    (typeof document !== 'undefined' ? document : null);
  if (!doc && !startRoot) return null;

  let current: Element | null = null;
  try {
    if (
      startRoot &&
      ((typeof Document !== 'undefined' && startRoot instanceof Document) ||
        (startRoot as any).nodeType === 11 ||
        (startRoot as any).nodeType === 9 ||
        typeof (startRoot as any).elementFromPoint === 'function')
    ) {
      current = (startRoot as Document | ShadowRoot).elementFromPoint(x, y);
    } else if (
      startRoot &&
      ((typeof Element !== 'undefined' && startRoot instanceof Element) ||
        Boolean((startRoot as any).tagName))
    ) {
      const sr = getShadowRoot(startRoot as Element);
      if (sr && typeof (sr as any).elementFromPoint === 'function') {
        current = (sr as any).elementFromPoint(x, y);
      } else {
        current = startRoot as Element;
      }
    } else if (doc && typeof doc.elementFromPoint === 'function') {
      current = doc.elementFromPoint(x, y);
    }
  } catch {}

  if (!current) return null;

  const visited = new Set<Element>();
  while (current && !visited.has(current)) {
    visited.add(current);
    try {
      const shadow = getShadowRoot(current);
      if (shadow && typeof (shadow as any).elementFromPoint === 'function') {
        const inner = (shadow as any).elementFromPoint(x, y);
        if (inner && inner !== current) {
          current = inner;
          continue;
        }
      }
    } catch {}
    break;
  }
  return current;
}

/**
 * Split a string by a single character delimiter unless that delimiter is inside quotes (single or double).
 * Reference: webdriverio/query-selector-shadow-dom (splitByCharacterUnlessQuoted)
 */
export function splitByCharacterUnlessQuoted(selector: string, character: string): string[] {
  const matches = selector.match(/\\?.|^$/gs);
  if (!matches) return [selector];
  return matches.reduce(
    (p: { quote: number; sQuote: number; a: string[] }, c: string) => {
      if (c === '"' && !p.sQuote) {
        p.quote ^= 1;
        p.a[p.a.length - 1] += c;
      } else if (c === "'" && !p.quote) {
        p.sQuote ^= 1;
        p.a[p.a.length - 1] += c;
      } else if (!p.quote && !p.sQuote && c === character) {
        p.a.push('');
      } else {
        p.a[p.a.length - 1] += c;
      }
      return p;
    },
    { quote: 0, sQuote: 0, a: [''] },
  ).a;
}

/**
 * Traverse across shadow boundaries upwards to find parent element or host element.
 * Reference: Playwright (parentElementOrShadowHost) & WebdriverIO (findParentOrHost)
 */
export function parentElementOrShadowHost(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  if (!element.parentNode) return null;
  if (element.parentNode.nodeType === 11 && (element.parentNode as ShadowRoot).host) {
    return (element.parentNode as ShadowRoot).host as Element;
  }
  return null;
}

/**
 * Normalizes explicit shadow-piercing combinators ('>>>', '/deep/', and '>>') outside quotes to whitespace.
 */
function normalizeExplicitCombinators(selector: string): string {
  const matches = selector.match(/\\?.|^$/gs) || [];
  let quote = 0;
  let sQuote = 0;
  let result = '';

  for (let i = 0; i < matches.length; i++) {
    const c = matches[i];
    if (c === '"' && !sQuote) {
      quote ^= 1;
      result += c;
    } else if (c === "'" && !quote) {
      sQuote ^= 1;
      result += c;
    } else if (!quote && !sQuote) {
      if (
        c === '/' &&
        matches[i + 1] === 'd' &&
        matches[i + 2] === 'e' &&
        matches[i + 3] === 'e' &&
        matches[i + 4] === 'p' &&
        matches[i + 5] === '/'
      ) {
        result += ' ';
        i += 5;
        continue;
      }
      if (c === '>' && matches[i + 1] === '>' && matches[i + 2] === '>') {
        result += ' ';
        i += 2;
        continue;
      }
      if (c === '>' && matches[i + 1] === '>') {
        result += ' ';
        i += 1;
        continue;
      }
      result += c;
    } else {
      result += c;
    }
  }
  return result;
}

/**
 * Atomic in-page client-side auto-scroll until target element is found.
 * Executes smooth step-by-step scrolling, waits for virtual lists / dynamic DOM recycling
 * to settle, searches both standard light DOM and encapsulated open/closed ShadowRoots,
 * centers matched target in the viewport, allocates/refreshes a live 1-based index,
 * and returns live index and coordinates.
 */
export async function inPageScrollUntilFound(
  options: ScrollUntilFoundOptions,
): Promise<ScrollUntilFoundResult> {
  const query = options?.query?.trim();
  const selector = options?.selector?.trim();
  if (!query && !selector) {
    return {
      found: false,
      stepsTaken: 0,
      scrolledPx: 0,
      message: 'Either query or selector must be provided for scroll_until_found',
    };
  }

  const maxSteps = Math.min(Math.max(1, options?.maxSteps ?? 10), 50);
  const stepPx = Math.min(Math.max(50, options?.stepPx ?? 800), 3000);
  const direction = options?.direction === 'up' ? 'up' : 'down';
  const settleMs = Math.min(Math.max(50, options?.settleMs ?? 150), 1000);
  const timeoutMs = Math.min(Math.max(1000, options?.timeoutMs ?? 15000), 60000);
  const startTime = Date.now();

  let targetRegex: RegExp | null = null;
  if (query) {
    try {
      targetRegex = options.isRegex
        ? new RegExp(query, 'i')
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch {
      targetRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  }

  // Resolve scroll container
  let container: HTMLElement | Window = window;
  if (options?.containerSelector) {
    const el = querySelectorDeep(options.containerSelector);
    if (el instanceof HTMLElement) {
      container = el;
    }
  }

  function probeTarget(): Element | null {
    if (typeof document === 'undefined') return null;

    if (selector) {
      const candidates = querySelectorAllDeep(selector, document);
      for (const el of candidates) {
        if (!el || !(el instanceof Element)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            if (!query || (targetRegex && targetRegex.test(el.textContent || ''))) {
              return el;
            }
          }
        }
      }
    }

    if (targetRegex) {
      const candidates = querySelectorAllDeep(
        'button, a, input, textarea, select, h1, h2, h3, h4, h5, h6, [role="button"], [role="article"], [role="link"], [data-testid], article, p, span, li, div, section, blockquote, label, td, th, dt, dd, strong, b, i, em, code, pre, figcaption',
        document,
      );
      for (const el of candidates) {
        if (!el || !(el instanceof Element)) continue;
        const text = (
          el.textContent ||
          el.getAttribute('aria-label') ||
          (el as HTMLInputElement).placeholder ||
          (el as HTMLInputElement).value ||
          ''
        ).trim();
        if (text && targetRegex.test(text)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              return el;
            }
          }
        }
      }
    }

    return null;
  }

  function getScrollPos(): number {
    if (container instanceof Window) {
      return window.scrollY || document.documentElement?.scrollTop || document.body?.scrollTop || 0;
    }
    return container.scrollTop;
  }

  function doScroll(delta: number): void {
    if (container instanceof Window) {
      window.scrollBy({ top: delta, left: 0, behavior: 'instant' as any });
    } else {
      container.scrollBy({ top: delta, left: 0, behavior: 'instant' as any });
    }
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  let stepsTaken = 0;
  let totalScrolledPx = 0;
  let lastPos = getScrollPos();
  let stallCount = 0;

  for (let step = 0; step <= maxSteps; step++) {
    if (Date.now() - startTime > timeoutMs) {
      break;
    }

    const hit = probeTarget();
    if (hit) {
      try {
        hit.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as any });
      } catch {}
      await wait(50);

      // Resolve or allocate live 1-based index in isolatedMap
      let targetIndex: number | undefined;
      const isolatedMap = getIsolatedIndexMap();
      for (const [idx, ref] of isolatedMap.entries()) {
        if (derefElement(ref) === hit) {
          targetIndex = idx;
          break;
        }
      }

      if (targetIndex === undefined) {
        const maxIdx = isolatedMap.size > 0 ? Math.max(...isolatedMap.keys()) : 0;
        targetIndex = maxIdx + 1;
        isolatedMap.set(targetIndex, wrapElement(hit));
      }

      const rect = hit.getBoundingClientRect();
      const coords = {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };

      const matchText = (hit.textContent || hit.getAttribute('aria-label') || '')
        .trim()
        .slice(0, 100);

      return {
        found: true,
        index: targetIndex,
        tagName: hit.tagName.toLowerCase(),
        text: matchText,
        stepsTaken,
        scrolledPx: totalScrolledPx,
        coordinates: coords,
        message: `Found target "${matchText || query || selector}" at index [${targetIndex}] after ${stepsTaken} step(s) (${totalScrolledPx}px). Element centered in viewport.`,
      };
    }

    if (step === maxSteps) {
      break;
    }

    const delta = direction === 'up' ? -stepPx : stepPx;
    doScroll(delta);
    stepsTaken++;
    totalScrolledPx += stepPx;

    await wait(settleMs);

    const currentPos = getScrollPos();
    if (Math.abs(currentPos - lastPos) < 2) {
      stallCount++;
      // If initial window scroll did not move, attempt fallback to smart inner container
      if (stallCount === 1 && container instanceof Window && !options?.containerSelector) {
        try {
          const smart = inPageFindSmartScrollTarget({ direction });
          if (smart && !smart.isWindow && smart.selector) {
            const el = querySelectorDeep(smart.selector);
            if (el instanceof HTMLElement) {
              container = el;
              lastPos = getScrollPos();
              stallCount = 0;
            }
          }
        } catch {}
      } else if (stallCount >= 2) {
        break;
      }
    } else {
      stallCount = 0;
    }
    lastPos = currentPos;
  }

  return {
    found: false,
    stepsTaken,
    scrolledPx: totalScrolledPx,
    message: `Target "${query || selector}" not found after ${stepsTaken} step(s) (${totalScrolledPx}px scrolled).`,
  };
}

/**
 * Folds whitespace around standard CSS combinators ('>', '+', '~') outside quotes.
 */
function foldCombinatorsUnlessQuoted(selector: string): string {
  const matches = selector.match(/\\?.|^$/gs) || [];
  let quote = 0;
  let sQuote = 0;
  let currentUnquoted = '';
  let result = '';

  const flushUnquoted = () => {
    if (currentUnquoted) {
      const folded = currentUnquoted
        .replace(/\s*([+~])\s*/g, '$1')
        .replace(/(?<!>)\s*>\s*(?!>)/g, '>');
      result += folded;
      currentUnquoted = '';
    }
  };

  for (let i = 0; i < matches.length; i++) {
    const c = matches[i];
    if (c === '"' && !sQuote) {
      if (!quote) flushUnquoted();
      quote ^= 1;
      result += c;
    } else if (c === "'" && !quote) {
      if (!sQuote) flushUnquoted();
      sQuote ^= 1;
      result += c;
    } else if (quote || sQuote) {
      result += c;
    } else {
      currentUnquoted += c;
    }
  }
  flushUnquoted();
  return result;
}

/**
 * Safely split a selector by delimiter (default space):
 * 1. Folds whitespace around child (>), next-sibling (+), and subsequent-sibling (~) combinators outside quotes;
 * 2. Splits using single/double quote and bracket/paren state machine so whitespace inside quotes,
 *    attribute brackets [...], and pseudo-classes (...) is preserved;
 * 3. Supports explicit piercing combinators ' >> ', '>>>', '/deep/'.
 */
export function splitSelectorSafely(selector: string, delimiter: string = ' '): string[] {
  if (!selector) return [];
  const normalized = normalizeExplicitCombinators(selector);
  const folded = foldCombinatorsUnlessQuoted(normalized);

  const matches = folded.match(/\\?.|^$/gs);
  if (!matches) return [folded.trim()].filter(Boolean);

  let quote = 0;
  let sQuote = 0;
  let brackets = 0;
  let parens = 0;
  const parts: string[] = [''];

  for (let i = 0; i < matches.length; i++) {
    const c = matches[i];
    if (c === '"' && !sQuote) {
      quote ^= 1;
      parts[parts.length - 1] += c;
    } else if (c === "'" && !quote) {
      sQuote ^= 1;
      parts[parts.length - 1] += c;
    } else if (!quote && !sQuote) {
      if (c === '[') brackets++;
      else if (c === ']' && brackets > 0) brackets--;
      else if (c === '(') parens++;
      else if (c === ')' && parens > 0) parens--;

      if (
        brackets === 0 &&
        parens === 0 &&
        (c === delimiter || (delimiter === ' ' && /\s/.test(c)))
      ) {
        parts.push('');
      } else {
        parts[parts.length - 1] += c;
      }
    } else {
      parts[parts.length - 1] += c;
    }
  }

  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * Single-segment search within a root across all open and closed ShadowRoot boundaries.
 */
function querySelectorAllDeepSingle(selector: string, root: ParentNode): Element[] {
  const results: Element[] = [];
  const visitedRoots = new Set<Node>();

  function search(currentRoot: ParentNode) {
    if (!currentRoot || visitedRoots.has(currentRoot)) return;
    visitedRoots.add(currentRoot);

    try {
      const matches = currentRoot.querySelectorAll(selector);
      for (let i = 0; i < matches.length; i++) {
        results.push(matches[i]);
      }
    } catch {}

    let allEls: NodeListOf<Element>;
    try {
      allEls = currentRoot.querySelectorAll('*');
    } catch {
      return;
    }

    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      const shadow = getShadowRoot(el);
      if (shadow) {
        search(shadow);
      }
    }
  }

  if (typeof Element !== 'undefined' && root instanceof Element) {
    const rootShadow = getShadowRoot(root);
    if (rootShadow) {
      search(rootShadow);
    }
  }

  search(root);
  return results;
}

/**
 * Deep query selector that penetrates all open (and closed when supported) ShadowRoot boundaries.
 * Traverses recursively through both standard light DOM and encapsulated component shadow roots.
 * Supports explicit piercing (' >> ', '>>>', '/deep/') and composite descendant selectors
 * (e.g. 'shreddit-markdown-composer textarea') across shadow boundaries.
 */
export function querySelectorAllDeep(
  selector: string,
  root: ParentNode = typeof document !== 'undefined' ? document : (null as any),
): Element[] {
  if (!root || !selector || typeof selector !== 'string') return [];

  // Comma-separated selector list handling
  const commaSeparators = splitSelectorSafely(selector, ',');
  if (commaSeparators.length > 1) {
    const hasComplexSegment = commaSeparators.some(
      (sub) => splitSelectorSafely(sub, ' ').length > 1,
    );
    if (hasComplexSegment) {
      const combined: Element[] = [];
      for (const sub of commaSeparators) {
        const subMatches = querySelectorAllDeep(sub, root);
        for (const m of subMatches) {
          if (!combined.includes(m)) {
            combined.push(m);
          }
        }
      }
      return combined;
    }
    return querySelectorAllDeepSingle(selector, root);
  }

  const segments = splitSelectorSafely(selector, ' ');
  if (segments.length === 0) return [];

  if (segments.length === 1) {
    return querySelectorAllDeepSingle(segments[0], root);
  }

  // Multi-segment composite descendant selector piercing across Shadow DOM boundaries:
  // Each segment is matched across Document and all reachable ShadowRoots.
  // Between segments, context retains both the element itself and its shadowRoot (for slotted & shadow children).
  let currentContexts: ParentNode[] = [root];
  if (typeof Element !== 'undefined' && root instanceof Element) {
    const rootShadow = getShadowRoot(root);
    if (rootShadow) {
      currentContexts.push(rootShadow);
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const subSelector = segments[i];
    const isLast = i === segments.length - 1;
    const nextMatches: Element[] = [];

    for (const ctx of currentContexts) {
      const matched = querySelectorAllDeepSingle(subSelector, ctx);
      for (const m of matched) {
        if (!nextMatches.includes(m)) {
          nextMatches.push(m);
        }
      }
    }

    if (isLast) {
      return nextMatches;
    }

    const nextContexts: ParentNode[] = [];
    for (const m of nextMatches) {
      if (!nextContexts.includes(m)) {
        nextContexts.push(m);
      }
      const sr = getShadowRoot(m);
      if (sr && !nextContexts.includes(sr)) {
        nextContexts.push(sr);
      }
    }
    currentContexts = nextContexts;
    if (currentContexts.length === 0) return [];
  }

  return [];
}

/**
 * Deep query selector returning the first matching element across all shadow boundaries.
 */
export function querySelectorDeep(
  selector: string,
  root: ParentNode = typeof document !== 'undefined' ? document : (null as any),
): Element | null {
  const all = querySelectorAllDeep(selector, root);
  return all.length > 0 ? all[0] : null;
}

/**
 * Helper to find an element by index using pure in-memory WeakRef mapping without DOM attribute pollution.
 */
/**
 * Lightweight metadata fingerprint for self-healing DOM node recovery across React/Vue re-renders.
 */
const INDEX_FINGERPRINT_KEY = Symbol.for('__browser_use_index_fingerprint_map__');

export interface ElementFingerprint {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  testId?: string;
  ariaLabel?: string;
  role?: string;
  text?: string;
  inShadowDom?: boolean;
  scopeHash?: string;
}

export function computeScopeHash(text: string): string {
  if (!text) return '';
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) + hash + text.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16);
}

export function getIndexFingerprintMap(): Map<number, ElementFingerprint> {
  const g = globalThis as any;
  if (!g[INDEX_FINGERPRINT_KEY]) {
    g[INDEX_FINGERPRINT_KEY] = new Map<number, ElementFingerprint>();
  }
  return g[INDEX_FINGERPRINT_KEY];
}

function selfHealInShadowRoots(root: Node, fp: ElementFingerprint): Element | null {
  if (!root) return null;
  const shadow = getShadowRoot(root);
  if (shadow) {
    if (fp.id) {
      const escapeId =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(fp.id)
          : fp.id.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, '\\$1');
      const found = shadow.querySelector('#' + escapeId);
      if (found && found.tagName.toLowerCase() === fp.tag) return found;
    }
    if (fp.ariaLabel) {
      const found = shadow.querySelector(
        fp.tag + '[aria-label=' + JSON.stringify(fp.ariaLabel) + ']',
      );
      if (found) return found;
    }
    if (fp.placeholder) {
      const found = shadow.querySelector(
        fp.tag + '[placeholder=' + JSON.stringify(fp.placeholder) + ']',
      );
      if (found) return found;
    }
    if (fp.testId) {
      const found = shadow.querySelector('[data-testid=' + JSON.stringify(fp.testId) + ']');
      if (found && found.tagName.toLowerCase() === fp.tag) return found;
    }
    if (fp.name) {
      const found = shadow.querySelector(fp.tag + '[name=' + JSON.stringify(fp.name) + ']');
      if (found) return found;
    }
    for (const child of Array.from(shadow.children)) {
      const res = selfHealInShadowRoots(child, fp);
      if (res) return res;
    }
  }
  if ('children' in root && (root as Element).children) {
    for (const child of Array.from((root as Element).children)) {
      const res = selfHealInShadowRoots(child, fp);
      if (res) return res;
    }
  }
  return null;
}

function selfHealFindElement(fp: ElementFingerprint): Element | null {
  if (typeof document === 'undefined') return null;
  const searchRoot = document.body || document.documentElement || null;
  if (fp.inShadowDom && searchRoot) {
    const inShadow = selfHealInShadowRoots(searchRoot, fp);
    if (inShadow) return inShadow;
  }
  if (fp.id) {
    const byId = document.getElementById(fp.id);
    if (byId && byId.tagName.toLowerCase() === fp.tag) return byId;
  }
  if (fp.testId) {
    const byTestId = document.querySelector('[data-testid=' + JSON.stringify(fp.testId) + ']');
    if (byTestId && byTestId.tagName.toLowerCase() === fp.tag) return byTestId;
  }
  if (fp.ariaLabel) {
    const byAria = document.querySelector(
      fp.tag + '[aria-label=' + JSON.stringify(fp.ariaLabel) + ']',
    );
    if (byAria) return byAria;
  }
  if (fp.name) {
    const byName = document.querySelector(fp.tag + '[name=' + JSON.stringify(fp.name) + ']');
    if (byName) return byName;
  }
  if (fp.placeholder) {
    const byPl = document.querySelector(
      fp.tag + '[placeholder=' + JSON.stringify(fp.placeholder) + ']',
    );
    if (byPl) return byPl;
  }
  if (fp.role) {
    if (fp.name) {
      const byRoleName = document.querySelector(
        fp.tag + '[role=' + JSON.stringify(fp.role) + '][name=' + JSON.stringify(fp.name) + ']',
      );
      if (byRoleName) return byRoleName;
    }
    if (fp.ariaLabel) {
      const byRoleAria = document.querySelector(
        fp.tag +
          '[role=' +
          JSON.stringify(fp.role) +
          '][aria-label=' +
          JSON.stringify(fp.ariaLabel) +
          ']',
      );
      if (byRoleAria) return byRoleAria;
    }
    const byRole = document.querySelector(fp.tag + '[role=' + JSON.stringify(fp.role) + ']');
    if (byRole) return byRole;
  }
  if (fp.text && searchRoot) {
    const selector = fp.tag ? fp.tag : '*';
    const candidates = Array.from(searchRoot.querySelectorAll(selector));
    for (const c of candidates) {
      const cText = (c.textContent || '').trim();
      if (
        cText === fp.text ||
        (cText.length > 0 &&
          fp.text.length > 0 &&
          (cText.includes(fp.text) || fp.text.includes(cText)))
      ) {
        if (!fp.role || c.getAttribute('role') === fp.role) {
          return c;
        }
      }
    }
  }
  return searchRoot ? selfHealInShadowRoots(searchRoot, fp) : null;
}

export function findIndexedElement(index: number | string): Element | null {
  const numIdx = typeof index === 'string' && /^\d+$/.test(index) ? parseInt(index, 10) : index;
  // Persistent refs ('e1','e2',...) resolve through the isolated ref map and are
  // stable across snapshots, unlike numeric per-snapshot indices.
  if (typeof index === 'string' && PERSISTENT_REF_PATTERN.test(index)) {
    const byRef =
      getPersistentRefMap().resolve(index) ?? getPersistentRefMap().fingerprintHeal(index);
    if (byRef) return byRef;
    // Unknown/stale ref: fall through to the legacy resolution paths below so
    // pre-existing 'e<n>' cache keys (__clawFast.actionElements) keep working.
  }
  const isolatedMap = getIsolatedIndexMap();
  if (isolatedMap.has(index as any) || isolatedMap.has(numIdx as any)) {
    const el = derefElement(isolatedMap.get(index as any) ?? isolatedMap.get(numIdx as any));
    if (el && (typeof Element === 'undefined' || el instanceof Element)) {
      const doc = typeof document !== 'undefined' ? document : undefined;
      const isConnected =
        typeof (el as any).isConnected === 'boolean'
          ? (el as any).isConnected
          : doc && typeof doc.contains === 'function'
            ? doc.contains(el) ||
              (typeof el.getRootNode === 'function' &&
                typeof ShadowRoot !== 'undefined' &&
                el.getRootNode() instanceof ShadowRoot)
            : !doc;
      if (isConnected) {
        return el;
      }
    }
  }

  // Fast Snapshot lookup (__clawFast)
  const g = globalThis as any;
  const clawFast = g.__clawFast;
  if (clawFast) {
    const el =
      clawFast.actionElements?.get(index) ||
      clawFast.actionElements?.get(numIdx) ||
      clawFast.nodes?.get(index) ||
      clawFast.nodes?.get(numIdx);
    if (el && (typeof Element === 'undefined' || el instanceof Element)) {
      const doc = typeof document !== 'undefined' ? document : undefined;
      const isConnected =
        typeof (el as any).isConnected === 'boolean'
          ? (el as any).isConnected
          : doc && typeof doc.contains === 'function'
            ? doc.contains(el) ||
              (typeof el.getRootNode === 'function' &&
                typeof ShadowRoot !== 'undefined' &&
                el.getRootNode() instanceof ShadowRoot)
            : !doc;
      if (isConnected) {
        return el;
      }
    }
  }

  // Self-healing recovery pass: if element reference disconnected or GC'd (e.g. React/Vue re-render)
  if (typeof numIdx === 'number' && !isNaN(numIdx)) {
    const fp = getIndexFingerprintMap().get(numIdx);
    if (fp) {
      const recovered = selfHealFindElement(fp);
      if (recovered) {
        isolatedMap.set(numIdx, wrapElement(recovered));
        return recovered;
      }
    }
  }

  // Graceful fallback: deep query across shadow boundaries
  if (typeof document !== 'undefined') {
    try {
      const fallback = querySelectorDeep(`[data-mcp-idx="${index}"]`, document);
      if (fallback) return fallback;
    } catch {}
  }

  return null;
}

/**
 * Persistent element refs.
 *
 * Numeric `index` is a per-snapshot aliasing scheme: it is reassigned on every
 * read_dom, so a reference captured before a re-render can silently point at a
 * different node afterwards. A persistent ref is minted once per element
 * identity and survives DOM mutation that keeps the node alive.
 *
 * Lifecycle:
 *  - mint(el) is idempotent for a live node: re-sighting the SAME node returns
 *    the SAME ref id.
 *  - resolve(ref) dereferences a WeakRef and requires the node to still be
 *    connected; a GC'd or replaced node resolves to null (STALE).
 *  - fingerprintHeal(ref) recovers the common React/Vue case where a re-render
 *    replaced the node with an identical one: the fingerprint (tag, stable
 *    attributes, accessible name, text) finds the replacement and the SAME ref
 *    id is transferred to it.
 *  - clear() invalidates every ref (document navigation / frame re-parenting).
 *  - ids are NEVER recycled: the monotonic counter is per map instance and
 *    survives clear(), so an invalidated id can never resolve to a new element.
 *
 * Storage mirrors getIsolatedIndexMap: a Map<String, WeakRef<Element>> pinned to
 * globalThis under a registered symbol. Host DOM attributes are never written.
 */
const PERSISTENT_REF_MAP_KEY = Symbol.for('__browser_use_persistent_ref_map__');

const PERSISTENT_REF_PATTERN = /^e\d+$/;

export interface RefMap {
  /** Stable ref ('e1','e2',...) minted once per element identity; re-sighting the SAME node returns the SAME id */
  mint(el: Element): string;
  /** null when the node is gone/replaced (stale); never returns a recycled id for a different element */
  resolve(ref: string): Element | null;
  /** When resolve() is null but a node with the SAME fingerprint exists, return it, keeping the same ref id */
  fingerprintHeal(ref: string, root?: ParentNode): Element | null;
  /** Invalidate every ref (navigation / re-parenting). Ids are NOT recycled afterwards */
  clear(): void;
}

/** Snapshot of the properties that identify an element across a re-render. */
function captureRefFingerprint(el: Element): ElementFingerprint {
  const attr = (name: string): string | undefined => {
    try {
      return el.getAttribute(name) || undefined;
    } catch {
      return undefined;
    }
  };
  let inShadowDom = false;
  try {
    inShadowDom =
      typeof el.getRootNode === 'function' &&
      typeof ShadowRoot !== 'undefined' &&
      el.getRootNode() instanceof ShadowRoot;
  } catch {}
  return {
    tag: (el.tagName || '').toLowerCase(),
    id: attr('id'),
    name: attr('name'),
    type: attr('type'),
    placeholder: attr('placeholder'),
    testId: attr('data-testid'),
    ariaLabel: attr('aria-label'),
    role: attr('role'),
    text: (el.textContent || '').trim().slice(0, 100) || undefined,
    inShadowDom,
  };
}

/** True when `el` is a plausible re-render replacement for `fp`. */
function matchesRefFingerprint(el: Element, fp: ElementFingerprint): boolean {
  if (!el || (el.tagName || '').toLowerCase() !== fp.tag) return false;
  const stableAttrs: Array<[string, string | undefined]> = [
    ['id', fp.id],
    ['name', fp.name],
    ['type', fp.type],
    ['placeholder', fp.placeholder],
    ['data-testid', fp.testId],
    ['aria-label', fp.ariaLabel],
    ['role', fp.role],
  ];
  let wanted = 0;
  let matched = 0;
  for (const [name, value] of stableAttrs) {
    if (!value) continue;
    wanted++;
    if (el.getAttribute(name) === value) matched++;
  }
  if (wanted > 0 && matched === 0) return false;
  if (fp.text) {
    const text = (el.textContent || '').trim();
    if (!(
      text === fp.text ||
      (text.length > 0 && fp.text.length > 0 && (text.includes(fp.text) || fp.text.includes(text)))
    )) {
      return false;
    }
  }
  return true;
}

function findElementByFingerprint(fp: ElementFingerprint, root: ParentNode): Element | null {
  let candidates: Element[] = [];
  try {
    candidates = Array.from(root.querySelectorAll(fp.tag ? fp.tag : '*')) as Element[];
  } catch {
    return null;
  }
  for (const cand of candidates) {
    if (matchesRefFingerprint(cand, fp)) return cand;
  }
  return null;
}

/**
 * Create an isolated persistent ref map. Each instance owns its own id counter.
 */
export function createRefMap(): RefMap {
  let refs = new Map<string, WeakRef<Element>>();
  let elToRef = new WeakMap<Element, string>();
  const fingerprints = new Map<string, ElementFingerprint>();
  let counter = 0;

  const resolve = (ref: string): Element | null => {
    if (typeof ref !== 'string' || !PERSISTENT_REF_PATTERN.test(ref)) return null;
    const wrapped = refs.get(ref);
    if (!wrapped) return null;
    const el = derefElement(wrapped);
    if (!el) return null;
    if (typeof (el as any).isConnected === 'boolean') {
      return (el as any).isConnected ? el : null;
    }
    const doc = typeof document !== 'undefined' ? document : undefined;
    if (!doc || typeof doc.contains !== 'function') return el;
    return doc.contains(el) ? el : null;
  };

  return {
    mint(el: Element): string {
      const existing = elToRef.get(el);
      if (existing) {
        // Keep the weak ref fresh: identity is unchanged, so the id is unchanged.
        if (!refs.get(existing)?.deref()) {
          refs.set(existing, wrapElement(el));
        }
        return existing;
      }
      const id = `e${++counter}`;
      elToRef.set(el, id);
      refs.set(id, wrapElement(el));
      fingerprints.set(id, captureRefFingerprint(el));
      return id;
    },

    resolve,

    fingerprintHeal(ref: string, root?: ParentNode): Element | null {
      const live = resolve(ref);
      if (live) return live;
      const fp = fingerprints.get(ref);
      if (!fp) return null;
      const explicitRoot = root ?? null;
      let found: Element | null = explicitRoot ? findElementByFingerprint(fp, explicitRoot) : null;
      if (!found && typeof document !== 'undefined') {
        found = selfHealFindElement(fp);
      }

      if (!found) return null;
      // Transfer the identity: the healed node keeps the SAME ref id.
      elToRef.set(found, ref);
      refs.set(ref, wrapElement(found));
      fingerprints.set(ref, captureRefFingerprint(found));
      return found;
    },

    clear(): void {
      refs = new Map<string, WeakRef<Element>>();
      elToRef = new WeakMap<Element, string>();
      fingerprints.clear();
      // counter is deliberately NOT reset: stale ids must never be recycled.
    },
  };
}

/**
 * Process-wide persistent ref map for the in-page engine. Pinned to globalThis
 * under a registered symbol for the same reason as the isolated index map: the
 * engine is injected as a file and re-executes, so a module-scope map would be
 * silently rebuilt between the writing and reading tool calls.
 */
export function getPersistentRefMap(): RefMap {
  const g = globalThis as any;
  if (!g[PERSISTENT_REF_MAP_KEY]) {
    g[PERSISTENT_REF_MAP_KEY] = createRefMap();
  }
  return g[PERSISTENT_REF_MAP_KEY] as RefMap;
}

/**
 * Remove Set-of-Mark visual badges overlay if present.
 */
export function inPageRemoveHighlights(): boolean {
  const overlay = document.getElementById('__mcp_som_overlay_container__');
  if (overlay) {
    overlay.remove();
    return true;
  }
  return false;
}

/**
 * Extract clean, high-signal text from an element:
 * - For <select>, extracts only currently selected option text (saving 90%+ tokens and exposing form state)
 * - For elements without text, checks ::before and ::after pseudo-element content
 */
export function extractCleanElementText(el: Element, maxLen = 120): string {
  if (!el) return '';
  const tag = (el.tagName || '').toLowerCase();
  let text = '';

  if (tag === 'select') {
    const selectEl = el as HTMLSelectElement;
    text = (selectEl.selectedOptions?.[0]?.text || selectEl.value || '').trim();
  } else {
    text = ((el as HTMLElement).innerText || el.textContent || '').trim();
  }

  if (!text) {
    try {
      const win =
        el.ownerDocument?.defaultView ||
        (typeof window !== 'undefined' ? window : (globalThis as any).window);
      if (win && typeof win.getComputedStyle === 'function') {
        const cleanContent = (c?: string): string => {
          if (!c || c === 'none' || c === 'normal') return '';
          let str = c.replace(/^["']|["']$/g, '').trim();
          // Decode CSS unicode escapes like \00d7, \u00d7, \2715, or \1F50D
          str = str.replace(/\\(?:u([0-9a-fA-F]{4})|([0-9a-fA-F]{1,6})\s?)/g, (_, uHex, hex) => {
            const code = parseInt(uHex || hex, 16);
            try {
              return isNaN(code) || code > 0x10ffff ? _ : String.fromCodePoint(code);
            } catch {
              return _;
            }
          });
          return str.trim();
        };
        let beforeContent: string | undefined;
        let afterContent: string | undefined;
        const isJsdom =
          typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
        if (!isJsdom) {
          try {
            beforeContent = win.getComputedStyle(el, '::before')?.getPropertyValue('content');
            afterContent = win.getComputedStyle(el, '::after')?.getPropertyValue('content');
          } catch {}
        }
        const bText = cleanContent(beforeContent);
        const aText = cleanContent(afterContent);
        const pseudoText = [bText, aText].filter(Boolean).join(' ').trim();
        if (pseudoText) {
          text = pseudoText;
        }
      }
    } catch {}
  }

  if (!text) {
    // 1. ARIA labelledby (highest priority in W3C accessible name specification)
    const ariaLabelledBy = el.getAttribute?.('aria-labelledby')?.trim();
    if (ariaLabelledBy) {
      try {
        const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (doc) {
          const ids = ariaLabelledBy.split(/\s+/);
          const parts: string[] = [];
          for (const id of ids) {
            let labelEl: Element | null = doc.getElementById(id);
            if (!labelEl) labelEl = querySelectorDeep(`#${id}`, doc);
            const lt = (labelEl?.textContent || '').trim();
            if (lt) parts.push(lt);
          }
          if (parts.length > 0) text = parts.join(' ');
        }
      } catch {}
    }
  }

  if (!text) {
    // 2. Semantic accessibility label extraction (aria-label, title, aria-description)
    const ariaLabel = el.getAttribute?.('aria-label')?.trim();
    if (ariaLabel) {
      text = ariaLabel;
    } else {
      const title = el.getAttribute?.('title')?.trim();
      if (title) {
        text = title;
      } else {
        const ariaDesc = el.getAttribute?.('aria-description')?.trim();
        if (ariaDesc) {
          text = ariaDesc;
        } else {
          // 3. Inner accessible children ([role="img"][aria-label], [aria-label], SVG titles)
          try {
            const innerRoleImg = el
              .querySelector?.('[role="img"][aria-label]')
              ?.getAttribute('aria-label')
              ?.trim();
            const svgAria = el
              .querySelector?.('svg[aria-label]')
              ?.getAttribute('aria-label')
              ?.trim();
            const svgTitle = el.querySelector?.('svg title, svg desc')?.textContent?.trim();
            const anyInnerAria = el
              .querySelector?.('[aria-label]')
              ?.getAttribute('aria-label')
              ?.trim();
            if (innerRoleImg) text = innerRoleImg;
            else if (svgAria) text = svgAria;
            else if (svgTitle) text = svgTitle;
            else if (anyInnerAria) text = anyInnerAria;
          } catch {}
        }
      }
    }
  }

  // 4. Parent custom element wrapper semantics (e.g. Reddit <faceplate-tracker action="reply"> wrapping button)
  if (!text && el.parentElement && isCustomElement(el.parentElement)) {
    const parent = el.parentElement;
    const parentLabel =
      parent.getAttribute('aria-label') ||
      parent.getAttribute('action') ||
      parent.getAttribute('data-action') ||
      parent.getAttribute('data-testid');
    if (parentLabel && typeof parentLabel === 'string') {
      text = parentLabel.replace(/[-_]/g, ' ').trim();
    }
  }

  // 5. Element's own action/test attributes
  if (!text) {
    const actionAttr =
      el.getAttribute?.('data-action') ||
      el.getAttribute?.('data-testid') ||
      el.getAttribute?.('data-tooltip') ||
      el.getAttribute?.('data-click-id');
    if (actionAttr && typeof actionAttr === 'string') {
      text = actionAttr.replace(/[-_]/g, ' ').trim();
    }
  }

  // If still empty and element has slotted children (Web Component container), extract slotted text
  if (!text && typeof el.querySelectorAll === 'function') {
    try {
      const slots = el.querySelectorAll('slot');
      if (slots.length > 0) {
        const slotTexts: string[] = [];
        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          const assigned =
            typeof slot.assignedNodes === 'function' ? slot.assignedNodes({ flatten: true }) : [];
          for (const n of assigned) {
            const t = n.textContent?.trim();
            if (t) slotTexts.push(t);
          }
        }
        if (slotTexts.length > 0) {
          text = slotTexts.join(' ');
        }
      }
    } catch {}
  }

  // Strip Unicode Private Use Area (PUA) characters (\uE000-\uF8FF) used by icon fonts
  // (e.g. \ue610 on JD/Taobao/FontAwesome), which crash Windows GBK console / python stdout.
  const sanitized = text
    .replace(/[\uE000-\uF8FF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitized.slice(0, maxLen);
}

/**
 * Re-index elements in a subframe by applying an index offset.
 * Synchronizes the subframe's in-page index map, DOM attributes, and visual badges.
 */
export function inPageReindexFrame(offset: number, highlight = false): boolean {
  if (typeof offset !== 'number' || offset === 0) return false;
  const isolatedMap = getIsolatedIndexMap();
  const entries = Array.from(isolatedMap.entries()).sort((a, b) => a[0] - b[0]);
  isolatedMap.clear();

  const reindexedElements: IndexedElement[] = [];

  for (const [oldIdx, wrapped] of entries) {
    const el = derefElement(wrapped);
    if (!el || !(el instanceof Element)) continue;

    const newIdx = oldIdx + offset;
    isolatedMap.set(newIdx, wrapElement(el));

    if (highlight) {
      try {
        const rect = el.getBoundingClientRect();
        const text = extractCleanElementText(el);
        reindexedElements.push({
          index: newIdx,
          tagName: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined,
          text: text || undefined,
          attributes: {},
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          isInteractive: true,
        });
      } catch {}
    }
  }

  if (highlight && reindexedElements.length > 0) {
    inPageRenderHighlights(reindexedElements);
  }

  return true;
}

/**
 * Re-align Set-of-Mark visual badges overlay after scrolling or dynamic layout shifts.
 * Re-reads bounding rects of indexed elements in isolatedMap and updates the visual overlay.
 */
export function inPageRealignHighlights(): boolean {
  const overlay = document.getElementById('__mcp_som_overlay_container__');
  if (!overlay) return false;
  const isolatedMap = getIsolatedIndexMap();
  const reindexedElements: IndexedElement[] = [];

  for (const [idx, wrapped] of isolatedMap.entries()) {
    const el = derefElement(wrapped);
    if (!el || !(el instanceof Element)) continue;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      const text = extractCleanElementText(el);
      reindexedElements.push({
        index: idx,
        tagName: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        text: text || undefined,
        attributes: {},
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        isInteractive: true,
      });
    } catch {}
  }

  if (reindexedElements.length > 0) {
    inPageRenderHighlights(reindexedElements);
    return true;
  }
  return false;
}

/**
 * Scroll target element into center view by index inside active tab.
 */
export function inPageScrollToIndex(index: number): boolean {
  if (index <= 0) return false;
  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) return false;
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });

    // Secondary safety check: ensure element is not occluded by sticky top/bottom bars or within safe 80px viewport margins
    const win = el.ownerDocument?.defaultView || window;
    const vh = win.innerHeight || 800;
    const margins = getStickyOcclusionMargins(win);
    const elStyle = typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
    const scrollMarginTop = parseFloat(elStyle?.scrollMarginTop || '0') || 0;
    const scrollMarginBottom = parseFloat(elStyle?.scrollMarginBottom || '0') || 0;
    const safeTop = Math.min(Math.max(margins.top, scrollMarginTop, 80), Math.round(vh * 0.35));
    const safeBottom = Math.min(
      Math.max(margins.bottom, scrollMarginBottom, 80),
      Math.round(vh * 0.35),
    );

    try {
      const r = el.getBoundingClientRect();
      if (r.top < safeTop + 10) {
        const delta = r.top - safeTop - 20;
        win.scrollBy?.({ top: delta, behavior: 'instant' as any });
        let anc = composedParent(el);
        while (anc && anc !== win.document.body && anc !== win.document.documentElement) {
          anc.scrollBy?.({ top: delta, behavior: 'instant' as any });
          anc = composedParent(anc);
        }
      } else if (r.bottom > vh - safeBottom - 10) {
        const delta = r.bottom - (vh - safeBottom) + 20;
        win.scrollBy?.({ top: delta, behavior: 'instant' as any });
        let anc = composedParent(el);
        while (anc && anc !== win.document.body && anc !== win.document.documentElement) {
          anc.scrollBy?.({ top: delta, behavior: 'instant' as any });
          anc = composedParent(anc);
        }
      }
    } catch {}

    return true;
  } catch {
    return false;
  }
}

/**
 * Render high-contrast Set-of-Mark visual badges on top of indexed elements (Set-of-Mark 2.0).
 * Features:
 * 1. Frustum Culling: skips elements strictly outside the current viewport.
 * 2. Anti-Collision: tracks badge locations and offsets badges if within 25px of an existing badge.
 * 3. Micro-Pill design: high legibility, compact footprint, semi-transparent background to prevent obscuring content.
 */
export function inPageRenderHighlights(indexedElements: IndexedElement[]): void {
  inPageRemoveHighlights();

  const overlay = document.createElement('div');
  overlay.id = '__mcp_som_overlay_container__';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText =
    [
      'position: fixed',
      'top: 0',
      'left: 0',
      'width: 100vw',
      'height: 100vh',
      'pointer-events: none',
      'z-index: 2147483647',
      'overflow: visible',
      'margin: 0',
      'padding: 0',
    ].join(' !important;') + ' !important;';

  const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement.clientHeight || 800;

  // Track placed badge centers for anti-collision
  const placedBadges: Array<{ x: number; y: number }> = [];

  for (const el of indexedElements) {
    if (!el.rect || (el.rect.width <= 0 && el.rect.height <= 0)) continue;

    // 1. Frustum Culling: skip elements completely outside the visible viewport
    if (
      el.rect.x + el.rect.width < 0 ||
      el.rect.y + el.rect.height < 0 ||
      el.rect.x > vw ||
      el.rect.y > vh
    ) {
      continue;
    }

    // Outlined bounding box
    const box = document.createElement('div');
    box.style.cssText =
      [
        'position: fixed',
        `left: ${el.rect.x}px`,
        `top: ${el.rect.y}px`,
        `width: ${el.rect.width}px`,
        `height: ${el.rect.height}px`,
        'border: 1.5px solid rgba(245, 158, 11, 0.85)',
        'background: rgba(245, 158, 11, 0.08)',
        'box-sizing: border-box',
        'pointer-events: none',
        'z-index: 2147483646',
      ].join(' !important;') + ' !important;';
    overlay.appendChild(box);

    // Numbered Badge position calculation with Anti-Collision
    const isSmall = el.rect.width < 60 || el.rect.height < 30;
    let badgeTop = isSmall ? Math.max(0, el.rect.y - 14) : el.rect.y;
    const badgeLeft = el.rect.x;

    // 2. Anti-Collision: check proximity to placed badges (< 25px)
    const isColliding = (bx: number, by: number): boolean => {
      for (const placed of placedBadges) {
        const dx = placed.x - bx;
        const dy = placed.y - by;
        if (dx * dx + dy * dy < 25 * 25) {
          return true;
        }
      }
      return false;
    };

    if (isColliding(badgeLeft + 10, badgeTop + 7)) {
      // Alternate placement: flip below element or shift vertically
      const altTop = el.rect.y + el.rect.height - 2;
      if (!isColliding(badgeLeft + 10, altTop + 7) && altTop + 14 <= vh) {
        badgeTop = altTop;
      } else {
        badgeTop = Math.max(0, badgeTop + 14);
      }
    }

    placedBadges.push({ x: badgeLeft + 10, y: badgeTop + 7 });

    // 3. Micro-Pill Badge
    const badge = document.createElement('div');
    badge.textContent = String(el.index);
    badge.style.cssText =
      [
        'position: fixed',
        `left: ${badgeLeft}px`,
        `top: ${badgeTop}px`,
        'background: rgba(250, 204, 21, 0.9)',
        'color: #000000',
        'font-size: 9px',
        'font-weight: 800',
        'font-family: monospace, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        'line-height: 11px',
        'padding: 1px 3px',
        'border-radius: 9999px',
        'border: 1px solid rgba(0, 0, 0, 0.7)',
        'box-shadow: 0 1px 3px rgba(0,0,0,0.35)',
        'pointer-events: none',
        'z-index: 2147483647',
        'user-select: none',
        'white-space: nowrap',
      ].join(' !important;') + ' !important;';

    overlay.appendChild(badge);
  }

  (document.body || document.documentElement).appendChild(overlay);
}

/**
 * Detect rich text composer / editor semantics vs generic searchbox inputs.
 * Enables accurate input disambiguation in modern SPAs (Twitter/X, Notion, Slack, GitHub).
 */
export function detectEditorSemantics(el: Element): {
  isComposer: boolean;
  isEditor: boolean;
  isSearch: boolean;
} {
  if (!el || !(el instanceof Element) || typeof (el as any).getAttribute !== 'function') {
    return { isComposer: false, isEditor: false, isSearch: false };
  }

  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const id = (el.getAttribute('id') || '').toLowerCase();
  const name = (el.getAttribute('name') || '').toLowerCase();
  const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
  const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
  const className = (typeof el.className === 'string' ? el.className : '').toLowerCase();
  const dataTestId = (
    el.getAttribute('data-testid') ||
    el.getAttribute('data-test-id') ||
    ''
  ).toLowerCase();

  const isContentEditable =
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('contenteditable') === '' ||
    (typeof (el as HTMLElement).isContentEditable === 'boolean' &&
      (el as HTMLElement).isContentEditable);

  // 1. Search Box Detection
  const isSearchType = tag === 'input' && type === 'search';
  const isSearchRole = role === 'searchbox' || role === 'search';
  const hasSearchAncestor =
    typeof el.closest === 'function' &&
    Boolean(el.closest('[role="search"], form[role="search"], .search-box, .search-form'));
  const matchesSearchText = /(search|query|find|sousuo|搜索|查找)/i.test(
    `${id} ${name} ${ariaLabel} ${placeholder} ${dataTestId}`,
  );

  const isSearch =
    isSearchType ||
    isSearchRole ||
    (!isContentEditable && matchesSearchText && (tag === 'input' || hasSearchAncestor));

  if (isSearch) {
    return { isComposer: false, isEditor: false, isSearch: true };
  }

  // 2. Rich Text Editor / SPA Composer signatures across social media, forums, and chat platforms
  const isSocialFeedOrMessageComposer =
    /(tweettextarea|tweet_box|composer|post_box|chat_input|reply_box|comment_box|message_input|editor_box)/i.test(
      dataTestId,
    ) ||
    /(tweet text|post text|what is happening|what's happening|post your reply|compose post|compose tweet|write a comment|write a reply|leave a comment|start a post|share your thoughts|发帖|有什么新鲜事|发布你的回复|写评论|发表评论|写下你的回复|发表新帖)/i.test(
      `${ariaLabel} ${placeholder} ${dataTestId}`,
    );

  const isRichEditorFramework =
    isContentEditable ||
    className.includes('drafteditor') ||
    className.includes('lexical') ||
    className.includes('prosemirror') ||
    className.includes('ql-editor') ||
    className.includes('cm-content') ||
    className.includes('monaco-editor') ||
    el.hasAttribute('data-lexical-editor') ||
    el.hasAttribute('data-slate-editor') ||
    el.hasAttribute('data-contents');

  const isMultiLineText =
    tag === 'textarea' || (role === 'textbox' && el.getAttribute('aria-multiline') === 'true');

  const isPostOrCommentContext =
    /(post|comment|reply|compose|tweet|thread|feed|status|feed-box|message|chat-input|editor|wysiwyg|pinglun|huifu|帖子|评论|回复)/i.test(
      `${id} ${name} ${ariaLabel} ${placeholder} ${className} ${dataTestId}`,
    );

  const isComposer =
    isSocialFeedOrMessageComposer ||
    (isRichEditorFramework && isPostOrCommentContext) ||
    (isMultiLineText && isPostOrCommentContext) ||
    (isContentEditable && isSocialFeedOrMessageComposer);

  const isEditor = !isComposer && (isRichEditorFramework || isMultiLineText || isContentEditable);

  return { isComposer, isEditor, isSearch: false };
}

/**
 * Detect fixed/sticky top and bottom occlusion bars (navbars, sticky headers, floating toolbars).
 * Returns safe margins to ensure elements scrolled or targeted are not occluded.
 */
export function getStickyOcclusionMargins(win: Window): { top: number; bottom: number } {
  let topMargin = 0;
  let bottomMargin = 0;
  try {
    const doc = win.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return { top: 0, bottom: 0 };
    const vpW = win.innerWidth || 1280;
    const vpH = win.innerHeight || 800;
    const candidates = doc.querySelectorAll(
      'header, nav, [role="banner"], [role="navigation"], [class*="header" i], [class*="nav" i], [class*="topbar" i], [class*="toolbar" i], [class*="floating" i], [class*="sticky" i], [class*="fixed" i]',
    );
    for (const c of Array.from(candidates)) {
      if (!(c instanceof (win as any).HTMLElement)) continue;
      const s = win.getComputedStyle(c);
      if (s.position === 'fixed' || s.position === 'sticky') {
        const r = c.getBoundingClientRect();
        if (r.width >= vpW * 0.4 && r.height >= 20 && r.height <= vpH * 0.4) {
          if (r.top <= 15) {
            topMargin = Math.max(topMargin, Math.round(r.bottom));
          } else if (r.bottom >= vpH - 15) {
            bottomMargin = Math.max(bottomMargin, Math.round(vpH - r.top));
          }
        }
      }
    }
  } catch {}
  return {
    top: Math.min(topMargin, 160),
    bottom: Math.min(bottomMargin, 160),
  };
}

export interface ActiveModalBlockerInfo {
  el: HTMLElement;
  coverage: number;
  stackingScore: number;
  kind: 'modal' | 'mask';
  name: string;
  isTrap?: boolean;
}

/**
 * Detect active modal blocker using stacking score competition algorithm.
 * Evaluates Top-Layer, dialog role, aria-modal, z-index, and DOM order so
 * secondary confirmation traps are not obscured by large parent modals.
 */
export function detectActiveModalBlocker(win: Window = window): ActiveModalBlockerInfo | null {
  try {
    const doc = win.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    const vpWidth = win.innerWidth || doc.documentElement?.clientWidth || 1280;
    const vpHeight = win.innerHeight || doc.documentElement?.clientHeight || 800;
    const vpArea = vpWidth * vpHeight;

    const positionedCandidates = Array.from(
      doc.querySelectorAll(
        'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover], [class*="modal"], [class*="dialog"], [class*="backdrop"], [class*="overlay"], [class*="mask"], [id*="modal"], [id*="dialog"], [id*="overlay"], [style*="fixed"], [style*="absolute"], body > div, body > section, body > aside',
      ),
    ) as HTMLElement[];

    try {
      const shadowCandidates = querySelectorAllDeep(
        'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover], shreddit-modal, [class*="modal"], [class*="dialog"]',
        doc,
      );
      for (const sc of shadowCandidates) {
        if (sc instanceof HTMLElement && !positionedCandidates.includes(sc)) {
          positionedCandidates.push(sc);
        }
      }
    } catch {}

    let topBlocker: ActiveModalBlockerInfo | null = null;

    for (let i = 0; i < positionedCandidates.length; i++) {
      const d = positionedCandidates[i];
      if (!d || d.getAttribute('aria-hidden') === 'true') continue;
      let style: CSSStyleDeclaration;
      try {
        style = win.getComputedStyle(d);
      } catch {
        continue;
      }
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.pointerEvents === 'none'
      )
        continue;
      const pos = style.position;
      const isPositioned = pos === 'fixed' || pos === 'absolute' || pos === 'sticky';
      const isDialogRole =
        d.tagName.toLowerCase() === 'dialog' ||
        d.getAttribute('role') === 'dialog' ||
        d.getAttribute('role') === 'alertdialog' ||
        d.getAttribute('aria-modal') === 'true';

      if (!isPositioned && !isDialogRole) continue;

      const rect = d.getBoundingClientRect();
      const ix = Math.max(0, Math.min(rect.right, vpWidth) - Math.max(rect.left, 0));
      const iy = Math.max(0, Math.min(rect.bottom, vpHeight) - Math.max(rect.top, 0));
      const cov = vpArea > 0 ? (ix * iy) / vpArea : 0;

      const qualifies = cov >= 0.6 || (isDialogRole && cov >= 0.12);
      if (!qualifies) continue;

      const hasInputs = !!d.querySelector('input, textarea, select, button, a');
      const kind: 'modal' | 'mask' =
        isDialogRole || hasInputs ? 'modal' : cov >= 0.85 ? 'mask' : 'modal';

      const tag = d.tagName.toLowerCase();
      const id = d.id ? `#${d.id}` : '';
      const name =
        d.getAttribute('aria-label') ||
        d.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim()?.slice(0, 40);
      const desc = name
        ? `${tag}${id} "${name}"`
        : `${tag}${id || (kind === 'mask' ? '.mask' : '.modal')}`;

      const textSnippet = `${desc} ${name || ''} ${d.textContent?.slice(0, 300) || ''}`;
      const isDiscardOrConfirm =
        /(discard|abandon|unsaved|confirm|放弃|取消|未保存|确认放弃|是否放弃|离开)/i.test(
          textSnippet,
        );

      // Stacking score: Top-Layer > confirmation trap > alertdialog > aria-modal > z-index > DOM order
      let score = 0;
      const isNativeDialog = tag === 'dialog' && (d as HTMLDialogElement).open;
      const isPopoverOpen =
        Boolean((d as any).matches?.(':popover-open')) ||
        (d.hasAttribute('popover') && style.display !== 'none');
      if (isNativeDialog || isPopoverOpen) {
        score += 1_000_000;
      }
      if (isDiscardOrConfirm) {
        score += 500_000;
      } else if (d.getAttribute('role') === 'alertdialog') {
        score += 200_000;
      } else if (d.getAttribute('aria-modal') === 'true') {
        score += 100_000;
      }

      let z = 0;
      if (style.zIndex && style.zIndex !== 'auto') {
        const parsedZ = parseInt(style.zIndex, 10);
        if (!isNaN(parsedZ)) z = parsedZ;
      }
      score += Math.max(0, Math.min(z, 99_999)) * 10;
      score += i;

      if (!topBlocker || score > topBlocker.stackingScore) {
        topBlocker = {
          el: d,
          coverage: cov,
          stackingScore: score,
          kind,
          name: isDiscardOrConfirm ? `${desc} [CONFIRMATION_TRAP]` : desc,
          isTrap: isDiscardOrConfirm,
        };
      }
    }

    return topBlocker;
  } catch {
    return null;
  }
}

/**
 * Focus Trap and Modal Focus Guard:
 * Pulls and locks DOM keyboard focus into the active modal dialog or specified modal root.
 * Ensures subsequent Tab, Enter, and keyboard shortcuts don't bleed into background DOM.
 */
export function inPageEnsureModalFocus(modalEl?: Element): boolean {
  if (typeof document === 'undefined') return false;
  let target = modalEl;
  if (!target) {
    const blocker = detectActiveModalBlocker(typeof window !== 'undefined' ? window : undefined);
    if (blocker?.el) {
      target = blocker.el;
    }
  }
  if (!target) return false;

  // Check if current active element is already inside target
  if (
    document.activeElement &&
    (target === document.activeElement || target.contains(document.activeElement))
  ) {
    return true;
  }

  // Find first focusable element inside the modal (penetrating Shadow DOM)
  const focusable = querySelectorAllDeep(
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], a[href]',
    target,
  );
  for (const el of focusable) {
    if (el instanceof HTMLElement) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        try {
          el.focus();
          return true;
        } catch {}
      }
    }
  }

  // Fallback: focus modal container itself
  if (target instanceof HTMLElement) {
    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
    }
    try {
      target.focus();
      return true;
    } catch {}
  }
  return false;
}

/**
 * W3C Standard Composite Card Flattening (Card-level Semantic Aggregation)
 *
 * Targets standard semantic containers:
 * - article, [role="article"], [role="listitem"], li, [aria-roledescription="card"], [aria-roledescription="item"]
 *
 * Identifies fragmented composite cards (e.g. eCommerce product items, search result snippets, social feed items)
 * that have >= 3 candidate nodes and NO form inputs. Aggregates all fragmented leaf text nodes (title, price,
 * ratings, tags, shop names) into a single structured card summary while strictly preserving the primary
 * clickable element's index, safe click point, and href, as well as distinct action buttons (e.g. "Add to Cart").
 * Slashes token count and DOM lines by 60%+ without vendor-specific hacks.
 */
export function flattenCompositeCards(
  candidates: Array<{
    node: Element;
    tag: string;
    rect: DOMRect;
    isFile: boolean;
    isInteractive: boolean;
    inShadowDom?: boolean;
    isClosedShadowHost?: boolean;
    isCard?: boolean;
    cardRole?: string;
    aggregatedText?: string;
    isCardSecondary?: boolean;
    isVirtualMarker?: boolean;
  }>,
  maxTextLength: number = 120,
): number {
  if (!candidates || candidates.length < 3) return 0;

  // Group candidate elements by their closest ancestor card container
  const cardMap = new Map<Element, Array<(typeof candidates)[0]>>();

  for (const cand of candidates) {
    if (cand.isVirtualMarker || cand.isFile || !cand.node || !(cand.node instanceof Element)) {
      continue;
    }

    const card = cand.node.closest?.(
      'article, [role="article"], [role="listitem"], li, [aria-roledescription="card"], [aria-roledescription="item"]',
    );
    if (!card || card.tagName.toLowerCase() === 'body') continue;

    let items = cardMap.get(card);
    if (!items) {
      items = [];
      cardMap.set(card, items);
    }
    items.push(cand);
  }

  let flattenedCount = 0;

  for (const [card, items] of cardMap.entries()) {
    if (items.length < 3) continue;

    // Safety Guard 1: Never collapse forms or containers with interactive editable inputs
    const hasFormInputs = card.querySelector?.(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="searchbox"]',
    );
    if (hasFormInputs) continue;

    // Safety Guard 2: Card dimensions should be reasonable (not a giant page section)
    const cardRect = card.getBoundingClientRect();
    if (cardRect.height > 1000 || (cardRect.width > 1200 && card.tagName.toLowerCase() !== 'li')) {
      continue;
    }

    // Collect distinct text fragments from the card items
    const infoTexts: string[] = [];
    for (const it of items) {
      // Exclude action buttons, checkboxes, radios from the card description
      const isControl = it.node.matches?.(
        'button, [role="button"], input[type="checkbox"], input[type="radio"], [role="checkbox"]',
      );
      if (isControl) continue;

      const t = extractCleanElementText(it.node, maxTextLength);
      if (t) {
        // Avoid duplicate or substring text
        const isRedundant = infoTexts.some(
          (existing) => existing === t || existing.includes(t) || t.includes(existing),
        );
        if (!isRedundant) {
          infoTexts.push(t);
        } else {
          // If the new text is longer and contains existing, replace with longer text
          const existingIdx = infoTexts.findIndex((existing) => t.includes(existing));
          if (existingIdx !== -1 && t.length > infoTexts[existingIdx].length) {
            infoTexts[existingIdx] = t;
          }
        }
      }
    }

    // Must have at least 2 distinct text fragments to be considered fragmented composite card
    if (infoTexts.length < 2) continue;

    // Find the primary interactive element (e.g. product title link or main card link)
    let primaryCandidate = items.find(
      (it) =>
        it.tag === 'a' &&
        Boolean(((it.node as HTMLElement).innerText || it.node.textContent || '').trim()),
    );
    if (!primaryCandidate) {
      primaryCandidate = items.find((it) => it.isInteractive);
    }
    if (!primaryCandidate) {
      primaryCandidate = items[0];
    }

    // Aggregate clean structured summary (joined by " | ")
    const cardSummary = infoTexts.join(' | ').slice(0, Math.max(maxTextLength * 2, 200));

    primaryCandidate.isCard = true;
    primaryCandidate.cardRole = 'card';
    primaryCandidate.aggregatedText = cardSummary;

    const ACTION_TRIGGER_TESTID_REGEX =
      /(reply|retweet|repost|like|favorite|bookmark|share|upvote|downvote|comment|action|menu|more)/i;
    const ACTION_TRIGGER_LABEL_REGEX =
      /(reply|retweet|repost|like|favorite|bookmark|share|upvote|downvote|comment|options|回复|转发|点赞|分享|收藏|评论|投票)/i;

    function detectActionTrigger(
      node: Element,
      primaryHref?: string,
    ): { isTrigger: boolean; type?: string } {
      if (!node || !(node instanceof Element)) return { isTrigger: false };
      const tag = node.tagName.toLowerCase();
      const testId = node.getAttribute?.('data-testid') || '';
      if (ACTION_TRIGGER_TESTID_REGEX.test(testId)) {
        const m = testId.match(ACTION_TRIGGER_TESTID_REGEX);
        return { isTrigger: true, type: m ? m[0].toLowerCase() : 'action' };
      }
      const ariaLabel = node.getAttribute?.('aria-label') || '';
      if (ACTION_TRIGGER_LABEL_REGEX.test(ariaLabel)) {
        const m = ariaLabel.match(ACTION_TRIGGER_LABEL_REGEX);
        return { isTrigger: true, type: m ? m[0].toLowerCase() : 'action' };
      }
      const role = node.getAttribute?.('role') || '';
      if (tag === 'button' || role === 'button') {
        const btnText = (node.textContent || '').trim();
        if (ACTION_TRIGGER_LABEL_REGEX.test(btnText)) {
          const m = btnText.match(ACTION_TRIGGER_LABEL_REGEX);
          return { isTrigger: true, type: m ? m[0].toLowerCase() : 'button' };
        }
        return { isTrigger: true, type: 'button' };
      }
      if (tag === 'a') {
        const href = node.getAttribute?.('href') || '';
        if (
          href &&
          primaryHref &&
          href !== primaryHref &&
          !href.startsWith('#') &&
          !href.startsWith('javascript:')
        ) {
          return { isTrigger: true, type: 'link' };
        }
      }
      return { isTrigger: false };
    }

    const primaryHref = primaryCandidate.node.getAttribute?.('href') || undefined;

    // Mark other non-control items as secondary so they are omitted from tree lines,
    // while explicitly identifying and preserving action triggers (reply, retweet, like, share, etc.)
    for (const it of items) {
      if (it === primaryCandidate) continue;
      const isControl = it.node.matches?.(
        'button, [role="button"], input[type="checkbox"], input[type="radio"], [role="checkbox"]',
      );
      const trigger = detectActionTrigger(it.node, primaryHref);
      if (trigger.isTrigger) {
        (it as any).isActionTrigger = true;
        (it as any).actionTriggerType = trigger.type;
        it.isInteractive = true;
      } else if (!isControl) {
        it.isCardSecondary = true;
      }
    }

    flattenedCount++;
  }

  return flattenedCount;
}

/**
 * DOM In-Page Indexer & Pruner
 * Evaluated inside the active tab context.
 */
export function inPageDOMPruner(options?: {
  viewportThreshold?: number;
  highlight?: boolean;
  startingIndex?: number;
  frameId?: string;
  maxTextLength?: number;
  format?: 'compact' | 'html';
  viewportOnly?: boolean;
  activeViewportOnly?: boolean;
  selector?: string;
  scope?: string;
  exclude?: string | string[];
  isolateModal?: boolean;
  virtualizeViewport?: boolean;
  flattenCards?: boolean;
}): PrunedDOMTreeResult {
  const isActiveViewportOnly =
    options?.activeViewportOnly === true || (options?.activeViewportOnly as any) === 'true';
  const isViewportOnly =
    options?.viewportOnly === true || (options?.viewportOnly as any) === 'true';
  const threshold = isActiveViewportOnly
    ? 0
    : isViewportOnly
      ? 150
      : (options?.viewportThreshold ?? 1000);
  const startingIndex = options?.startingIndex ?? 1;
  const frameId = options?.frameId;

  // Robust :has-text evaluator for container scoping & exclusion
  function splitTopLevelCommas(selector: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let parenDepth = 0;

    for (let i = 0; i < selector.length; i++) {
      const ch = selector[i];
      const prev = i > 0 ? selector[i - 1] : '';

      if (ch === "'" && !inDoubleQuote && prev !== '\\') {
        inSingleQuote = !inSingleQuote;
        current += ch;
      } else if (ch === '"' && !inSingleQuote && prev !== '\\') {
        inDoubleQuote = !inDoubleQuote;
        current += ch;
      } else if (ch === '(' && !inSingleQuote && !inDoubleQuote) {
        parenDepth++;
        current += ch;
      } else if (ch === ')' && !inSingleQuote && !inDoubleQuote) {
        if (parenDepth > 0) parenDepth--;
        current += ch;
      } else if (ch === ',' && !inSingleQuote && !inDoubleQuote && parenDepth === 0) {
        if (current.trim()) parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  function extractFirstHasText(sel: string): {
    prefix: string;
    pattern: string | RegExp;
    suffix: string;
  } | null {
    const idx = sel.indexOf(':has-text(');
    if (idx === -1) return null;

    const prefix = sel.slice(0, idx).trim() || '*';
    const afterOpen = sel.slice(idx + ':has-text('.length);

    let inSingle = false;
    let inDouble = false;
    let closeIdx = -1;

    for (let i = 0; i < afterOpen.length; i++) {
      const ch = afterOpen[i];
      const prev = i > 0 ? afterOpen[i - 1] : '';
      if (ch === "'" && !inDouble && prev !== '\\') {
        inSingle = !inSingle;
      } else if (ch === '"' && !inSingle && prev !== '\\') {
        inDouble = !inDouble;
      } else if (ch === ')' && !inSingle && !inDouble) {
        closeIdx = i;
        break;
      }
    }

    if (closeIdx === -1) return null;

    const rawArg = afterOpen.slice(0, closeIdx).trim();
    const suffix = afterOpen.slice(closeIdx + 1);

    let pattern: string | RegExp = rawArg;
    const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(rawArg);
    if (regexMatch) {
      try {
        pattern = new RegExp(regexMatch[1], regexMatch[2]);
      } catch {
        pattern = rawArg;
      }
    } else if (
      (rawArg.startsWith('"') && rawArg.endsWith('"')) ||
      (rawArg.startsWith("'") && rawArg.endsWith("'"))
    ) {
      pattern = rawArg.slice(1, -1).replace(/\\(["'])/g, '$1');
    }

    return { prefix, pattern, suffix };
  }

  function elementMatchesPattern(el: Element, pattern: string | RegExp): boolean {
    const text = (el as HTMLElement).innerText || el.textContent || '';
    if (pattern instanceof RegExp) {
      return pattern.test(text);
    }
    return text.includes(pattern);
  }

  function queryHasTextSingleSelector(
    root: Element | Document,
    selector: string,
    single: boolean,
  ): Element[] {
    const parsed = extractFirstHasText(selector);
    if (!parsed) {
      try {
        return single
          ? root.querySelector(selector)
            ? [root.querySelector(selector)!]
            : []
          : Array.from(root.querySelectorAll(selector));
      } catch {
        return [];
      }
    }

    const { prefix, pattern, suffix } = parsed;
    let baseCandidates: Element[];
    try {
      baseCandidates = Array.from(root.querySelectorAll(prefix));
    } catch {
      baseCandidates = [];
    }

    const matchedPrefix = baseCandidates.filter((el) => elementMatchesPattern(el, pattern));

    const trimmedSuffix = suffix.trim();
    if (!trimmedSuffix) {
      if (single) {
        if (matchedPrefix.length === 0) return [];
        const innermost = matchedPrefix.find(
          (el) => !matchedPrefix.some((other) => other !== el && el.contains(other)),
        );
        return [innermost || matchedPrefix[0]];
      }
      return matchedPrefix;
    }

    const results: Element[] = [];
    const seen = new Set<Element>();

    for (const parent of matchedPrefix) {
      let childMatches: Element[];
      if (trimmedSuffix.startsWith(':has-text(')) {
        childMatches = queryHasTextSingleSelector(parent, '*' + trimmedSuffix, single);
      } else {
        const isCombinator = /^[>+~]/.test(trimmedSuffix);
        const childSel = isCombinator ? `:scope ${trimmedSuffix}` : trimmedSuffix;
        if (childSel.includes(':has-text(')) {
          childMatches = queryHasTextSingleSelector(parent, childSel, single);
        } else {
          try {
            childMatches = single
              ? parent.querySelector(childSel)
                ? [parent.querySelector(childSel)!]
                : []
              : Array.from(parent.querySelectorAll(childSel));
          } catch {
            childMatches = [];
          }
        }
      }

      for (const m of childMatches) {
        if (!seen.has(m)) {
          seen.add(m);
          results.push(m);
          if (single) return results;
        }
      }
    }

    return results;
  }

  function queryWithHasText(root: Element | Document, selector: string, single = false): Element[] {
    if (typeof selector !== 'string') return [];
    if (!selector.includes(':has-text(')) {
      try {
        return single
          ? root.querySelector(selector)
            ? [root.querySelector(selector)!]
            : []
          : Array.from(root.querySelectorAll(selector));
      } catch {
        return [];
      }
    }

    const parts = splitTopLevelCommas(selector);
    if (parts.length === 1) {
      return queryHasTextSingleSelector(root, parts[0], single);
    }

    const combined: Element[] = [];
    const seen = new Set<Element>();
    for (const part of parts) {
      const res = queryHasTextSingleSelector(root, part, single);
      for (const el of res) {
        if (!seen.has(el)) {
          seen.add(el);
          combined.push(el);
          if (single) return [el];
        }
      }
    }
    return combined;
  }

  function buildExcludeChecker(
    exclude?: string | string[],
  ): (el: Element, isRoot?: boolean) => boolean {
    if (!exclude) return () => false;
    const rawList = Array.isArray(exclude) ? exclude : [exclude];
    const standardSelectors: string[] = [];
    const textExcludedSet = new Set<Element>();

    for (const item of rawList) {
      if (typeof item === 'string') {
        for (const part of splitTopLevelCommas(item)) {
          const trimmed = part.trim();
          if (trimmed) {
            if (trimmed.includes(':has-text(')) {
              for (const matched of queryWithHasText(document, trimmed, false)) {
                textExcludedSet.add(matched);
              }
            } else {
              standardSelectors.push(trimmed);
            }
          }
        }
      }
    }

    if (standardSelectors.length === 0 && textExcludedSet.size === 0) return () => false;

    return (el: Element, isRoot = false) => {
      if (!el) return false;
      if (textExcludedSet.size > 0) {
        if (textExcludedSet.has(el)) return true;
        if (isRoot) {
          for (const textEl of textExcludedSet) {
            if (textEl.contains(el)) return true;
          }
        }
      }

      for (const sel of standardSelectors) {
        try {
          if (isRoot) {
            if (typeof el.closest === 'function' && el.closest(sel)) return true;
          }
          if (typeof el.matches === 'function' && el.matches(sel)) return true;
        } catch {
          try {
            if (el.matches(sel)) return true;
          } catch {}
        }
      }
      return false;
    };
  }

  const isExcluded = buildExcludeChecker(options?.exclude);
  const maxTextLength =
    typeof options?.maxTextLength === 'number' && options.maxTextLength > 0
      ? options.maxTextLength
      : 120;
  const outputFormat = options?.format === 'html' ? 'html' : 'compact';
  const winHeight = window.innerHeight;
  const winWidth = window.innerWidth;

  const droppedTags = new Set([
    'script',
    'style',
    'head',
    'meta',
    'link',
    'title',
    'noscript',
    'template',
  ]);

  const svgInternalTags = new Set([
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'use',
    'defs',
    'clippath',
    'mask',
    'pattern',
    'text',
    'tspan',
    'g',
  ]);

  const interactiveRoles = new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'tab',
    'menuitem',
    'option',
    'textbox',
    'combobox',
    'searchbox',
    'switch',
    'slider',
    'spinbutton',
  ]);

  let totalOriginalNodes = 0;
  // Number of nodes retained in the pruned tree (interactive + informational + files).
  // Previously this counter was never incremented, so elementCount was always 0 and
  // compressionRatio was always 1 — both self-contradictory next to interactiveCount.
  let prunedElementCount = 0;
  const indexedElements: IndexedElement[] = [];
  const indexMap: Record<
    number,
    { selector?: string; backendNodeId?: number; frameId?: string; tagName?: string }
  > = {};

  const isolatedMap = getIsolatedIndexMap();
  const persistentRefMap = getPersistentRefMap();
  if (startingIndex === 1) {
    isolatedMap.clear();
    getIndexFingerprintMap().clear();
  }

  let nextIndex = startingIndex;

  const PROPAGATING_ELEMENTS = new Set([
    'p',
    'span',
    'b',
    'strong',
    'i',
    'em',
    'small',
    'label',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'div',
    'li',
    'td',
    'th',
    'sub',
    'sup',
  ]);

  function isInteractive(
    el: Element,
    style: CSSStyleDeclaration,
    parentHasPointer = false,
  ): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') {
      return false;
    }
    if (
      style.pointerEvents === 'none' ||
      el.hasAttribute('inert') ||
      (el as any).inert === true ||
      el.getAttribute('aria-hidden') === 'true'
    ) {
      return false;
    }
    if (
      tag === 'button' ||
      tag === 'select' ||
      tag === 'textarea' ||
      tag === 'details' ||
      tag === 'summary' ||
      tag === 'option' ||
      tag === 'canvas'
    ) {
      return true;
    }
    if (tag === 'input' && (el as HTMLInputElement).type !== 'hidden') {
      return true;
    }
    if (tag === 'a' && (el as HTMLAnchorElement).href) {
      return true;
    }
    if (
      (el as HTMLElement).isContentEditable ||
      el.getAttribute('contenteditable') === 'true' ||
      el.getAttribute('contenteditable') === ''
    ) {
      return true;
    }
    const role = el.getAttribute('role')?.toLowerCase();
    if (role && interactiveRoles.has(role)) {
      return true;
    }
    if (
      el.hasAttribute('onclick') ||
      el.hasAttribute('oncontextmenu') ||
      el.hasAttribute('ondblclick') ||
      el.hasAttribute('draggable') ||
      el.hasAttribute('data-action') ||
      (el as HTMLElement).tabIndex >= 0 ||
      el.hasAttribute('aria-valuenow') ||
      el.hasAttribute('aria-controls') ||
      el.hasAttribute('aria-selected') ||
      el.hasAttribute('aria-checked')
    ) {
      return true;
    }
    // Task B6: Non-invasive JS dynamic event listener detection (getEventListeners)
    try {
      const g = globalThis as any;
      if (typeof g.getEventListeners === 'function') {
        const listeners = g.getEventListeners(el);
        if (listeners && (listeners.click || listeners.mousedown || listeners.pointerdown)) {
          return true;
        }
      }
    } catch {}
    const cls =
      typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : '';
    if (
      cls.includes('group/') ||
      cls.includes('hover') ||
      cls.includes('dropdown') ||
      cls.includes('menu-item') ||
      el.hasAttribute('aria-haspopup') ||
      el.hasAttribute('aria-expanded')
    ) {
      return true;
    }
    if (isInteractiveSvgNode(el, style)) {
      return true;
    }
    // Web Component icon buttons and action triggers (e.g. Reddit faceplate-tracker, faceplate-button, shreddit action rows)
    if (
      (el.hasAttribute('aria-label') || el.hasAttribute('title')) &&
      (isCustomElement(el) ||
        style.cursor === 'pointer' ||
        tag.includes('button') ||
        tag.includes('item') ||
        tag.includes('action') ||
        cls.includes('button') ||
        cls.includes('btn') ||
        cls.includes('action'))
    ) {
      return true;
    }
    // Closed shadow host check: custom elements with zero exposed shadowRoot but with interactive layout
    if (isCustomElement(el) && getShadowRoot(el) === null) {
      if (
        style.cursor === 'pointer' ||
        el.hasAttribute('aria-label') ||
        el.hasAttribute('role') ||
        (el as HTMLElement).tabIndex >= 0
      ) {
        return true;
      }
    }
    if (style.cursor && /grab|grabbing|resize|^move$|all-scroll/i.test(style.cursor)) {
      // Drag/resize targets carry grab/resize cursors instead of pointer.
      return true;
    }
    if (style.cursor === 'pointer') {
      // Browser-use enhancement: Block cursor: pointer inheritance from parent
      // on standard propagating containers to eliminate redundant fractured sub-elements
      if (parentHasPointer && PROPAGATING_ELEMENTS.has(tag)) {
        return false;
      }
      return true;
    }
    return false;
  }

  interface OcclusionResult {
    isFullyOccluded: boolean;
    isOccluded: boolean;
    occludedBy?: string;
    safeClickPoint: { x: number; y: number; offsetX: number; offsetY: number };
  }

  /**
   * 9-point grid occlusion sampling (3x3 grid at 15%, 50%, 85% width/height).
   * Determines whether an element is fully occluded, partially occluded, or clear,
   * and calculates the optimal unoccluded safe click point.
   */
  function checkOcclusionGrid(el: Element, rect: DOMRect): OcclusionResult {
    const defaultCenter = {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      offsetX: rect.width / 2,
      offsetY: rect.height / 2,
    };

    if (rect.width <= 0 || rect.height <= 0) {
      return { isFullyOccluded: false, isOccluded: false, safeClickPoint: defaultCenter };
    }
    if (rect.left < 0 || rect.top < 0 || rect.right > winWidth || rect.bottom > winHeight) {
      return { isFullyOccluded: false, isOccluded: false, safeClickPoint: defaultCenter };
    }

    const ratios = [0.15, 0.5, 0.85];
    let totalSampled = 0;
    let occludedCount = 0;
    let primaryOccluder: string | undefined = undefined;
    const clearPoints: Array<{ x: number; y: number; offsetX: number; offsetY: number }> = [];
    let centerClearPoint: { x: number; y: number; offsetX: number; offsetY: number } | null = null;

    for (const ry of ratios) {
      for (const rx of ratios) {
        const px = rect.left + rect.width * rx;
        const py = rect.top + rect.height * ry;

        if (px < 0 || py < 0 || px >= winWidth || py >= winHeight) {
          continue;
        }
        totalSampled++;

        let topEl: Element | null = null;
        try {
          if (typeof document.elementFromPoint === 'function') {
            topEl = document.elementFromPoint(px, py);
          }
        } catch {}

        // Composed / Shadow-aware deep hit check
        let deepHit: Element | null = null;
        if (el.getRootNode && el.getRootNode() !== document) {
          try {
            deepHit = hitElementAtPoint(el, px, py);
          } catch {}
        }

        if (
          deepHit &&
          (deepHit === el || composedContains(el, deepHit) || composedContains(deepHit, el))
        ) {
          const pt = {
            x: Math.round(px),
            y: Math.round(py),
            offsetX: rect.width * rx,
            offsetY: rect.height * ry,
          };
          clearPoints.push(pt);
          if (rx === 0.5 && ry === 0.5) centerClearPoint = pt;
          continue;
        }

        if (!topEl) {
          const pt = {
            x: Math.round(px),
            y: Math.round(py),
            offsetX: rect.width * rx,
            offsetY: rect.height * ry,
          };
          clearPoints.push(pt);
          if (rx === 0.5 && ry === 0.5) centerClearPoint = pt;
          continue;
        }

        if (topEl === el || composedContains(el, topEl) || composedContains(topEl, el)) {
          const pt = {
            x: Math.round(px),
            y: Math.round(py),
            offsetX: rect.width * rx,
            offsetY: rect.height * ry,
          };
          clearPoints.push(pt);
          if (rx === 0.5 && ry === 0.5) centerClearPoint = pt;
          continue;
        }

        try {
          const topStyle = window.getComputedStyle(topEl);
          if (
            topStyle.display !== 'none' &&
            topStyle.visibility !== 'hidden' &&
            parseFloat(topStyle.opacity || '1') >= 0.8
          ) {
            occludedCount++;
            if (!primaryOccluder) {
              const tag = topEl.tagName?.toLowerCase() || 'element';
              const id = topEl.id ? `#${topEl.id}` : '';
              primaryOccluder = `${tag}${id}`;
            }
            continue;
          }
        } catch {}

        const pt = {
          x: Math.round(px),
          y: Math.round(py),
          offsetX: rect.width * rx,
          offsetY: rect.height * ry,
        };
        clearPoints.push(pt);
        if (rx === 0.5 && ry === 0.5) centerClearPoint = pt;
      }
    }

    if (totalSampled > 0 && occludedCount === totalSampled) {
      return {
        isFullyOccluded: true,
        isOccluded: true,
        occludedBy: primaryOccluder,
        safeClickPoint: defaultCenter,
      };
    }

    const isPartiallyOccluded = occludedCount > 0;
    let safePoint = defaultCenter;

    if (clearPoints.length > 0) {
      // Prefer the geometric center whenever it is unoccluded. Previously a
      // partially occluded element skipped this branch and averaged every clear
      // sample, which biased the point toward whichever 15%/85% column survived.
      // On a ~40px control that is a +8..+18px drift off center — enough to land
      // on a neighbouring element. Centre-first removes that bias.
      if (centerClearPoint) {
        safePoint = defaultCenter;
      } else {
        const avgOffsetX = clearPoints.reduce((sum, p) => sum + p.offsetX, 0) / clearPoints.length;
        const avgOffsetY = clearPoints.reduce((sum, p) => sum + p.offsetY, 0) / clearPoints.length;
        const avgX = Math.round(rect.left + avgOffsetX);
        const avgY = Math.round(rect.top + avgOffsetY);

        let centroidClear = false;
        try {
          if (typeof document.elementFromPoint === 'function') {
            const topAtAvg = document.elementFromPoint(avgX, avgY);
            if (
              !topAtAvg ||
              topAtAvg === el ||
              composedContains(el, topAtAvg) ||
              composedContains(topAtAvg, el)
            ) {
              centroidClear = true;
            }
          }
        } catch {}

        if (centroidClear) {
          safePoint = { x: avgX, y: avgY, offsetX: avgOffsetX, offsetY: avgOffsetY };
        } else {
          let bestDist = Infinity;
          let bestPt = clearPoints[0];
          for (const pt of clearPoints) {
            const d = Math.hypot(pt.x - avgX, pt.y - avgY);
            if (d < bestDist) {
              bestDist = d;
              bestPt = pt;
            }
          }
          safePoint = bestPt;
        }
      }
    }

    return {
      isFullyOccluded: false,
      isOccluded: isPartiallyOccluded,
      occludedBy: isPartiallyOccluded ? primaryOccluder : undefined,
      safeClickPoint: safePoint,
    };
  }

  function checkOcclusion(el: Element, rect: DOMRect): boolean {
    return checkOcclusionGrid(el, rect).isFullyOccluded;
  }

  function isAdOrTrackingElement(el: Element): boolean {
    const tag = el.tagName?.toLowerCase() || '';
    if (tag === 'ins' && el.classList?.contains?.('adsbygoogle')) return true;
    const idAndClass = `${el.id || ''} ${(el as HTMLElement).className || ''}`.toLowerCase();
    if (
      /(^|[\s_-])(adsbygoogle|google[-_]?ads?|ad[-_]?banner|ad[-_]?wrapper|ad[-_]?container|taboola|outbrain|sponsored[-_]?post|advertisement)([\s_-]|$)/i.test(
        idAndClass,
      )
    ) {
      return true;
    }
    return false;
  }

  function isInformationalNode(el: Element): boolean {
    const tag = el.tagName?.toLowerCase() || '';
    if (/^h[1-6]$/.test(tag) || tag === 'th') return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'alert' || role === 'status' || role === 'heading') return true;
    if (el.hasAttribute('aria-live')) return true;
    // Leaf elements with concise visible text (labels, cards, badges, tiles, ritual plates)
    // are semantic informational nodes that agents need to perceive and target
    if (
      el.children.length === 0 &&
      el.textContent &&
      el.textContent.trim().length > 0 &&
      el.textContent.trim().length <= 80 &&
      !['script', 'style', 'noscript', 'meta', 'link'].includes(tag)
    ) {
      return true;
    }
    return false;
  }

  // Visual assets (img/canvas/video/CSS background images) with viewport
  // geometry, so the agent can request an individual asset by index.
  const assets: PageAsset[] = [];
  const assetRegistry: Array<{ kind: string; el: Element; src?: string }> = [];
  let assetSeq = 0;
  const pushAsset = (
    kind: PageAsset['kind'],
    el: Element,
    rect: DOMRect,
    src?: string,
    alt?: string,
  ) => {
    if (rect.width < 8 || rect.height < 8) return;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > winHeight || rect.left > winWidth) return;
    assetSeq += 1;
    assetRegistry.push({ kind, el, src });
    assets.push({
      index: assetSeq,
      kind,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      ...(src ? { src } : {}),
      ...(alt ? { alt } : {}),
    });
  };

  let virtualizedCount = 0;
  const virtualizedSummary: Array<{ selector: string; count: number }> = [];

  const shouldVirtualize =
    options?.virtualizeViewport === true ||
    (options?.virtualizeViewport !== false && !options?.selector && !options?.scope);

  function isProtectedFromVirtualization(el: Element): boolean {
    if (typeof document !== 'undefined' && document.activeElement) {
      if (el === document.activeElement || el.contains(document.activeElement)) {
        return true;
      }
    }
    const tag = (el.tagName || '').toLowerCase();
    if (
      tag === 'header' ||
      tag === 'nav' ||
      tag === 'footer' ||
      tag === 'dialog' ||
      tag === 'form' ||
      tag === 'main'
    ) {
      return true;
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (
      role === 'navigation' ||
      role === 'banner' ||
      role === 'contentinfo' ||
      role === 'search' ||
      role === 'dialog' ||
      role === 'alertdialog' ||
      role === 'menu' ||
      role === 'menubar' ||
      role === 'tablist'
    ) {
      return true;
    }
    if (
      typeof el.closest === 'function' &&
      el.closest(
        'header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], dialog',
      )
    ) {
      return true;
    }
    try {
      const s = window.getComputedStyle(el);
      if (s.position === 'fixed' || s.position === 'sticky') return true;
    } catch {}
    return false;
  }

  function getChildSignature(el: Element): string {
    const tag = (el.tagName || '').toLowerCase();
    let classSig = '';
    const rawClass =
      typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    if (rawClass.trim()) {
      const parts = rawClass
        .trim()
        .split(/\s+/)
        .filter(
          (c) =>
            !/^(active|selected|hover|focus|current|first|last|odd|even|visible|show|open|hide)$/i.test(
              c,
            ),
        )
        .slice(0, 2)
        .sort()
        .join('.');
      if (parts) classSig = '.' + parts;
    }
    const role = el.getAttribute('role');
    const rawTestId = el.getAttribute('data-testid');
    const normalizedTestId = rawTestId ? rawTestId.replace(/[-_]\d+$/, '') : null;
    const testIdPart = normalizedTestId ? `[data-testid*="${normalizedTestId}"]` : '';
    return role
      ? `${tag}${classSig}${testIdPart}[role="${role}"]`
      : `${tag}${classSig}${testIdPart}`;
  }

  function traverse(
    node: Element,
    propagatingParentRect?: DOMRect | null,
    parentHasPointer = false,
    insideShadow = false,
  ) {
    if (isExcluded(node, false)) return;

    totalOriginalNodes++;

    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'body' || tag === 'html') {
      let style: CSSStyleDeclaration | null = null;
      try {
        style = window.getComputedStyle(node);
      } catch {}
      const currentHasPointer = style?.cursor === 'pointer';
      const nextPointer = currentHasPointer || parentHasPointer;
      const children = node.children ? Array.from(node.children) : [];
      for (const child of children) {
        traverse(child, propagatingParentRect, nextPointer, insideShadow);
      }
      return;
    }

    if (droppedTags.has(tag)) return;
    if (svgInternalTags.has(tag)) {
      const insideSvg = typeof node.closest === 'function' ? Boolean(node.closest('svg')) : true;
      if (insideSvg) {
        let nodeStyle: CSSStyleDeclaration | undefined;
        try {
          nodeStyle = window.getComputedStyle(node);
        } catch {}
        if (!isInteractiveSvgNode(node, nodeStyle)) {
          return;
        }
      }
    }
    if (typeof Element !== 'undefined' && !(node instanceof Element)) return;
    if (isAdOrTrackingElement(node)) return;

    const isFile = tag === 'input' && (node as HTMLInputElement).type === 'file';
    if (!isFile && typeof (node as any).checkVisibility === 'function') {
      if (!(node as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return;
      }
    }

    if (
      node.hasAttribute('inert') ||
      (node as any).inert === true ||
      node.getAttribute('aria-hidden') === 'true'
    ) {
      return;
    }

    let style: CSSStyleDeclaration | null = null;
    try {
      style = window.getComputedStyle(node);
    } catch {}
    if (!style) {
      return;
    }
    const rect = node.getBoundingClientRect();
    const isZeroSize = rect.width <= 0 || rect.height <= 0;

    if (!isFile) {
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (parseFloat(style.opacity || '1') <= 0) return;
      if (isZeroSize) {
        if (node.children.length === 0 && !getShadowRoot(node)) return;
      } else {
        if (
          rect.top > winHeight + threshold ||
          rect.bottom < -threshold ||
          rect.left > winWidth + threshold ||
          rect.right < -threshold
        ) {
          return;
        }
      }
    }

    // Inline visual asset detection during the single traverse pass (eliminates secondary querySelectorAll thrashing)
    if (!isZeroSize) {
      if (tag === 'img') {
        const img = node as HTMLImageElement;
        pushAsset('img', img, rect, img.currentSrc || img.src || undefined, img.alt || undefined);
      } else if (tag === 'canvas' || tag === 'video') {
        pushAsset(tag as 'canvas' | 'video', node, rect);
      } else if (assets.length < 40) {
        const bg = style.backgroundImage;
        if (bg && bg !== 'none') {
          const m = /url\(["']?([^"')]+)["']?\)/.exec(bg);
          if (m) pushAsset('bg-image', node, rect, m[1]);
        }
      }
    }

    const currentHasPointer = style.cursor === 'pointer';
    const interactive = isInteractive(node, style, parentHasPointer);
    const informational = !interactive && isInformationalNode(node);

    if (propagatingParentRect && !interactive && !isFile && !informational) {
      const xOverlap = Math.max(
        0,
        Math.min(rect.right, propagatingParentRect.right) -
          Math.max(rect.left, propagatingParentRect.left),
      );
      const yOverlap = Math.max(
        0,
        Math.min(rect.bottom, propagatingParentRect.bottom) -
          Math.max(rect.top, propagatingParentRect.top),
      );
      const overlapArea = xOverlap * yOverlap;
      const childArea = rect.width * rect.height;
      if (childArea > 0 && overlapArea / childArea >= 0.99) {
        const nextPointer = currentHasPointer || parentHasPointer;
        for (const child of Array.from(node.children)) {
          traverse(child, propagatingParentRect, nextPointer, insideShadow);
        }
        const shadow = getShadowRoot(node);
        if (shadow) {
          for (const shadowChild of Array.from(shadow.children)) {
            traverse(shadowChild, propagatingParentRect, nextPointer, true);
          }
        }
        return;
      }
    }

    const hasInfoText =
      informational && Boolean(((node as HTMLElement).innerText || node.textContent || '').trim());
    const isClosedHost =
      isCustomElement(node) &&
      getShadowRoot(node) === null &&
      (interactive ||
        style.cursor === 'pointer' ||
        node.hasAttribute('aria-label') ||
        node.hasAttribute('role') ||
        (node as HTMLElement).tabIndex >= 0);

    // Task B7: 2-level form control descendant penetration
    const hasFormControlDescendant = (element: Element, maxDepth = 2): boolean => {
      if (maxDepth <= 0 || !element || !element.children) return false;
      for (const child of Array.from(element.children)) {
        const childTag = (child.tagName || '').toLowerCase();
        if (
          childTag === 'input' ||
          childTag === 'select' ||
          childTag === 'textarea' ||
          childTag === 'button'
        ) {
          return true;
        }
        if (hasFormControlDescendant(child, maxDepth - 1)) {
          return true;
        }
      }
      return false;
    };

    const isWrapperOverFormControl =
      (tag === 'label' || tag === 'span' || tag === 'div') && hasFormControlDescendant(node, 2);

    if (
      !isZeroSize &&
      !isWrapperOverFormControl &&
      (interactive || isFile || (informational && hasInfoText) || isClosedHost)
    ) {
      candidates.push({
        node,
        tag,
        rect,
        isFile,
        isInteractive: interactive || isFile || isClosedHost,
        inShadowDom: insideShadow || (isClosedHost ? true : undefined),
        isClosedShadowHost: isClosedHost ? true : undefined,
      });
    }

    // Task B4: Native <select> options static flattening into virtual entries
    if (tag === 'select' && (node as HTMLSelectElement).options) {
      const selectEl = node as HTMLSelectElement;
      for (const opt of Array.from(selectEl.options)) {
        if (opt.disabled || (opt.closest && opt.closest('optgroup[disabled]'))) {
          continue;
        }
        candidates.push({
          node: opt,
          tag: 'option',
          rect,
          isFile: false,
          isInteractive: true,
          inShadowDom: insideShadow,
          isSelectOption: true,
          parentSelect: selectEl,
          optionValue: opt.value,
          optionLabel: opt.label || opt.text || opt.value,
        });
      }
    }

    const nextPropagatingRect =
      !isZeroSize && interactive && (tag === 'button' || tag === 'a')
        ? rect
        : propagatingParentRect;
    const nextPointer = currentHasPointer || parentHasPointer;

    // Traverse standard children with Viewport Virtualization Pruning
    const rawChildren = Array.from(node.children);
    let childrenToTraverse = rawChildren;

    if (shouldVirtualize && rawChildren.length >= 4) {
      // Check if current node acts as a scroll container clipping its children
      let containerRect: DOMRect | null = null;
      try {
        const pStyle = window.getComputedStyle(node);
        const inlineStyle = (node as HTMLElement).style;
        const overflow =
          (pStyle?.overflowY || inlineStyle?.overflowY || '') +
          ' ' +
          (pStyle?.overflow || inlineStyle?.overflow || '');
        if (/(auto|scroll|hidden|clip)/i.test(overflow)) {
          containerRect = node.getBoundingClientRect();
        }
      } catch {}

      const groups = new Map<string, Element[]>();
      for (const child of rawChildren) {
        const sig = getChildSignature(child);
        let arr = groups.get(sig);
        if (!arr) {
          arr = [];
          groups.set(sig, arr);
        }
        arr.push(child);
      }

      const foldedSet = new Set<Element>();
      for (const [sig, items] of groups.entries()) {
        if (items.length >= 4) {
          const inViewportOrProtected: Element[] = [];
          const offscreenItems: Element[] = [];

          for (const item of items) {
            if (isProtectedFromVirtualization(item)) {
              inViewportOrProtected.push(item);
              continue;
            }
            const r = item.getBoundingClientRect();
            let inContainer = true;
            if (containerRect && containerRect.height > 0) {
              inContainer =
                r.bottom >= containerRect.top - 60 &&
                r.top <= containerRect.bottom + 60 &&
                r.right >= containerRect.left &&
                r.left <= containerRect.right;
            }
            const inViewport =
              inContainer &&
              r.bottom >= -60 &&
              r.top <= winHeight + 100 &&
              r.right >= 0 &&
              r.left <= winWidth;
            if (inViewport) {
              inViewportOrProtected.push(item);
            } else {
              offscreenItems.push(item);
            }
          }

          if (offscreenItems.length >= 3) {
            // Keep the first offscreen item as sample representation
            const sampleCount = Math.min(1, offscreenItems.length);
            const folded = offscreenItems.slice(sampleCount);

            for (const f of folded) {
              foldedSet.add(f);
            }

            virtualizedCount += folded.length;
            const parentTag = (node.tagName || '').toLowerCase();
            const parentId = node.id ? `#${node.id}` : '';
            const parentCls =
              typeof node.className === 'string' && node.className.trim()
                ? '.' + node.className.trim().split(/\s+/)[0]
                : '';
            const clusterSelector = `${parentTag}${parentId || parentCls} > ${sig}`;
            virtualizedSummary.push({ selector: clusterSelector, count: folded.length });

            const markerRect = offscreenItems[0].getBoundingClientRect();
            candidates.push({
              node: items[0],
              tag: 'virtual_marker',
              rect: {
                x: markerRect.x ?? markerRect.left ?? 0,
                y: markerRect.y ?? markerRect.top ?? 0,
                top: markerRect.top ?? 0,
                bottom: markerRect.bottom ?? 0,
                left: markerRect.left ?? 0,
                right: markerRect.right ?? 0,
                width: markerRect.width ?? 0,
                height: markerRect.height ?? 0,
              } as DOMRect,
              isFile: false,
              isInteractive: false,
              isVirtualMarker: true,
              virtualCount: folded.length,
              virtualSig: sig,
            } as any);
          }
        }
      }

      // Preserve strict DOM child ordering while omitting folded elements
      childrenToTraverse = rawChildren.filter((c) => !foldedSet.has(c));
    }

    for (const child of childrenToTraverse) {
      traverse(child, nextPropagatingRect, nextPointer, insideShadow);
    }

    // Traverse slotted elements if node is a slot
    if (tag === 'slot' && typeof (node as HTMLSlotElement).assignedElements === 'function') {
      try {
        const assigned = (node as HTMLSlotElement).assignedElements({ flatten: true });
        for (const assignedEl of assigned) {
          traverse(assignedEl, nextPropagatingRect, nextPointer, insideShadow);
        }
      } catch {}
    }

    // Traverse Shadow DOM children (penetration for open and closed shadow roots)
    const shadow = getShadowRoot(node);
    if (shadow) {
      for (const shadowChild of Array.from(shadow.children)) {
        traverse(shadowChild, nextPropagatingRect, nextPointer, true);
      }
    }
  }

  const candidates: Array<{
    node: Element;
    tag: string;
    rect: DOMRect;
    isFile: boolean;
    isInteractive: boolean;
    inShadowDom?: boolean;
    isClosedShadowHost?: boolean;
    isSelectOption?: boolean;
    parentSelect?: HTMLSelectElement;
    optionValue?: string;
    optionLabel?: string;
    text?: string;
  }> = [];

  let roots: Element[] = [];
  let selectorMatched = false;
  let modalIsolated = false;

  const targetSelector = options?.scope || options?.selector;
  if (targetSelector) {
    try {
      const allRoots = targetSelector.includes(':has-text(')
        ? queryWithHasText(document, targetSelector, false)
        : querySelectorAllDeep(targetSelector, document);
      selectorMatched = allRoots.length > 0;
      // Filter out nested roots so child elements are not traversed or indexed twice
      roots = allRoots.filter((r) => !allRoots.some((other) => other !== r && other.contains(r)));
    } catch {
      roots = [];
      selectorMatched = false;
    }
  } else if (options?.isolateModal !== false) {
    // Phase 2: Safe Modal Isolation & Portal/Toast Protection (Auto-detected by default)
    const activeBlocker = detectActiveModalBlocker(window);
    if (activeBlocker && activeBlocker.el) {
      modalIsolated = true;
      const modalRoots: Element[] = [activeBlocker.el];
      const WHITELIST_SELECTORS = [
        'dialog[open]',
        '[popover]:not([popover="manual"])',
        ':popover-open',
        '[data-radix-popper-content-wrapper]',
        '[data-radix-portal]',
        '[data-floating-ui-portal]',
        '[data-headlessui-portal]',
        '[data-portal]',
        '#toast-root',
        '#notification-root',
        '#portal-root',
        '.Toastify',
        '.toaster',
        '[data-sonner-toaster]',
        '.ant-select-dropdown',
        '.ant-picker-dropdown',
        '.ant-dropdown',
        '.ant-message',
        '.ant-notification',
        '.MuiMenu-root',
        '.MuiPopover-root',
        '.MuiAutocomplete-popper',
        '.MuiSnackbar-root',
        '.el-select-dropdown',
        '.el-dropdown-menu',
        '.el-notification',
      ];

      for (const sel of WHITELIST_SELECTORS) {
        try {
          const items = Array.from(document.querySelectorAll(sel));
          for (const item of items) {
            if (item instanceof HTMLElement) {
              const s = window.getComputedStyle(item);
              if (
                s.display !== 'none' &&
                s.visibility !== 'hidden' &&
                (s.opacity === '' || parseFloat(s.opacity) > 0)
              ) {
                if (!modalRoots.includes(item)) modalRoots.push(item);
              }
            }
          }
        } catch {}
      }

      // Dynamic top-level body portals check for any modern UI library
      try {
        const topPortals = Array.from(
          document.querySelectorAll('body > div, body > section, body > aside'),
        );
        for (const tp of topPortals) {
          if (tp instanceof HTMLElement) {
            const s = window.getComputedStyle(tp);
            if (
              (s.position === 'fixed' || s.position === 'absolute') &&
              parseInt(s.zIndex || '0', 10) >= 1000
            ) {
              if (
                s.display !== 'none' &&
                s.visibility !== 'hidden' &&
                (s.opacity === '' || parseFloat(s.opacity) > 0)
              ) {
                if (!modalRoots.includes(tp)) modalRoots.push(tp);
              }
            }
          }
        }
      } catch {}

      roots = modalRoots.filter(
        (r) => !modalRoots.some((other) => other !== r && other.contains(r)),
      );
      selectorMatched = true;
    } else if (document.body) {
      roots = [document.body];
      selectorMatched = true;
    }
  } else if (document.body) {
    roots = [document.body];
    selectorMatched = true;
  }

  for (const root of roots) {
    if (isExcluded(root, true)) continue;
    traverse(root, null, false, false);
  }

  // Phase 2: Deterministic visual reading-order sort (top-to-bottom, left-to-right)
  candidates.sort((a, b) => {
    const ay = a.rect?.y ?? a.rect?.top ?? 0;
    const by = b.rect?.y ?? b.rect?.top ?? 0;
    const ax = a.rect?.x ?? a.rect?.left ?? 0;
    const bx = b.rect?.x ?? b.rect?.left ?? 0;
    const dy = Math.round(ay) - Math.round(by);
    if (Math.abs(dy) > 4) {
      return dy;
    }
    return Math.round(ax) - Math.round(bx);
  });

  type TreeOutputItem = { type: 'element'; el: IndexedElement } | { type: 'marker'; line: string };
  const treeOutputItems: TreeOutputItem[] = [];

  // Phase 2: Decoupled batch hit-testing & indexing pass (eliminates layout thrashing)
  let flattenedCardCount = 0;
  if (options?.flattenCards !== false) {
    flattenedCardCount = flattenCompositeCards(candidates as any, maxTextLength);
  }

  for (const cand of candidates) {
    if ((cand as any).isCardSecondary) {
      continue;
    }

    if ((cand as any).isVirtualMarker) {
      const virtualMarkerText =
        outputFormat === 'html'
          ? `<!-- [virtualized: ${(cand as any).virtualCount} similar offscreen items in <${(cand as any).virtualSig}> folded (scroll down or use scope/selector to reveal)] -->`
          : `~ [virtualized: ${(cand as any).virtualCount} similar offscreen items in <${(cand as any).virtualSig}> folded (scroll down or use selector to reveal)]`;
      treeOutputItems.push({ type: 'marker', line: virtualMarkerText });
      continue;
    }

    const occlusion = checkOcclusionGrid(cand.node, cand.rect);
    if (occlusion.isFullyOccluded) continue;

    safeClickPointWeakMap.set(cand.node, occlusion.safeClickPoint);

    const assignedIndex = nextIndex++;
    isolatedMap.set(assignedIndex, wrapElement(cand.node));
    // Persistent ref: stable across re-renders, unlike the per-snapshot `index`.
    const persistentRef = persistentRefMap.mint(cand.node);
    const gFast = globalThis as any;
    if (gFast.__clawFast) {
      gFast.__clawFast.nodes.set(assignedIndex, cand.node);
      gFast.__clawFast.ids.set(cand.node, assignedIndex);
    }

    // Detect visual geometric shape if styled or transformed (diamond, circle, hex, triangle, square)
    let detectedShape: string | undefined = undefined;
    try {
      const targets = [
        cand.node,
        ...Array.from(cand.node.querySelectorAll('span, div, i, svg, polygon, circle, rect')),
      ];
      for (const t of targets) {
        const style = t.getAttribute('style') || '';
        if (/rotate\(\s*(45|135|225|315)deg\s*\)/i.test(style)) {
          detectedShape = 'diamond';
          break;
        }
        if (/border-radius:\s*(50%|9999px)/i.test(style)) {
          detectedShape = 'circle';
          break;
        }
        if (/clip-path:\s*polygon/i.test(style)) {
          const pts = (style.match(/%/g) || []).length;
          detectedShape = pts >= 12 ? 'hex' : 'triangle';
          break;
        }
        if (t.tagName.toLowerCase() === 'circle') {
          detectedShape = 'circle';
          break;
        }
        if (t.tagName.toLowerCase() === 'polygon') {
          detectedShape = 'polygon';
          break;
        }
      }
    } catch {}

    const attributes: Record<string, string> = {};
    const attrsToKeep = [
      'id',
      'name',
      'type',
      'placeholder',
      'aria-label',
      'role',
      'href',
      'title',
      'disabled',
      'aria-disabled',
      'contenteditable',
      'aria-checked',
      'aria-selected',
      'aria-expanded',
      'aria-pressed',
    ];
    for (const attr of attrsToKeep) {
      const val = cand.node.getAttribute(attr);
      if (val) attributes[attr] = val.slice(0, 100);
    }
    if (typeof cand.node.getAttributeNames === 'function') {
      for (const attr of cand.node.getAttributeNames()) {
        if (attr.startsWith('data-') && !attributes[attr]) {
          const val = cand.node.getAttribute(attr);
          if (val) attributes[attr] = val.slice(0, 100);
        }
      }
    }
    if (cand.isFile) {
      attributes['type'] = 'file';
    }
    if (detectedShape) {
      attributes['visual-shape'] = detectedShape;
    }

    // Task B1: Compute scopeHash for Local Scope Guard
    let scopeHash = '';
    try {
      const container =
        (cand.node as Element).closest?.(
          'form,dialog,[role="dialog"],article,li,tr,[role="row"]',
        ) || cand.node.parentElement;
      const scopeText = container ? (container.textContent || '').trim().slice(0, 1000) : '';
      if (scopeText) {
        scopeHash = computeScopeHash(scopeText);
        attributes['data-scope-hash'] = scopeHash;
      }
    } catch {}

    // Task B4: Select option attributes
    if (cand.isSelectOption) {
      if (cand.optionValue !== undefined) {
        attributes['value'] = cand.optionValue;
      }
      attributes['selected'] = (cand.node as HTMLOptionElement).selected ? 'true' : 'false';
    }

    const candText =
      cand.text ||
      (cand.node ? (cand.node.textContent || '').trim().slice(0, 100) : undefined) ||
      undefined;
    getIndexFingerprintMap().set(assignedIndex, {
      tag: cand.tag,
      id: attributes.id,
      name: attributes.name,
      type: attributes.type,
      placeholder: attributes.placeholder,
      testId: attributes['data-testid'],
      ariaLabel: attributes['aria-label'],
      role: attributes.role,
      text: candText,
      inShadowDom: cand.inShadowDom,
      scopeHash: scopeHash || undefined,
    });
    if (
      (cand.node as HTMLElement).isContentEditable ||
      cand.node.getAttribute('contenteditable') === 'true' ||
      cand.node.getAttribute('contenteditable') === ''
    ) {
      attributes['contenteditable'] = 'true';
    }
    if (
      (cand.node as any).disabled ||
      cand.node.hasAttribute('disabled') ||
      cand.node.getAttribute('aria-disabled') === 'true'
    ) {
      attributes['disabled'] = 'true';
    }

    // Expose live toggle state. React controlled inputs update the IDL property
    // (`el.checked`) without touching the content attribute, so the attribute
    // layer alone cannot tell a checked box from an unchecked one — agents had
    // to fall back to screenshots to verify form state.
    try {
      const node = cand.node as HTMLInputElement;
      const inputType = (attributes.type || node.getAttribute('type') || '').toLowerCase();
      if (cand.tag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) {
        attributes['checked'] = node.checked ? 'true' : 'false';
      }
      if (cand.tag === 'option') {
        attributes['selected'] = (node as unknown as HTMLOptionElement).selected ? 'true' : 'false';
      }
    } catch {}

    // Scrollable container hint (P1-7)
    try {
      if (
        cand.node.scrollHeight > cand.node.clientHeight + 2 &&
        /(auto|scroll)/.test(window.getComputedStyle(cand.node).overflowY)
      ) {
        attributes['scrollable'] = 'true';
      }
    } catch {}

    // Form validation state. Agents previously had to submit a form and watch
    // for a re-render to learn whether a field was valid, and React/Angular
    // validators set aria-invalid without ever setting the DOM validity flags.
    // Report both: the native constraint state and the ARIA hint.
    try {
      const el = cand.node as HTMLInputElement;
      const supportsValidity =
        cand.tag === 'input' || cand.tag === 'textarea' || cand.tag === 'select';
      if (supportsValidity && el.validity) {
        if (el.validity.valid === false) attributes['invalid'] = 'true';
        if (el.validity.valid === true) attributes['valid'] = 'true';
        if (el.validity.valueMissing) attributes['invalidReason'] = 'valueMissing';
        else if (el.validity.typeMismatch) attributes['invalidReason'] = 'typeMismatch';
        else if (el.validity.patternMismatch) attributes['invalidReason'] = 'patternMismatch';
        else if (el.validity.tooShort) attributes['invalidReason'] = 'tooShort';
        else if (el.validity.tooLong) attributes['invalidReason'] = 'tooLong';
        else if (el.validity.rangeUnderflow) attributes['invalidReason'] = 'rangeUnderflow';
        else if (el.validity.rangeOverflow) attributes['invalidReason'] = 'rangeOverflow';
        else if (el.validity.stepMismatch) attributes['invalidReason'] = 'stepMismatch';
        else if (el.validity.badInput) attributes['invalidReason'] = 'badInput';
        else if (el.validity.customError) attributes['invalidReason'] = 'customError';
        if (el.validationMessage) {
          attributes['validationMessage'] = String(el.validationMessage).slice(0, 120);
        }
      }
      // Framework validators commonly only flip aria-invalid.
      if (cand.node.getAttribute('aria-invalid') === 'true') attributes['invalid'] = 'true';
      if (
        cand.node.hasAttribute('required') ||
        cand.node.getAttribute('aria-required') === 'true'
      ) {
        attributes['required'] = 'true';
      }
      // Constraint hints so an agent can satisfy the field without guessing.
      for (const attr of ['pattern', 'min', 'max', 'minlength', 'maxlength', 'step']) {
        if (attributes[attr]) continue;
        const val = cand.node.getAttribute(attr);
        if (val) attributes[attr] = val.slice(0, 100);
      }
    } catch {}

    // Dialog / modal status (P1-7)
    try {
      if (cand.node.closest('dialog, [role="dialog"], [role="alertdialog"], .modal')) {
        attributes['dialog'] = 'true';
      }
    } catch {}

    // Form value extraction with sensitive field masking (P1-7)
    let elemValue: string | undefined = undefined;
    if (cand.tag === 'input' || cand.tag === 'textarea' || cand.tag === 'select') {
      try {
        const rawVal = (cand.node as any).value;
        if (typeof rawVal === 'string' && rawVal.length > 0) {
          const type = (attributes.type || cand.node.getAttribute('type') || '').toLowerCase();
          const name = (attributes.name || cand.node.getAttribute('name') || '').toLowerCase();
          const id = (attributes.id || cand.node.getAttribute('id') || '').toLowerCase();
          const autocomplete = (cand.node.getAttribute('autocomplete') || '').toLowerCase();
          const ariaLabel = (
            attributes['aria-label'] ||
            cand.node.getAttribute('aria-label') ||
            ''
          ).toLowerCase();
          const isSensitive =
            type === 'password' ||
            /(password|passcode|secret|cc-|credit-card|cvv|cvc|card-number|one-time-code|otp|token)/i.test(
              `${name} ${id} ${autocomplete} ${ariaLabel}`,
            );

          if (isSensitive) {
            elemValue = '••••••••';
          } else {
            elemValue = rawVal.slice(0, 200);
          }
        }
      } catch {}
    }

    const isCard = (cand as any).isCard === true;
    let text = isCard
      ? (cand as any).aggregatedText
      : extractCleanElementText(cand.node, maxTextLength);
    const editorSemantics = detectEditorSemantics(cand.node);
    let role = isCard ? 'card' : cand.node.getAttribute('role') || undefined;

    // Task B4: Virtual select option text and role
    if (cand.isSelectOption) {
      const parentName =
        cand.parentSelect?.getAttribute('name') ||
        cand.parentSelect?.getAttribute('aria-label') ||
        cand.parentSelect?.getAttribute('id') ||
        'select';
      const optText =
        cand.optionLabel || (cand.node as HTMLOptionElement).text || cand.optionValue || '';
      text = `${parentName} → ${optText}`;
      role = 'option';
      if (!elemValue && cand.optionValue !== undefined) {
        elemValue = cand.optionValue;
      }
    }

    const indexedElem: IndexedElement = {
      index: assignedIndex,
      tagName: cand.tag,
      role: role,
      text: text || undefined,
      value: elemValue,
      attributes,
      rect: {
        x: Math.round(cand.rect.x),
        y: Math.round(cand.rect.y),
        width: Math.round(cand.rect.width),
        height: Math.round(cand.rect.height),
      },
      isInteractive: cand.isInteractive,
      isOccluded: occlusion.isOccluded,
      occludedBy: occlusion.occludedBy,
      inShadowDom: cand.inShadowDom,
      safeClickPoint: {
        x: occlusion.safeClickPoint.x,
        y: occlusion.safeClickPoint.y,
      },
      isComposer: editorSemantics.isComposer || undefined,
      isEditor: editorSemantics.isEditor || undefined,
      isSearch: editorSemantics.isSearch || undefined,
      isClosedShadowHost: cand.isClosedShadowHost || undefined,
      isActionTrigger: (cand as any).isActionTrigger || undefined,
      actionTriggerType: (cand as any).actionTriggerType || undefined,
    };

    (indexedElem as unknown as { ref?: string }).ref = persistentRef;
    indexedElements.push(indexedElem);
    treeOutputItems.push({ type: 'element', el: indexedElem });
    prunedElementCount++;
    indexMap[assignedIndex] = {
      selector: attributes.id ? `#${attributes.id}` : `${cand.tag}`,
      frameId,
      tagName: cand.tag,
    };
  }

  // Calculate scroll guidance (pages_up / pages_down)
  const scrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
  const totalHeight = Math.max(
    document.body?.scrollHeight || 0,
    document.documentElement?.scrollHeight || 0,
    document.body?.offsetHeight || 0,
    document.documentElement?.offsetHeight || 0,
    viewportHeight,
  );
  const pixelsAbove = Math.max(0, scrollY);
  const pixelsBelow = Math.max(0, totalHeight - (scrollY + viewportHeight));

  const pages_up = Number((pixelsAbove / viewportHeight).toFixed(1));
  const pages_down = Number((pixelsBelow / viewportHeight).toFixed(1));

  const scrollInfo = {
    pages_up,
    pages_down,
    scroll_y: Math.round(scrollY),
    total_height: Math.round(totalHeight),
    viewport_height: Math.round(viewportHeight),
  };

  const compressionRatio =
    totalOriginalNodes > 0
      ? Number(((totalOriginalNodes - prunedElementCount) / totalOriginalNodes).toFixed(4))
      : 0;

  const treeLines = treeOutputItems.map((item) => {
    if (item.type === 'marker') {
      return item.line;
    }
    const el = item.el;
    if (outputFormat === 'html') {
      const attrStr = Object.entries(el.attributes)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      const valPart = el.value ? ` value="${el.value}"` : '';
      const textPart = el.text ? ` "${el.text}"` : '';
      const occludedPart = el.isOccluded
        ? ` [occluded: partially by ${el.occludedBy || 'overlay'}]`
        : '';
      const shadowPart = el.isClosedShadowHost
        ? ' [closed-shadow-host]'
        : el.inShadowDom
          ? ' [shadow]'
          : '';
      return `[${el.index}]${shadowPart} <${el.tagName}${attrStr ? ' ' + attrStr : ''}${valPart}>${textPart}</${el.tagName}>${occludedPart}`;
    }
    return renderCompactElementLine(el);
  });

  let treeString = treeLines.join('\n');

  let activeModal: string | undefined = undefined;
  let focusTrapped = false;
  let isConfirmationTrap = false;
  let blockingLayerKind: 'modal' | 'mask' | undefined = undefined;

  try {
    const topBlocker = detectActiveModalBlocker(window);
    if (topBlocker) {
      focusTrapped = true;
      blockingLayerKind = topBlocker.kind;
      activeModal = topBlocker.name;
      if (topBlocker.isTrap) {
        isConfirmationTrap = true;
      }
    }
  } catch {}

  try {
    if (!activeModal) {
      const dialogs = Array.from(
        document.querySelectorAll(
          'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]',
        ),
      ) as HTMLElement[];
      for (const d of dialogs) {
        const isAriaHidden = d.getAttribute('aria-hidden') === 'true';
        const isOpenAttr =
          d.tagName.toLowerCase() === 'dialog' ? (d as HTMLDialogElement).open : true;
        if (!isAriaHidden && isOpenAttr) {
          let isVis = false;
          try {
            const style = window.getComputedStyle(d);
            isVis = style.display !== 'none' && style.visibility !== 'hidden' && d.offsetWidth > 0;
          } catch {}
          if (isVis) {
            focusTrapped = true;
            const tag = d.tagName.toLowerCase();
            const id = d.id ? `#${d.id}` : '';
            const name =
              d.getAttribute('aria-label') ||
              d.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim()?.slice(0, 40);
            const textSnippet = `${tag}${id} ${name || ''} ${d.textContent?.slice(0, 300) || ''}`;
            const isDiscardOrConfirm =
              /(discard|abandon|unsaved|confirm|放弃|取消|未保存|确认放弃|是否放弃|离开)/i.test(
                textSnippet,
              );
            const baseDesc = name ? `${tag}${id} "${name}"` : `${tag}${id || '.modal'}`;
            if (isDiscardOrConfirm) {
              isConfirmationTrap = true;
              activeModal = `${baseDesc} [CONFIRMATION_TRAP]`;
            } else {
              activeModal = baseDesc;
            }
            break;
          }
        }
      }
    }
  } catch {}

  if (activeModal) {
    const modalNotice = isConfirmationTrap
      ? `[Modal Guidance: CRITICAL CONFIRMATION TRAP DETECTED (${activeModal}). A secondary confirmation dialog is open ("Discard / Confirm" / "放弃帖子？"). You MUST dismiss or confirm this dialog (e.g. click "Discard" or "Cancel") before attempting any other actions on the page.]\n`
      : `[Modal Guidance: Active modal focus trap (${activeModal}). Prioritize interacting with modal elements or dismissing it.]\n`;
    treeString = modalNotice + treeString;
  }

  if (modalIsolated) {
    const isolateNotice = `[MODAL_ACTIVE: Focus locked to active modal "${activeModal || 'dialog'}". Background page elements pruned to prevent misclicks. Dismiss modal or submit to return to main page.]\n`;
    treeString = isolateNotice + treeString;
  }

  if (pages_down > 0 || pages_up > 0) {
    treeString =
      `[Scroll Guidance: ${pages_up} pages above, ${pages_down} pages below. Use ${resolveToolName('interact_index')} / scroll to reveal more content.]\n` +
      treeString;
  }

  // Handle visual Set-of-Mark badges if highlight is enabled
  if (options?.highlight) {
    inPageRenderHighlights(indexedElements);
  }

  (globalThis as any)[Symbol.for('__browser_use_page_assets__')] = assetRegistry;

  return {
    treeString,
    elementCount: prunedElementCount,
    // Informational nodes (h1-h6, th, role=alert/status/heading, aria-live) are
    // indexed with isInteractive:false, so counting every indexed element here
    // made interactiveCount identical to elementCount and told the agent nothing.
    interactiveCount: indexedElements.filter((el) => el.isInteractive).length,
    compressionRatio,
    indexMap,
    indexedElements,
    assets,
    pages_up,
    pages_down,
    scrollInfo,
    activeModal,
    focusTrapped: focusTrapped || undefined,
    isConfirmationTrap: isConfirmationTrap || undefined,
    selectorMatched:
      options?.selector !== undefined || options?.scope !== undefined ? selectorMatched : undefined,
    modalIsolated: modalIsolated || undefined,
    virtualizedCount: virtualizedCount > 0 ? virtualizedCount : undefined,
    virtualizedSummary: virtualizedSummary.length > 0 ? virtualizedSummary : undefined,
    flattenedCardCount: flattenedCardCount > 0 ? flattenedCardCount : undefined,
  };
}

export function actionPointForElement(
  target: Element,
  view: Window = window,
): { x: number; y: number } | null {
  const rects = Array.from(target.getClientRects?.() || []).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  if (rects.length === 0) {
    const rect = target.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    rects.push(rect);
  }

  const vw = typeof view?.innerWidth === 'number' && view.innerWidth > 0 ? view.innerWidth : 1280;
  const vh = typeof view?.innerHeight === 'number' && view.innerHeight > 0 ? view.innerHeight : 800;
  const margins = getStickyOcclusionMargins(view);
  const safeTop = margins.top > 0 ? margins.top : 0;
  const safeBottom = margins.bottom > 0 ? vh - margins.bottom : vh;

  let best = null;
  for (const rect of rects) {
    const left = Math.max(0, rect.left);
    const top = Math.max(safeTop, rect.top);
    const right = Math.min(vw, rect.right);
    const bottom = Math.min(safeBottom, rect.bottom);
    const visibleArea = Math.max(0, right - left) * Math.max(0, bottom - top);

    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    const distanceX = centerX - Math.max(0, Math.min(vw, centerX));
    const distanceY = centerY - Math.max(safeTop, Math.min(safeBottom, centerY));
    const viewportDistance = distanceX * distanceX + distanceY * distanceY;

    if (
      !best ||
      visibleArea > best.visibleArea ||
      (visibleArea === best.visibleArea && viewportDistance < best.viewportDistance)
    ) {
      best = { rect, left, top, right, bottom, visibleArea, viewportDistance };
    }
  }

  if (best && best.visibleArea > 0) {
    return {
      x: (best.left + best.right) / 2,
      y: (best.top + best.bottom) / 2,
    };
  }

  if (best) {
    const safeY = Math.min(
      Math.max(best.rect.top + 5, safeTop + 10),
      Math.max(safeTop + 10, Math.min(best.rect.bottom - 5, safeBottom - 10)),
    );
    return {
      x: (best.rect.left + best.rect.right) / 2,
      y: safeY,
    };
  }
  return null;
}

export function scrollRequestForPoint(
  target: Element,
  x: number,
  y: number,
): { x: number; y: number; deltaX: number; deltaY: number } | null {
  const view = target.ownerDocument?.defaultView || window;
  const vw = typeof view?.innerWidth === 'number' && view.innerWidth > 0 ? view.innerWidth : 1280;
  const vh = typeof view?.innerHeight === 'number' && view.innerHeight > 0 ? view.innerHeight : 800;

  let ancestor = composedParent(target);
  while (ancestor) {
    if (
      ancestor !== target.ownerDocument?.body &&
      ancestor !== target.ownerDocument?.documentElement
    ) {
      const style =
        typeof view.getComputedStyle === 'function' ? view.getComputedStyle(ancestor) : null;
      if (style) {
        const canScrollX =
          /^(auto|scroll|overlay)$/.test(style.overflowX) &&
          ancestor.scrollWidth > ancestor.clientWidth + 1;
        const canScrollY =
          /^(auto|scroll|overlay)$/.test(style.overflowY) &&
          ancestor.scrollHeight > ancestor.clientHeight + 1;

        if (canScrollX || canScrollY) {
          const rect = ancestor.getBoundingClientRect();
          const area = {
            left: Math.max(0, rect.left),
            top: Math.max(0, rect.top),
            right: Math.min(vw, rect.right),
            bottom: Math.min(vh, rect.bottom),
          };

          if (area.right > area.left && area.bottom > area.top) {
            let deltaX =
              canScrollX && (x < area.left || x >= area.right)
                ? x - (area.left + area.right) / 2
                : 0;
            let deltaY =
              canScrollY && (y < area.top || y >= area.bottom)
                ? y - (area.top + area.bottom) / 2
                : 0;

            if (
              (deltaX < 0 && ancestor.scrollLeft <= 0) ||
              (deltaX > 0 && ancestor.scrollLeft >= ancestor.scrollWidth - ancestor.clientWidth - 1)
            )
              deltaX = 0;
            if (
              (deltaY < 0 && ancestor.scrollTop <= 0) ||
              (deltaY > 0 &&
                ancestor.scrollTop >= ancestor.scrollHeight - ancestor.clientHeight - 1)
            )
              deltaY = 0;

            if (deltaX || deltaY) {
              return {
                x: (area.left + area.right) / 2,
                y: (area.top + area.bottom) / 2,
                deltaX,
                deltaY,
              };
            }
          }
        }
      }
    }
    ancestor = composedParent(ancestor);
  }

  if (x >= 0 && y >= 0 && x < vw && y < vh) return null;

  return {
    x: Math.max(0, Math.min(vw - 1, x)),
    y: Math.max(0, Math.min(vh - 1, y)),
    deltaX: x - vw / 2,
    deltaY: y - vh / 2,
  };
}

export function extractElementLocationDetails(el: Element): {
  success: boolean;
  index?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  tagName: string;
  inputType?: string;
  text?: string;
  value?: string;
  role?: string;
  isClickable?: boolean;
  frameOffsetX: number;
  frameOffsetY: number;
  attributes?: Record<string, string>;
  isComposer?: boolean;
  isEditor?: boolean;
  isSearch?: boolean;
  disabled?: boolean;
  ariaDisabled?: boolean;
  validity?: { valid: boolean };
  invalidReason?: string;
  checked?: boolean;
  selected?: boolean;
  scopeHash?: string;
} {
  const win = el.ownerDocument?.defaultView || window;
  const initialRect = el.getBoundingClientRect();
  const vh = win.innerHeight || 0;
  const vw = win.innerWidth || 0;
  const margins = getStickyOcclusionMargins(win);
  const elStyle = typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
  const scrollMarginTop = parseFloat(elStyle?.scrollMarginTop || '0') || 0;
  const scrollMarginBottom = parseFloat(elStyle?.scrollMarginBottom || '0') || 0;
  const safeTop = Math.min(Math.max(margins.top, scrollMarginTop, 80), Math.round(vh * 0.35));
  const safeBottom = Math.min(
    Math.max(margins.bottom, scrollMarginBottom, 80),
    Math.round(vh * 0.35),
  );
  const minSafeTop = safeTop;
  const maxSafeBottom = Math.max(minSafeTop, vh - safeBottom);

  const inViewport =
    vh > 0 &&
    vw > 0 &&
    initialRect.top >= minSafeTop &&
    initialRect.bottom <= maxSafeBottom &&
    initialRect.left >= 0 &&
    initialRect.right <= vw &&
    initialRect.width > 0 &&
    initialRect.height > 0;

  if (!inViewport) {
    // Try local scroll first
    const point = actionPointForElement(el, win);
    if (point) {
      const scrollReq = scrollRequestForPoint(el, point.x, point.y);
      if (scrollReq && (scrollReq.deltaX || scrollReq.deltaY)) {
        let ancestor = composedParent(el);
        let scrolled = false;
        while (ancestor && !scrolled) {
          if (ancestor !== el.ownerDocument.body && ancestor !== el.ownerDocument.documentElement) {
            const style = win.getComputedStyle(ancestor);
            const canScrollX =
              /^(auto|scroll|overlay)$/.test(style.overflowX) &&
              ancestor.scrollWidth > ancestor.clientWidth + 1;
            const canScrollY =
              /^(auto|scroll|overlay)$/.test(style.overflowY) &&
              ancestor.scrollHeight > ancestor.clientHeight + 1;
            if (canScrollX || canScrollY) {
              ancestor.scrollBy({
                left: scrollReq.deltaX,
                top: scrollReq.deltaY,
                behavior: 'instant' as any,
              });
              scrolled = true;
            }
          }
          ancestor = composedParent(ancestor);
        }
        if (!scrolled) {
          try {
            if (typeof (el as any).scrollIntoView === 'function') {
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
            }
          } catch {}
        }
      } else {
        try {
          if (typeof (el as any).scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
          }
        } catch {}
      }
    } else {
      try {
        if (typeof (el as any).scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
        }
      } catch {}
    }

    // Secondary safety check: if element ended up occluded by a sticky top header or bottom bar, nudge scroll
    try {
      const isJsdom =
        typeof win.navigator !== 'undefined' &&
        typeof win.navigator.userAgent === 'string' &&
        win.navigator.userAgent.includes('jsdom');
      const updatedR = el.getBoundingClientRect();
      if (!isJsdom && updatedR.top < safeTop + 10) {
        const delta = updatedR.top - safeTop - 20;
        win.scrollBy?.({ top: delta, behavior: 'instant' as any });
        let anc = composedParent(el);
        while (anc && anc !== win.document.body && anc !== win.document.documentElement) {
          anc.scrollBy?.({ top: delta, behavior: 'instant' as any });
          anc = composedParent(anc);
        }
      } else if (!isJsdom && updatedR.bottom > vh - safeBottom - 10) {
        const delta = updatedR.bottom - (vh - safeBottom) + 20;
        win.scrollBy?.({ top: delta, behavior: 'instant' as any });
        let anc = composedParent(el);
        while (anc && anc !== win.document.body && anc !== win.document.documentElement) {
          anc.scrollBy?.({ top: delta, behavior: 'instant' as any });
          anc = composedParent(anc);
        }
      }
    } catch {}
  }

  const rect = el.getBoundingClientRect();
  const text = extractCleanElementText(el).slice(0, 100);

  // Calculate cumulative viewport offset if inside an iframe (with border and zoom compensation)
  let frameOffsetX = 0;
  let frameOffsetY = 0;
  try {
    let curWin: Window = window;
    while (curWin !== curWin.top) {
      if (curWin.frameElement) {
        const fEl = curWin.frameElement;
        const fRect = fEl.getBoundingClientRect();
        const parentWin = curWin.parent || fEl.ownerDocument?.defaultView || window;
        const fStyle =
          typeof parentWin.getComputedStyle === 'function'
            ? parentWin.getComputedStyle(fEl)
            : undefined;
        const borderLeft = parseFloat(fStyle?.borderLeftWidth || '0') || 0;
        const borderTop = parseFloat(fStyle?.borderTopWidth || '0') || 0;
        const zoom = parseFloat((fStyle as any)?.zoom || '1') || 1;

        frameOffsetX += (fRect.left + borderLeft) / zoom;
        frameOffsetY += (fRect.top + borderTop) / zoom;
        curWin = curWin.parent;
      } else {
        break;
      }
    }
  } catch {
    // Cross-origin boundary fallback
  }

  const safePoint = safeClickPointWeakMap.get(el);
  let clickX, clickY;
  if (safePoint) {
    clickX = rect.left + safePoint.offsetX;
    clickY = rect.top + safePoint.offsetY;
  } else {
    const bestPoint = actionPointForElement(el, win);
    if (bestPoint) {
      clickX = bestPoint.x;
      clickY = bestPoint.y;
    } else {
      clickX = rect.left + rect.width / 2;
      clickY = rect.top + rect.height / 2;
    }
  }

  const semantics = detectEditorSemantics(el);

  const disabled = Boolean(
    (el as any).disabled === true ||
    (typeof (el as any).hasAttribute === 'function' && el.hasAttribute('disabled')),
  );
  const ariaDisabled =
    typeof (el as any).getAttribute === 'function' && el.getAttribute('aria-disabled') === 'true';
  const isAriaInvalid =
    typeof (el as any).getAttribute === 'function' && el.getAttribute('aria-invalid') === 'true';
  const valObj =
    typeof (el as any).validity === 'object' && (el as any).validity !== null
      ? (el as any).validity
      : undefined;
  const validity = valObj
    ? { valid: isAriaInvalid ? false : Boolean(valObj.valid) }
    : isAriaInvalid
      ? { valid: false }
      : undefined;
  const invalidReason =
    typeof (el as any).validationMessage === 'string' && (el as any).validationMessage
      ? (el as any).validationMessage
      : isAriaInvalid
        ? 'aria-invalid'
        : undefined;
  const checked =
    typeof (el as any).checked === 'boolean'
      ? (el as any).checked
      : typeof (el as any).getAttribute === 'function' && el.getAttribute('aria-checked') === 'true'
        ? true
        : typeof (el as any).getAttribute === 'function' &&
            el.getAttribute('aria-checked') === 'false'
          ? false
          : undefined;
  const selected =
    typeof (el as any).selected === 'boolean'
      ? (el as any).selected
      : typeof (el as any).getAttribute === 'function' &&
          el.getAttribute('aria-selected') === 'true'
        ? true
        : typeof (el as any).getAttribute === 'function' &&
            el.getAttribute('aria-selected') === 'false'
          ? false
          : undefined;

  let matchedIndex: number | undefined;
  try {
    const isolatedMap = getIsolatedIndexMap();
    // Pass 1: exact element match
    for (const [idx, entry] of isolatedMap.entries()) {
      const target = derefElement(entry);
      if (target === el) {
        matchedIndex = idx;
        break;
      }
    }
    // Pass 2: interactive wrapper match (e.g. inner icon/span of button/link)
    if (matchedIndex === undefined) {
      const interactiveEl =
        typeof el.closest === 'function'
          ? el.closest('button, a, input, select, textarea, [role="button"]')
          : null;
      if (interactiveEl && interactiveEl !== el) {
        for (const [idx, entry] of isolatedMap.entries()) {
          const target = derefElement(entry);
          if (target === interactiveEl) {
            matchedIndex = idx;
            break;
          }
        }
      }
    }
    // Pass 3: allocate new index if still unindexed
    if (matchedIndex === undefined) {
      const maxIdx = isolatedMap.size > 0 ? Math.max(...isolatedMap.keys()) : 0;
      matchedIndex = maxIdx + 1;
      isolatedMap.set(matchedIndex, wrapElement(el));
    }
  } catch {}

  const elTag = el.tagName.toLowerCase();
  const elRole =
    typeof el.getAttribute === 'function'
      ? el.getAttribute('role')?.toLowerCase() || undefined
      : undefined;
  const isClickable = Boolean(
    elTag === 'button' ||
    elTag === 'a' ||
    elRole === 'button' ||
    (el as HTMLInputElement).type === 'submit' ||
    (el as HTMLInputElement).type === 'button' ||
    typeof (el as any).onclick === 'function' ||
    (typeof window !== 'undefined' &&
      window.getComputedStyle &&
      window.getComputedStyle(el).cursor === 'pointer'),
  );

  return {
    success: true,
    ...(typeof matchedIndex === 'number' ? { index: matchedIndex } : {}),
    x: Math.round(clickX + frameOffsetX),
    y: Math.round(clickY + frameOffsetY),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    tagName: elTag,
    inputType:
      typeof (el as HTMLInputElement).type === 'string'
        ? (el as HTMLInputElement).type.toLowerCase()
        : undefined,
    text,
    value:
      typeof (globalThis as any).HTMLInputElement !== 'undefined' &&
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        ? String((el as any).value ?? '')
        : typeof (el as any)?.value === 'string'
          ? (el as any).value
          : undefined,
    role: elRole,
    isClickable,
    frameOffsetX,
    frameOffsetY,
    attributes:
      typeof (el as any).attributes !== 'undefined'
        ? Object.fromEntries(
            Array.from((el as Element).attributes || []).map((a) => [a.name, a.value]),
          )
        : undefined,
    isComposer: semantics.isComposer || undefined,
    isEditor: semantics.isEditor || undefined,
    isSearch: semantics.isSearch || undefined,
    disabled,
    ariaDisabled,
    validity,
    invalidReason,
    checked,
    selected,
    scopeHash: (() => {
      try {
        const container =
          el.closest?.('form,dialog,[role="dialog"],article,li,tr,[role="row"]') ||
          el.parentElement;
        const scopeText = container ? (container.textContent || '').trim().slice(0, 1000) : '';
        return scopeText ? computeScopeHash(scopeText) : undefined;
      } catch {
        return undefined;
      }
    })(),
  };
}

/**
 * Retrieve element coordinates and info for native CDP interaction.
 * Supports numeric 1-based index or string ref (e.g. "1" or "ref_1").
 */
export function inPageGetElementCoordinates(refOrIndex: number | string): {
  success: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  tagName?: string;
  inputType?: string;
  text?: string;
  value?: string;
  frameOffsetX?: number;
  frameOffsetY?: number;
  attributes?: Record<string, string>;
  isComposer?: boolean;
  isEditor?: boolean;
  isSearch?: boolean;
  disabled?: boolean;
  ariaDisabled?: boolean;
  validity?: { valid: boolean };
  invalidReason?: string;
  checked?: boolean;
  selected?: boolean;
  scopeHash?: string;
  warning?: string;
  isSelectOption?: boolean;
  error?: string;
} {
  let index: number;
  if (typeof refOrIndex === 'string') {
    const parsed = refOrIndex.startsWith('ref_')
      ? parseInt(refOrIndex.slice(4), 10)
      : parseInt(refOrIndex, 10);
    if (isNaN(parsed)) {
      return { success: false, error: `Invalid index or ref format: ${refOrIndex}` };
    }
    index = parsed;
  } else {
    index = refOrIndex;
  }

  if (index <= 0) {
    return {
      success: false,
      error: `Index must be a positive 1-based integer. Received: ${index}`,
    };
  }

  const rawEntry = getIsolatedIndexMap().get(index);
  const rawEl = derefElement(rawEntry);
  const fp = getIndexFingerprintMap().get(index);

  let warning: string | undefined;
  let hadDrift = false;

  if (rawEl && fp) {
    const isConnected = (rawEl as any).isConnected ?? true;
    const currentTag = rawEl.tagName?.toLowerCase();
    const currentRole =
      rawEl.getAttribute?.('role')?.toLowerCase() || (rawEl as any).role?.toLowerCase();
    const currentText = (rawEl.textContent || '').trim().slice(0, 100);
    const tagMismatch = Boolean(fp.tag && currentTag !== fp.tag.toLowerCase());
    const roleMismatch = Boolean(fp.role && currentRole && currentRole !== fp.role.toLowerCase());
    const textMismatch = Boolean(
      fp.text && currentText && !currentText.includes(fp.text) && !fp.text.includes(currentText),
    );
    if (!isConnected || tagMismatch || roleMismatch || textMismatch) {
      hadDrift = true;
    }
  } else if (!rawEl && fp) {
    hadDrift = true;
  }

  let el = findIndexedElement(index);

  // Task B12: Multi-attribute index drift verification and in-place self-healing (Tag, Role, Text)
  if (hadDrift && fp) {
    if (!el || el === rawEl) {
      const recovered = selfHealFindElement(fp);
      if (recovered) {
        el = recovered;
        getIsolatedIndexMap().set(index, wrapElement(recovered));
      }
    }
    if (el && el !== rawEl) {
      warning = `Element index drift detected for index [${index}]; auto-healed target using element fingerprint (${fp.tag}${fp.id ? '#' + fp.id : ''}${fp.text ? ' "' + fp.text + '"' : ''})`;
    }
  }

  if (!el || !(el instanceof Element)) {
    return {
      success: false,
      error: `Element with index [${index}] not found in active DOM index map. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
    };
  }

  // Label → control resolution.
  // A <label for="x"> (or a label wrapping its control) is clickable, so the
  // indexer assigns it an index, but it is NOT fillable. Targeting it made
  // fills abort with "Focus verification failed: target element [n] (<label>)
  // is not active" on ordinary forms — the agent asked for the "Full name"
  // field and got the <label>. Follow the association to the real control.
  let labelResolutionNote: string | undefined;
  if (el instanceof HTMLLabelElement) {
    const control =
      (el as HTMLLabelElement).control ||
      (el.htmlFor ? document.getElementById(el.htmlFor) : null) ||
      el.querySelector('input, select, textarea, [contenteditable="true"]');
    if (control && control instanceof Element) {
      el = control;
      labelResolutionNote =
        `Index [${index}] pointed at a <label>; resolved to its associated ` +
        `<${control.tagName.toLowerCase()}${control.getAttribute('type') ? ' type=' + control.getAttribute('type') : ''}> control.`;
    }
  }

  const details: any = extractElementLocationDetails(el);
  if (labelResolutionNote) {
    details.labelResolved = labelResolutionNote;
  }
  if (warning) {
    details.warning = warning;
  }
  if (el instanceof HTMLOptionElement || el.tagName.toLowerCase() === 'option') {
    details.isSelectOption = true;
  }
  return details;
}

/**
 * Bounding box / interactive element auto-snapping.
 * If model eye measurement clicked slightly off-target (e.g. 10-25px outside a dice/button onto whitespace),
 * magnetically snap the coordinate to the closest interactive element.
 */
export function inPageSnapCoordinate(
  x: number,
  y: number,
  snapRadius = 24,
): {
  snapped: boolean;
  x: number;
  y: number;
  originalX: number;
  originalY: number;
  targetIndex?: number;
  targetTag?: string;
  distance?: number;
} {
  const origX = Math.round(x);
  const origY = Math.round(y);
  const defaultRes = { snapped: false, x: origX, y: origY, originalX: origX, originalY: origY };

  if (typeof document === 'undefined') return defaultRes;

  const vw = window.innerWidth || document.documentElement?.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement?.clientHeight || 800;
  if (origX < 0 || origY < 0 || origX > vw || origY > vh) return defaultRes;

  // 1. Direct hit test at (origX, origY) with deep Shadow DOM penetration
  let hitEl: Element | null = null;
  try {
    hitEl = deepElementFromPoint(origX, origY);
  } catch {}

  const isInteractiveNode = (el: Element | null): boolean => {
    if (!el || (typeof Element !== 'undefined' && !(el instanceof Element))) return false;
    const tag = el.tagName.toLowerCase();
    if (/^(button|input|select|textarea|a|canvas|video|audio|summary)$/.test(tag)) return true;
    const role = el.getAttribute('role')?.toLowerCase();
    if (
      role &&
      /^(button|link|checkbox|radio|menuitem|tab|switch|option|combobox|treeitem)$/.test(role)
    )
      return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('data-action') || (el as any).onclick)
      return true;
    const tabIndex =
      typeof (el as HTMLElement).tabIndex === 'number' ? (el as HTMLElement).tabIndex : -1;
    if (tabIndex >= 0) return true;
    if (tag === 'svg' || (el as any).ownerSVGElement) {
      const svgRoot = tag === 'svg' ? el : (el as any).ownerSVGElement;
      if (svgRoot && (svgRoot.hasAttribute('onclick') || svgRoot.getAttribute('role') === 'button'))
        return true;
    }
    if (typeof (el as any).closest === 'function') {
      try {
        if ((el as any).closest('button, a, [role="button"], [onclick]')) return true;
      } catch {}
    }
    try {
      const style = window.getComputedStyle(el);
      if (style.cursor === 'pointer' || /grab|grabbing/i.test(style.cursor)) return true;
    } catch {}
    if (isCustomElement(el) && (el.hasAttribute('aria-label') || el.hasAttribute('title'))) {
      return true;
    }
    return false;
  };

  // If already directly hitting an interactive element or inside one, no snap needed
  let cur: Element | null = hitEl;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    if (isInteractiveNode(cur)) {
      return defaultRes;
    }
    cur = composedParent(cur);
  }

  // 2. Search candidate elements in isolatedIndexMap within snapRadius
  const isolatedMap = getIsolatedIndexMap();
  let bestEl: Element | null = null;
  let bestDist = Infinity;
  let bestIndex: number | undefined;
  let bestRect: DOMRect | undefined;

  for (const [idx, wrapped] of isolatedMap.entries()) {
    const el = derefElement(wrapped);
    if (!el || (typeof Element !== 'undefined' && !(el instanceof Element))) continue;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      // Clamped point in rect closest to (origX, origY)
      const cx = Math.max(rect.left, Math.min(rect.right, origX));
      const cy = Math.max(rect.top, Math.min(rect.bottom, origY));
      const dist = Math.hypot(origX - cx, origY - cy);
      if (dist < bestDist && dist <= snapRadius) {
        bestDist = dist;
        bestEl = el;
        bestIndex = idx;
        bestRect = rect;
      }
    } catch {}
  }

  // 3. Fallback: Radial search if isolatedIndexMap had no candidates (penetrates Shadow DOM)
  if (!bestEl) {
    const searchDistances = [8, 16, snapRadius];
    const angles = [0, 45, 90, 135, 180, 225, 270, 315];
    for (const r of searchDistances) {
      if (bestEl) break;
      for (const a of angles) {
        const rad = (a * Math.PI) / 180;
        const px = Math.round(origX + r * Math.cos(rad));
        const py = Math.round(origY + r * Math.sin(rad));
        if (px < 0 || py < 0 || px > vw || py > vh) continue;
        try {
          const sampleEl = deepElementFromPoint(px, py);
          let candidate: Element | null = sampleEl;
          while (
            candidate &&
            candidate !== document.body &&
            candidate !== document.documentElement
          ) {
            if (isInteractiveNode(candidate)) {
              const b = candidate.getBoundingClientRect();
              const cx = Math.max(b.left, Math.min(b.right, origX));
              const cy = Math.max(b.top, Math.min(b.bottom, origY));
              const d = Math.hypot(origX - cx, origY - cy);
              if (d <= snapRadius) {
                bestDist = d;
                bestEl = candidate;
                bestRect = b;
                break;
              }
            }
            candidate = composedParent(candidate);
          }
        } catch {}
      }
    }
  }

  // 4. Final deep query search for closest interactive Shadow DOM elements if still unhit
  if (!bestEl && typeof document !== 'undefined') {
    try {
      const candidates = querySelectorAllDeep(
        'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"], [aria-label], [data-action]',
        document,
      );
      for (const candEl of candidates) {
        if (!candEl || !(candEl instanceof Element)) continue;
        const b = candEl.getBoundingClientRect();
        if (b.width <= 0 || b.height <= 0) continue;
        const cx = Math.max(b.left, Math.min(b.right, origX));
        const cy = Math.max(b.top, Math.min(b.bottom, origY));
        const d = Math.hypot(origX - cx, origY - cy);
        if (d < bestDist && d <= snapRadius) {
          bestDist = d;
          bestEl = candEl;
          bestRect = b;
        }
      }
    } catch {}
  }

  if (bestEl && bestRect) {
    // Bring element into comfortable viewport view if scrolled outside or clipped
    try {
      const curVh = window.innerHeight || 800;
      const curVw = window.innerWidth || 1280;
      if (
        bestRect.top < 0 ||
        bestRect.bottom > curVh ||
        bestRect.left < 0 ||
        bestRect.right > curVw
      ) {
        if (typeof (bestEl as any).scrollIntoView === 'function') {
          (bestEl as any).scrollIntoView({
            block: 'center',
            inline: 'center',
            behavior: 'instant',
          });
          bestRect = bestEl.getBoundingClientRect();
        }
      }
    } catch {}

    // For small/medium elements (<= 120px in width/height), snap to geometric center.
    // For large elements (> 120px), clamp within the element with a safe margin to avoid jumping hundreds of pixels.
    const isSmallOrMedium = bestRect.width <= 120 && bestRect.height <= 120;
    let safeX: number;
    let safeY: number;

    if (isSmallOrMedium) {
      safeX = Math.round((bestRect.left + bestRect.right) / 2);
      safeY = Math.round((bestRect.top + bestRect.bottom) / 2);
    } else {
      const marginX = Math.min(12, Math.floor(bestRect.width * 0.1));
      const marginY = Math.min(12, Math.floor(bestRect.height * 0.1));
      safeX = Math.round(
        Math.max(bestRect.left + marginX, Math.min(bestRect.right - marginX, origX)),
      );
      safeY = Math.round(
        Math.max(bestRect.top + marginY, Math.min(bestRect.bottom - marginY, origY)),
      );
    }
    return {
      snapped: true,
      x: safeX,
      y: safeY,
      originalX: origX,
      originalY: origY,
      targetIndex: bestIndex,
      targetTag: bestEl.tagName.toLowerCase(),
      distance: Math.round(bestDist),
    };
  }

  return defaultRes;
}

/**
 * Post-dispatch delivery verification for CDP Input events.
 *
 * Chrome throttles CDP input to occluded/hidden tabs: the command acks
 * successfully but the renderer never records the event (TESTING-NOTES #27),
 * producing phantom successes. document.elementFromPoint cannot detect this -
 * layout is computed on demand even in hidden tabs - so verification uses
 * one-shot capture listeners armed BEFORE dispatch: if no trusted event
 * arrives, the input never reached the renderer.
 */
// Returns a marker because executeInPage's retrieve protocol throws on
// undefined returns (its undefined sentinel means 'entrypoint vanished').
export function inPageArmDeliveryProbe(events: string[]): { armed: true } {
  const g = globalThis as any;
  const prev = g.__MCP_DELIVERY_PROBE__;
  if (prev && typeof prev.remove === 'function') {
    try {
      prev.remove();
    } catch {}
  }
  const probe: any = { events, hits: [], armed: true, remove: () => {} };
  const listener = (e: Event) => {
    if (!probe.armed) return;
    probe.hits.push({
      type: e.type,
      isTrusted: (e as any).isTrusted === true,
      target: (e.target as Element | null | undefined)?.tagName?.toLowerCase?.(),
    });
    if (probe.hits.length > 8) probe.hits.shift();
  };
  probe.remove = () => {
    for (const t of events) {
      document.removeEventListener(t, listener, true);
    }
  };
  for (const t of events) {
    document.addEventListener(t, listener, true);
  }
  g.__MCP_DELIVERY_PROBE__ = probe;
  return { armed: true };
}

export function inPageReadDeliveryProbe(disarm?: boolean): {
  delivered: boolean;
  hits: any[];
  missing?: boolean;
} {
  const probe = (globalThis as any).__MCP_DELIVERY_PROBE__;
  if (!probe) return { delivered: false, hits: [], missing: true };
  const hits = probe.hits.slice();
  if (disarm !== false) {
    probe.armed = false;
    try {
      probe.remove();
    } catch {}
  }
  return { delivered: hits.length > 0, hits };
}

/**
 * Locate element coordinates and info using CSS or XPath selector.
 */
export function inPageLocateBySelector(
  selector: string,
  selectorType?: 'css' | 'xpath',
): {
  success: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  tagName?: string;
  text?: string;
  value?: string;
  frameOffsetX?: number;
  frameOffsetY?: number;
  error?: string;
} {
  if (!selector || typeof selector !== 'string') {
    return { success: false, error: 'Selector parameter must be a non-empty string' };
  }

  try {
    let targetEl: Element | null = null;
    const isXPath =
      selectorType === 'xpath' ||
      selector.startsWith('//') ||
      selector.startsWith('(') ||
      selector.startsWith('/html');

    if (isXPath && typeof document !== 'undefined' && typeof document.evaluate === 'function') {
      const xRes = document.evaluate(
        selector,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      if (xRes.singleNodeValue instanceof Element) {
        targetEl = xRes.singleNodeValue;
      }
    } else if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      try {
        targetEl = document.querySelector(selector);
      } catch {
        // Native querySelector throws DOMException on shadow combinators like '>>>' or '/deep/'
        targetEl = null;
      }
      if (!targetEl) {
        targetEl = querySelectorDeep(selector, document);
      }
    }

    if (!targetEl) {
      return { success: false, error: `Element not found by selector: ${selector}` };
    }

    return extractElementLocationDetails(targetEl);
  } catch (err) {
    return {
      success: false,
      error: `Selector lookup error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface LocateByTextOptions {
  role?: string;
  exact?: boolean;
  visibleOnly?: boolean;
  threshold?: number;
}

/**
 * Locate element coordinates and info by visible text content and/or ARIA role.
 */
export function inPageLocateByText(
  text: string,
  roleOrOptions?: string | LocateByTextOptions,
): {
  success: boolean;
  index?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  tagName?: string;
  inputType?: string;
  text?: string;
  value?: string;
  role?: string;
  isClickable?: boolean;
  frameOffsetX?: number;
  frameOffsetY?: number;
  error?: string;
} {
  const role =
    typeof roleOrOptions === 'string'
      ? roleOrOptions
      : roleOrOptions && typeof roleOrOptions === 'object' && typeof roleOrOptions.role === 'string'
        ? roleOrOptions.role
        : undefined;

  const isExact =
    typeof roleOrOptions === 'object' && roleOrOptions !== null
      ? Boolean(roleOrOptions.exact)
      : false;

  if (!text && !role) {
    return { success: false, error: 'Either text or role must be provided' };
  }

  try {
    const normalizedTarget = (text || '').trim().toLowerCase();
    const isSeekingComposer = role === 'composer' || role === 'editor';
    const selector = role
      ? isSeekingComposer
        ? '[role="textbox"], textarea, [contenteditable], [data-testid*="composer" i], [data-testid*="editor" i], [data-testid*="post" i], [data-testid*="tweet" i], [data-testid*="comment" i], [data-testid*="chat" i], [data-testid*="message" i], .DraftEditor-root, .ProseMirror, .ql-editor, .monaco-editor, .cm-editor, .tiptap, div, span, [role]'
        : `[role="${role}"], ${role}`
      : 'button, a, input, textarea, select, span, p, div, h1, h2, h3, h4, [role]';
    let elements: Element[];
    try {
      elements = querySelectorAllDeep(selector, document);
    } catch {
      elements = querySelectorAllDeep('*', document);
    }

    let bestMatch: Element | null = null;
    let bestScore = -1;

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (!(el instanceof Element)) continue;
      let style: CSSStyleDeclaration | null = null;
      try {
        style = window.getComputedStyle(el);
      } catch {}
      if (
        style?.display === 'none' ||
        style?.visibility === 'hidden' ||
        parseFloat(style?.opacity || '1') <= 0 ||
        style?.pointerEvents === 'none' ||
        el.hasAttribute('inert') ||
        (el as any).inert === true ||
        el.getAttribute('aria-hidden') === 'true' ||
        (typeof el.closest === 'function' && el.closest('[aria-hidden="true"], [inert]') !== null)
      )
        continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const vh = window.innerHeight || 800;
      const vw = window.innerWidth || 1280;
      const inActiveViewport = rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0;
      const viewportBonus = inActiveViewport ? 1000 : 0;

      const semantics = detectEditorSemantics(el);
      if (role === 'composer') {
        if (!semantics.isComposer && !semantics.isEditor) continue;
      } else if (role === 'editor') {
        if (!semantics.isEditor && !semantics.isComposer) continue;
      } else if (typeof role === 'string' && role.length > 0) {
        const elRole = el.getAttribute('role')?.toLowerCase() || el.tagName.toLowerCase();
        if (elRole !== role.toLowerCase()) continue;
      }

      // If looking for textbox, penalize generic search inputs and reward rich compose boxes
      const searchPenalty = role === 'textbox' && semantics.isSearch ? 40 : 0;
      const composerBonus = semantics.isComposer ? 25 : semantics.isEditor ? 15 : 0;

      if (normalizedTarget) {
        const elText = (el.textContent || '').trim().toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const placeholder = (el.getAttribute('placeholder') || '').trim().toLowerCase();

        let matchScore = 0;
        if (
          elText === normalizedTarget ||
          ariaLabel === normalizedTarget ||
          placeholder === normalizedTarget
        ) {
          matchScore = 100;
        } else if (
          !isExact &&
          (elText.includes(normalizedTarget) || ariaLabel.includes(normalizedTarget))
        ) {
          matchScore = 50;
        }

        if (matchScore > 0) {
          const totalScore = matchScore + composerBonus + viewportBonus - searchPenalty;
          if (totalScore > bestScore) {
            bestMatch = el;
            bestScore = totalScore;
          }
        }
      } else {
        // Only role was specified
        const roleScore = 10 + composerBonus + viewportBonus - searchPenalty;
        if (roleScore > bestScore) {
          bestMatch = el;
          bestScore = roleScore;
        }
      }
    }

    if (!bestMatch) {
      return {
        success: false,
        error: `Element not found matching text="${text}" role="${role || ''}"`,
      };
    }

    return extractElementLocationDetails(bestMatch);
  } catch (err) {
    return {
      success: false,
      error: `Text lookup error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Return the current frame's origin (used to distinguish cross-origin subframes from
 * same-origin iframes whose cumulative frame offset is 0).
 */
export function inPageGetFrameOrigin(): string {
  try {
    return window.location.origin;
  } catch {
    return '';
  }
}

/**
 * Retrieve element crop rectangle (viewport-relative) with optional padding for region-of-interest screenshot.
 * Optionally expands small elements (< 100x100) to a contextual bounding box (Midscene-inspired expandSearchArea).
 */
export function inPageGetIndexCropRect(
  index: number,
  padding: number = 0,
  autoExpand: boolean = false,
): {
  success: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  devicePixelRatio?: number;
  error?: string;
} {
  if (index <= 0) {
    return {
      success: false,
      error: `Index must be a positive 1-based integer. Received: ${index}`,
    };
  }

  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) {
    return {
      success: false,
      error: `Element with index [${index}] not found in active DOM index map. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
    };
  }

  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
  } catch {}

  const rawRect = el.getBoundingClientRect();

  let frameOffsetX = 0;
  let frameOffsetY = 0;
  try {
    let curWin: Window = window;
    while (curWin !== curWin.top) {
      if (curWin.frameElement) {
        const fEl = curWin.frameElement;
        const fRect = fEl.getBoundingClientRect();
        const parentWin = curWin.parent || fEl.ownerDocument?.defaultView || window;
        const fStyle =
          typeof parentWin.getComputedStyle === 'function'
            ? parentWin.getComputedStyle(fEl)
            : undefined;
        const borderLeft = parseFloat(fStyle?.borderLeftWidth || '0') || 0;
        const borderTop = parseFloat(fStyle?.borderTopWidth || '0') || 0;
        const zoom = parseFloat((fStyle as any)?.zoom || '1') || 1;

        frameOffsetX += (fRect.left + borderLeft) / zoom;
        frameOffsetY += (fRect.top + borderTop) / zoom;
        curWin = curWin.parent;
      } else {
        break;
      }
    }
  } catch {}

  // Micro-element adaptive expansion (Midscene-inspired expandSearchArea)
  // For small elements (< 100x100), expand to retain surrounding table headers, labels, and context
  let effectivePadding = Math.max(0, padding);
  if (autoExpand && (rawRect.width < 100 || rawRect.height < 100)) {
    // Expand by at least 100px on each side (or expand to at least 200x200)
    const minBoundingSize = 200;
    const neededPadX = Math.max(0, Math.round((minBoundingSize - rawRect.width) / 2));
    const neededPadY = Math.max(0, Math.round((minBoundingSize - rawRect.height) / 2));
    effectivePadding = Math.max(effectivePadding, Math.max(100, Math.max(neededPadX, neededPadY)));
  }

  const left = Math.max(0, Math.round(rawRect.left + frameOffsetX - effectivePadding));
  const top = Math.max(0, Math.round(rawRect.top + frameOffsetY - effectivePadding));
  const maxW =
    typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth > 0
      ? Math.max(1, window.innerWidth - left)
      : undefined;
  const maxH =
    typeof window !== 'undefined' &&
    typeof window.innerHeight === 'number' &&
    window.innerHeight > 0
      ? Math.max(1, window.innerHeight - top)
      : undefined;
  const rawWidth = Math.round(rawRect.width + effectivePadding * 2);
  const rawHeight = Math.round(rawRect.height + effectivePadding * 2);
  const width = Math.max(1, maxW !== undefined ? Math.min(rawWidth, maxW) : rawWidth);
  const height = Math.max(1, maxH !== undefined ? Math.min(rawHeight, maxH) : rawHeight);

  return {
    success: true,
    rect: { x: left, y: top, width, height },
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

/**
 * One-shot pointer-move delivery for CDP-synthetic pointer drags: CDP routes
 * mouseMoved by hit-testing and page-side setPointerCapture does not stick
 * under synthetic presses, so narrow targets (resize handles, sliders) miss
 * every move once the cursor leaves their few-pixel hit area. Deliver the
 * final pointermove straight to the element under the press point carrying
 * the real end coordinates, so its onPointerMove sees the true final position.
 */
export function inPagePointerDragMove(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): { success: boolean; tag?: string; error?: string } {
  try {
    const el = document.elementFromPoint(fromX, fromY);
    if (!el) {
      return { success: false, error: `No element at point (${fromX}, ${fromY})` };
    }
    el.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        clientX: toX,
        clientY: toY,
        button: -1,
        buttons: 1,
      }),
    );
    return {
      success: true,
      tag: el.id || el.tagName.toLowerCase(),
    };
  } catch (err) {
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

/**
 * Perform fallback in-page interaction by 1-based index inside active tab.
 */
/**
 * Focus an indexed element without firing click handlers.
 * chrome_keyboard previously used inPageInteractIndex(index, 'click'), which both
 * fired the element's click handlers as a side effect and never actually moved
 * focus for non-focusable nodes — so subsequent key events landed on whatever
 * document.activeElement already was. This focuses first, then falls back to a
 * click only for elements that cannot take focus directly.
 */
export function inPageFocusIndex(index: number): {
  success: boolean;
  index: number;
  tagName?: string;
  focused?: boolean;
  error?: string;
} {
  if (index <= 0) {
    return {
      success: false,
      index,
      error: `Index must be a positive 1-based integer. Received: ${index}`,
    };
  }

  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) {
    return {
      success: false,
      index,
      error: `Element with index [${index}] not found in active DOM index map. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
    };
  }

  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
  } catch {}

  const htmlEl = el as HTMLElement;
  let focused = false;
  try {
    if (typeof htmlEl.focus === 'function') {
      htmlEl.focus({ preventScroll: true });
      focused = document.activeElement === el || el.contains(document.activeElement);
    }
  } catch {}

  // Non-focusable containers (plain div/li/canvas): make them programmatically
  // focusable for this session so keyboard events target the intended node.
  if (!focused && !el.hasAttribute('tabindex')) {
    try {
      el.setAttribute('tabindex', '-1');
      htmlEl.focus({ preventScroll: true });
      focused = document.activeElement === el || el.contains(document.activeElement);
    } catch {}
  }

  return {
    success: true,
    index,
    tagName: el.tagName.toLowerCase(),
    focused,
  };
}

export function inPageInteractIndex(
  index: number,
  action: 'click' | 'hover' | 'double_click' | 'right_click' = 'click',
): { success: boolean; index: number; tagName?: string; text?: string; error?: string } {
  if (index <= 0) {
    return {
      success: false,
      index,
      error: `Index must be a positive 1-based integer. Received: ${index}`,
    };
  }

  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) {
    return {
      success: false,
      index,
      error: `Element with index [${index}] not found in active DOM index map. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
    };
  }

  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
  } catch {}

  const text = ((el as HTMLElement).innerText || el.textContent || '').trim().slice(0, 100);

  if (action === 'click') {
    // Task B4: Direct single-step selection for HTMLOptionElement
    if (el instanceof HTMLOptionElement || el.tagName.toLowerCase() === 'option') {
      const opt = el as HTMLOptionElement;
      const select = (
        opt.parentElement instanceof HTMLSelectElement ? opt.parentElement : opt.closest?.('select')
      ) as HTMLSelectElement | null;
      if (select) {
        select.value = opt.value;
        opt.selected = true;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          success: true,
          index,
          tagName: 'option',
          text: opt.label || opt.text || opt.value,
        };
      }
    }
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    (el as HTMLElement).click?.();
  } else if (action === 'double_click') {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    (el as HTMLElement).click?.();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    (el as HTMLElement).click?.();
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  } else if (action === 'right_click') {
    const rawRect = el.getBoundingClientRect();
    const cx = Math.round(rawRect.left + rawRect.width / 2);
    const cy = Math.round(rawRect.top + rawRect.height / 2);
    const mouseOpts: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      clientX: cx,
      clientY: cy,
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...mouseOpts, pointerType: 'mouse' }));
    } catch {}
    el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
    try {
      el.dispatchEvent(
        new PointerEvent('pointerup', { ...mouseOpts, buttons: 0, pointerType: 'mouse' }),
      );
    } catch {}
    el.dispatchEvent(new MouseEvent('mouseup', { ...mouseOpts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('contextmenu', mouseOpts));
  } else if (action === 'hover') {
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
  }

  return {
    success: true,
    index,
    tagName: el.tagName.toLowerCase(),
    text,
  };
}

/**
 * Fill input or textarea by 1-based index inside active tab.
 */
export function inPageFillIndex(
  refOrIndex: number | string,
  textToFill: string,
  clear = true,
  pressEnter = false,
): {
  success: boolean;
  committed?: boolean;
  index: number;
  tagName?: string;
  filledText?: string;
  submitButtonState?: { found: boolean; disabled?: boolean; text?: string };
  diagnostics?: string;
  error?: string;
} {
  let index: number;
  if (typeof refOrIndex === 'string') {
    const parsed = refOrIndex.startsWith('ref_')
      ? parseInt(refOrIndex.slice(4), 10)
      : parseInt(refOrIndex, 10);
    if (isNaN(parsed)) {
      return {
        success: false,
        index: 0,
        error: `Invalid index or ref format: ${refOrIndex}`,
      };
    }
    index = parsed;
  } else {
    index = refOrIndex;
  }

  if (index <= 0) {
    return {
      success: false,
      index,
      error: `Index must be a positive 1-based integer. Received: ${index}`,
    };
  }

  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) {
    return {
      success: false,
      index,
      error: `Element with index [${index}] not found in active DOM index map. ${DIAGNOSTIC_REFRESH_GUIDANCE}`,
    };
  }

  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
  } catch {}

  if (typeof (el as HTMLElement).focus === 'function') {
    (el as HTMLElement).focus();
  }

  const getNativeSetter = (element: any, prop: string) => {
    let proto = Object.getPrototypeOf(element);
    while (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc?.set) return desc.set;
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  };

  const nativeInputValueSetter = getNativeSetter(el, 'value');
  const nativeCheckboxSetter = getNativeSetter(el, 'checked');
  const nativeTextAreaValueSetter = nativeInputValueSetter;

  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const isTruthy =
      textToFill === 'true' ||
      textToFill === '1' ||
      textToFill === 'checked' ||
      textToFill === 'on' ||
      (textToFill !== 'false' && textToFill !== '0' && textToFill !== 'off' && Boolean(textToFill));
    if (nativeCheckboxSetter) {
      nativeCheckboxSetter.call(el, isTruthy);
    } else {
      el.checked = isTruthy;
    }
  } else if (el instanceof HTMLInputElement && nativeInputValueSetter) {
    if (clear) nativeInputValueSetter.call(el, '');
    nativeInputValueSetter.call(el, textToFill);
    try {
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: textToFill,
        }),
      );
    } catch {
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  } else if (el instanceof HTMLTextAreaElement && nativeTextAreaValueSetter) {
    if (clear) nativeTextAreaValueSetter.call(el, '');
    nativeTextAreaValueSetter.call(el, textToFill);
    try {
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: textToFill,
        }),
      );
    } catch {
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  } else if (el instanceof HTMLSelectElement) {
    let matched = false;
    for (const opt of Array.from(el.options)) {
      if (
        opt.value === textToFill ||
        opt.text === textToFill ||
        opt.text.trim() === textToFill.trim()
      ) {
        el.value = opt.value;
        matched = true;
        break;
      }
    }
    if (!matched) el.value = textToFill;
  } else if (
    el.getAttribute('role') === 'combobox' ||
    el.getAttribute('role') === 'listbox' ||
    el.getAttribute('aria-haspopup') === 'listbox'
  ) {
    try {
      void inPageSelectCustomCombobox(index, undefined, textToFill);
    } catch {}
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (clear) {
      el.value = '';
    }
    el.value = textToFill;
  } else if (
    (el as HTMLElement).isContentEditable ||
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('contenteditable') === '' ||
    Boolean(el.querySelector?.('[contenteditable="true"]'))
  ) {
    const editTarget =
      (el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true'
        ? (el as HTMLElement)
        : (el.querySelector?.('[contenteditable="true"]') as HTMLElement) || (el as HTMLElement);

    if (clear) {
      const sel = window.getSelection();
      if (sel && typeof document.createRange === 'function') {
        try {
          const range = document.createRange();
          range.selectNodeContents(editTarget);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false);
        } catch {}
      }
      editTarget.innerText = '';
    }
    const lines = textToFill ? textToFill.split(/\r?\n/) : [];
    if (lines.length > 1) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 0) {
          let insertedLine = false;
          try {
            insertedLine = document.execCommand('insertText', false, lines[i]);
          } catch {}
          if (!insertedLine && typeof editTarget.appendChild === 'function') {
            editTarget.appendChild(document.createTextNode(lines[i]));
          }
        }
        if (i < lines.length - 1) {
          let paraInserted = false;
          try {
            paraInserted = document.execCommand('insertParagraph', false);
          } catch {}
          if (!paraInserted) {
            try {
              paraInserted = document.execCommand('insertLineBreak', false);
            } catch {}
          }
          if (!paraInserted && typeof editTarget.appendChild === 'function') {
            editTarget.appendChild(document.createElement('br'));
          }
          try {
            editTarget.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                composed: true,
              }),
            );
            editTarget.dispatchEvent(
              new KeyboardEvent('keyup', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                composed: true,
              }),
            );
          } catch {}
        }
      }
    } else {
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, textToFill);
      } catch {}
      if (!inserted) {
        editTarget.innerText = textToFill;
      }
    }
    try {
      editTarget.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: textToFill,
        }),
      );
    } catch {
      editTarget.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    editTarget.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  } else {
    (el as any).value = textToFill;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  if (pressEnter) {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        composed: true,
      }),
    );
    el.dispatchEvent(
      new KeyboardEvent('keypress', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        composed: true,
      }),
    );
    el.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        composed: true,
      }),
    );
    if (el instanceof HTMLInputElement && el.form) {
      const submitBtn = el.form.querySelector(
        'button[type="submit"], input[type="submit"]',
      ) as HTMLElement | null;
      if (submitBtn) {
        submitBtn.click();
      } else if (typeof el.form.requestSubmit === 'function') {
        try {
          el.form.requestSubmit();
        } catch {}
      }
    }
  }

  const verification: any = textToFill
    ? inPageVerifyInputCommitment(index, textToFill)
    : { committed: true };

  return {
    success: verification.committed,
    committed: verification.committed,
    index,
    tagName: el.tagName.toLowerCase(),
    filledText: textToFill,
    ...(verification.submitButtonState
      ? { submitButtonState: verification.submitButtonState }
      : {}),
    ...(verification.diagnostics ? { diagnostics: verification.diagnostics } : {}),
  };
}

/**
 * Dispatch bubbling synthetic input and change events to force controlled components
 * (React/Vue/Angular/Svelte) to commit values updated via native CDP / typing.
 */
export function inPageDispatchInputEvents(refOrIndex: number | string): {
  success: boolean;
  error?: string;
} {
  let index: number;
  if (typeof refOrIndex === 'string') {
    const parsed = refOrIndex.startsWith('ref_')
      ? parseInt(refOrIndex.slice(4), 10)
      : parseInt(refOrIndex, 10);
    if (isNaN(parsed)) return { success: false, error: `Invalid index: ${refOrIndex}` };
    index = parsed;
  } else {
    index = refOrIndex;
  }
  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) {
    return { success: false, error: `Element [${index}] not found` };
  }
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
  } catch {
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return { success: true };
}

export { inPageWaitForDOMSettle } from '@/utils/action-watchdog';

/**
 * Cross-platform Deep Reset Protocol for rich-text editors and form controls.
 * Uses In-Page DOM Selection + execCommand/beforeinput delete + value resetting.
 * Eliminates text concatenation and phantom residual characters across Draft.js, Lexical, and React controlled inputs.
 */
export function inPageDeepResetElement(refOrIndex: number | string): {
  success: boolean;
  cleared: boolean;
  currentLength: number;
  tagName?: string;
  isComposer?: boolean;
  error?: string;
} {
  let index: number;
  if (typeof refOrIndex === 'string') {
    const parsed = refOrIndex.startsWith('ref_')
      ? parseInt(refOrIndex.slice(4), 10)
      : parseInt(refOrIndex, 10);
    if (isNaN(parsed)) {
      return {
        success: false,
        cleared: false,
        currentLength: 0,
        error: `Invalid index: ${refOrIndex}`,
      };
    }
    index = parsed;
  } else {
    index = refOrIndex;
  }

  if (index <= 0) {
    return {
      success: false,
      cleared: false,
      currentLength: 0,
      error: `Index must be positive: ${index}`,
    };
  }

  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) {
    return {
      success: false,
      cleared: false,
      currentLength: 0,
      error: `Element [${index}] not found`,
    };
  }

  try {
    if (typeof (el as HTMLElement).focus === 'function') {
      (el as HTMLElement).focus();
    }
  } catch {}

  const semantics = detectEditorSemantics(el);

  // Standard <input> or <textarea>
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
    try {
      inputEl.select();
    } catch {}

    const proto =
      el instanceof HTMLInputElement
        ? window.HTMLInputElement?.prototype
        : window.HTMLTextAreaElement?.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto || {}, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(inputEl, '');
    } else {
      inputEl.value = '';
    }

    try {
      inputEl.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'deleteContentBackward',
        }),
      );
    } catch {}

    try {
      inputEl.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'deleteContentBackward',
        }),
      );
    } catch {
      inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    const currentLen = (inputEl.value || '').length;
    return {
      success: true,
      cleared: currentLen === 0,
      currentLength: currentLen,
      tagName: el.tagName.toLowerCase(),
      isComposer: semantics.isComposer,
    };
  }

  // Rich-text editor (contenteditable, Draft.js, Lexical, ProseMirror, Quill)
  const editTarget =
    (el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true'
      ? (el as HTMLElement)
      : (el.querySelector?.('[contenteditable="true"]') as HTMLElement) || (el as HTMLElement);

  try {
    if (typeof editTarget.focus === 'function') {
      editTarget.focus();
    }
  } catch {}

  // 1. Select all contents in DOM selection
  const sel = window.getSelection();
  if (sel && typeof document.createRange === 'function') {
    try {
      const range = document.createRange();
      range.selectNodeContents(editTarget);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  }

  // 2. Dispatch synthetic beforeinput with deleteContentBackward
  try {
    editTarget.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: 'deleteContentBackward',
      }),
    );
  } catch {}

  // 3. Native document.execCommand delete
  try {
    document.execCommand('delete', false);
  } catch {}

  // 4. If content remains, clear innerText / innerHTML directly
  let currentLen = (editTarget.innerText || editTarget.textContent || '').trim().length;
  if (currentLen > 0) {
    try {
      editTarget.innerText = '';
    } catch {}
    try {
      editTarget.innerHTML = '';
    } catch {}
  }

  // 5. Notify framework of input deletion
  try {
    editTarget.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'deleteContentBackward',
      }),
    );
  } catch {
    editTarget.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  }
  editTarget.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

  currentLen = (editTarget.innerText || editTarget.textContent || '').trim().length;
  return {
    success: true,
    cleared: currentLen === 0,
    currentLength: currentLen,
    tagName: el.tagName.toLowerCase(),
    isComposer: semantics.isComposer || semantics.isEditor,
  };
}

export function cleanAndNormalizeText(str: string): string {
  return str
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // strip zero-width characters (Draft.js/Lexical artifacts)
    .replace(/\u00A0/g, ' ') // non-breaking space to normal space
    .replace(/\r\n|\r/g, '\n') // newline normalization
    .replace(/[ \t]+/g, ' ') // collapse horizontal spaces
    .trim();
}

/**
 * Focus Guard: strictly verifies that document.activeElement is indeed the target element.
 * Traverses shadow roots if present. If the target element was clicked but did not acquire focus,
 * attempts programmatic focus fallback. If activeElement is a previously focused element, returns isFocused: false
 * to prevent misdirected text typing and concatenation.
 */
export function inPageVerifyActiveElement(
  refOrIndex?: number | string,
  selector?: string,
): {
  success: boolean;
  isFocused: boolean;
  targetTag?: string;
  activeTag?: string;
  activeId?: string;
  activeName?: string;
  error?: string;
} {
  let targetEl: Element | null = null;
  // If a CSS selector is provided, prioritize it for dynamic SPAs where indices drift
  if (selector) {
    try {
      targetEl = document.querySelector(selector);
    } catch {}
  }
  if (!targetEl && refOrIndex !== undefined && refOrIndex !== null && refOrIndex !== '') {
    targetEl = findIndexedElement(refOrIndex);
  }
  if (!targetEl && typeof refOrIndex === 'string') {
    try {
      targetEl = document.querySelector(refOrIndex);
    } catch {}
  }

  // Mirror the label → control resolution used when resolving coordinates:
  // the click now lands on the labelled control, so the focus guard must
  // expect that control (otherwise a correct fill still aborts).
  if (targetEl instanceof HTMLLabelElement) {
    const control =
      (targetEl as HTMLLabelElement).control ||
      (targetEl.htmlFor ? document.getElementById(targetEl.htmlFor) : null) ||
      targetEl.querySelector('input, select, textarea, [contenteditable="true"]');
    if (control && control instanceof Element) {
      targetEl = control;
    }
  }

  if (!targetEl) {
    return {
      success: false,
      isFocused: false,
      error: `Target element [${refOrIndex ?? selector}] not found in DOM during active element verification`,
    };
  }

  const getDeepActive = (): Element | null => {
    let el = typeof document !== 'undefined' ? document.activeElement : null;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  };

  let active = getDeepActive();

  // Check if active matches targetEl or is contained within targetEl (e.g. contenteditable or custom input inside wrapper)
  let isFocused =
    active === targetEl || Boolean(targetEl.contains && active && targetEl.contains(active));

  // If focus failed via mouse click, attempt programmatic focus fallback
  if (!isFocused && typeof (targetEl as HTMLElement).focus === 'function') {
    try {
      (targetEl as HTMLElement).focus({ preventScroll: true });
      active = getDeepActive();
      isFocused =
        active === targetEl || Boolean(targetEl.contains && active && targetEl.contains(active));
    } catch {}
  }

  // If still not focused and targetEl is a composite container wrapping an input/textarea/contenteditable
  if (!isFocused && typeof targetEl.querySelector === 'function') {
    const innerFocusable = targetEl.querySelector(
      'input:not([type="hidden"]), textarea, [contenteditable="true"]',
    ) as HTMLElement | null;
    if (innerFocusable && typeof innerFocusable.focus === 'function') {
      try {
        innerFocusable.focus({ preventScroll: true });
        active = getDeepActive();
        isFocused =
          active === targetEl ||
          active === innerFocusable ||
          Boolean(targetEl.contains && active && targetEl.contains(active));
      } catch {}
    }
  }

  const targetTag = targetEl.tagName.toLowerCase();
  const activeTag = active?.tagName?.toLowerCase() || 'none';
  const activeId = (active as HTMLElement)?.id || undefined;
  const activeName = (active as HTMLInputElement)?.name || undefined;

  if (!isFocused) {
    const activeDesc = `<${activeTag}${activeId ? '#' + activeId : ''}${activeName ? '[name="' + activeName + '"]' : ''}>`;
    return {
      success: false,
      isFocused: false,
      targetTag,
      activeTag,
      activeId,
      activeName,
      error: `Focus verification failed: target element [${refOrIndex ?? selector}] (<${targetTag}>) is not active. document.activeElement is ${activeDesc}. Target element could not be focused.`,
    };
  }

  return {
    success: true,
    isFocused: true,
    targetTag,
    activeTag,
    activeId,
    activeName,
  };
}

/**
 * Selects an option on custom div[role="combobox"] / [role="listbox"] elements:
 * 1. Clicks trigger to open dropdown if closed (aria-expanded != true).
 * 2. Locates candidate options via aria-controls, aria-owns, dropdown portals, or child elements.
 * 3. Matches option by exact text/value, word boundary, prefix, or substring.
 * 4. Clicks the matching option and dispatches input/change events.
 */
export async function inPageSelectCustomCombobox(
  refOrIndex?: number | string,
  selector?: string,
  valueToSelect?: string,
): Promise<{
  success: boolean;
  committed: boolean;
  selectedText?: string;
  selectedValue?: string;
  diagnostics?: string;
  error?: string;
}> {
  let element: Element | null = null;
  if (selector) {
    try {
      element = document.querySelector(selector);
    } catch {}
  }
  if (!element && refOrIndex !== undefined && refOrIndex !== null && refOrIndex !== '') {
    element = findIndexedElement(refOrIndex);
  }
  if (!element && typeof refOrIndex === 'string') {
    try {
      element = document.querySelector(refOrIndex);
    } catch {}
  }

  if (!element) {
    return {
      success: false,
      committed: false,
      error: `Combobox target [${refOrIndex ?? selector}] not found in active DOM`,
    };
  }

  const targetVal = String(valueToSelect ?? '').trim();

  // 1. Native <select> or container wrapping a <select>
  const selectEl =
    element.tagName.toLowerCase() === 'select'
      ? (element as HTMLSelectElement)
      : element.querySelector('select');
  if (selectEl) {
    let matched = false;
    let matchedText = '';
    let matchedValue = '';
    const normTarget = targetVal.toLowerCase();

    for (const opt of Array.from(selectEl.options)) {
      const oText = opt.text.trim().toLowerCase();
      const oVal = opt.value.trim().toLowerCase();
      if (oText === normTarget || oVal === normTarget) {
        matched = true;
        matchedText = opt.text.trim();
        matchedValue = opt.value;
        break;
      }
    }
    if (!matched) {
      for (const opt of Array.from(selectEl.options)) {
        const oText = opt.text.trim().toLowerCase();
        if (oText.startsWith(normTarget) || oText.includes(normTarget)) {
          matched = true;
          matchedText = opt.text.trim();
          matchedValue = opt.value;
          break;
        }
      }
    }
    if (!matched) {
      matchedText = targetVal;
      matchedValue = targetVal;
      matched = true;
    }

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(selectEl, matchedValue);
    } else {
      selectEl.value = matchedValue;
    }

    selectEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    selectEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    return {
      success: true,
      committed: true,
      selectedText: matchedText,
      selectedValue: matchedValue,
    };
  }

  // 2. Custom ARIA Combobox / Listbox
  // Click combobox to open dropdown if not expanded
  const isExpanded = element.getAttribute('aria-expanded') === 'true';
  if (!isExpanded) {
    try {
      if (typeof (element as HTMLElement).focus === 'function') {
        (element as HTMLElement).focus({ preventScroll: true });
      }
      try {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      } catch {}
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      (element as HTMLElement).click?.();
      // Allow framework portal / dropdown menu to mount
      await new Promise((r) => setTimeout(r, 80));
    } catch {}
  }

  // Search candidate options in:
  // a) aria-controls or aria-owns container (with ShadowRoot support)
  const ariaControls = element.getAttribute('aria-controls') || element.getAttribute('aria-owns');
  const searchRoots: Element[] = [element];
  if (ariaControls) {
    const rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : null;
    const controlled =
      (rootNode as ShadowRoot | Document)?.getElementById?.(ariaControls) ||
      document.getElementById(ariaControls);
    if (controlled) searchRoots.push(controlled);
  }

  // b) Document portals / overlays
  const portalSelector =
    '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], [data-floating-ui-portal], .ant-select-dropdown, .el-select-dropdown, .MuiMenu-paper, [class*="select-dropdown" i], [class*="dropdown-menu" i]';
  const portals = Array.from(document.querySelectorAll(portalSelector));
  searchRoots.push(...portals);

  // Collect option elements
  const optionSelector =
    '[role="option"], [role="menuitem"], [role="treeitem"], [data-radix-collection-item], [data-combobox-option], .ant-select-item-option, .el-select-dropdown__item, .MuiMenuItem-root, .v-list-item, li[data-value], [class*="option" i], [class*="select-item" i]';

  const candidates: Element[] = [];
  for (const root of searchRoots) {
    const found = Array.from(root.querySelectorAll(optionSelector));
    for (const f of found) {
      if (!candidates.includes(f)) candidates.push(f);
    }
  }

  // Fallback: document-wide option query if none found in candidate roots
  if (candidates.length === 0) {
    const docOptions = Array.from(document.querySelectorAll(optionSelector));
    candidates.push(...docOptions);
  }

  // Filter out hidden options (e.g. in closed submenus or offscreen inactive portals)
  const visibleCandidates = candidates.filter((el) => {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    if (
      typeof el.closest === 'function' &&
      el.closest('[hidden], [aria-hidden="true"], [style*="display: none"]')
    ) {
      return false;
    }
    return true;
  });
  const activeCandidates = visibleCandidates.length > 0 ? visibleCandidates : candidates;

  if (activeCandidates.length === 0) {
    return {
      success: false,
      committed: false,
      error: `Custom combobox opened, but no [role="option"] elements found in DOM or portals.`,
    };
  }

  // Match best candidate option
  const normTarget = targetVal.toLowerCase();
  let matchedOption: Element | null = null;

  // Pass 1: exact text or value
  for (const opt of activeCandidates) {
    const text = (opt.textContent || '').trim().toLowerCase();
    const val = (opt.getAttribute('data-value') || opt.getAttribute('value') || '')
      .trim()
      .toLowerCase();
    if (text === normTarget || (val && val === normTarget)) {
      matchedOption = opt;
      break;
    }
  }

  // Pass 2: exact word boundary match
  if (!matchedOption) {
    const safeWord = normTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = new RegExp(`(^|\\b|\\s)${safeWord}(\\b|\\s|$)`, 'i');
    for (const opt of activeCandidates) {
      const text = (opt.textContent || '').trim();
      if (wordRegex.test(text)) {
        matchedOption = opt;
        break;
      }
    }
  }

  // Pass 3: startsWith
  if (!matchedOption) {
    for (const opt of activeCandidates) {
      const text = (opt.textContent || '').trim().toLowerCase();
      if (text.startsWith(normTarget)) {
        matchedOption = opt;
        break;
      }
    }
  }

  // Pass 4: includes
  if (!matchedOption) {
    for (const opt of activeCandidates) {
      const text = (opt.textContent || '').trim().toLowerCase();
      if (text.includes(normTarget)) {
        matchedOption = opt;
        break;
      }
    }
  }

  if (!matchedOption) {
    const availableTexts = activeCandidates
      .map((c) => c.textContent?.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(', ');
    return {
      success: false,
      committed: false,
      error: `No matching option found for "${targetVal}" in combobox. Available options: [${availableTexts}]`,
    };
  }

  // Click the matched option
  try {
    if (typeof (matchedOption as HTMLElement).focus === 'function') {
      (matchedOption as HTMLElement).focus({ preventScroll: true });
    }
    try {
      matchedOption.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
      );
    } catch {}
    matchedOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    matchedOption.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    matchedOption.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    (matchedOption as HTMLElement).click?.();
  } catch {}

  // Trigger input and change on the combobox trigger element as well
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

  // Settle pause
  await new Promise((r) => setTimeout(r, 50));

  const selectedText = matchedOption.textContent?.trim() || targetVal;
  const selectedValue =
    matchedOption.getAttribute('data-value') || matchedOption.getAttribute('value') || selectedText;

  return {
    success: true,
    committed: true,
    selectedText,
    selectedValue,
  };
}

/**
 * Verifies whether input text was truly committed into framework reactive state (React/Draft.js/Lexical).
 * Inspects element value/text and checks for nearby submit/tweet/post buttons disabled state.
 */
export function inPageVerifyInputCommitment(
  refOrIndex: number | string,
  expectedText: string,
): {
  committed: boolean;
  currentValue: string;
  expectedValue: string;
  length: number;
  tagName: string;
  isComposer?: boolean;
  submitButtonState?: {
    found: boolean;
    disabled?: boolean;
    text?: string;
    index?: number;
  };
  diagnostics?: string;
} {
  let index: number;
  if (typeof refOrIndex === 'string') {
    const parsed = refOrIndex.startsWith('ref_')
      ? parseInt(refOrIndex.slice(4), 10)
      : parseInt(refOrIndex, 10);
    index = isNaN(parsed) ? 0 : parsed;
  } else {
    index = refOrIndex;
  }

  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) {
    return {
      committed: false,
      currentValue: '',
      expectedValue: expectedText,
      length: 0,
      tagName: 'unknown',
      diagnostics: `Element [${index}] not found during commitment verification`,
    };
  }

  const semantics = detectEditorSemantics(el);
  let currentValue = '';

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    currentValue = el.value || '';
  } else {
    const editTarget =
      (el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true'
        ? (el as HTMLElement)
        : (el.querySelector?.('[contenteditable="true"]') as HTMLElement) || (el as HTMLElement);
    const rawText =
      typeof editTarget.innerText === 'string' && editTarget.innerText.length > 0
        ? editTarget.innerText
        : editTarget.innerHTML
          ? editTarget.innerHTML
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/div><div>/gi, '\n')
              .replace(/<\/p><p>/gi, '\n')
              .replace(/<[^>]+>/g, '')
          : editTarget.textContent || '';
    currentValue = rawText.trim();
  }

  // Check nearby submit/action button state
  let submitButtonState: { found: boolean; disabled?: boolean; text?: string; index?: number } = {
    found: false,
  };
  try {
    let container: Element | null =
      el.closest('form') ||
      el.closest('[role="search"]') ||
      el.closest('[role="form"]') ||
      el.closest('[role="dialog"]') ||
      el.closest(
        '[data-testid*="composer" i], [data-testid*="post" i], [data-testid*="editor" i], [data-testid*="comment" i], [data-testid*="chat" i], [data-testid*="message" i], [data-testid*="tweet" i]',
      ) ||
      el.closest('[class*="composer" i]') ||
      el.closest('[class*="search" i]') ||
      el.closest('[class*="form" i]') ||
      el.closest('[class*="input-group" i]') ||
      el.closest('[class*="search-box" i]') ||
      el.closest('[class*="search-bar" i]') ||
      el.parentElement?.parentElement ||
      el.parentElement;
    if (!container) container = el.ownerDocument.body;

    const candidateButtons: Element[] = Array.from(
      querySelectorAllDeep(
        'button, [role="button"], input[type="submit"], input[type="button"], a.btn, a[class*="btn" i], a[class*="button" i], a[class*="submit" i], a[href*="doPostBack" i]',
        container,
      ),
    );

    // If container is within a form with an ID, also check external submit buttons with form="formId"
    const formEl = el.closest('form');
    if (formEl && formEl.id) {
      const extButtons = Array.from(
        querySelectorAllDeep(
          `button[form="${formEl.id}"], input[form="${formEl.id}"]`,
          el.ownerDocument,
        ),
      );
      for (const eb of extButtons) {
        if (!candidateButtons.includes(eb)) candidateButtons.push(eb);
      }
    }

    // If still no buttons found and container is narrow, expand search up the DOM tree (up to 8 levels, penetrating Shadow DOM hosts)
    let currAncestor: Element | null = el.parentElement;
    let upCount = 0;
    while (currAncestor && upCount < 8 && candidateButtons.length === 0) {
      const expanded = Array.from(
        querySelectorAllDeep(
          'button, [role="button"], input[type="submit"], input[type="button"], a.btn, a[class*="btn" i], a[class*="button" i], a[class*="submit" i]',
          currAncestor,
        ),
      );
      if (expanded.length > 0) {
        candidateButtons.push(...expanded);
        break;
      }
      if (currAncestor.parentElement) {
        currAncestor = currAncestor.parentElement;
      } else {
        const rootNode =
          typeof currAncestor.getRootNode === 'function' ? currAncestor.getRootNode() : null;
        if (
          rootNode &&
          typeof ShadowRoot !== 'undefined' &&
          rootNode instanceof ShadowRoot &&
          (rootNode as any).host
        ) {
          currAncestor = (rootNode as any).host;
        } else {
          currAncestor = null;
        }
      }
      upCount++;
    }

    const candidateBtn = candidateButtons.find((b) => {
      const type = (b.getAttribute('type') || '').toLowerCase();
      const text = (b.textContent || (b as HTMLInputElement).value || '').trim().toLowerCase();
      const testId = (b.getAttribute('data-testid') || '').toLowerCase();
      const ariaLabel = (b.getAttribute('aria-label') || '').toLowerCase();
      const name = (b.getAttribute('name') || '').toLowerCase();
      const id = (b.getAttribute('id') || '').toLowerCase();
      const href = (b.getAttribute('href') || '').toLowerCase();
      const className = (b.getAttribute('class') || '').toLowerCase();
      const title = (b.getAttribute('title') || '').toLowerCase();

      const hasSearchIconOrChild = Boolean(
        b.querySelector('svg, i, [class*="search" i], [data-icon*="search" i]'),
      );

      return (
        type === 'submit' ||
        testId.includes('submit') ||
        testId.includes('send') ||
        testId.includes('post') ||
        testId.includes('publish') ||
        testId.includes('confirm') ||
        testId.includes('tweet') ||
        testId.includes('search') ||
        testId.includes('query') ||
        ariaLabel.includes('tweet') ||
        ariaLabel.includes('post') ||
        ariaLabel.includes('submit') ||
        ariaLabel.includes('send') ||
        ariaLabel.includes('search') ||
        ariaLabel.includes('query') ||
        ariaLabel.includes('搜索') ||
        ariaLabel.includes('查询') ||
        ariaLabel.includes('提交') ||
        title.includes('search') ||
        title.includes('搜索') ||
        title.includes('查询') ||
        title.includes('提交') ||
        name.includes('submit') ||
        name.includes('search') ||
        name.includes('query') ||
        name.includes('btnsearch') ||
        id.includes('submit') ||
        id.includes('search') ||
        id.includes('btnsearch') ||
        href.includes('dopostback') ||
        className.includes('btn-search') ||
        className.includes('search-btn') ||
        className.includes('search-button') ||
        className.includes('btn-primary') ||
        className.includes('btn-action') ||
        className.includes('btn-submit') ||
        className.includes('button-primary') ||
        className.includes('is-primary') ||
        className.includes('submit-btn') ||
        hasSearchIconOrChild ||
        /(tweet|post|reply|send|submit|发布|发帖|发送|提交|ok|next|continue|确认|确定|查询|搜索|search|query|find|go|enter|login|sign in)/i.test(
          text,
        )
      );
    });

    if (candidateBtn) {
      const disabled =
        (candidateBtn as HTMLButtonElement).disabled === true ||
        candidateBtn.getAttribute('aria-disabled') === 'true' ||
        candidateBtn.classList.contains('disabled') ||
        (candidateBtn as HTMLElement).style.pointerEvents === 'none';

      let candidateBtnIndex: number | undefined;
      try {
        const isolatedMap = getIsolatedIndexMap();
        // Pass 1: exact match
        for (const [idx, entry] of isolatedMap.entries()) {
          const target = derefElement(entry);
          if (target === candidateBtn) {
            candidateBtnIndex = idx;
            break;
          }
        }
        // Pass 2: wrapper match
        if (candidateBtnIndex === undefined) {
          for (const [idx, entry] of isolatedMap.entries()) {
            const target = derefElement(entry);
            if (target && candidateBtn.contains(target)) {
              candidateBtnIndex = idx;
              break;
            }
          }
        }
        // Pass 3: allocate new index if still unindexed
        if (candidateBtnIndex === undefined) {
          const maxIdx = isolatedMap.size > 0 ? Math.max(...isolatedMap.keys()) : 0;
          candidateBtnIndex = maxIdx + 1;
          isolatedMap.set(candidateBtnIndex, wrapElement(candidateBtn));
        }
      } catch {}
      submitButtonState = {
        found: true,
        disabled,
        text: (candidateBtn.textContent || (candidateBtn as HTMLInputElement).value || '').trim(),
        ...(typeof candidateBtnIndex === 'number' ? { index: candidateBtnIndex } : {}),
      };
    }
  } catch {}

  // Checkbox and radio inputs
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const isTruthy =
      expectedText === 'true' ||
      expectedText === '1' ||
      expectedText === 'checked' ||
      expectedText === 'on' ||
      (expectedText !== 'false' &&
        expectedText !== '0' &&
        expectedText !== 'off' &&
        Boolean(expectedText));
    const isChecked = el.checked;
    const committed = isChecked === isTruthy;
    return {
      committed,
      currentValue: String(isChecked),
      expectedValue: String(isTruthy),
      length: String(isChecked).length,
      tagName: el.tagName.toLowerCase(),
      isComposer: false,
      submitButtonState: submitButtonState.found ? submitButtonState : undefined,
      diagnostics: committed
        ? undefined
        : `Checkbox checked state (${isChecked}) did not match expected (${isTruthy})`,
    };
  }

  // Select dropdowns
  if (el instanceof HTMLSelectElement) {
    const selectedText = el.selectedOptions?.[0]?.text?.trim() || '';
    const committed =
      el.value === expectedText ||
      selectedText === expectedText.trim() ||
      selectedText.includes(expectedText.trim());
    return {
      committed,
      currentValue: el.value,
      expectedValue: expectedText,
      length: el.value.length,
      tagName: 'select',
      isComposer: false,
      submitButtonState: submitButtonState.found ? submitButtonState : undefined,
      diagnostics: committed
        ? undefined
        : `Select value ("${el.value}") did not match expected ("${expectedText}")`,
    };
  }

  // Custom ARIA combobox and listbox
  if (
    el.getAttribute('role') === 'combobox' ||
    el.getAttribute('role') === 'listbox' ||
    el.getAttribute('aria-haspopup') === 'listbox'
  ) {
    const activeDescendant = el.getAttribute('aria-activedescendant');
    let selectedOptionText = '';
    if (activeDescendant) {
      const descEl = el.ownerDocument.getElementById(activeDescendant);
      if (descEl) selectedOptionText = descEl.textContent?.trim() || '';
    }
    const innerInput = el.querySelector('input');
    const innerVal = innerInput?.value || '';
    // The combobox control may ITSELF be the <input> (e.g. <input type="search" role="combobox">
    // as used by Wikipedia's Codex typeahead, Google and Amazon). For such elements
    // querySelector('input') is null and textContent is empty, so the element's own value must be
    // read too — otherwise a successful fill is reported as `Combobox value ("") did not match`.
    const ownVal =
      typeof (el as HTMLInputElement).value === 'string' ? (el as HTMLInputElement).value : '';
    const currentText = el.textContent?.trim() || '';
    const ariaVal = el.getAttribute('aria-valuenow') || '';
    const dataVal = el.getAttribute('data-value') || el.getAttribute('value') || '';

    // Check for aria-selected option
    const ariaControls = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    let ariaSelectedText = '';
    const rootNode = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
    const controlled = ariaControls
      ? (rootNode as ShadowRoot | Document)?.getElementById?.(ariaControls) ||
        el.ownerDocument.getElementById(ariaControls) ||
        document.getElementById(ariaControls)
      : null;
    const selectedEl =
      el.querySelector('[aria-selected="true"], [data-selected="true"]') ||
      controlled?.querySelector('[aria-selected="true"], [data-selected="true"]');
    if (selectedEl) {
      ariaSelectedText =
        selectedEl.textContent?.trim() || selectedEl.getAttribute('data-value') || '';
    }

    const normExp = cleanAndNormalizeText(expectedText).toLowerCase();
    const safeWord = normExp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = new RegExp(`(^|\\b|\\s)${safeWord}(\\b|\\s|$)`, 'i');

    const committed = Boolean(
      (selectedOptionText && cleanAndNormalizeText(selectedOptionText).toLowerCase() === normExp) ||
      (ariaSelectedText && cleanAndNormalizeText(ariaSelectedText).toLowerCase() === normExp) ||
      (ariaVal && cleanAndNormalizeText(ariaVal).toLowerCase() === normExp) ||
      (dataVal && cleanAndNormalizeText(dataVal).toLowerCase() === normExp) ||
      (ownVal && cleanAndNormalizeText(ownVal).toLowerCase() === normExp) ||
      (innerVal && cleanAndNormalizeText(innerVal).toLowerCase() === normExp) ||
      (currentText && cleanAndNormalizeText(currentText).toLowerCase() === normExp) ||
      (currentText && wordRegex.test(cleanAndNormalizeText(currentText))),
    );

    const displayVal =
      selectedOptionText ||
      ariaSelectedText ||
      ownVal ||
      innerVal ||
      currentText ||
      ariaVal ||
      dataVal;
    return {
      committed,
      currentValue: displayVal,
      expectedValue: expectedText,
      length: displayVal.length,
      tagName: el.tagName.toLowerCase(),
      isComposer: false,
      submitButtonState: submitButtonState.found ? submitButtonState : undefined,
      diagnostics: committed
        ? undefined
        : `Combobox value ("${displayVal.slice(0, 50)}") did not match expected ("${expectedText}")`,
    };
  }

  function cleanAndNormalize(str: string): string {
    return cleanAndNormalizeText(str);
  }

  const normExpected = cleanAndNormalize(expectedText);
  const normCurrent = cleanAndNormalize(currentValue);

  let committed = false;
  if (!normExpected) {
    // If clearing, committed means length is 0
    committed = normCurrent.length === 0;
  } else {
    // Check if input element has maxlength constraint
    const maxLen =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.maxLength > 0
          ? el.maxLength
          : -1
        : -1;
    const cappedExpected =
      maxLen > 0 && normExpected.length > maxLen ? normExpected.slice(0, maxLen) : normExpected;

    // Strictly committed if current value strictly matches expected text (or matches capped by maxlength)
    // Eliminates permissive normCurrent.includes(cappedExpected) which allowed concatenated multi-field values to falsely pass.
    const isStrictMatch =
      normCurrent.length > 0 &&
      (normCurrent === cappedExpected ||
        (maxLen > 0 && normCurrent === normExpected.slice(0, maxLen)));

    // Clean replacement / exact prefix matching (Requirement 2)
    // Supports phone number formatting (e.g. '(123) 456-7890' vs '1234567890'),
    // stripped formatting (e.g. '1234567890' vs '123-456-7890'),
    // and static currency/country formatting prefixes (e.g. '+1 ', '$ ', '¥ ')
    let isCleanMatch = false;
    if (!isStrictMatch && normCurrent.length > 0 && normExpected.length > 0) {
      const isPhoneOrNumber =
        (el instanceof HTMLInputElement && (el.type === 'tel' || el.type === 'number')) ||
        /phone|tel|mobile|zip|postal/i.test((el as HTMLInputElement).name || '') ||
        /phone|tel|mobile|zip|postal/i.test((el as HTMLInputElement).id || '');

      const digitsCurrent = normCurrent.replace(/\D/g, '');
      const digitsExpected = normExpected.replace(/\D/g, '');

      if (isPhoneOrNumber && digitsCurrent.length >= 7 && digitsCurrent === digitsExpected) {
        // Formatted phone or postal code match
        isCleanMatch = true;
      } else if (normCurrent.replace(/[\s().-]/g, '') === normExpected.replace(/[\s().-]/g, '')) {
        // Punctuation/spacing formatting difference
        isCleanMatch = true;
      } else if (normCurrent.endsWith(cappedExpected)) {
        // Static prefix check: prefix must only be non-alphanumeric formatting symbols (e.g. '+1 ', '$', '¥', '#')
        const prefix = normCurrent.slice(0, normCurrent.length - cappedExpected.length);
        if (prefix.length <= 4 && /^[$€£¥\s+#/:-]+$/.test(prefix)) {
          isCleanMatch = true;
        }
      }
    }

    committed = isStrictMatch || isCleanMatch;
  }

  // Check if associated action button is still disabled for composer / post targets
  const isPostOrComposer = Boolean(
    semantics.isComposer ||
    semantics.isEditor ||
    (submitButtonState.found &&
      /^(tweet|post|reply|send|发帖|发送|发布)/i.test(submitButtonState.text || '')),
  );

  let diagnostics: string | undefined;
  if (
    committed &&
    isPostOrComposer &&
    submitButtonState.found &&
    submitButtonState.disabled &&
    normExpected.length > 0
  ) {
    committed = false;
    diagnostics = `Associated action button ("${submitButtonState.text || 'Submit'}") remains disabled, indicating framework reactive state (React/Draft.js) has not committed the input.`;
  } else if (!committed) {
    diagnostics = `Element value ("${normCurrent.slice(0, 50)}") did not reflect expected input ("${normExpected.slice(0, 50)}").`;
  }

  return {
    committed,
    currentValue,
    expectedValue: expectedText,
    length: currentValue.length,
    tagName: el.tagName.toLowerCase(),
    isComposer: semantics.isComposer || semantics.isEditor,
    submitButtonState: submitButtonState.found ? submitButtonState : undefined,
    diagnostics,
  };
}

export interface PerceptiveSignature {
  question?: string;
  progress?: string;
  stepCurrent?: number;
  stepTotal?: number;
  activeInputs: Array<{
    index?: number;
    tagName: string;
    type?: string;
    name?: string;
    placeholder?: string;
    ariaLabel?: string;
    value?: string;
  }>;
  alerts: string[];
  url: string;
  title: string;
}

/**
 * Extracts key semantic perception signature from the active viewport:
 * - Active question headings (h1-h4, [role="heading"], .question-text)
 * - Step progress indicator (e.g. "2 of 15", "Step 3", "2 / 15")
 * - Currently visible active inputs/controls
 * - Active validation alerts and error banners
 */
export function inPageDetectPerceptiveSignature(): PerceptiveSignature {
  const win = window;
  const doc = document;
  const vh = win.innerHeight || 800;
  const vw = win.innerWidth || 1280;

  function isVisibleInViewport(el: Element): boolean {
    if (!el || !(el instanceof Element)) return false;
    let style: CSSStyleDeclaration | null = null;
    try {
      style = win.getComputedStyle(el);
    } catch {}
    if (
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      parseFloat(style?.opacity || '1') <= 0 ||
      style?.pointerEvents === 'none' ||
      el.hasAttribute('inert') ||
      (el as any).inert === true ||
      el.getAttribute('aria-hidden') === 'true' ||
      (typeof el.closest === 'function' && el.closest('[aria-hidden="true"], [inert]') !== null)
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0;
  }

  // 1. Detect question headings in active viewport
  let question: string | undefined;
  const headingSelectors = [
    'h1, h2, h3, h4',
    '[role="heading"]',
    '.question-text',
    '[data-qa*="question" i]',
    '[data-qa*="title" i]',
    '[class*="question" i]',
    '[class*="title" i]',
    '[class*="header" i]',
    'legend',
  ].join(', ');

  const headings = Array.from(doc.querySelectorAll(headingSelectors)).filter(isVisibleInViewport);
  headings.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

  for (const h of headings) {
    const text = (h.textContent || '').trim().replace(/\s+/g, ' ');
    if (text.length >= 3 && text.length <= 300) {
      question = text;
      break;
    }
  }

  // 2. Detect progress indicators (e.g. "2 of 15", "Step 3 of 10", "3 / 10", "20%")
  let progress: string | undefined;
  let stepCurrent: number | undefined;
  let stepTotal: number | undefined;

  const progressBars = Array.from(doc.querySelectorAll('[role="progressbar"]')).filter(
    isVisibleInViewport,
  );
  for (const pb of progressBars) {
    const valNow = pb.getAttribute('aria-valuenow');
    const valMax = pb.getAttribute('aria-valuemax');
    const ariaText = pb.getAttribute('aria-valuetext') || pb.getAttribute('aria-label');
    if (valNow && valMax) {
      stepCurrent = parseInt(valNow, 10);
      stepTotal = parseInt(valMax, 10);
      progress = `${stepCurrent} / ${stepTotal}`;
      break;
    } else if (ariaText) {
      const match = /\b(\d+)\s*(?:of|\/)\s*(\d+)\b/i.exec(ariaText);
      if (match) {
        stepCurrent = parseInt(match[1], 10);
        stepTotal = parseInt(match[2], 10);
        progress = `${stepCurrent} / ${stepTotal}`;
        break;
      }
    }
  }

  if (!progress) {
    const progressCandidateSelectors = [
      '[class*="progress" i]',
      '[class*="step" i]',
      '[data-qa*="progress" i]',
      '[data-qa*="step" i]',
      'span, div, p',
    ].join(', ');
    const candidates = Array.from(doc.querySelectorAll(progressCandidateSelectors)).filter(
      isVisibleInViewport,
    );
    for (const c of candidates) {
      if (c.children.length > 2) continue;
      const t = (c.textContent || '').trim();
      if (t.length > 40) continue;
      const match = /\b(\d+)\s*(?:of|\/)\s*(\d+)\b/i.exec(t);
      if (match) {
        stepCurrent = parseInt(match[1], 10);
        stepTotal = parseInt(match[2], 10);
        progress = `${stepCurrent} / ${stepTotal}`;
        break;
      }
      const stepMatch = /\bstep\s*(\d+)\b/i.exec(t);
      if (stepMatch) {
        stepCurrent = parseInt(stepMatch[1], 10);
        progress = t;
        break;
      }
      const zhMatch = /第\s*(\d+)\s*(?:题|步)(?:\s*(?:共|\/)\s*(\d+)\s*(?:题|步)?)?/i.exec(t);
      if (zhMatch) {
        stepCurrent = parseInt(zhMatch[1], 10);
        if (zhMatch[2]) stepTotal = parseInt(zhMatch[2], 10);
        progress = t;
        break;
      }
    }
  }

  // 3. Detect active form inputs in active viewport
  const isolatedMap = getIsolatedIndexMap();
  const indexLookup = new Map<Element, number>();
  for (const [idx, entry] of isolatedMap.entries()) {
    const target = derefElement(entry);
    if (target) indexLookup.set(target, idx);
  }

  const activeInputs: PerceptiveSignature['activeInputs'] = [];
  const inputElements = Array.from(
    doc.querySelectorAll(
      'input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="textbox"]',
    ),
  ).filter(isVisibleInViewport);

  let maxIdx = isolatedMap.size > 0 ? Math.max(...isolatedMap.keys()) : 0;

  for (const inp of inputElements) {
    const tag = inp.tagName.toLowerCase();
    const type = (inp as HTMLInputElement).type?.toLowerCase();
    const name = inp.getAttribute('name') || undefined;
    const placeholder = inp.getAttribute('placeholder') || undefined;
    const ariaLabel = inp.getAttribute('aria-label') || undefined;
    const value =
      inp instanceof HTMLInputElement || inp instanceof HTMLTextAreaElement
        ? inp.value
        : (inp as HTMLElement).innerText?.trim() || undefined;

    let inpIndex = indexLookup.get(inp);
    if (typeof inpIndex !== 'number') {
      maxIdx++;
      inpIndex = maxIdx;
      isolatedMap.set(inpIndex, wrapElement(inp));
      indexLookup.set(inp, inpIndex);
    }

    activeInputs.push({
      index: inpIndex,
      tagName: tag,
      type,
      name,
      placeholder,
      ariaLabel,
      value: value ? value.slice(0, 80) : undefined,
    });
  }

  // 4. Detect alerts and errors in active viewport
  const alerts: string[] = [];
  const alertElements = Array.from(
    doc.querySelectorAll(
      '[role="alert"], [role="status"], .error-message, [class*="error" i], [class*="invalid" i]',
    ),
  ).filter(isVisibleInViewport);

  for (const a of alertElements) {
    const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
    if (text.length >= 3 && text.length <= 200 && !alerts.includes(text)) {
      alerts.push(text);
    }
  }

  return {
    question,
    progress,
    stepCurrent,
    stepTotal,
    activeInputs,
    alerts,
    url: win.location.href,
    title: doc.title || '',
  };
}

export interface ChoiceCandidateItem {
  index: number;
  tagName: string;
  role?: string;
  text: string;
  ariaLabel?: string;
  value?: string;
}

/**
 * Scans viewport for interactive choice/option elements (buttons, radio buttons, options, tiles, links).
 * Automatically indexes unindexed elements in isolatedMap to enable physical click dispatch.
 */
export function inPageQueryChoiceCandidates(): ChoiceCandidateItem[] {
  const win = window;
  const doc = document;
  const vh = win.innerHeight || 800;
  const vw = win.innerWidth || 1280;

  function isVisibleInViewport(el: Element): boolean {
    if (!el || !(el instanceof Element)) return false;
    let style: CSSStyleDeclaration | null = null;
    try {
      style = win.getComputedStyle(el);
    } catch {}
    if (
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      parseFloat(style?.opacity || '1') <= 0 ||
      style?.pointerEvents === 'none' ||
      el.hasAttribute('inert') ||
      (el as any).inert === true ||
      el.getAttribute('aria-hidden') === 'true' ||
      (typeof el.closest === 'function' && el.closest('[aria-hidden="true"], [inert]') !== null)
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0;
  }

  const isolatedMap = getIsolatedIndexMap();
  const indexLookup = new Map<Element, number>();
  for (const [idx, entry] of isolatedMap.entries()) {
    const target = derefElement(entry);
    if (target) indexLookup.set(target, idx);
  }

  let maxIdx = isolatedMap.size > 0 ? Math.max(...isolatedMap.keys()) : 0;

  const selector =
    'button, [role="button"], [role="radio"], [role="option"], label, input[type="radio"], input[type="checkbox"], [role="checkbox"], a, li[role="treeitem"]';
  let elements: Element[];
  try {
    elements = querySelectorAllDeep(selector, doc).filter(isVisibleInViewport);
  } catch {
    elements = Array.from(doc.querySelectorAll(selector)).filter(isVisibleInViewport);
  }

  const results: ChoiceCandidateItem[] = [];
  for (const el of elements) {
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    const ariaLabel = el.getAttribute('aria-label') || undefined;
    const value =
      el instanceof HTMLInputElement || el instanceof HTMLButtonElement ? el.value : undefined;
    const role = el.getAttribute('role') || undefined;
    const tagName = el.tagName.toLowerCase();

    if (!text && !ariaLabel && !value) continue;

    let idx = indexLookup.get(el);
    if (typeof idx !== 'number') {
      maxIdx++;
      idx = maxIdx;
      isolatedMap.set(idx, wrapElement(el));
      indexLookup.set(el, idx);
    }

    results.push({
      index: idx,
      tagName,
      role,
      text: text || ariaLabel || value || '',
      ariaLabel,
      value,
    });
  }

  return results;
}

/**
 * Compares two perceptive signatures and generates a structured delta.
 */
export function computePerceptiveDelta(
  pre: PerceptiveSignature | null | undefined,
  post: PerceptiveSignature | null | undefined,
):
  | {
      advanced: boolean;
      questionChanged: boolean;
      progressChanged: boolean;
      previousQuestion?: string;
      currentQuestion?: string;
      previousProgress?: string;
      progress?: string;
      activeInputs: PerceptiveSignature['activeInputs'];
      errorMessage?: string;
      urlChanged: boolean;
    }
  | undefined {
  if (!post && !pre) return undefined;
  if (!post && pre) {
    return {
      advanced: false,
      questionChanged: false,
      progressChanged: false,
      previousQuestion: pre.question,
      currentQuestion: undefined,
      previousProgress: pre.progress,
      progress: undefined,
      activeInputs: [],
      urlChanged: false,
    };
  }
  if (post && !pre) {
    return {
      advanced: false,
      questionChanged: false,
      progressChanged: false,
      currentQuestion: post.question,
      progress: post.progress,
      activeInputs: post.activeInputs || [],
      errorMessage: post.alerts && post.alerts.length > 0 ? post.alerts.join('; ') : undefined,
      urlChanged: false,
    };
  }

  const p1 = pre!;
  const p2 = post!;

  const questionChanged = Boolean(
    (p1.question && p2.question && p1.question !== p2.question) ||
    (!p1.question && p2.question) ||
    (p1.question && !p2.question),
  );
  const progressChanged = Boolean(
    (p1.progress && p2.progress && p1.progress !== p2.progress) ||
    (!p1.progress && p2.progress) ||
    (p1.progress && !p2.progress),
  );
  const inputsDisappeared = Boolean(
    p1.activeInputs &&
    p1.activeInputs.length > 0 &&
    (!p2.activeInputs || p2.activeInputs.length === 0),
  );
  const stepAdvanced =
    (typeof p2.stepCurrent === 'number' &&
      typeof p1.stepCurrent === 'number' &&
      p2.stepCurrent > p1.stepCurrent) ||
    (typeof p2.stepCurrent === 'number' && p1.stepCurrent === undefined) ||
    progressChanged ||
    questionChanged ||
    inputsDisappeared;
  const urlChanged = Boolean(p1.url && p2.url && p1.url !== p2.url);
  const advanced = Boolean(stepAdvanced || urlChanged);

  return {
    advanced,
    questionChanged,
    progressChanged,
    previousQuestion: p1.question,
    currentQuestion: p2.question,
    previousProgress: p1.progress,
    progress: p2.progress,
    activeInputs: p2.activeInputs || [],
    errorMessage: p2.alerts && p2.alerts.length > 0 ? p2.alerts.join('; ') : undefined,
    urlChanged,
  };
}

/**
 * Extract clean hierarchical markdown from document.
 * Deeply traverses paragraphs and containers to preserve links, bold, code, and structural elements.
 */
export function inPageExtractMarkdown(includeLinks = true, fit = false): string {
  const droppedTags = new Set([
    'script',
    'style',
    'head',
    'meta',
    'link',
    'title',
    'noscript',
    'template',
    'svg',
  ]);

  function isVisible(el: Element): boolean {
    if (!(el instanceof HTMLElement)) return true;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') <= 0) return false;
    return true;
  }

  // fit 模式：crawl4ai 式启发降噪（chrome fit-markdown 的浏览器内等价物）。
  // 只删结构性噪声，不做 BM25/评分——agent 自己会过滤内容。
  let fitRoot: ParentNode = document;
  const fitNoise = new Set<Element>();
  if (fit) {
    try {
      const main = document.querySelector('article, main, [role=main], #content, .content');
      fitRoot =
        main instanceof HTMLElement && main.innerText.trim().length > 200 ? main : document.body;
      const noise = fitRoot.querySelectorAll(
        'nav, header, footer, aside, form, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true]',
      );
      noise.forEach((el) => fitNoise.add(el));
    } catch {}
  }

  function serializeChildren(node: Node): string {
    let res = '';
    for (const child of Array.from(node.childNodes)) {
      res += serializeNode(child);
    }
    return res;
  }

  function serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent || '').replace(/\r\n/g, '\n');
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (droppedTags.has(tag)) return '';
    if (fitNoise.size > 0 && fitNoise.has(el)) return '';
    if (!isVisible(el)) return '';

    // Handle image elements
    if (tag === 'img') {
      const src = (el as HTMLImageElement).src || el.getAttribute('src') || '';
      const alt = el.getAttribute('alt') || '';
      if (!src) return '';
      return alt ? `![${alt}](${src})` : `![](${src})`;
    }

    // Handle horizontal rule and line break
    if (tag === 'hr') return '\n\n---\n\n';
    if (tag === 'br') return '\n';

    let inner = '';
    const shadow = getShadowRoot(el);
    if (shadow) {
      for (const child of Array.from(shadow.childNodes)) {
        inner += serializeNode(child);
      }
    } else {
      inner = serializeChildren(el);
    }

    const trimmed = inner.trim();

    // Preserve whitespace around inline formatting tokens
    const leadingSpace = inner.match(/^\s*/)?.[0] || '';
    const trailingSpace = inner.match(/\s*$/)?.[0] || '';

    switch (tag) {
      case 'h1':
        return trimmed ? `\n\n# ${trimmed}\n\n` : '';
      case 'h2':
        return trimmed ? `\n\n## ${trimmed}\n\n` : '';
      case 'h3':
        return trimmed ? `\n\n### ${trimmed}\n\n` : '';
      case 'h4':
        return trimmed ? `\n\n#### ${trimmed}\n\n` : '';
      case 'h5':
        return trimmed ? `\n\n##### ${trimmed}\n\n` : '';
      case 'h6':
        return trimmed ? `\n\n###### ${trimmed}\n\n` : '';
      case 'p':
        return trimmed ? `\n\n${trimmed}\n\n` : '';
      case 'a': {
        const href = (el as HTMLAnchorElement).href || el.getAttribute('href');
        if (includeLinks && href && trimmed) {
          return `${leadingSpace}[${trimmed}](${href})${trailingSpace}`;
        }
        return `${leadingSpace}${trimmed}${trailingSpace}`;
      }
      case 'strong':
      case 'b':
        return trimmed ? `${leadingSpace}**${trimmed}**${trailingSpace}` : '';
      case 'em':
      case 'i':
        return trimmed ? `${leadingSpace}*${trimmed}*${trailingSpace}` : '';
      case 'code':
        return trimmed ? `${leadingSpace}\`${trimmed}\`${trailingSpace}` : '';
      case 'pre': {
        const codeText = (el.textContent || '').trim();
        return codeText ? `\n\n\`\`\`\n${codeText}\n\`\`\`\n\n` : '';
      }
      case 'blockquote':
        return trimmed ? `\n\n> ${trimmed.replace(/\n/g, '\n> ')}\n\n` : '';
      case 'li': {
        const parentTag = el.parentElement?.tagName.toLowerCase();
        if (parentTag === 'ol') {
          const siblings = Array.from(el.parentElement?.children || []).filter(
            (c) => c.tagName.toLowerCase() === 'li',
          );
          const idx = siblings.indexOf(el) + 1;
          return `\n${idx > 0 ? idx : 1}. ${trimmed}`;
        }
        return trimmed ? `\n- ${trimmed}` : '';
      }
      case 'ul':
      case 'ol':
        return trimmed ? `\n\n${trimmed}\n\n` : '';
      case 'button':
        return trimmed ? `[Button: ${trimmed}]` : '';
      case 'table':
        return trimmed ? `\n\n${trimmed}\n\n` : '';
      case 'tr': {
        const cells = Array.from(el.children).filter(
          (c) => c.tagName.toLowerCase() === 'td' || c.tagName.toLowerCase() === 'th',
        );
        if (cells.length === 0) return '';
        const rowStr =
          '| ' +
          cells.map((c) => (c.textContent || '').trim().replace(/\|/g, '\\|')).join(' | ') +
          ' |';
        const isHeaderRow =
          cells.every((c) => c.tagName.toLowerCase() === 'th') ||
          el.parentElement?.tagName.toLowerCase() === 'thead';
        if (isHeaderRow) {
          const sep = '| ' + cells.map(() => '---').join(' | ') + ' |';
          return `\n${rowStr}\n${sep}`;
        }
        return `\n${rowStr}`;
      }
      case 'td':
      case 'th':
        return trimmed;
      case 'thead':
      case 'tbody':
      case 'tfoot':
        return inner;
      case 'div':
      case 'section':
      case 'article':
      case 'main':
      case 'header':
      case 'footer':
      case 'aside':
      case 'nav':
        return trimmed ? `\n\n${trimmed}\n\n` : '';
      default:
        return inner;
    }
  }

  const rawSource: Node = fit ? fitRoot : (document.body as Node);
  const raw = rawSource ? serializeNode(rawSource) : '';

  // Apply light SPA JSON blob cleanup mirroring browser-use
  const processed = raw
    .replace(/`\{["\w].*?\}`/gs, '')
    .replace(/\{"\$type":[^}]{100,}\}/g, '')
    .replace(/\{"[^"]{5,}":\{[^}]{100,}\}/g, '');

  const lines = processed.split('\n');
  const filteredLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 100 && (trimmed.startsWith('{') || trimmed.startsWith('{"'))) {
      try {
        JSON.parse(trimmed);
        continue;
      } catch {}
    }
    filteredLines.push(line.trimEnd());
  }

  try {
    delete (window as any).__mcpFitNoise__;
  } catch {}

  return filteredLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface DropdownOptionItem {
  text: string;
  value: string;
  index: number;
  selected: boolean;
}

export interface DropdownOptionsResult {
  success: boolean;
  type: 'select' | 'aria' | 'custom';
  id?: string;
  name?: string;
  options: DropdownOptionItem[];
  error?: string;
}

/**
 * In-page dropdown options extractor.
 * Supports native <select>, ARIA comboboxes/menus, and common custom UI dropdowns.
 * Lives here (not get-dropdown-options.ts) so the bundled inpage-engine script
 * can register it for file-based injection.
 */
export async function inPageExtractDropdownOptions(
  targetIndex?: number,
  targetSelector?: string,
): Promise<DropdownOptionsResult> {
  let element: Element | null = null;
  if (typeof targetIndex === 'number' && targetIndex > 0) {
    element = findIndexedElement(targetIndex);
  }
  if (!element && targetSelector) {
    element = document.querySelector(targetSelector);
  }

  if (!element) {
    return {
      success: false,
      type: 'select',
      options: [],
      error: `Element not found for index: ${targetIndex} or selector: ${targetSelector}`,
    };
  }

  const tagName = element.tagName.toLowerCase();

  // 1. Native <select> element (or container wrapping a <select>)
  const selectEl =
    tagName === 'select' ? (element as HTMLSelectElement) : element.querySelector('select');
  if (selectEl) {
    const options: DropdownOptionItem[] = Array.from(selectEl.options).map((opt, idx) => ({
      text: opt.text.trim(),
      value: opt.value,
      index: idx,
      selected: opt.selected,
    }));

    return {
      success: true,
      type: 'select',
      id: selectEl.id || undefined,
      name: selectEl.name || undefined,
      options,
    };
  }

  // 2. ARIA combobox / listbox / menu
  const role = element.getAttribute('role')?.toLowerCase();
  const ariaControls = element.getAttribute('aria-controls');
  const ariaOwns = element.getAttribute('aria-owns');

  if (role === 'combobox' || role === 'listbox' || role === 'menu' || ariaControls || ariaOwns) {
    // If it's a closed combobox, try opening it and wait for React/Vue portal mount
    if (role === 'combobox' && element.getAttribute('aria-expanded') !== 'true') {
      try {
        (element as HTMLElement).focus?.();
        try {
          element.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
          );
        } catch {}
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        (element as HTMLElement).click?.();
        // Micro-wait (50-100ms) for framework dropdown/portal to mount
        await new Promise((resolve) => setTimeout(resolve, 80));
      } catch {}
    }

    let searchRoot: Element = element;
    if (ariaControls) {
      const controlledEl = document.getElementById(ariaControls);
      if (controlledEl) searchRoot = controlledEl;
    } else if (ariaOwns) {
      const ownedEl = document.getElementById(ariaOwns);
      if (ownedEl) searchRoot = ownedEl;
    }

    let items = searchRoot.querySelectorAll('[role="option"], [role="menuitem"]');
    // If empty, search document-level active popups/listboxes (common in React/Vue portals)
    if (items.length === 0) {
      // Small sleep in case portal is mounting asynchronously
      await new Promise((resolve) => setTimeout(resolve, 60));
      const portalRoot = document.querySelector(
        '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], [data-floating-ui-portal], .ant-select-dropdown, .el-select-dropdown, .MuiMenu-paper, [class*="select-dropdown"], [class*="dropdown-menu"]',
      );
      if (portalRoot) {
        items = portalRoot.querySelectorAll(
          '[role="option"], [role="menuitem"], [role="treeitem"], [data-radix-collection-item], [data-combobox-option], .ant-select-item-option, .el-select-dropdown__item, .MuiMenuItem-root, .v-list-item, [class*="option" i], [class*="select-item" i]',
        );
      }
    }

    const options: DropdownOptionItem[] = [];

    items.forEach((item, idx) => {
      const text = item.textContent?.trim() || '';
      if (text) {
        options.push({
          text,
          value: item.getAttribute('data-value') || item.getAttribute('value') || text,
          index: idx,
          selected:
            item.getAttribute('aria-selected') === 'true' ||
            item.getAttribute('aria-checked') === 'true' ||
            item.getAttribute('data-state') === 'checked' ||
            item.getAttribute('data-state') === 'selected' ||
            item.classList.contains('selected') ||
            item.classList.contains('is-selected') ||
            item.classList.contains('active') ||
            item.classList.contains('Mui-selected') ||
            item.classList.contains('ant-select-item-option-selected') ||
            /(selected|active|checked)/i.test(
              typeof item.className === 'string' ? item.className : '',
            ),
        });
      }
    });

    if (options.length > 0) {
      return {
        success: true,
        type: 'aria',
        id: element.id || undefined,
        name: element.getAttribute('aria-label') || undefined,
        options,
      };
    }
  }

  // 3. Custom dropdowns (Semantic UI, Bootstrap, Tailwind, etc.)
  const customItems = element.querySelectorAll('.item, .option, li[data-value], [data-value]');
  if (customItems.length > 0) {
    const options: DropdownOptionItem[] = [];
    customItems.forEach((item, idx) => {
      const text = item.textContent?.trim() || '';
      if (text) {
        options.push({
          text,
          value: item.getAttribute('data-value') || text,
          index: idx,
          selected:
            item.getAttribute('aria-selected') === 'true' ||
            item.getAttribute('aria-checked') === 'true' ||
            item.getAttribute('data-state') === 'checked' ||
            item.getAttribute('data-state') === 'selected' ||
            item.classList.contains('selected') ||
            item.classList.contains('is-selected') ||
            item.classList.contains('active') ||
            /(selected|active|checked)/i.test(
              typeof item.className === 'string' ? item.className : '',
            ),
        });
      }
    });

    if (options.length > 0) {
      return {
        success: true,
        type: 'custom',
        id: element.id || undefined,
        name: element.getAttribute('aria-label') || undefined,
        options,
      };
    }
  }

  return {
    success: false,
    type: 'select',
    options: [],
    error: `Target element <${tagName}> is neither a native select nor an ARIA/custom dropdown menu`,
  };
}

export interface SmartScrollTargetInfo {
  found: boolean;
  isWindow: boolean;
  tagName: string;
  selector?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  canScrollDown: boolean;
  canScrollUp: boolean;
  canScrollRight: boolean;
  canScrollLeft: boolean;
}

/**
 * Identify the optimal scrollable container on the page, or target a specific
 * container by selector, ref, or coordinate.
 */
export function inPageFindSmartScrollTarget(options?: {
  selector?: string;
  ref?: number;
  coordinate?: { x: number; y: number };
  direction?: 'down' | 'up' | 'left' | 'right';
  isWindow?: boolean;
}): SmartScrollTargetInfo {
  // If explicitly requested window scroll, skip container search
  if (!options?.isWindow) {
    let targetEl: Element | null = null;

    if (typeof options?.ref === 'number') {
      targetEl = findIndexedElement(options.ref);
    } else if (options?.selector) {
      try {
        targetEl = document.querySelector(options.selector);
      } catch {}
    } else if (options?.coordinate) {
      try {
        if (typeof document.elementFromPoint === 'function') {
          targetEl = document.elementFromPoint(options.coordinate.x, options.coordinate.y);
        }
      } catch {}
    }

    // If a target element was specified, check if it or an ancestor is scrollable
    if (targetEl) {
      let curr: Element | null = targetEl;
      while (curr && curr !== document.body && curr !== document.documentElement) {
        const isScrollable =
          (curr.scrollHeight > curr.clientHeight + 10 ||
            curr.scrollWidth > curr.clientWidth + 10) &&
          /(auto|scroll|overlay)/i.test(
            (window.getComputedStyle?.(curr)?.overflowY || '') +
              ' ' +
              (window.getComputedStyle?.(curr)?.overflowX || ''),
          );
        if (isScrollable) {
          targetEl = curr;
          break;
        }
        curr = curr.parentElement;
      }
      if (curr === document.body || curr === document.documentElement) {
        targetEl = null; // Fall back to window
      }
    }

    // If no explicit target, find the optimal scrollable container using the Priority Scroll Engine
    if (
      !targetEl &&
      typeof document !== 'undefined' &&
      typeof document.querySelectorAll === 'function'
    ) {
      const winW = typeof window !== 'undefined' ? window.innerWidth || 800 : 800;
      const winH = typeof window !== 'undefined' ? window.innerHeight || 600 : 600;
      const vpCenterX = winW / 2;
      const vpCenterY = winH / 2;

      // Check whether window/document itself can scroll in requested direction
      const doc = (
        typeof document !== 'undefined' ? document.documentElement || document.body : null
      ) as HTMLElement | null;
      const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
      const currentScrollY =
        win?.scrollY ||
        win?.pageYOffset ||
        doc?.scrollTop ||
        (typeof document !== 'undefined' ? document.body?.scrollTop : 0) ||
        0;
      const currentScrollX =
        win?.scrollX ||
        win?.pageXOffset ||
        doc?.scrollLeft ||
        (typeof document !== 'undefined' ? document.body?.scrollLeft : 0) ||
        0;
      const winScrollHeight = Math.max(
        doc?.scrollHeight || 0,
        (typeof document !== 'undefined' ? document.body?.scrollHeight : 0) || 0,
        winH,
      );
      const winScrollWidth = Math.max(
        doc?.scrollWidth || 0,
        (typeof document !== 'undefined' ? document.body?.scrollWidth : 0) || 0,
        winW,
      );

      let windowCanScrollInDir = winScrollHeight > winH + 15;
      if (options?.direction === 'down') {
        windowCanScrollInDir =
          winScrollHeight > winH + 15 && currentScrollY + winH < winScrollHeight - 5;
      } else if (options?.direction === 'up') {
        windowCanScrollInDir = currentScrollY > 5;
      } else if (options?.direction === 'right') {
        windowCanScrollInDir =
          winScrollWidth > winW + 15 && currentScrollX + winW < winScrollWidth - 5;
      } else if (options?.direction === 'left') {
        windowCanScrollInDir = currentScrollX > 5;
      }

      // Probe scroll container of the central viewport element
      let centerScrollParent: Element | null = null;
      if (typeof document.elementFromPoint === 'function') {
        try {
          let probeEl = document.elementFromPoint(vpCenterX, vpCenterY);
          while (probeEl && probeEl !== document.body && probeEl !== document.documentElement) {
            const sh = probeEl.scrollHeight;
            const ch = probeEl.clientHeight;
            const sw = probeEl.scrollWidth;
            const cw = probeEl.clientWidth;
            if (sh > ch + 10 || sw > cw + 10) {
              const style = window.getComputedStyle?.(probeEl);
              const overflow = (style?.overflowY || '') + ' ' + (style?.overflowX || '');
              if (/(auto|scroll|overlay)/i.test(overflow)) {
                centerScrollParent = probeEl;
                break;
              }
            }
            probeEl = probeEl.parentElement;
          }
        } catch {}
      }

      let bestScore = -1;
      let bestEl: Element | null = null;
      const allElements = document.querySelectorAll('*');

      for (const el of Array.from(allElements)) {
        if (el === document.body || el === document.documentElement) continue;
        const sh = el.scrollHeight;
        const ch = el.clientHeight;
        const sw = el.scrollWidth;
        const cw = el.clientWidth;
        if (sh <= ch + 10 && sw <= cw + 10) continue;

        const scrollTop = el.scrollTop || 0;
        const scrollLeft = el.scrollLeft || 0;
        const canScrollDown = scrollTop + ch < sh - 5;
        const canScrollUp = scrollTop > 5;
        const canScrollRight = scrollLeft + cw < sw - 5;
        const canScrollLeft = scrollLeft > 5;

        let canScrollInDir = true;
        if (options?.direction === 'down') canScrollInDir = canScrollDown;
        else if (options?.direction === 'up') canScrollInDir = canScrollUp;
        else if (options?.direction === 'right') canScrollInDir = canScrollRight;
        else if (options?.direction === 'left') canScrollInDir = canScrollLeft;
        else canScrollInDir = canScrollDown || canScrollUp || canScrollRight || canScrollLeft;

        // Disqualify containers that are exhausted in the requested direction
        if (!canScrollInDir) continue;

        const style = window.getComputedStyle?.(el);
        if (!style) continue;
        const overflow = (style.overflowY || '') + ' ' + (style.overflowX || '');
        if (!/(auto|scroll|overlay)/i.test(overflow)) continue;
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          parseFloat(style.opacity || '1') <= 0
        )
          continue;

        const rect =
          typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        if (!rect) continue;

        const vLeft = Math.max(0, rect.left);
        const vTop = Math.max(0, rect.top);
        const vRight = Math.min(winW, rect.right);
        const vBottom = Math.min(winH, rect.bottom);
        const visibleWidth = vRight - vLeft;
        const visibleHeight = vBottom - vTop;
        if (visibleWidth < 50 || visibleHeight < 50) continue;

        const elCenterX = rect.left + rect.width / 2;
        const distX = Math.abs(elCenterX - vpCenterX);
        const centerProximity = Math.max(0.05, 1 - (distX / (winW / 2)) * 0.85);
        const straddlesCenter = rect.left <= vpCenterX && rect.right >= vpCenterX;

        // Width & aspect ratio penalty: heavily penalize narrow sidebars / columns (<300px)
        const widthPenalty = rect.width < 220 ? 0.1 : rect.width < 320 ? 0.3 : 1.0;

        // Semantic analysis: negative weighting for navigation/sidebars
        const getAttr = (k: string) =>
          typeof el.getAttribute === 'function' ? el.getAttribute(k) || '' : '';
        const tag = el.tagName.toLowerCase();
        const role = getAttr('role').toLowerCase();
        const idClass = (
          (el.id || '') +
          ' ' +
          (typeof el.className === 'string' ? el.className : '') +
          ' ' +
          getAttr('data-testid') +
          ' ' +
          getAttr('aria-label')
        ).toLowerCase();

        const isNavOrSidebar =
          tag === 'nav' ||
          tag === 'aside' ||
          tag === 'header' ||
          tag === 'footer' ||
          role === 'navigation' ||
          role === 'banner' ||
          role === 'complementary' ||
          role === 'menu' ||
          role === 'menubar' ||
          role === 'tablist' ||
          /(sidebar|side-nav|sidenav|navigation|navbar|rail|drawer|menu-list|toc|panel-left|left-rail|right-rail)/i.test(
            idClass,
          );

        const semanticMultiplier = isNavOrSidebar ? 0.05 : 1.0;

        // Content boost for main article / feed containers
        const isMainContent =
          tag === 'main' ||
          tag === 'article' ||
          role === 'main' ||
          /(main-content|post-container|feed|scroll-content|timeline|messages|discussion)/i.test(
            idClass,
          );

        const contentBoost = isMainContent ? 2.0 : 1.0;

        // Proximity boost if element matches the viewport center's scroll parent
        const isCenterParent =
          centerScrollParent &&
          (el === centerScrollParent ||
            el.contains(centerScrollParent) ||
            centerScrollParent.contains(el));
        const centerParentBoost = isCenterParent ? 3.0 : 1.0;

        const baseArea = visibleWidth * visibleHeight;
        const interactiveCount =
          typeof el.querySelectorAll === 'function'
            ? el.querySelectorAll('button, a, input, select, textarea, [role="button"]').length
            : 0;
        const interactiveFactor = 1 + 0.1 * Math.min(5, interactiveCount);

        const score =
          baseArea *
          centerProximity *
          widthPenalty *
          semanticMultiplier *
          contentBoost *
          centerParentBoost *
          (straddlesCenter ? 1.5 : 1.0) *
          interactiveFactor;

        if (score > bestScore) {
          bestScore = score;
          bestEl = el;
        }
      }

      // Default to window if viewport center has no scroll container and window can scroll,
      // or if best candidate is a penalized sidebar
      const bestIsPenalizedSidebar = bestEl
        ? /sidebar|side-nav|sidenav|navigation|navbar|rail|drawer|menu-list|toc/i.test(
            bestEl.id + ' ' + (typeof bestEl.className === 'string' ? bestEl.className : ''),
          )
        : false;
      const shouldPreferWindow =
        windowCanScrollInDir &&
        (!bestEl ||
          (bestIsPenalizedSidebar && bestScore < winW * winH * 0.35) ||
          bestScore < winW * winH * 0.02);

      if (!shouldPreferWindow && bestEl) {
        targetEl = bestEl;
      }
    }

    if (targetEl && typeof targetEl.getBoundingClientRect === 'function') {
      const rect = targetEl.getBoundingClientRect();
      const scrollTop = targetEl.scrollTop || 0;
      const scrollLeft = targetEl.scrollLeft || 0;
      const scrollHeight = targetEl.scrollHeight || 0;
      const scrollWidth = targetEl.scrollWidth || 0;
      const clientHeight = targetEl.clientHeight || 0;
      const clientWidth = targetEl.clientWidth || 0;

      let selector: string;
      if (targetEl.id) {
        const safeId =
          typeof CSS !== 'undefined' && CSS.escape
            ? CSS.escape(targetEl.id)
            : targetEl.id.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, '\\$1');
        selector = `#${safeId}`;
      } else {
        try {
          targetEl.setAttribute('data-browserclaw-scroll-target', 'true');
          selector = `${targetEl.tagName.toLowerCase()}[data-browserclaw-scroll-target="true"]`;
        } catch {
          selector = targetEl.tagName.toLowerCase();
        }
      }

      const winW = typeof window !== 'undefined' ? window.innerWidth || 800 : 800;
      const winH = typeof window !== 'undefined' ? window.innerHeight || 600 : 600;
      const margins =
        typeof window !== 'undefined' ? getStickyOcclusionMargins(window) : { top: 0, bottom: 0 };
      const safeTopMargin = Math.min(Math.max(margins.top, 80), Math.round(winH * 0.35));
      const safeBottomMargin = Math.min(Math.max(margins.bottom, 80), Math.round(winH * 0.35));
      const vLeft = Math.max(0, rect.left);
      const vTop = Math.max(safeTopMargin, rect.top);
      const vRight = Math.min(winW, rect.right);
      const vBottom = Math.min(winH - safeBottomMargin, rect.bottom);
      const visibleWidth = Math.max(1, vRight - vLeft);
      const visibleHeight = Math.max(1, vBottom - vTop);
      const dispatchX = Math.round(vLeft + visibleWidth / 2);
      const dispatchY = Math.round(vTop + visibleHeight / 2);

      return {
        found: true,
        isWindow: false,
        tagName: targetEl.tagName.toLowerCase(),
        selector,
        x: dispatchX,
        y: dispatchY,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scrollLeft,
        scrollTop,
        scrollWidth,
        scrollHeight,
        clientWidth,
        clientHeight,
        canScrollDown: scrollTop + clientHeight < scrollHeight - 5,
        canScrollUp: scrollTop > 5,
        canScrollRight: scrollLeft + clientWidth < scrollWidth - 5,
        canScrollLeft: scrollLeft > 5,
      };
    }
  }

  // Fallback to Window / Document
  const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
  const doc = (
    typeof document !== 'undefined' ? document.documentElement || document.body : null
  ) as HTMLElement | null;
  const scrollY = win?.scrollY || win?.pageYOffset || doc?.scrollTop || 0;
  const scrollX = win?.scrollX || win?.pageXOffset || doc?.scrollLeft || 0;
  const clientWidth = win?.innerWidth || doc?.clientWidth || 800;
  const clientHeight = win?.innerHeight || doc?.clientHeight || 600;
  const scrollHeight = Math.max(
    doc?.scrollHeight || 0,
    (typeof document !== 'undefined' ? document.body?.scrollHeight : 0) || 0,
    clientHeight,
  );
  const scrollWidth = Math.max(
    doc?.scrollWidth || 0,
    (typeof document !== 'undefined' ? document.body?.scrollWidth : 0) || 0,
    clientWidth,
  );

  const winMargins = win ? getStickyOcclusionMargins(win) : { top: 0, bottom: 0 };
  const safeTop = Math.min(Math.max(winMargins.top, 80), Math.round(clientHeight * 0.35));
  const safeBottom =
    clientHeight - Math.min(Math.max(winMargins.bottom, 80), Math.round(clientHeight * 0.35));
  const effectiveH = Math.max(10, safeBottom - safeTop);
  const windowDispatchY = Math.round(safeTop + effectiveH / 2);

  return {
    found: true,
    isWindow: true,
    tagName: 'window',
    x: Math.round(clientWidth / 2),
    y: windowDispatchY,
    width: clientWidth,
    height: clientHeight,
    scrollLeft: scrollX,
    scrollTop: scrollY,
    scrollWidth,
    scrollHeight,
    clientWidth,
    clientHeight,
    canScrollDown: scrollY + clientHeight < scrollHeight - 5,
    canScrollUp: scrollY > 5,
    canScrollRight: scrollX + clientWidth < scrollWidth - 5,
    canScrollLeft: scrollX > 5,
  };
}

export function inPagePerformSmartScroll(
  isWindow: boolean,
  selector: string | undefined,
  deltaX: number,
  deltaY: number,
  smooth = true,
): {
  success: boolean;
  newScrollTop: number;
  newScrollLeft: number;
  canScrollDown: boolean;
  canScrollUp: boolean;
} {
  const behavior = smooth ? ('smooth' as ScrollBehavior) : ('auto' as ScrollBehavior);
  if (isWindow || !selector) {
    if (typeof window !== 'undefined' && typeof window.scrollBy === 'function') {
      window.scrollBy({ left: deltaX, top: deltaY, behavior });
    }
    const doc = (
      typeof document !== 'undefined' ? document.documentElement || document.body : null
    ) as HTMLElement | null;
    const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
    const scrollY = win?.scrollY || win?.pageYOffset || doc?.scrollTop || 0;
    const scrollX = win?.scrollX || win?.pageXOffset || doc?.scrollLeft || 0;
    const clientHeight = win?.innerHeight || doc?.clientHeight || 600;
    const scrollHeight = Math.max(
      doc?.scrollHeight || 0,
      (typeof document !== 'undefined' ? document.body?.scrollHeight : 0) || 0,
      clientHeight,
    );
    return {
      success: true,
      newScrollTop: Math.round(scrollY),
      newScrollLeft: Math.round(scrollX),
      canScrollDown: scrollY + clientHeight < scrollHeight - 5,
      canScrollUp: scrollY > 5,
    };
  }

  let el: Element | null = null;
  if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
    try {
      el = document.querySelector(selector);
    } catch {}
  }
  if (!el) {
    if (typeof window !== 'undefined' && typeof window.scrollBy === 'function') {
      window.scrollBy({ left: deltaX, top: deltaY, behavior });
    }
    const doc = (
      typeof document !== 'undefined' ? document.documentElement || document.body : null
    ) as HTMLElement | null;
    const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
    return {
      success: true,
      newScrollTop: Math.round(win?.scrollY || doc?.scrollTop || 0),
      newScrollLeft: Math.round(win?.scrollX || doc?.scrollLeft || 0),
      canScrollDown: true,
      canScrollUp: false,
    };
  }

  if (typeof el.scrollBy === 'function') {
    el.scrollBy({ left: deltaX, top: deltaY, behavior });
  } else {
    el.scrollTop += deltaY;
    el.scrollLeft += deltaX;
  }
  return {
    success: true,
    newScrollTop: Math.round(el.scrollTop),
    newScrollLeft: Math.round(el.scrollLeft),
    canScrollDown: el.scrollTop + el.clientHeight < el.scrollHeight - 5,
    canScrollUp: el.scrollTop > 5,
  };
}

/**
 * Resolve an asset index (from inPageDOMPruner assets) to image data.
 * Primary path pulls real bytes: canvas -> toDataURL, img/bg-image ->
 * fetch + FileReader in page context (same-origin or CORS-enabled only).
 * Returns rect so background can fall back to viewport cropping when bytes
 * are not obtainable (tainted canvas, opaque cross-origin, video).
 */
export async function inPageGetAssetImage(assetIndex: number): Promise<{
  success: boolean;
  reason?: string;
  dataUrl?: string;
  rect?: { x: number; y: number; width: number; height: number };
  kind?: string;
  src?: string;
}> {
  const MAP_KEY = Symbol.for('__browser_use_page_assets__') as any;
  const assets = (globalThis as any)[MAP_KEY];
  const entry = assets && assets[assetIndex - 1];
  if (!entry)
    return {
      success: false,
      reason: `asset ${assetIndex} not found (run ${resolveToolName('read_dom')} first)`,
    };
  const rect = entry.el.getBoundingClientRect().toJSON();
  const out: any = {
    success: false,
    reason: 'unsupported',
    dataUrl: undefined,
    rect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    kind: entry.kind,
    src: entry.src,
  };
  try {
    if (entry.kind === 'canvas') {
      out.dataUrl = (entry.el as HTMLCanvasElement).toDataURL('image/png');
      out.success = true;
      return out;
    }
    const src = entry.src;
    if (!src) {
      out.reason = 'no src (video/streams must be cropped)';
      return out;
    }
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) {
      out.reason = `fetch ${res.status}`;
      return out;
    }
    const blob = await res.blob();
    out.dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('FileReader failed'));
      fr.readAsDataURL(blob);
    });
    out.success = true;
    return out;
  } catch (err) {
    out.success = false;
    out.reason = String(err instanceof Error ? err.message : err);
    return out;
  }
}

/**
 * Extract crawlable links (absolute URL, anchor text, internal/external,
 * nofollow). Read-only; runs in the page's isolated world.
 */
export function inPageGetLinks(options?: {
  selector?: string;
  sameOriginOnly?: boolean;
  includeEmptyHref?: boolean;
}): Array<{ url: string; text: string; internal: boolean; nofollow: boolean }> {
  const root: ParentNode = options?.selector
    ? (document.querySelector(options.selector) ?? document)
    : document;
  const anchors = root.querySelectorAll('a[href]');
  const out: Array<{ url: string; text: string; internal: boolean; nofollow: boolean }> = [];
  const seen = new Set<string>();
  anchors.forEach((a) => {
    const href = (a as HTMLAnchorElement).href;
    if (!href || !/^https?:/i.test(href)) return;
    if (seen.has(href)) return;
    seen.add(href);
    const rel = (a.getAttribute('rel') || '').toLowerCase();
    const nofollow = rel.includes('nofollow');
    const internal = new URL(href, location.href).origin === location.origin;
    if (options?.sameOriginOnly && !internal) return;
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    out.push({ url: href, text, internal, nofollow });
  });
  return out;
}
export function inPageCheckInterception(
  index: number,
  x: number,
  y: number,
): {
  intercepted: boolean;
  description?: string;
  canPierce?: boolean;
  pierceReason?: string;
} {
  const el = findIndexedElement(index);
  if (!el || !(el instanceof Element)) return { intercepted: false };

  const intercepting = interceptingElementAtPoint(el, x, y);
  if (
    intercepting &&
    intercepting !== el &&
    !el.contains(intercepting) &&
    !intercepting.contains(el)
  ) {
    const win = intercepting.ownerDocument?.defaultView || window;
    let isTransparentOrTransient = false;
    let pierceReason: string | undefined;

    try {
      const style = win.getComputedStyle(intercepting);
      // 1. Pointer-events: none -> passes straight through
      if (style.pointerEvents === 'none') {
        return { intercepted: false };
      }
      // 2. Hidden display / visibility -> passes straight through
      if (style.display === 'none' || style.visibility === 'hidden') {
        return { intercepted: false };
      }
      // 3. Near-zero opacity -> non-opaque overlay
      const op = parseFloat(style.opacity || '1');
      if (op <= 0.05) {
        isTransparentOrTransient = true;
        pierceReason = 'zero_opacity';
      }

      // 4. Transparent background color (e.g. rgba(0, 0, 0, 0) or transparent)
      const bg = (style.backgroundColor || '').toLowerCase().replace(/\s+/g, '');
      const isTransparentBg =
        bg === 'transparent' || bg === 'rgba(0,0,0,0)' || bg === 'hsla(0,0%,0%,0)';

      // 5. Transient backdrop masks / loading stubs / fading transitions
      const classIdStr =
        `${intercepting.className || ''} ${intercepting.id || ''} ${intercepting.getAttribute('role') || ''}`.toLowerCase();
      const isMaskOrBackdrop =
        /(backdrop|mask|overlay|loading|spinner|shim|transition|fading|fade-out|toast|stub)/i.test(
          classIdStr,
        );
      const isAriaHidden = intercepting.getAttribute('aria-hidden') === 'true';
      const isPresentation = intercepting.getAttribute('role') === 'presentation';

      // Check if intercepting element has no interactive children
      const hasInteractiveChildren = Boolean(
        intercepting.querySelector?.('button, a, input, textarea, select, [role="button"]'),
      );

      if (
        !hasInteractiveChildren &&
        (isMaskOrBackdrop || isAriaHidden || isPresentation || isTransparentBg || op <= 0.1)
      ) {
        isTransparentOrTransient = true;
        pierceReason =
          pierceReason || (isTransparentBg ? 'transparent_background' : 'transient_mask');
      }
    } catch {}

    const desc = describeHitTarget(intercepting);
    if (isTransparentOrTransient) {
      return {
        intercepted: true,
        description: desc,
        canPierce: true,
        pierceReason: pierceReason || 'transient_overlay',
      };
    }

    return { intercepted: true, description: desc };
  }
  return { intercepted: false };
}

export function inPageDispatchSyntheticClick(
  index: number | null | undefined,
  x: number,
  y: number,
  action: 'click' | 'right_click' | 'double_click' = 'click',
): boolean {
  let el = typeof index === 'number' && index > 0 ? findIndexedElement(index) : null;
  if (
    !el &&
    typeof document !== 'undefined' &&
    typeof (document as any).elementsFromPoint === 'function'
  ) {
    const elements = (document as any).elementsFromPoint(x, y) || [];
    for (const cand of elements) {
      if (!(cand instanceof Element)) continue;
      const win = cand.ownerDocument?.defaultView || window;
      let isMask = false;
      try {
        const s = win.getComputedStyle(cand);
        if (s.pointerEvents === 'none' || s.display === 'none' || s.visibility === 'hidden') {
          continue;
        }
        const op = parseFloat(s.opacity || '1');
        const bg = (s.backgroundColor || '').toLowerCase().replace(/\s+/g, '');
        const isTransparentBg = bg === 'transparent' || bg === 'rgba(0,0,0,0)';
        const classId =
          `${cand.className || ''} ${cand.id || ''} ${cand.getAttribute('role') || ''}`.toLowerCase();
        const matchesMask =
          /(backdrop|mask|overlay|loading|spinner|shim|transition|fading|fade-out|toast|stub)/i.test(
            classId,
          );
        const hasInteractive = Boolean(
          cand.querySelector?.('button, a, input, textarea, select, [role="button"]'),
        );
        if (!hasInteractive && (op <= 0.05 || (matchesMask && isTransparentBg))) {
          isMask = true;
        }
      } catch {}
      if (!isMask) {
        el = cand;
        break;
      }
    }
  }
  if (!el && typeof document !== 'undefined' && typeof document.elementFromPoint === 'function') {
    el = document.elementFromPoint(x, y);
  }
  if (!el || !(el instanceof Element)) return false;

  const isRight = action === 'right_click';
  const button = isRight ? 2 : 0;
  const buttons = isRight ? 2 : 1;

  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button,
  };

  try {
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons, pointerType: 'mouse' }));
  } catch {}
  el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons }));
  try {
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
  } catch {}
  el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));

  if (isRight) {
    el.dispatchEvent(new MouseEvent('contextmenu', { ...init, buttons: 0 }));
  } else if (action === 'double_click') {
    el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons, pointerType: 'mouse' }));
    } catch {}
    el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons }));
    try {
      el.dispatchEvent(
        new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }),
      );
    } catch {}
    el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('dblclick', { ...init, buttons: 0 }));
  } else {
    el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  }

  return true;
}

/**
 * Detect active confirmation trap dialogs (e.g. "Discard draft?", "放弃帖子？") on the page.
 */
export function inPageDetectConfirmationTrap(): {
  detected: boolean;
  title?: string;
  buttons?: string[];
} {
  if (typeof document === 'undefined') return { detected: false };
  try {
    const dialogs = Array.from(
      document.querySelectorAll(
        'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]',
      ),
    ) as HTMLElement[];
    for (const d of dialogs) {
      const isAriaHidden = d.getAttribute('aria-hidden') === 'true';
      const isOpenAttr =
        d.tagName.toLowerCase() === 'dialog' ? (d as HTMLDialogElement).open : true;
      if (isAriaHidden || !isOpenAttr) continue;
      const win = d.ownerDocument?.defaultView || window;
      let isVis = false;
      try {
        const style = win.getComputedStyle(d);
        isVis =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          (d.offsetWidth > 0 || d.offsetHeight > 0);
      } catch {}
      if (!isVis) continue;

      const title =
        d.getAttribute('aria-label') ||
        d.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim()?.slice(0, 80) ||
        d.textContent?.slice(0, 150)?.trim();

      const textSnippet = `${d.tagName} ${title || ''} ${d.textContent?.slice(0, 300) || ''}`;
      const isTrap =
        /(discard|abandon|unsaved|confirm|放弃|取消|未保存|确认放弃|是否放弃|离开)/i.test(
          textSnippet,
        );

      if (isTrap) {
        const buttons = Array.from(d.querySelectorAll('button, [role="button"]'))
          .map((b) => b.textContent?.trim() || b.getAttribute('aria-label') || '')
          .filter(Boolean)
          .slice(0, 5);
        return {
          detected: true,
          title: title || 'Confirmation Dialog',
          buttons,
        };
      }
    }
  } catch {}
  return { detected: false };
}

/**
 * Format an indexed element into a concise, Accessibility-Tree-inspired line.
 * Omits closing tags and redundant markup, cutting token usage by 60%+.
 */
export function renderCompactElementLine(el: IndexedElement, frameId?: string | number): string {
  let role = el.role || el.tagName.toLowerCase();
  const tag = el.tagName.toLowerCase();
  const inputType = el.attributes?.type?.toLowerCase();

  if (el.role === 'card') {
    role = 'card';
  } else if (tag === 'input') {
    if (inputType === 'checkbox') role = 'checkbox';
    else if (inputType === 'radio') role = 'radio';
    else if (inputType === 'submit' || inputType === 'button') role = 'button';
    else if (inputType === 'password') role = 'password';
    else if (inputType === 'file') role = 'file';
    else if (inputType === 'search' || el.isSearch || role === 'searchbox') role = 'searchbox';
    else role = 'textbox';
  } else if (tag === 'a') {
    role = 'link';
  } else if (tag === 'button') {
    role = 'button';
  } else if (tag === 'textarea') {
    role = 'textbox';
  } else if (tag === 'select') {
    role = 'combobox';
  } else if (tag === 'option') {
    role = 'option';
  }

  let text = el.text ? `"${el.text}"` : '';
  if (!text && el.attributes?.['aria-label']) {
    text = `"${el.attributes['aria-label']}"`;
  } else if (!text && el.attributes?.title) {
    text = `"${el.attributes.title}"`;
  }

  const parts: string[] = [`[${el.index}]`];
  if (el.isClosedShadowHost) {
    parts.push('[closed-shadow-host]');
  } else if (el.inShadowDom) {
    parts.push('[shadow]');
  }
  if (el.isComposer) {
    parts.push('[composer]');
  } else if (el.isEditor) {
    parts.push('[editor]');
  }
  parts.push(role);
  if (text) parts.push(text);

  if (el.attributes?.id) parts.push(`#${el.attributes.id}`);
  if (el.attributes?.name) parts.push(`name="${el.attributes.name}"`);
  if (el.attributes?.placeholder) parts.push(`placeholder="${el.attributes.placeholder}"`);
  if (tag === 'a' && el.attributes?.href) parts.push(`href="${el.attributes.href}"`);
  if (el.value !== undefined && el.value !== '') {
    const isSensitive =
      inputType === 'password' ||
      el.attributes?.name?.toLowerCase().includes('password') ||
      el.attributes?.autocomplete?.toLowerCase().includes('password') ||
      el.attributes?.autocomplete?.toLowerCase().includes('cc-');
    const valDisplay = isSensitive ? '•••' : el.value;
    parts.push(`value="${valDisplay}"`);
  }
  if (el.attributes?.['visual-shape']) parts.push(`shape="${el.attributes['visual-shape']}"`);

  if (el.attributes?.required === 'true' || el.attributes?.required === '') parts.push('required');
  if (el.attributes?.disabled === 'true' || el.attributes?.disabled === '') parts.push('disabled');
  if (
    el.attributes?.['aria-checked'] === 'true' ||
    el.attributes?.checked === 'true' ||
    el.attributes?.checked === ''
  )
    parts.push('checked');
  if (el.attributes?.['aria-selected'] === 'true') parts.push('selected');
  if (el.attributes?.['aria-expanded']) parts.push(`expanded=${el.attributes['aria-expanded']}`);

  if (frameId !== undefined && frameId !== 0 && frameId !== '0') {
    parts.push(`frame="${frameId}"`);
  }

  if (el.isActionTrigger) {
    parts.push(`(action-trigger${el.actionTriggerType ? `: ${el.actionTriggerType}` : ''})`);
  }

  if (el.isOccluded) {
    parts.push(`[occluded${el.occludedBy ? ` by ${el.occludedBy}` : ''}]`);
  }

  return parts.join(' ');
}

/**
 * In-page inspection to detect active slider verification or bot challenges.
 */
export function inPageCheckCaptcha(): { detected: boolean; type?: string } {
  try {
    const captchaSelectors = [
      '#captcha_modal',
      '.geetest_holder',
      '.nc_wrapper',
      '#nc_1_wrapper',
      '.yidun_modal',
      '.tcaptcha-transform',
      'iframe[src*="captcha"]',
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      'iframe[src*="turnstile"]',
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="arkoselabs"]',
      'iframe[src*="funcaptcha"]',
      '.cf-turnstile',
      '#cf-turnstile',
      'div[class*="cf-turnstile" i]',
      '.h-captcha',
      '#hcaptcha',
      'div[class*="hcaptcha" i]',
      '#arkose',
      'div[id*="arkose" i]',
      'div[class*="arkose" i]',
      'div[id*="aws-waf" i]',
      'div[class*="aws-waf" i]',
      'div[class*="captcha" i]',
      'div[id*="captcha" i]',
      '.slider-verify',
      '.slide-verify',
      '[data-testid*="captcha" i]',
      '[data-testid*="turnstile" i]',
    ];
    for (const sel of captchaSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of Array.from(els)) {
        if (el && el instanceof HTMLElement) {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            (el.offsetWidth > 0 || el.offsetHeight > 0 || rect.width > 0 || rect.height > 0)
          ) {
            return { detected: true, type: sel };
          }
        }
      }
    }
  } catch {}
  return { detected: false };
}

/**
 * In-page rich text media insertion engine.
 * Synthesizes ClipboardEvent('paste') and DragEvent('drop') containing a real File object
 * inside a DataTransfer container, bypassing browser clipboard security sandboxes.
 */
export function inPageInsertMedia(options: {
  base64Data: string;
  fileName?: string;
  mimeType?: string;
  index?: number;
  selector?: string;
}): {
  success: boolean;
  target?: {
    tagName: string;
    selector?: string;
    isContentEditable: boolean;
    index?: number;
  };
  dispatchedEvents: string[];
  fileName: string;
  mimeType: string;
  fileSize: number;
  error?: string;
} {
  try {
    let targetEl: Element | null = null;
    const targetIndex = options.index;

    if (typeof targetIndex === 'number' && targetIndex > 0) {
      targetEl = findIndexedElement(targetIndex);
    } else if (options.selector) {
      try {
        targetEl = document.querySelector(options.selector);
      } catch {}
    }

    // If no explicit target, prefer document.activeElement if editable
    if (!targetEl) {
      const active = document.activeElement;
      if (
        active &&
        active !== document.body &&
        active !== document.documentElement &&
        ((active as HTMLElement).isContentEditable ||
          active.getAttribute('contenteditable') === 'true' ||
          active.tagName === 'TEXTAREA' ||
          active.getAttribute('role') === 'textbox')
      ) {
        targetEl = active;
      }
    }

    // If still no target, locate the primary composer / rich text editor on page
    if (!targetEl) {
      const composerSelectors = [
        '[data-lexical-editor="true"]',
        '.DraftEditor-root [contenteditable="true"]',
        '.drafteditor-root [contenteditable="true"]',
        '.ProseMirror[contenteditable="true"]',
        '.ProseMirror',
        '.ql-editor',
        '.monaco-editor [contenteditable="true"]',
        '.cm-content[contenteditable="true"]',
        '.tiptap',
        '[data-testid*="composer" i]',
        '[data-testid*="editor" i]',
        '[data-testid*="post" i]',
        '[data-testid*="tweet" i]',
        '[data-testid*="comment" i]',
        '[data-testid*="message" i]',
        '[data-testid*="chat" i]',
        '[contenteditable="true"]',
        '[role="textbox"]',
        'div[aria-label*="post" i][contenteditable="true"]',
        'div[aria-label*="comment" i][contenteditable="true"]',
        'div[aria-label*="write" i][contenteditable="true"]',
        'div[aria-label*="message" i][contenteditable="true"]',
        'textarea',
      ];
      for (const sel of composerSelectors) {
        const found = document.querySelector(sel);
        if (found) {
          targetEl = found;
          break;
        }
      }
    }

    if (!targetEl) {
      targetEl = document.body;
    }

    // Scroll into view & focus
    try {
      if (typeof (targetEl as any).scrollIntoView === 'function') {
        targetEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as any });
      }
      if (typeof (targetEl as HTMLElement).focus === 'function') {
        (targetEl as HTMLElement).focus();
      }
    } catch {}

    const cleanBase64 = (options.base64Data || '').replace(/^data:.*?;base64,/, '').trim();
    if (!cleanBase64) {
      return {
        success: false,
        dispatchedEvents: [],
        fileName: options.fileName || 'unknown',
        mimeType: options.mimeType || 'application/octet-stream',
        fileSize: 0,
        error: 'base64Data must be a non-empty string',
      };
    }

    // Convert base64 string to Uint8Array
    let byteArray: Uint8Array;
    if (typeof atob === 'function') {
      const binaryString = atob(cleanBase64);
      const len = binaryString.length;
      byteArray = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        byteArray[i] = binaryString.charCodeAt(i);
      }
    } else if (typeof Buffer !== 'undefined') {
      byteArray = new Uint8Array(Buffer.from(cleanBase64, 'base64'));
    } else {
      byteArray = new Uint8Array(0);
    }

    const extMatch = (options.fileName || '').match(/\.([a-zA-Z0-9]+)$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    let mimeType = options.mimeType;
    if (!mimeType) {
      if (ext === 'png') mimeType = 'image/png';
      else if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
      else if (ext === 'gif') mimeType = 'image/gif';
      else if (ext === 'webp') mimeType = 'image/webp';
      else if (ext === 'svg') mimeType = 'image/svg+xml';
      else mimeType = 'image/png';
    }

    const fileName = options.fileName || `media-${Date.now()}.${mimeType.split('/')[1] || 'png'}`;

    // Construct File and DataTransfer
    let dt: DataTransfer | null = null;
    let fileObj: any = null;
    if (typeof File === 'function') {
      try {
        fileObj = new File([byteArray as any], fileName, {
          type: mimeType,
          lastModified: Date.now(),
        });
      } catch {}
    }
    if (!fileObj && typeof Blob === 'function') {
      try {
        fileObj = new Blob([byteArray as any], { type: mimeType });
      } catch {}
    }
    if (!fileObj) {
      fileObj = {
        name: fileName,
        type: mimeType,
        size: byteArray.length,
        lastModified: Date.now(),
      };
    }
    try {
      Object.defineProperty(fileObj, 'name', {
        value: fileName,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(fileObj, 'type', {
        value: mimeType,
        writable: true,
        configurable: true,
      });
    } catch {}

    if (typeof DataTransfer === 'function') {
      try {
        dt = new DataTransfer();
        if (fileObj) {
          try {
            dt.items.add(fileObj);
          } catch {}
          try {
            Object.defineProperty(dt, 'files', {
              get: () => [fileObj],
              configurable: true,
            });
          } catch {}
        }
      } catch {}
    }

    const dispatchedEvents: string[] = [];

    // 1. Dispatch synthetic ClipboardEvent('paste')
    try {
      let pasteEvent: any;
      if (typeof ClipboardEvent === 'function') {
        try {
          pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            composed: true,
            clipboardData: dt || undefined,
          });
        } catch {
          pasteEvent = new Event('paste', { bubbles: true, cancelable: true, composed: true });
        }
      } else {
        pasteEvent = new Event('paste', { bubbles: true, cancelable: true, composed: true });
      }

      const clipboardDataObj = {
        items: [
          {
            kind: 'file',
            type: mimeType,
            getAsFile: () => fileObj,
          },
        ],
        files: [fileObj],
        types: ['Files'],
        getData: () => '',
        setData: () => {},
        clearData: () => {},
      };

      try {
        Object.defineProperty(pasteEvent, 'clipboardData', {
          get: () => clipboardDataObj,
          configurable: true,
        });
      } catch {
        try {
          pasteEvent.clipboardData = clipboardDataObj;
        } catch {}
      }

      targetEl.dispatchEvent(pasteEvent);
      dispatchedEvents.push('paste');
    } catch {}

    // 2. Dispatch synthetic DragEvent dragenter -> dragover -> drop
    try {
      const dragDataObj = {
        items: [
          {
            kind: 'file',
            type: mimeType,
            getAsFile: () => fileObj,
          },
        ],
        files: [fileObj],
        types: ['Files'],
        getData: () => '',
        setData: () => {},
        clearData: () => {},
      };

      const createDragEvent = (type: string) => {
        let ev: any;
        if (typeof DragEvent === 'function') {
          try {
            ev = new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              dataTransfer: dt || undefined,
            });
          } catch {
            ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
          }
        } else {
          ev = new Event(type, { bubbles: true, cancelable: true, composed: true });
        }
        try {
          Object.defineProperty(ev, 'dataTransfer', {
            get: () => dragDataObj,
            configurable: true,
          });
        } catch {
          try {
            ev.dataTransfer = dragDataObj;
          } catch {}
        }
        return ev;
      };

      targetEl.dispatchEvent(createDragEvent('dragenter'));
      targetEl.dispatchEvent(createDragEvent('dragover'));
      targetEl.dispatchEvent(createDragEvent('drop'));
      dispatchedEvents.push('drop');
    } catch {}

    // 3. Dispatch beforeinput with insertFromPaste
    try {
      if (typeof InputEvent === 'function') {
        const beforeInput = new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertFromPaste',
          dataTransfer: dt || undefined,
        } as any);
        targetEl.dispatchEvent(beforeInput);
        dispatchedEvents.push('beforeinput');
      }
    } catch {}

    const isContentEditable = Boolean(
      (targetEl as HTMLElement).isContentEditable ||
      targetEl.getAttribute('contenteditable') === 'true' ||
      targetEl.getAttribute('contenteditable') === '',
    );

    const targetId = targetEl.id ? `#${targetEl.id}` : '';
    const selector = targetId || targetEl.tagName.toLowerCase();

    return {
      success: true,
      target: {
        tagName: targetEl.tagName.toLowerCase(),
        selector,
        isContentEditable,
        ...(typeof targetIndex === 'number' ? { index: targetIndex } : {}),
      },
      dispatchedEvents,
      fileName,
      mimeType,
      fileSize: byteArray.length,
    };
  } catch (err: any) {
    return {
      success: false,
      dispatchedEvents: [],
      fileName: options.fileName || 'unknown',
      mimeType: options.mimeType || 'application/octet-stream',
      fileSize: 0,
      error: err?.message || String(err),
    };
  }
}

/**
 * Retrieve current scroll and viewport geometry in the page.
 * Used for real-time drift compensation between screenshot capture and click execution.
 */
export function inPageGetScrollState(): {
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  docWidth: number;
  docHeight: number;
} {
  const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
  const doc = win?.document;
  const docEl = doc?.documentElement;
  const body = doc?.body;
  const scrollX = win?.scrollX || win?.pageXOffset || docEl?.scrollLeft || body?.scrollLeft || 0;
  const scrollY = win?.scrollY || win?.pageYOffset || docEl?.scrollTop || body?.scrollTop || 0;
  const viewportWidth = win?.innerWidth || docEl?.clientWidth || 1280;
  const viewportHeight = win?.innerHeight || docEl?.clientHeight || 800;
  const docWidth = Math.max(
    body?.scrollWidth || 0,
    docEl?.scrollWidth || 0,
    body?.offsetWidth || 0,
    docEl?.offsetWidth || 0,
    viewportWidth,
  );
  const docHeight = Math.max(
    body?.scrollHeight || 0,
    docEl?.scrollHeight || 0,
    body?.offsetHeight || 0,
    docEl?.offsetHeight || 0,
    viewportHeight,
  );
  return {
    scrollX: Math.round(scrollX),
    scrollY: Math.round(scrollY),
    viewportWidth: Math.round(viewportWidth),
    viewportHeight: Math.round(viewportHeight),
    docWidth: Math.round(docWidth),
    docHeight: Math.round(docHeight),
  };
}

/**
 * Instantaneously scrolls page to the specified coordinates without animation delay.
 */
export function inPageInstantScrollTo(
  x: number,
  y: number,
): { success: boolean; scrollX: number; scrollY: number } {
  const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
  if (!win) return { success: false, scrollX: 0, scrollY: 0 };
  const prevBehavior = win.document?.documentElement?.style?.scrollBehavior || '';
  try {
    if (win.document?.documentElement) {
      win.document.documentElement.style.scrollBehavior = 'auto';
    }
    const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
    if (!isJsdom && typeof win.scrollTo === 'function') {
      win.scrollTo({ left: x, top: y, behavior: 'instant' as any });
    }
  } finally {
    if (win.document?.documentElement) {
      win.document.documentElement.style.scrollBehavior = prevBehavior;
    }
  }
  const curX = win.scrollX || win.pageXOffset || 0;
  const curY = win.scrollY || win.pageYOffset || 0;
  return { success: true, scrollX: Math.round(curX), scrollY: Math.round(curY) };
}

/**
 * Temporarily locks smooth scroll behavior to prevent inertia/smooth-scroll racing during click dispatch.
 */
let originalScrollBehavior: string | null = null;
export function inPageLockScroll(lock: boolean): boolean {
  const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
  const docEl = win?.document?.documentElement;
  if (!docEl) return false;
  if (lock) {
    if (originalScrollBehavior === null) {
      originalScrollBehavior = docEl.style.scrollBehavior || '';
    }
    docEl.style.scrollBehavior = 'auto';
  } else {
    if (originalScrollBehavior !== null) {
      docEl.style.scrollBehavior = originalScrollBehavior;
      originalScrollBehavior = null;
    }
  }
  return true;
}

/**
 * Deep page text extraction that pierces all open and closed ShadowRoot boundaries,
 * flattens <slot> projections, and structures text into clean readable lines.
 */
export function inPageExtractDeepPageText(rootNode?: Node): string {
  const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
  const doc = win?.document;
  const start = rootNode || doc?.body || doc;
  if (!start) return '';

  const chunks: string[] = [];

  function walk(node: Node) {
    if (!node) return;

    if (node.nodeType === 3) {
      // Text node
      const val = node.textContent?.trim();
      if (val) {
        chunks.push(val);
      }
      return;
    }

    if (node.nodeType !== 1 && node.nodeType !== 11) {
      // Not Element or DocumentFragment / ShadowRoot
      return;
    }

    const el = node as Element;
    const tag = (el.tagName || '').toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'svg'].includes(tag)) {
      return;
    }

    // Accessible name for buttons/links/custom elements without visible text
    const ariaLabel = el.getAttribute?.('aria-label')?.trim();
    if (ariaLabel && !el.textContent?.includes(ariaLabel)) {
      chunks.push(`[${ariaLabel}]`);
    }

    // Traverse shadow root (open or closed)
    const shadow = getShadowRoot(el);
    if (shadow) {
      walk(shadow);
    }

    // Flatten <slot> elements
    if (tag === 'slot' && typeof (el as HTMLSlotElement).assignedNodes === 'function') {
      try {
        const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
        for (const a of assigned) {
          walk(a);
        }
      } catch {
        for (const child of Array.from(node.childNodes)) {
          walk(child);
        }
      }
    } else {
      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }
    }

    // Block-level break for standard layout and Web Component wrappers
    if (
      /^(div|p|h[1-6]|li|section|article|header|footer|nav|blockquote|tr|table|shreddit-|faceplate-)/i.test(
        tag,
      )
    ) {
      chunks.push('\n');
    }
  }

  walk(start);

  return chunks
    .join(' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface DismissedOverlayInfo {
  id?: string;
  className?: string;
  role?: string;
  title?: string;
  buttonText?: string;
  buttonSelector?: string;
  action: 'clicked_close_button' | 'dispatched_escape';
  x?: number;
  y?: number;
}

export interface DismissOverlaysResult {
  dismissedCount: number;
  overlays: DismissedOverlayInfo[];
}

/**
 * Fast in-page dismiss detector for visible top-level dialogs, marketing popups,
 * promotional modals, and cookie banners.
 */
export function inPageDismissOverlays(options?: { maxDismissals?: number }): DismissOverlaysResult {
  const maxCount = options?.maxDismissals ?? 5;
  const result: DismissOverlaysResult = {
    dismissedCount: 0,
    overlays: [],
  };

  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return result;
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  if (!win) return result;

  const candidateSelectors = [
    'dialog[open]',
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    '[popover]',
    '[class*="modal"]',
    '[class*="popup"]',
    '[class*="dialog"]',
    '[class*="mask"]',
    '[class*="overlay"]',
    '[class*="coupon"]',
    '[class*="marketing"]',
    '[class*="banner"]',
    '[id*="modal"]',
    '[id*="popup"]',
    '[id*="dialog"]',
    '[id*="overlay"]',
  ];

  const foundElements = new Set<Element>();
  function queryDeep(root: ParentNode, depth = 0): void {
    if (depth > 5) return;
    try {
      const matched = root.querySelectorAll(candidateSelectors.join(', '));
      for (const el of Array.from(matched)) {
        foundElements.add(el);
      }
    } catch {}
    try {
      const hosts = root.querySelectorAll('*');
      for (const h of Array.from(hosts)) {
        const sr = (h as HTMLElement).shadowRoot;
        if (sr) queryDeep(sr, depth + 1);
      }
    } catch {}
  }
  queryDeep(doc);

  // Also check top-level positioned elements with high z-index (>= 1000)
  try {
    const topLevelElements = doc.querySelectorAll(
      'body > div, body > section, body > aside, [style*="z-index"], [style*="position: fixed"], [style*="position: absolute"]',
    );
    for (const el of Array.from(topLevelElements)) {
      let style: CSSStyleDeclaration;
      try {
        style = win.getComputedStyle(el);
      } catch {
        continue;
      }
      const pos = style.position;
      if (pos === 'fixed' || pos === 'absolute') {
        const z = parseInt(style.zIndex, 10);
        if (!isNaN(z) && z >= 1000) {
          foundElements.add(el);
        }
      }
    }
  } catch {}

  interface QualifiedOverlay {
    element: HTMLElement;
    zIndex: number;
    title?: string;
  }

  const qualified: QualifiedOverlay[] = [];

  for (const el of foundElements) {
    if (!(el instanceof (win as any).HTMLElement)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;

    // Never dismiss critical authentication/login dialogs containing password inputs
    if (el.querySelector('input[type="password"]')) continue;

    let style: CSSStyleDeclaration;
    try {
      style = win.getComputedStyle(el);
    } catch {
      continue;
    }

    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.pointerEvents === 'none' ||
      parseFloat(style.opacity || '1') <= 0.05
    ) {
      continue;
    }

    const rect = el.getBoundingClientRect();
    const htmlEl = el as HTMLElement;
    const w = rect.width || htmlEl.offsetWidth || 0;
    const h = rect.height || htmlEl.offsetHeight || 0;
    if (w < 40 || h < 40) continue;

    let z = 0;
    if (style.zIndex && style.zIndex !== 'auto') {
      const parsedZ = parseInt(style.zIndex, 10);
      if (!isNaN(parsedZ)) z = parsedZ;
    }

    const title =
      el.getAttribute('aria-label') ||
      el
        .querySelector('h1, h2, h3, [role="heading"], [class*="title"]')
        ?.textContent?.trim()
        ?.slice(0, 50);

    qualified.push({
      element: htmlEl,
      zIndex: z,
      title: title || undefined,
    });
  }

  // Sort descending by z-index so top-most overlays are dismissed first
  qualified.sort((a, b) => b.zIndex - a.zIndex);

  const clickedCloseButtons = new Set<Element>();
  const dismissedContainers = new Set<Element>();

  const closeTextExactRegex =
    /^(关闭|跳过|我知道了|知道了|我已知晓|放弃优惠|残忍拒绝|稍后再说|暂不参与|收下留情|x|×|✕|✖|close|dismiss|cancel|skip|not now|later|no thanks)$/i;
  const closeSubstrRegex =
    /(关闭|跳过|残忍拒绝|放弃优惠|稍后再说|暂不参与|close|dismiss|cancel|skip)/i;
  const closeAttrRegex = /(close|dismiss|cancel|关闭|跳过)/i;
  const closeClassRegex =
    /(close|dismiss|cancel|btn-close|close-btn|close-icon|headerbtn|modal-close|dialog-close|popup-close|drawer-close|banner-close|toast-close|shut|cha)/i;

  for (const q of qualified) {
    if (result.dismissedCount >= maxCount) break;
    const container = q.element;

    // Check if this container or its ancestor/descendant was already dismissed in this pass
    if (
      dismissedContainers.has(container) ||
      Array.from(dismissedContainers).some((d) => d.contains(container) || container.contains(d))
    ) {
      continue;
    }

    try {
      const curStyle = win.getComputedStyle(container);
      if (curStyle.display === 'none' || curStyle.visibility === 'hidden') continue;
    } catch {
      continue;
    }

    const candidates: HTMLElement[] = [];
    function findCandidatesDeep(root: ParentNode, depth = 0): void {
      if (depth > 4) return;
      try {
        const found = Array.from(
          root.querySelectorAll(
            'button, [role="button"], a, i, span, svg, div[class*="close" i], div[class*="btn" i], div[class*="shut" i], div[class*="cha" i], [class*="headerbtn" i], [aria-label], [title], [data-testid], [data-dismiss], [data-bs-dismiss], [data-modal-hide], [data-dismiss-target], [data-radix-dialog-close]',
          ),
        ) as HTMLElement[];
        candidates.push(...found);
      } catch {}
      try {
        const hosts = root.querySelectorAll('*');
        for (const h of Array.from(hosts)) {
          const sr = (h as HTMLElement).shadowRoot;
          if (sr) findCandidatesDeep(sr, depth + 1);
        }
      } catch {}
    }
    findCandidatesDeep(container);

    interface ScoredCandidate {
      element: HTMLElement;
      score: number;
      buttonText: string;
    }
    const scoredCandidates: ScoredCandidate[] = [];

    const containerRect = container.getBoundingClientRect();

    for (const c of candidates) {
      if (!(c instanceof (win as any).HTMLElement)) continue;
      if (clickedCloseButtons.has(c)) continue;

      let cStyle: CSSStyleDeclaration;
      try {
        cStyle = win.getComputedStyle(c);
      } catch {
        continue;
      }
      if (
        cStyle.display === 'none' ||
        cStyle.visibility === 'hidden' ||
        cStyle.pointerEvents === 'none'
      ) {
        continue;
      }

      const cRect = c.getBoundingClientRect();
      const w = cRect.width || c.offsetWidth || 0;
      const h = cRect.height || c.offsetHeight || 0;
      if (w === 0 && h === 0) continue;

      const rawText = (c.textContent || (c as HTMLInputElement).value || '').trim();
      const ariaLabel = c.getAttribute('aria-label') || '';
      const title = c.getAttribute('title') || '';
      const className = typeof c.className === 'string' ? c.className : '';
      const dataDismiss = c.getAttribute('data-dismiss') || '';
      const dataBsDismiss = c.getAttribute('data-bs-dismiss') || '';
      const dataModalHide = c.getAttribute('data-modal-hide') || '';
      const dataDismissTarget = c.getAttribute('data-dismiss-target') || '';
      const hasRadixClose = c.hasAttribute('data-radix-dialog-close');
      const dataTestId = c.getAttribute('data-testid') || '';

      const tag = c.tagName.toLowerCase();
      const role = (c.getAttribute('role') || '').toLowerCase();
      const isInteractiveTag =
        tag === 'button' ||
        role === 'button' ||
        tag === 'a' ||
        (tag === 'input' &&
          (c.getAttribute('type') === 'button' || c.getAttribute('type') === 'submit'));
      const isClickable =
        isInteractiveTag ||
        c.hasAttribute('onclick') ||
        cStyle.cursor === 'pointer' ||
        (typeof (c as any).tabIndex === 'number' && (c as any).tabIndex >= 0);

      let score = 0;
      let detectedText = '';

      // 1. Explicit data-dismiss attribute
      if (
        dataDismiss === 'modal' ||
        dataDismiss === 'dialog' ||
        dataBsDismiss === 'modal' ||
        Boolean(dataModalHide) ||
        Boolean(dataDismissTarget) ||
        hasRadixClose
      ) {
        score += 100;
        detectedText = ariaLabel || title || rawText || 'dismiss';
      }

      // 2. Exact text match
      const isExactText = closeTextExactRegex.test(rawText);
      const isSymbol = /^[x×✕✖+-]$/i.test(rawText);
      if (isExactText) {
        if (isInteractiveTag) {
          score += 95;
        } else if (isClickable || isSymbol) {
          score += 85;
        } else {
          score += 60;
        }
        detectedText = (!isSymbol && rawText) || ariaLabel || title || rawText || 'close';
      }

      // 3. ARIA / Title / TestID match
      if (
        closeAttrRegex.test(ariaLabel) ||
        closeAttrRegex.test(title) ||
        closeAttrRegex.test(dataTestId)
      ) {
        if (isInteractiveTag) {
          score += 90;
        } else if (isClickable) {
          score += 80;
        } else {
          score += 55;
        }
        detectedText = detectedText || ariaLabel || title || 'close';
      }

      // 4. Class name match
      if (closeClassRegex.test(className)) {
        if (isInteractiveTag) {
          score += 85;
        } else if (isClickable) {
          score += 75;
        } else {
          score += 50;
        }
        detectedText = detectedText || ariaLabel || title || className || 'close';
      }

      // 5. SVG child match
      const svgChild = c.querySelector('svg');
      if (svgChild) {
        const svgClass = svgChild.getAttribute('class') || '';
        const svgAria = svgChild.getAttribute('aria-label') || '';
        if (closeClassRegex.test(svgClass) || closeAttrRegex.test(svgAria)) {
          score += isInteractiveTag ? 80 : isClickable ? 70 : 50;
          detectedText = detectedText || svgAria || 'svg_close';
        }
      }

      // 6. Substring text match (STRICT: ONLY for clickable/interactive elements with short text <= 8 chars)
      // Never match an informational <span> or <div> like "限时优惠，关闭前请看"!
      if (
        !isExactText &&
        isClickable &&
        rawText.length > 0 &&
        rawText.length <= 8 &&
        closeSubstrRegex.test(rawText)
      ) {
        score += isInteractiveTag ? 50 : 35;
        detectedText = detectedText || rawText;
      }

      // Bonuses:
      if (score >= 40) {
        // Bonus for real button tags
        if (isInteractiveTag) score += 10;
        // Bonus for top-right corner positioning (classic modal close button)
        if (
          containerRect.width > 0 &&
          containerRect.height > 0 &&
          cRect.top <= containerRect.top + 80 &&
          cRect.right >= containerRect.right - 80
        ) {
          score += 15;
        }

        scoredCandidates.push({
          element: c,
          score,
          buttonText: detectedText || rawText || className || 'close',
        });
      }
    }

    scoredCandidates.sort((a, b) => b.score - a.score);
    const bestCandidate = scoredCandidates[0];

    if (bestCandidate) {
      const closeButton = bestCandidate.element;
      const buttonText = bestCandidate.buttonText;
      const bRect = closeButton.getBoundingClientRect();
      const clickX = Math.round(bRect.left + (bRect.width || closeButton.offsetWidth || 20) / 2);
      const clickY = Math.round(bRect.top + (bRect.height || closeButton.offsetHeight || 20) / 2);

      const eventInit: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 1,
        clientX: clickX,
        clientY: clickY,
      };

      try {
        if (typeof (win as any).PointerEvent !== 'undefined') {
          try {
            closeButton.dispatchEvent(
              new (win as any).PointerEvent('pointerdown', {
                ...eventInit,
                pointerType: 'mouse',
              } as any),
            );
          } catch {}
        }
        const MouseEv = (win as any).MouseEvent || MouseEvent;
        try {
          closeButton.dispatchEvent(new MouseEv('mousedown', eventInit));
        } catch {}
        if (typeof (win as any).PointerEvent !== 'undefined') {
          try {
            closeButton.dispatchEvent(
              new (win as any).PointerEvent('pointerup', {
                ...eventInit,
                pointerType: 'mouse',
              } as any),
            );
          } catch {}
        }
        try {
          closeButton.dispatchEvent(new MouseEv('mouseup', eventInit));
        } catch {}
        let clickFired = false;
        try {
          closeButton.dispatchEvent(new MouseEv('click', eventInit));
          clickFired = true;
        } catch {}
        if (!clickFired && typeof closeButton.click === 'function') {
          try {
            closeButton.click();
          } catch {}
        }
      } catch {}

      clickedCloseButtons.add(closeButton);
      dismissedContainers.add(container);

      result.dismissedCount++;
      result.overlays.push({
        id: container.id || undefined,
        className:
          typeof container.className === 'string' ? container.className.slice(0, 100) : undefined,
        role: container.getAttribute('role') || container.tagName.toLowerCase(),
        title: q.title,
        buttonText,
        buttonSelector: describeHitTarget(closeButton),
        action: 'clicked_close_button',
        x: clickX,
        y: clickY,
      });
    } else {
      // If modal qualifies (role=dialog or high z-index), try Escape key
      if (
        q.zIndex >= 1000 ||
        container.getAttribute('role') === 'dialog' ||
        container.tagName.toLowerCase() === 'dialog'
      ) {
        try {
          const escDown = new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
            composed: true,
          });
          const escUp = new KeyboardEvent('keyup', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
            composed: true,
          });

          const target =
            doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : container;
          target.dispatchEvent(escDown);
          target.dispatchEvent(escUp);
          if (doc.body && target !== doc.body) {
            doc.body.dispatchEvent(escDown);
            doc.body.dispatchEvent(escUp);
          }

          dismissedContainers.add(container);
          result.dismissedCount++;
          result.overlays.push({
            id: container.id || undefined,
            className:
              typeof container.className === 'string'
                ? container.className.slice(0, 100)
                : undefined,
            role: container.getAttribute('role') || container.tagName.toLowerCase(),
            title: q.title,
            action: 'dispatched_escape',
          });
        } catch {}
      }
    }
  }

  return result;
}
