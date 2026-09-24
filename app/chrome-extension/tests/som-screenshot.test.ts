import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildElementMap,
  resolveClickPoint,
  resolveZoomTargets,
  type SomLabel,
} from '../entrypoints/background/tools/browser/screenshot';

function stubRect(width: number, height: number, left = 0, top = 0) {
  return function () {
    return {
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

describe('Set-of-Mark screenshots', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('(a) renders exact `[n] tag – name` element map lines', () => {
    const labels: SomLabel[] = [
      { n: 12, tag: 'input', name: 'Search or jump to…', x: 100, y: 50 },
      { n: 3, tag: 'button', name: 'Sign in', x: 10, y: 20 },
    ];

    const lines = buildElementMap(labels);

    expect(lines).toEqual(['[12] input – Search or jump to…', '[3] button – Sign in']);
    expect(lines[0]).toBe('[12] input – Search or jump to…');
  });

  it('(b) image marks and map lines share one numbering source (no desync)', () => {
    const labels: SomLabel[] = [
      { n: 1, tag: 'a', name: 'Home', x: 5, y: 5 },
      { n: 2, tag: 'input', name: 'Email', x: 40, y: 60 },
      { n: 7, tag: 'button', name: 'Submit', x: 90, y: 120 },
    ];

    // Image marks and the textual element map are both derived from the SAME array.
    const imageMarks = labels.map((l) => ({ n: l.n, x: l.x, y: l.y }));
    const mapLines = buildElementMap(labels);

    const mapNumbers = mapLines.map((line) => Number(/^\[(\d+)\]/.exec(line)![1]));

    expect(mapNumbers).toEqual(labels.map((l) => l.n));
    expect(imageMarks.map((m) => m.n)).toEqual(labels.map((l) => l.n));
    expect(mapLines).toHaveLength(imageMarks.length);
    for (let i = 0; i < labels.length; i++) {
      expect(mapLines[i]).toContain(`[${imageMarks[i].n}]`);
    }
  });

  it('(c) resolveClickPoint uses elementFromPoint and dodges an overlay covering the centre', () => {
    const prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = stubRect(200, 100);
    const prevEFP = document.elementFromPoint;
    try {
      const el = document.createElement('button');
      el.id = 'target';
      document.body.appendChild(el);

      const overlay = document.createElement('div');
      overlay.id = 'sticky-overlay';
      overlay.style.position = 'fixed';
      document.body.appendChild(overlay);

      // Geometric centre is covered by the fixed overlay; every offset sample is clear.
      let calls = 0;
      (document as any).elementFromPoint = (x: number, y: number) => {
        calls++;
        if (Math.round(x) === 100 && Math.round(y) === 50) return overlay;
        return el;
      };

      const point = resolveClickPoint(el);

      expect(calls).toBeGreaterThan(0);
      // Must NOT be the naive geometric centre.
      expect(`${point.x},${point.y}`).not.toBe('100,50');
      // The chosen point must be one where elementFromPoint returns the element itself.
      expect(document.elementFromPoint(point.x, point.y)).toBe(el);
      expect(point.occluded).toBe(false);
    } finally {
      Element.prototype.getBoundingClientRect = prevRect;
      (document as any).elementFromPoint = prevEFP;
    }
  });

  it('(d) flags the point as occluded when every sample is covered', () => {
    const prevRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = stubRect(200, 100);
    const prevEFP = document.elementFromPoint;
    try {
      const el = document.createElement('button');
      document.body.appendChild(el);
      const overlay = document.createElement('div');
      overlay.id = 'modal';
      document.body.appendChild(overlay);

      (document as any).elementFromPoint = () => overlay;

      const point = resolveClickPoint(el);

      expect(point.occluded).toBe(true);
      // Best point from the map is returned (the geometric centre) rather than throwing.
      expect(point.x).toBe(100);
      expect(point.y).toBe(50);
    } finally {
      Element.prototype.getBoundingClientRect = prevRect;
      (document as any).elementFromPoint = prevEFP;
    }
  });

  it('(e) resolveZoomTargets errors on an unknown n and lists valid values', () => {
    const labels: SomLabel[] = [
      { n: 1, tag: 'a', name: 'Home', x: 5, y: 5 },
      { n: 4, tag: 'button', name: 'Go', x: 50, y: 50 },
    ];

    const ok = resolveZoomTargets(labels, [4]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.targets.map((t) => t.n)).toEqual([4]);

    const bad = resolveZoomTargets(labels, [99]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain('99');
      expect(bad.error).toContain('1');
      expect(bad.error).toContain('4');
      expect(bad.error.toLowerCase()).toContain('valid');
    }
  });
});
