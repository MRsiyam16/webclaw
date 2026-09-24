import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * chrome_screenshot zoom crop mode (Set-of-Mark label zoom).
 *
 * Live finding: a call with `zoom: 2` returned the plain non-SoM screenshot,
 * byte-identical to a bare call, with no error. The param was silently dropped
 * (the handler only accepted an array), and an unknown label number produced no
 * structured error either. These tests pin the contract:
 *   (a) a known label number resolves to a real crop (image bytes returned);
 *   (b) an unknown label number answers with a STRUCTURED error that lists the
 *       valid label numbers — never silence.
 */

vi.mock('../utils/image-utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createImageBitmapFromUrl: vi.fn(async () => ({ width: 1200, height: 800 })),
    canvasToDataURL: vi.fn(async () => 'data:image/webp;base64,ZOOMCROP'),
  };
});

import {
  normalizeZoomRequest,
  resolveZoomTargets,
  applyZoomCrops,
  zoomErrorResponse,
  type SomLabel,
} from '../entrypoints/background/tools/browser/screenshot';

class FakeOffscreenCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return { drawImage: vi.fn(), imageSmoothingEnabled: false };
  }
}

const labels: SomLabel[] = [
  { n: 3, tag: 'button', name: 'Sign in', x: 10, y: 20 },
  { n: 7, tag: 'a', name: 'Help', x: 200, y: 300 },
];
const rects = new Map([
  [3, { x: 10, y: 20, width: 100, height: 40 }],
  [7, { x: 200, y: 300, width: 80, height: 24 }],
]);
const viewport = { width: 1200, height: 800 };

describe('chrome_screenshot zoom crop mode', () => {
  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(a) a scalar zoom param is accepted as a one-label request (no silent drop)', () => {
    expect(normalizeZoomRequest(2)).toEqual({ ok: true, labels: [2] });
    expect(normalizeZoomRequest([3])).toEqual({ ok: true, labels: [3] });
    expect(normalizeZoomRequest([3, 3, 7])).toEqual({ ok: true, labels: [3, 7] });
    expect(normalizeZoomRequest(undefined)).toEqual({ ok: true, labels: [] });
  });

  it('(b) a non-numeric zoom param is rejected, not silently dropped', () => {
    const bad = normalizeZoomRequest('big');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid_zoom_param');
  });

  it('(c) a known label returns a crop result (upscaled image bytes)', async () => {
    const outcome = await applyZoomCrops({
      imageDataUrl: 'data:image/webp;base64,SOURCE',
      labels,
      rects,
      requested: [3],
      viewport,
      mimeType: 'image/webp',
      quality: 0.92,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.images).toHaveLength(1);
      expect(outcome.images[0].n).toBe(3);
      expect(outcome.images[0].dataUrl).toMatch(/^data:image\//);
      expect(outcome.images[0].crop.width).toBeGreaterThan(0);
      expect(outcome.images[0].crop.scale).toBeGreaterThanOrEqual(2);
    }
  });

  it('(d) an unknown label returns the structured error listing valid numbers (never silence)', async () => {
    const outcome = await applyZoomCrops({
      imageDataUrl: 'data:image/webp;base64,SOURCE',
      labels,
      rects,
      requested: [99],
      viewport,
      mimeType: 'image/webp',
      quality: 0.92,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('unknown_som_label');
      expect(outcome.unknownLabels).toEqual([99]);
      expect(outcome.validLabels).toEqual([3, 7]);
      expect(outcome.message).toContain('99');

      const res = zoomErrorResponse(outcome);
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text as string);
      expect(body.success).toBe(false);
      expect(body.code).toBe('unknown_som_label');
      expect(body.validLabels).toEqual([3, 7]);
    }
  });

  it('(e) resolveZoomTargets reports the valid set on an unknown label', () => {
    const bad = resolveZoomTargets(labels, [99, 3]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.unknown).toEqual([99]);
      expect(bad.validNumbers).toEqual([3, 7]);
      expect(bad.error).toContain('99');
    }
    const ok = resolveZoomTargets(labels, [7]);
    expect(ok.ok).toBe(true);
  });
});