import { describe, it, expect, beforeEach } from 'vitest';
import { createRefMap, type RefMap } from '../entrypoints/background/tools/browser/dom-indexer';

/**
 * Persistent element refs:
 * - a ref survives DOM mutation that keeps the node
 * - it is invalidated only when the node is replaced, the document navigates,
 *   or the frame re-parents
 * - invalidated ids are NEVER recycled to a different element
 */
describe('persistent element refs', () => {
  let refMap: RefMap;

  beforeEach(() => {
    document.body.innerHTML = '';
    refMap = createRefMap();
  });

  it('(a) keeps the same ref across a re-render that preserves the node', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const button = document.getElementById('go') as HTMLButtonElement;
    const ref = refMap.mint(button);
    expect(ref).toMatch(/^e\d+$/);

    // Mutate the node in place (React/Vue style prop + text update) and churn siblings
    button.setAttribute('data-state', 'busy');
    button.textContent = 'Working';
    document.body.appendChild(document.createElement('span'));

    expect(refMap.resolve(ref)).toBe(button);
    expect(refMap.mint(button)).toBe(ref);
  });

  it('(b) invalidates without recycling when the node is replaced', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const button = document.getElementById('go') as HTMLButtonElement;
    const before = refMap.mint(button);

    const clone = button.cloneNode(true) as HTMLButtonElement;
    document.body.replaceChild(clone, button);

    expect(refMap.resolve(before)).toBeNull();
    const after = refMap.mint(clone);
    expect(after).toMatch(/^e\d+$/);
    expect(after).not.toBe(before);
    // the stale id must never resolve to the replacement node
    expect(refMap.resolve(before)).toBeNull();
  });

  it('(c) fingerprintHeal recovers an identical replacement under the same ref id', () => {
    document.body.innerHTML = '<div><button id="go" data-testid="go-btn">Go</button></div>';
    const button = document.getElementById('go') as HTMLButtonElement;
    const ref = refMap.mint(button);

    const clone = button.cloneNode(true) as HTMLButtonElement;
    button.parentElement!.replaceChild(clone, button);

    expect(refMap.resolve(ref)).toBeNull();
    const healed = refMap.fingerprintHeal(ref);
    expect(healed).toBe(clone);
    expect(healed).not.toBeNull();
    // the same ref id travels with the healed node
    expect(refMap.mint(healed as Element)).toBe(ref);
    expect(refMap.resolve(ref)).toBe(clone);
  });

  it('(c2) fingerprintHeal returns null when nothing matches the fingerprint', () => {
    document.body.innerHTML = '<button id="gone">Bye</button>';
    const button = document.getElementById('gone') as HTMLButtonElement;
    const ref = refMap.mint(button);
    button.remove();

    expect(refMap.resolve(ref)).toBeNull();
    expect(refMap.fingerprintHeal(ref)).toBeNull();
  });

  it('(d) mints /^e\\d+$/ ids that are unique and monotonically increasing', () => {
    document.body.innerHTML = '<button>1</button><button>2</button><button>3</button>';
    const buttons = Array.from(document.querySelectorAll('button'));
    const refs = buttons.map((b) => refMap.mint(b));

    for (const r of refs) expect(r).toMatch(/^e\d+$/);
    expect(new Set(refs).size).toBe(refs.length);
    const nums = refs.map((r) => parseInt(r.slice(1), 10));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(nums[2]).toBeGreaterThan(nums[0]);

    // re-sighting the same nodes must return the same ids, not advance the counter
    expect(buttons.map((b) => refMap.mint(b))).toEqual(refs);
  });

  it('(e) clearing (navigation / re-parenting) staleness does not recycle ids', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const button = document.getElementById('go') as HTMLButtonElement;
    const before = refMap.mint(button);

    refMap.clear();

    expect(refMap.resolve(before)).toBeNull();
    const after = refMap.mint(button);
    expect(after).toMatch(/^e\d+$/);
    expect(after).not.toBe(before);
    expect(parseInt(after.slice(1), 10)).toBeGreaterThan(parseInt(before.slice(1), 10));
  });
});
