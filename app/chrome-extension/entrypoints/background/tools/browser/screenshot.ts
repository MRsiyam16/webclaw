import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, resolveToolName } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  canvasToDataURL,
  createImageBitmapFromUrl,
  cropAndResizeImage,
  stitchImages,
  compressImage,
  overlayCoordinateGrid,
  smartCompressForTransport,
} from '../../../../utils/image-utils';
import { screenshotContextManager } from '@/utils/screenshot-context';
import { executeInPage } from './in-page-engine';
import { screenshotRingBuffer } from '@/utils/screenshot-ring-buffer';
import { isRestrictedChromeUrl } from '@/utils/restricted-url';

// Screenshot-specific constants
const SCREENSHOT_CONSTANTS = {
  SCROLL_DELAY_MS: 350, // Time to wait after scroll for rendering and lazy loading
  CAPTURE_STITCH_DELAY_MS: 50, // Small delay between captures in a scroll sequence
  MAX_CAPTURE_PARTS: 50, // Maximum number of parts to capture (for infinite scroll pages)
  MAX_CAPTURE_HEIGHT_PX: 50000, // Maximum height in pixels to capture
  PIXEL_TOLERANCE: 1,
  SCRIPT_INIT_DELAY: 100, // Delay for script initialization
} as {
  readonly SCROLL_DELAY_MS: number;
  CAPTURE_STITCH_DELAY_MS: number; // This one is mutable
  readonly MAX_CAPTURE_PARTS: number;
  readonly MAX_CAPTURE_HEIGHT_PX: number;
  readonly PIXEL_TOLERANCE: number;
  readonly SCRIPT_INIT_DELAY: number;
};

// Adjust CAPTURE_STITCH_DELAY_MS to respect Chrome's capture rate if available in runtime
// Some TS typings don't expose MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND; use a safe cast with a sane fallback.
const __MAX_CAP_RATE: number | undefined = (chrome.tabs as any)
  ?.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND;
if (typeof __MAX_CAP_RATE === 'number' && __MAX_CAP_RATE > 0) {
  // Minimum interval between consecutive captureVisibleTab calls (ms)
  const minIntervalMs = Math.ceil(1000 / __MAX_CAP_RATE);
  // Our capture loop already waits SCROLL_DELAY_MS between scroll and capture; add any extra delay needed
  const requiredExtraDelay = Math.max(0, minIntervalMs - SCREENSHOT_CONSTANTS.SCROLL_DELAY_MS);
  SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS = Math.max(
    requiredExtraDelay,
    SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS,
  );
}

interface ScreenshotToolParams {
  name?: string;
  selector?: string;
  targetIndex?: number;
  index?: number; // Alias for targetIndex
  padding?: number;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number; // 0-100
  tabId?: number;
  background?: boolean;
  windowId?: number;
  width?: number;
  height?: number;
  storeBase64?: boolean;
  fullPage?: boolean;
  savePng?: boolean;
  saveToDisk?: boolean;
  maxHeight?: number; // Maximum height to capture in pixels (for infinite scroll pages)
  grid?: boolean | string; // Overlay coordinate reference grid ('ruler' | 'crosshair' | 'classic' | '1000' | true)
  enableGrid?: boolean | string; // Alias for grid
  expandSearchArea?: boolean; // Adaptively expand crop box for small elements (<100x100)
  autoExpand?: boolean;
  som?: boolean; // Overlay Set-of-Mark numbered badges on interactive elements before capture
  highlight?: boolean; // Alias for som
  setOfMark?: boolean; // Alias for som
  /** Capture mode. 'som' = Set-of-Mark: annotated image + textual element map on ONE shared numbering scheme */
  mode?: 'som' | string;
  /** Zoom crop mode: label numbers to zoom into (crop around each label's safe click point, scaled up) */
  zoom?: number[];
  /** View a single visual asset listed by chrome_read_dom (1-based asset index). Bytes first, viewport-crop fallback */
  assetIndex?: number;
  /** Sub-region ROI crop (lossless zoom into specified bounding box [ymin, xmin, ymax, xmax] or { x0, y0, x1, y1 }) */
  region?:
    | {
        x0?: number;
        y0?: number;
        x1?: number;
        y1?: number;
        xmin?: number;
        ymin?: number;
        xmax?: number;
        ymax?: number;
      }
    | [number, number, number, number]
    | any;
  crop?:
    | {
        x0?: number;
        y0?: number;
        x1?: number;
        y1?: number;
        xmin?: number;
        ymin?: number;
        xmax?: number;
        ymax?: number;
      }
    | [number, number, number, number]
    | any;
  highClarity?: boolean; // Prioritize 100% full-resolution clarity without downsampling
  allowDimensionScaling?: boolean; // Allow downscaling image dimensions for transport budget
  sessionId?: string;
  sessionContext?: string;
}

/** Page details returned by screenshot-helper content script */
interface ScreenshotPageDetails {
  totalWidth: number;
  totalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  currentScrollX: number;
  currentScrollY: number;
}

const PAGE_DETAILS_REQUIRED_FIELDS: Array<keyof ScreenshotPageDetails> = [
  'totalWidth',
  'totalHeight',
  'viewportWidth',
  'viewportHeight',
  'devicePixelRatio',
  'currentScrollX',
  'currentScrollY',
];

/**
 * Validates and asserts that the response from content script contains valid page details
 */
function assertValidPageDetails(details: unknown): ScreenshotPageDetails {
  if (!details || typeof details !== 'object') {
    throw new Error(
      'Screenshot helper did not respond. The content script may not be injected or cannot run on this page.',
    );
  }

  const candidate = details as Partial<ScreenshotPageDetails>;
  const invalidFields = PAGE_DETAILS_REQUIRED_FIELDS.filter(
    (field) => typeof candidate[field] !== 'number' || !Number.isFinite(candidate[field]),
  );

  if (invalidFields.length > 0) {
    throw new Error(
      `Screenshot helper returned invalid page details (missing/invalid: ${invalidFields.join(', ')}).`,
    );
  }

  return candidate as ScreenshotPageDetails;
}

/**
 * Normalizes an image data URL to exact CSS dimensions by scaling onto an OffscreenCanvas.
 * Eliminates physical coordinate drift across arbitrary display scaling (125%, 150%, 200%).
 */
export async function normalizeImageToCssDimensions(
  dataUrl: string,
  targetWidthCss: number,
  targetHeightCss: number,
  mimeType: string = 'image/webp',
  quality: number = 0.8,
): Promise<string> {
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return dataUrl;
  }
  try {
    const img = await createImageBitmapFromUrl(dataUrl);
    if (
      img.width === targetWidthCss &&
      img.height === targetHeightCss &&
      dataUrl.startsWith(`data:${mimeType}`)
    ) {
      return dataUrl;
    }
    const canvas = new OffscreenCanvas(targetWidthCss, targetHeightCss);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context from OffscreenCanvas');
    ctx.drawImage(img, 0, 0, targetWidthCss, targetHeightCss);
    return await canvasToDataURL(canvas, mimeType, quality);
  } catch {
    return dataUrl;
  }
}

/**
 * Detect window-transition black bars (right/bottom edges fully near-black).
 * Samples 1px lines at the right and bottom edges; >92% black on EITHER edge
 * after activation means the compositor had not presented the real frame.
 */
async function hasBlackBars(dataUrl: string): Promise<boolean> {
  try {
    const img = await createImageBitmapFromUrl(dataUrl);
    const w = img.width,
      h = img.height;
    if (w < 64 || h < 64) return false;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0);
    const sample = (edge: 'right' | 'bottom'): number => {
      const count = edge === 'right' ? 48 : 48;
      let black = 0;
      for (let i = 0; i < count; i++) {
        const x = edge === 'right' ? w - 1 : Math.floor((i / count) * w);
        const y = edge === 'bottom' ? h - 1 : Math.floor((i / count) * h);
        const d = ctx.getImageData(x, y, 1, 1).data;
        if (d[0] + d[1] + d[2] < 18) black++;
      }
      return black / count;
    };
    const right = sample('right');
    const bottom = sample('bottom');
    return right > 0.92 || bottom > 0.92;
  } catch {
    return false;
  }
}

const pendingScreenshotFilenames = new Map<number, string>();

if (typeof chrome !== 'undefined' && chrome.downloads?.onDeterminingFilename) {
  try {
    chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
      const designatedName = pendingScreenshotFilenames.get(item.id);
      if (designatedName) {
        pendingScreenshotFilenames.delete(item.id);
        suggest({ filename: designatedName, conflictAction: 'uniquify' });
      }
    });
  } catch {}
}

/**
 * Saves screenshot base64 data to the system temporary directory via Native Messaging Host.
 * Strictly avoids polluting the user's personal Downloads folder.
 */
async function saveScreenshotToNativeTemp(
  base64Data: string,
  filename: string,
  fullDataUrl?: string,
): Promise<{ filename?: string; fullPath?: string } | undefined> {
  try {
    const { sendFileOperationToNative, cancelFileOperation, ensureNativeConnected } =
      await import('../../native-host');
    if (typeof ensureNativeConnected === 'function') {
      await ensureNativeConnected('save_screenshot').catch(() => false);
    }
    let cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, '');
    // If base64 payload exceeds 600KB, compress using smartCompressForTransport so it comfortably fits within the 1MB Native Messaging ceiling
    const sourceDataUrl =
      fullDataUrl ||
      (base64Data.startsWith('data:') ? base64Data : `data:image/png;base64,${cleanBase64}`);
    if (cleanBase64.length > 600 * 1024 && typeof OffscreenCanvas !== 'undefined') {
      try {
        const compressed = await smartCompressForTransport(sourceDataUrl, {
          maxBytes: 550 * 1024,
          preferredFormat: 'image/webp',
          allowDimensionScaling: true,
        });
        cleanBase64 = compressed.dataUrl.replace(/^data:[^;]+;base64,/, '');
        filename = filename.replace(/\.[a-z0-9]+$/i, '.webp');
      } catch (compressErr) {
        console.warn('saveScreenshotToNativeTemp compression fallback failed:', compressErr);
      }
    }

    const requestId = `screenshot-temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeoutMs = 20000;
    const resp = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        cancelFileOperation(requestId);
        reject(new Error('Native temp save timed out'));
      }, timeoutMs);

      const ok = sendFileOperationToNative(
        {
          type: 'file_operation',
          requestId,
          payload: {
            action: 'prepareFile',
            base64Data: cleanBase64,
            fileName: filename,
          },
        },
        (message: any) => {
          clearTimeout(timer);
          resolve(message?.payload);
        },
      );

      if (!ok) {
        clearTimeout(timer);
        reject(new Error('Native host not connected'));
      }
    });

    if (resp && resp.success && resp.filePath) {
      return { filename, fullPath: resp.filePath };
    }
  } catch (err) {
    console.warn('saveScreenshotToNativeTemp failed, falling back:', err);
  }
  return undefined;
}

/**
 * A single Set-of-Mark label. The SAME array of labels feeds both the numbered
 * marks drawn onto the screenshot image and the textual element map, so the
 * numbering can never desync between the two representations.
 */
export interface SomLabel {
  n: number;
  tag: string;
  name: string;
  x: number;
  y: number;
}

/** Result of safe-click-point resolution. `occluded` is true when samples were covered. */
export interface ResolvedClickPoint {
  x: number;
  y: number;
  occluded: boolean;
}

export type ZoomResolution =
  | { ok: true; targets: SomLabel[] }
  | { ok: false; error: string; unknown: number[]; validNumbers: number[] };

/** One resolved zoom crop: the label number, its crop box, and the image bytes. */
export interface ZoomCropImage {
  n: number;
  crop: { x: number; y: number; width: number; height: number; scale: number };
  dataUrl: string;
}

/**
 * Outcome of a zoom crop request. A failure is always STRUCTURED (code + the
 * valid label numbers) so an unknown label can never be silently dropped.
 */
export type ZoomCropOutcome =
  | { ok: true; images: ZoomCropImage[] }
  | {
      ok: false;
      code: 'unknown_som_label';
      message: string;
      unknownLabels: number[];
      validLabels: number[];
    };

/**
 * Accepts `zoom` as a single label number or an array of them. A scalar used to
 * be dropped on the floor (the live defect: `zoom: 2` returned the plain
 * screenshot with no error); anything non-numeric is now a structured rejection
 * rather than silence.
 */
export function normalizeZoomRequest(
  value: unknown,
): { ok: true; labels: number[] } | { ok: false; code: 'invalid_zoom_param'; message: string } {
  if (value === undefined || value === null) return { ok: true, labels: [] };
  const raw = Array.isArray(value) ? value : [value];
  const labels: number[] = [];
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      return {
        ok: false,
        code: 'invalid_zoom_param',
        message: `zoom must be a Set-of-Mark label number or an array of them; received ${JSON.stringify(value)}.`,
      };
    }
    const n = Math.trunc(item);
    if (n > 0 && !labels.includes(n)) labels.push(n);
  }
  return { ok: true, labels };
}

/** Builds the tool result for a rejected zoom request (structured, never silence). */
export function zoomErrorResponse(
  failure: { code: string; message: string } & Record<string, unknown>,
): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ success: false, ...failure }, null, 2),
      },
    ],
    isError: true,
  };
}

/** 3x3 grid sampled at 15% / 50% / 85% of width and height (the 9-point map). */
const SOM_SAFE_GRID_RATIOS = [0.15, 0.5, 0.85] as const;

/**
 * Renders the textual element map. Each line is exactly `[<n>] <tag> – <name>`
 * (en-dash U+2013 between tag and name).
 */
export function buildElementMap(labels: SomLabel[]): string[] {
  return labels.map((label) => `[${label.n}] ${label.tag} – ${label.name}`);
}

/** True when the hit element is the element itself or one of its descendants (composed-tree aware). */
function isSelfOrDescendant(el: Element, hit: Element | null): boolean {
  let current: Element | null = hit;
  while (current) {
    if (current === el) return true;
    const root = current.getRootNode ? current.getRootNode() : null;
    const host = root && (root as any).nodeType === 11 ? (root as any).host : null;
    current = current.parentElement || host || null;
  }
  return false;
}

/**
 * Resolves a safe click point for an element using document.elementFromPoint
 * sampling over the 9-point map. The returned point is one where
 * elementFromPoint resolves to the element ITSELF (or its descendant) — never a
 * sticky header / modal covering it. The naive geometric centre is returned
 * only when no sampled point is clear, and then `occluded` is set to true.
 */
export function resolveClickPoint(el: Element): ResolvedClickPoint {
  const rect = el.getBoundingClientRect();
  const centre = {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  };

  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { x: centre.x, y: centre.y, occluded: false };
  }

  const clearPoints: Array<{ x: number; y: number }> = [];
  let centreClear = false;

  for (const ry of SOM_SAFE_GRID_RATIOS) {
    for (const rx of SOM_SAFE_GRID_RATIOS) {
      const px = Math.round(rect.left + rect.width * rx);
      const py = Math.round(rect.top + rect.height * ry);
      let hit: Element | null = null;
      try {
        hit =
          typeof document.elementFromPoint === 'function'
            ? document.elementFromPoint(px, py)
            : null;
      } catch {
        hit = null;
      }
      if (!hit || isSelfOrDescendant(el, hit)) {
        clearPoints.push({ x: px, y: py });
        if (rx === 0.5 && ry === 0.5) centreClear = true;
      }
    }
  }

  // Every sampled point is covered: return the best point from the map (the
  // geometric centre) and flag it, rather than silently pretending it is safe.
  if (clearPoints.length === 0) {
    return { x: centre.x, y: centre.y, occluded: true };
  }

  // A clear point was found: the returned point is not occluded. The flag
  // describes the returned point, not whether some other sample was covered.
  if (centreClear) {
    return { x: centre.x, y: centre.y, occluded: false };
  }

  // NEVER fall back to the naive geometric centre when the map has a hit:
  // pick the clear sample closest to the centre (ties keep enumeration order).
  let best = clearPoints[0];
  let bestDistance = Infinity;
  for (const point of clearPoints) {
    const distance = Math.hypot(point.x - centre.x, point.y - centre.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return { x: best.x, y: best.y, occluded: false };
}

/** Resolves requested zoom label numbers to their labels, erroring with the valid set. */
export function resolveZoomTargets(labels: SomLabel[], requested: number[]): ZoomResolution {
  const byNumber = new Map(labels.map((label) => [label.n, label]));
  const validNumbers = labels.map((label) => label.n);
  const unknown = requested.filter((n) => !byNumber.has(n));
  if (unknown.length > 0) {
    const valid = validNumbers.join(', ');
    return {
      ok: false,
      error: `Unknown Set-of-Mark label number(s): ${unknown.join(', ')}. Valid label numbers: ${valid || '(none)'}.`,
      unknown,
      validNumbers,
    };
  }
  return { ok: true, targets: requested.map((n) => byNumber.get(n)!) };
}

function clampZoomCrop(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  scale = 2,
  padding = 8,
): { x: number; y: number; width: number; height: number; scale: number } | null {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const x0 = Math.max(0, Math.floor(rect.x - padding));
  const y0 = Math.max(0, Math.floor(rect.y - padding));
  const x1 = Math.min(viewport.width, Math.ceil(rect.x + rect.width + padding));
  const y1 = Math.min(viewport.height, Math.ceil(rect.y + rect.height + padding));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  return { x: x0, y: y0, width, height, scale };
}

/** Draws numbered SoM badges at each label's safe click point onto the image. */
async function overlaySomMarkers(
  dataUrl: string,
  labels: SomLabel[],
  mimeType: string,
  quality: number,
): Promise<string> {
  if (typeof OffscreenCanvas === 'undefined' || labels.length === 0) return dataUrl;
  try {
    const img = await createImageBitmapFromUrl(dataUrl);
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0);
    const radius = Math.max(9, Math.min(18, Math.round(Math.min(img.width, img.height) / 55)));
    ctx.font = `bold ${Math.round(radius * 1.1)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const label of labels) {
      if (label.x < 0 || label.y < 0 || label.x > img.width || label.y > img.height) continue;
      ctx.beginPath();
      ctx.arc(label.x, label.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(226, 38, 38, 0.88)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(label.n), label.x, label.y);
    }
    return await canvasToDataURL(canvas, mimeType as any, quality);
  } catch (err) {
    console.warn('Failed to overlay Set-of-Mark markers:', err);
    return dataUrl;
  }
}

/** Crops and upscales one region of the captured image. */
async function cropZoomRegion(
  dataUrl: string,
  crop: { x: number; y: number; width: number; height: number; scale: number },
  mimeType: string,
  quality: number,
  maxDimension = 1600,
): Promise<string | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const img = await createImageBitmapFromUrl(dataUrl);
    const outWidth = Math.max(1, Math.min(maxDimension, Math.round(crop.width * crop.scale)));
    const outHeight = Math.max(1, Math.min(maxDimension, Math.round(crop.height * crop.scale)));
    const canvas = new OffscreenCanvas(outWidth, outHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, outWidth, outHeight);
    return await canvasToDataURL(canvas, mimeType as any, quality);
  } catch (err) {
    console.warn('Failed to produce zoom crop:', err);
    return null;
  }
}

/**
 * Zoom crop mode: resolve the requested Set-of-Mark label numbers against the
 * SAME one-pass label array that produced the drawn marks / element map (no
 * desync), crop+upscale each label's region, and return the image bytes.
 *
 * Unknown label numbers return a structured failure carrying the valid numbers;
 * the caller must surface that, never swallow it.
 */
export async function applyZoomCrops(input: {
  imageDataUrl: string;
  labels: SomLabel[];
  rects: Map<number, { x: number; y: number; width: number; height: number }>;
  requested: number[];
  viewport: { width: number; height: number };
  mimeType: string;
  quality: number;
  scale?: number;
}): Promise<ZoomCropOutcome> {
  const resolution = resolveZoomTargets(input.labels, input.requested);
  if (!resolution.ok) {
    return {
      ok: false,
      code: 'unknown_som_label',
      message: resolution.error,
      unknownLabels: resolution.unknown,
      validLabels: resolution.validNumbers,
    };
  }

  const images: ZoomCropImage[] = [];
  for (const target of resolution.targets) {
    const rect = input.rects.get(target.n) || {
      x: target.x - 40,
      y: target.y - 40,
      width: 80,
      height: 80,
    };
    const crop = clampZoomCrop(rect, input.viewport, input.scale ?? 2);
    if (!crop) continue;
    const dataUrl = await cropZoomRegion(input.imageDataUrl, crop, input.mimeType, input.quality);
    if (dataUrl) images.push({ n: target.n, crop, dataUrl });
  }
  return { ok: true, images };
}

/**
 * Builds SoM labels (one shared array) from the indexed elements returned by
 * inPageDOMPruner. Subframe indices are offset exactly like the badge reindex
 * pass so the numbering matches the drawn badges.
 */
function buildSomLabelsFromResults(somResults: any[]): {
  labels: SomLabel[];
  rects: Map<number, { x: number; y: number; width: number; height: number }>;
} {
  const labels: SomLabel[] = [];
  const rects = new Map<number, { x: number; y: number; width: number; height: number }>();
  if (!Array.isArray(somResults) || somResults.length === 0) return { labels, rects };

  const mainFrame = somResults.find((r) => r.frameId === 0) || somResults[0];
  const ordered = [mainFrame, ...somResults.filter((r) => r !== mainFrame)];
  let runningIndex = (mainFrame?.result?.indexedElements?.length || 0) + 1;

  for (const frame of ordered) {
    const elements = frame?.result?.indexedElements;
    if (!Array.isArray(elements)) continue;
    const offset = frame === mainFrame ? 0 : runningIndex - 1;
    if (frame !== mainFrame) runningIndex += elements.length;
    for (const el of elements) {
      const n = Number(el?.index) + offset;
      if (!Number.isFinite(n) || n <= 0) continue;
      const tag = String(el?.tagName || el?.tag || 'element').toLowerCase();
      const name =
        String(
          el?.text ||
            el?.attributes?.['aria-label'] ||
            el?.attributes?.name ||
            el?.attributes?.placeholder ||
            el?.role ||
            '',
        ).trim() || tag;
      const safePoint = el?.safeClickPoint || el?.rect || { x: 0, y: 0 };
      labels.push({
        n,
        tag,
        name,
        x: Math.round(Number(safePoint.x) || 0),
        y: Math.round(Number(safePoint.y) || 0),
      });
      const rect = el?.rect || {};
      rects.set(n, {
        x: Number(rect.x) || 0,
        y: Number(rect.y) || 0,
        width: Number(rect.width) || 0,
        height: Number(rect.height) || 0,
      });
    }
  }
  return { labels, rects };
}

/**
 * Tool for capturing screenshots of web pages
 */
class ScreenshotTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SCREENSHOT;

  /**
   * Execute screenshot operation
   */
  async execute(rawArgs: ScreenshotToolParams): Promise<ToolResult> {
    const targetIndex =
      typeof rawArgs.targetIndex === 'number'
        ? rawArgs.targetIndex
        : typeof (rawArgs as any).index === 'number'
          ? (rawArgs as any).index
          : undefined;
    const grid = rawArgs.grid ?? (rawArgs as any).enableGrid;
    // Zoom accepts a single label number or an array. A non-numeric value is a
    // structured rejection — the old array-only check silently dropped scalars.
    const zoomNormalized = normalizeZoomRequest((rawArgs as any).zoom);
    if (!zoomNormalized.ok) return zoomErrorResponse(zoomNormalized);
    const zoomRequested: number[] = zoomNormalized.labels;
    const som =
      rawArgs.som === true ||
      (rawArgs as any).highlight === true ||
      (rawArgs as any).setOfMark === true ||
      (rawArgs as any).mode === 'som' ||
      zoomRequested.length > 0;

    const args: ScreenshotToolParams = {
      ...rawArgs,
      targetIndex,
      grid,
      som,
    };

    const {
      name = 'screenshot',
      selector,
      storeBase64 = false,
      fullPage = false,
      savePng = false,
      saveToDisk = false,
      format = args.format || 'webp',
    } = args;

    console.log(`Starting screenshot with options:`, args);

    // Resolve target tab with Session Tab Affinity support
    const tab = await this.resolveAffinityTab({
      tabId: args.tabId,
      windowId: args.windowId,
      sessionId: args.sessionId || args.sessionContext,
    });

    // Check URL restrictions (shared with every content-script tool)
    if (isRestrictedChromeUrl(tab.url)) {
      return createErrorResponse(
        'Cannot capture special browser pages or web store pages due to security restrictions.',
      );
    }

    let finalImageDataUrl: string | undefined;
    let finalImageWidthCss: number | undefined;
    let finalImageHeightCss: number | undefined;
    const results: any = { base64: null, fileSaved: false };
    let originalScroll: { x: number; y: number } | null = null;
    let didPreparePage = false;
    let didInjectSoM = false;
    let pageDetails: ScreenshotPageDetails | undefined;

    let elementCropOrigin: { x: number; y: number } | undefined;
    // Set-of-Mark: ONE shared labels array feeds both the drawn marks and the element map.
    let somLabels: SomLabel[] = [];
    let enableSoM = false;
    const somRects = new Map<number, { x: number; y: number; width: number; height: number }>();
    const somZoomImages: Array<{
      n: number;
      crop: { x: number; y: number; width: number; height: number; scale: number };
      dataUrl: string;
    }> = [];
    const qualityFraction =
      typeof args.quality === 'number' ? Math.max(0, Math.min(1, args.quality / 100)) : 0.8;

    try {
      enableSoM = args.som === true;
      if (enableSoM) {
        try {
          const somResults = await executeInPage(
            { tabId: tab.id!, allFrames: true },
            'inPageDOMPruner',
            [{ highlight: true }],
          );
          didInjectSoM = true;

          // Reindex subframe badges so they match global monotonic indices from chrome_read_dom
          if (Array.isArray(somResults) && somResults.length > 1) {
            const mainFrame = somResults.find((r) => r.frameId === 0) || somResults[0];
            let currentIndex = (mainFrame?.result?.indexedElements?.length || 0) + 1;

            for (const r of somResults) {
              if (r === mainFrame || !r.result) continue;
              const subCount = r.result.indexedElements?.length || 0;
              if (subCount > 0 && r.frameId !== undefined) {
                const frameOffset = currentIndex - 1;
                currentIndex += subCount;
                try {
                  await executeInPage(
                    { tabId: tab.id!, frameIds: [r.frameId] },
                    'inPageReindexFrame',
                    [frameOffset, true],
                  );
                } catch (reindexErr) {
                  console.warn(
                    `Failed to reindex subframe ${r.frameId} for screenshot:`,
                    reindexErr,
                  );
                }
              }
            }
          }

          // Build the ONE shared labels array from the pruned elements. Both the
          // drawn marks and the textual element map derive from this array.
          const built = buildSomLabelsFromResults(somResults as any[]);
          somLabels = built.labels;
          for (const [n, rect] of built.rects) somRects.set(n, rect);
        } catch (somErr) {
          console.warn('Failed to render Set-of-Mark badges for screenshot:', somErr);
        }
      }

      const background = args.background === true;
      const targetMimeType =
        format === 'webp' ? 'image/webp' : format === 'jpeg' ? 'image/jpeg' : 'image/png';

      // === Path 0: named asset (from chrome_read_dom assets[]) ===
      // Primary: fetch real bytes in page (canvas toDataURL / img+bg fetch).
      // Fallback: crop the viewport capture by the asset rect.
      let assetHandled = false;
      if (typeof args.assetIndex === 'number') {
        const assetResults = await executeInPage(
          { tabId: tab.id!, allFrames: true },
          'inPageGetAssetImage',
          [args.assetIndex],
        );
        const asset = assetResults?.find((r) => r.result)?.result;
        if (!asset?.rect) {
          return createErrorResponse(
            asset?.reason ||
              `Asset ${args.assetIndex} not found. Run ${resolveToolName('read_dom')} to list assets.`,
          );
        }
        if (asset.dataUrl && asset.dataUrl.startsWith('data:')) {
          finalImageDataUrl = asset.dataUrl;
          const img = await createImageBitmapFromUrl(asset.dataUrl);
          finalImageWidthCss = img.width;
          finalImageHeightCss = img.height;
          assetHandled = true;
          results.assetKind = asset.kind;
          results.assetSrc = asset.src;
          results.assetSource = 'bytes';
        } else {
          // Fallback: viewport crop of the asset rect (DPR-scaled)
          const dpr = pageDetails?.devicePixelRatio || 1;
          const pad = Math.max(0, args.padding ?? 0);
          const crop = {
            x: Math.max(0, Math.round((asset.rect.x - pad) * dpr)),
            y: Math.max(0, Math.round((asset.rect.y - pad) * dpr)),
            w: Math.round((asset.rect.width + pad * 2) * dpr),
            h: Math.round((asset.rect.height + pad * 2) * dpr),
          };
          const visibleDataUrl = await this.captureTabPng(tab);
          if (!visibleDataUrl)
            throw new Error('captureTabPng returned empty image (asset fallback)');
          const cropped = new OffscreenCanvas(crop.w, crop.h);
          const cctx = cropped.getContext('2d');
          if (!cctx) throw new Error('OffscreenCanvas 2d context failed (asset fallback)');
          const raw = await createImageBitmapFromUrl(visibleDataUrl);
          cctx.drawImage(raw, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
          finalImageDataUrl = await canvasToDataURL(
            cropped,
            targetMimeType as any,
            qualityFraction,
          );
          finalImageWidthCss = crop.w;
          finalImageHeightCss = crop.h;
          assetHandled = true;
          results.assetKind = asset.kind;
          results.assetSrc = asset.src;
          results.assetSource = 'viewport-crop';
          results.assetFallbackReason = asset.reason;
        }
      }

      // === Path -1: Sub-region ROI crop (lossless zoom / crop) ===
      const roiInput = args.region || (args as any).crop;
      if (!assetHandled && roiInput) {
        try {
          const tabId = tab.id!;
          const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
          await cdpSessionManager.withSession(tabId, 'screenshot-roi', async () => {
            const metrics: any = await cdpSessionManager.sendCommand(
              tabId,
              'Page.getLayoutMetrics',
              {},
            );
            const viewport = metrics?.cssVisualViewport ||
              metrics?.cssLayoutViewport ||
              metrics?.layoutViewport ||
              metrics?.visualViewport || {
                clientWidth: 1280,
                clientHeight: 800,
                pageX: 0,
                pageY: 0,
              };
            const vw = Math.round(viewport.clientWidth || 1280);
            const vh = Math.round(viewport.clientHeight || 800);
            const pageX = Number(viewport.pageX || 0);
            const pageY = Number(viewport.pageY || 0);

            let rx0 = 0,
              ry0 = 0,
              rx1 = vw,
              ry1 = vh;
            if (Array.isArray(roiInput) && roiInput.length === 4) {
              const [a, b, c, d] = roiInput.map(Number);
              let isYminFirst = true;
              if ((a > vh || c > vh) && a <= vw && c <= vw) isYminFirst = false;
              else if ((b > vh || d > vh) && b <= vw && d <= vw) isYminFirst = true;
              const ymin = isYminFirst ? Math.min(a, c) : Math.min(b, d);
              const ymax = isYminFirst ? Math.max(a, c) : Math.max(b, d);
              const xmin = isYminFirst ? Math.min(b, d) : Math.min(a, c);
              const xmax = isYminFirst ? Math.max(b, d) : Math.max(a, c);
              const maxVal = Math.max(a, b, c, d);
              if (maxVal <= 1.0 && maxVal > 0) {
                rx0 = Math.round(xmin * vw);
                rx1 = Math.round(xmax * vw);
                ry0 = Math.round(ymin * vh);
                ry1 = Math.round(ymax * vh);
              } else if (maxVal <= 1000 && (ymax > vh || xmax > vw)) {
                rx0 = Math.round((xmin / 1000) * vw);
                rx1 = Math.round((xmax / 1000) * vw);
                ry0 = Math.round((ymin / 1000) * vh);
                ry1 = Math.round((ymax / 1000) * vh);
              } else {
                rx0 = Math.round(xmin);
                rx1 = Math.round(xmax);
                ry0 = Math.round(ymin);
                ry1 = Math.round(ymax);
              }
            } else if (typeof roiInput === 'object' && roiInput !== null) {
              const rawX0 = roiInput.x0 ?? roiInput.xmin ?? roiInput.left ?? 0;
              const rawY0 = roiInput.y0 ?? roiInput.ymin ?? roiInput.top ?? 0;
              const rawX1 =
                roiInput.x1 ??
                roiInput.xmax ??
                (typeof roiInput.width === 'number' ? rawX0 + roiInput.width : vw);
              const rawY1 =
                roiInput.y1 ??
                roiInput.ymax ??
                (typeof roiInput.height === 'number' ? rawY0 + roiInput.height : vh);
              rx0 = Math.round(Number(rawX0));
              rx1 = Math.round(Number(rawX1));
              ry0 = Math.round(Number(rawY0));
              ry1 = Math.round(Number(rawY1));
            }
            rx0 = Math.max(0, Math.min(vw - 1, rx0));
            ry0 = Math.max(0, Math.min(vh - 1, ry0));
            rx1 = Math.max(rx0 + 1, Math.min(vw, rx1));
            ry1 = Math.max(ry0 + 1, Math.min(vh, ry1));
            const w = rx1 - rx0;
            const h = ry1 - ry0;

            const cdpFormat = format === 'webp' ? 'webp' : format === 'png' ? 'png' : 'jpeg';
            const cdpQuality =
              (cdpFormat === 'jpeg' || cdpFormat === 'webp') && typeof args.quality === 'number'
                ? Math.max(0, Math.min(100, Math.round(args.quality)))
                : 85;

            const shot: any = await cdpSessionManager.sendCommand(tabId, 'Page.captureScreenshot', {
              format: cdpFormat,
              quality: cdpQuality,
              captureBeyondViewport: false,
              fromSurface: true,
              clip: {
                x: pageX + rx0,
                y: pageY + ry0,
                width: w,
                height: h,
                scale: 1,
              },
            });
            if (shot?.data) {
              const rawDataUrl = `data:${shot.mimeType || targetMimeType};base64,${shot.data}`;
              finalImageDataUrl = await normalizeImageToCssDimensions(
                rawDataUrl,
                w,
                h,
                targetMimeType,
                qualityFraction,
              );
              finalImageWidthCss = w;
              finalImageHeightCss = h;
              elementCropOrigin = { x: rx0, y: ry0 };
              assetHandled = true;
              results.roi = { x0: rx0, y0: ry0, x1: rx1, y1: ry1, width: w, height: h };
            }
          });
        } catch (roiErr) {
          console.warn('ROI crop capture failed, falling through:', roiErr);
        }
      }

      // CDP path: simple viewport capture (no fullPage, no selector, no targetIndex, no som)
      const canUseCdpCapture =
        !assetHandled &&
        !fullPage &&
        !selector &&
        typeof args.targetIndex !== 'number' &&
        !enableSoM;

      // === Path 1: CDP viewport capture (no content script needed) ===
      if (canUseCdpCapture) {
        try {
          const tabId = tab.id!;
          const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
          await cdpSessionManager.withSession(tabId, 'screenshot', async () => {
            // Wait two compositor frames so a just-activated/just-navigated
            // tab has presented its real content; otherwise captureScreenshot
            // races the window-transition frame and returns black bars.
            try {
              if (tab.active) {
                const rafPromise = cdpSessionManager.sendCommand(tabId, 'Runtime.evaluate', {
                  expression:
                    'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))',
                  awaitPromise: true,
                });
                await Promise.race([rafPromise, new Promise((r) => setTimeout(r, 300))]);
              } else {
                await new Promise((r) => setTimeout(r, 50));
              }
            } catch (rafErr) {
              console.warn('rAF settle wait failed (capturing anyway):', rafErr);
            }
            const metrics: any = await cdpSessionManager.sendCommand(
              tabId,
              'Page.getLayoutMetrics',
              {},
            );
            const viewport = metrics?.cssVisualViewport ||
              metrics?.cssLayoutViewport ||
              metrics?.layoutViewport ||
              metrics?.visualViewport || {
                clientWidth: 800,
                clientHeight: 600,
                pageX: 0,
                pageY: 0,
              };
            const cdpFormat = format === 'webp' ? 'webp' : format === 'png' ? 'png' : 'jpeg';
            const cdpQuality =
              (cdpFormat === 'jpeg' || cdpFormat === 'webp') && typeof args.quality === 'number'
                ? Math.max(0, Math.min(100, Math.round(args.quality)))
                : cdpFormat === 'jpeg' || cdpFormat === 'webp'
                  ? 80
                  : undefined;

            const clientWidth = Math.round(viewport.clientWidth || 800);
            const clientHeight = Math.round(viewport.clientHeight || 600);
            originalScroll = { x: viewport.pageX || 0, y: viewport.pageY || 0 };

            const shot: any = await cdpSessionManager.sendCommand(tabId, 'Page.captureScreenshot', {
              format: cdpFormat,
              quality: cdpQuality,
              captureBeyondViewport: false,
              fromSurface: true,
              clip: {
                x: viewport.pageX || 0,
                y: viewport.pageY || 0,
                width: clientWidth,
                height: clientHeight,
                scale: 1,
              },
            });
            const base64Data = typeof shot?.data === 'string' ? shot.data : '';
            if (!base64Data) {
              throw new Error('CDP Page.captureScreenshot returned empty data');
            }
            const rawDataUrl = `data:${shot.mimeType || targetMimeType};base64,${base64Data}`;
            // Enforce DPR 1:1 normalization via OffscreenCanvas
            finalImageDataUrl = await normalizeImageToCssDimensions(
              rawDataUrl,
              clientWidth,
              clientHeight,
              targetMimeType,
              qualityFraction,
            );
            finalImageWidthCss = clientWidth;
            finalImageHeightCss = clientHeight;
            if (await hasBlackBars(finalImageDataUrl)) {
              // Window-transition frame: wait two more presented frames and
              // retry exactly once before accepting the capture.
              await new Promise((r) => setTimeout(r, 250));
              try {
                await cdpSessionManager.sendCommand(tabId, 'Runtime.evaluate', {
                  expression:
                    'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))',
                  awaitPromise: true,
                });
              } catch {}
              const retry: any = await cdpSessionManager.sendCommand(
                tabId,
                'Page.captureScreenshot',
                {
                  format: cdpFormat,
                  quality: cdpQuality,
                  captureBeyondViewport: false,
                  fromSurface: true,
                  clip: {
                    x: viewport.pageX || 0,
                    y: viewport.pageY || 0,
                    width: clientWidth,
                    height: clientHeight,
                    scale: 1,
                  },
                },
              );
              const retryData = typeof retry?.data === 'string' ? retry.data : '';
              if (retryData) {
                finalImageDataUrl = await normalizeImageToCssDimensions(
                  `data:${retry.mimeType || targetMimeType};base64,${retryData}`,
                  clientWidth,
                  clientHeight,
                  targetMimeType,
                  qualityFraction,
                );
              }
            }
          });
        } catch (e) {
          console.warn('CDP viewport capture failed, falling back to helper path:', e);
        }
      }

      // === Path 2: Helper-assisted capture (requires content script) ===
      if (!assetHandled && !finalImageDataUrl) {
        // Always inject helper when we need pageDetails
        await this.injectContentScript(tab.id!, ['inject-scripts/screenshot-helper.js']);
        await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY));

        // Prepare page (hide scrollbars, handle fixed elements)
        // Helper messages can die with a stale listener after extension
        // reloads or renderer swaps. One re-inject + retry recovers them;
        // a second failure surfaces as the original error.
        const prepareResp = await this.sendToHelperWithRetry(tab.id!, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE,
          options: { fullPage },
        });
        if (!prepareResp || prepareResp.success !== true) {
          throw new Error(
            'Screenshot helper did not acknowledge page preparation. The content script may not be injected or cannot run on this page.',
          );
        }
        didPreparePage = true;

        // Get page details with validation
        const rawPageDetails = await this.sendToHelperWithRetry(tab.id!, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_GET_PAGE_DETAILS,
        });
        pageDetails = assertValidPageDetails(rawPageDetails);
        originalScroll = { x: pageDetails.currentScrollX, y: pageDetails.currentScrollY };

        if (fullPage) {
          this.logInfo('Capturing full page...');
          const fullCapture = await this._captureFullPage(tab.id!, args, pageDetails, tab.windowId);
          finalImageDataUrl = fullCapture.dataUrl;
          finalImageWidthCss = fullCapture.widthCss;
          finalImageHeightCss = fullCapture.heightCss;
        } else if (selector || typeof args.targetIndex === 'number') {
          this.logInfo(`Capturing element (selector=${selector}, targetIndex=${args.targetIndex})`);
          const elementCapture = await this._captureElement(
            tab.id!,
            args,
            pageDetails.devicePixelRatio,
            tab.windowId,
          );
          finalImageDataUrl = elementCapture.dataUrl;
          finalImageWidthCss = elementCapture.widthCss;
          finalImageHeightCss = elementCapture.heightCss;
          elementCropOrigin = { x: elementCapture.originX, y: elementCapture.originY };
        } else {
          // Visible area only
          this.logInfo('Capturing visible area...');
          const rawVisibleDataUrl = await this.captureTabPngWithRetry(tab);
          if (!rawVisibleDataUrl) throw new Error('captureVisibleTab returned empty image');
          // Enforce DPR 1:1 Normalization: resample from physical pixels to exact CSS viewport dimensions
          finalImageDataUrl = await normalizeImageToCssDimensions(
            rawVisibleDataUrl,
            pageDetails.viewportWidth,
            pageDetails.viewportHeight,
            targetMimeType,
            qualityFraction,
          );
          finalImageWidthCss = pageDetails.viewportWidth;
          finalImageHeightCss = pageDetails.viewportHeight;
        }
      }

      if (!finalImageDataUrl) {
        throw new Error('Failed to capture image data');
      }

      // 1.5. Coordinate reference grid overlay
      if ((args.grid === true || typeof args.grid === 'string') && finalImageDataUrl) {
        try {
          const gridStyle = typeof args.grid === 'string' ? (args.grid as any) : 'ruler';
          // Output canvas is 1:1 normalized to CSS pixels, so effective DPR is 1
          finalImageDataUrl = await overlayCoordinateGrid(
            finalImageDataUrl,
            1,
            100,
            targetMimeType,
            qualityFraction,
            {
              style:
                gridStyle === 'classic'
                  ? 'classic'
                  : gridStyle === 'crosshair'
                    ? 'crosshair'
                    : 'ruler',
              originX: elementCropOrigin?.x,
              originY: elementCropOrigin?.y,
              normalized1000: gridStyle === '1000',
            },
          );
        } catch (gridErr) {
          console.warn('Failed to overlay coordinate reference grid on screenshot:', gridErr);
        }
      }

      // 1.6. Set-of-Mark: draw numbered marks from the SAME labels array as the element map
      if (enableSoM && finalImageDataUrl && somLabels.length > 0) {
        const markerMime =
          format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : targetMimeType;
        finalImageDataUrl = await overlaySomMarkers(
          finalImageDataUrl,
          somLabels,
          markerMime,
          qualityFraction,
        );
      }

      // 1.7. Zoom crop mode: crop around each requested label's safe click point
      if (zoomRequested.length > 0 && finalImageDataUrl) {
        const viewport = {
          width: pageDetails?.viewportWidth ?? finalImageWidthCss ?? 0,
          height: pageDetails?.viewportHeight ?? finalImageHeightCss ?? 0,
        };
        const zoomMime =
          format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : targetMimeType;
        const zoomOutcome = await applyZoomCrops({
          imageDataUrl: finalImageDataUrl,
          labels: somLabels,
          rects: somRects,
          requested: zoomRequested,
          viewport,
          mimeType: zoomMime,
          quality: 0.92,
        });
        if (!zoomOutcome.ok) return zoomErrorResponse(zoomOutcome);
        for (const image of zoomOutcome.images) somZoomImages.push(image);
      }

      // 2. Process output
      // Update screenshot context for coordinate scaling by tools like chrome_computer
      try {
        if (typeof finalImageWidthCss === 'number' && typeof finalImageHeightCss === 'number') {
          let hostname = '';
          try {
            hostname = tab.url ? new URL(tab.url).hostname : '';
          } catch {
            // ignore
          }
          // For element captures or ROI crops, keep crop bounds and origin offset
          const isRoiOrElement = Boolean(elementCropOrigin);
          const cropW = isRoiOrElement ? finalImageWidthCss : undefined;
          const cropH = isRoiOrElement ? finalImageHeightCss : undefined;
          const viewportWidth = pageDetails?.viewportWidth ?? finalImageWidthCss;
          const viewportHeight = pageDetails?.viewportHeight ?? finalImageHeightCss;
          const captureMode: 'viewport' | 'fullpage' | 'element' = fullPage
            ? 'fullpage'
            : isRoiOrElement
              ? 'element'
              : 'viewport';
          const scrollX = originalScroll?.x ?? pageDetails?.currentScrollX ?? 0;
          const scrollY = originalScroll?.y ?? pageDetails?.currentScrollY ?? 0;
          const docWidth = fullPage ? (pageDetails?.totalWidth ?? finalImageWidthCss) : undefined;
          const docHeight = fullPage
            ? (pageDetails?.totalHeight ?? finalImageHeightCss)
            : undefined;
          screenshotContextManager.setContext(tab.id!, {
            screenshotWidth: finalImageWidthCss,
            screenshotHeight: finalImageHeightCss,
            viewportWidth,
            viewportHeight,
            cropWidth: cropW,
            cropHeight: cropH,
            originX: elementCropOrigin?.x,
            originY: elementCropOrigin?.y,
            devicePixelRatio: pageDetails?.devicePixelRatio,
            hostname,
            scrollX,
            scrollY,
            captureMode,
            docWidth,
            docHeight,
          });
        }
      } catch (e) {
        console.warn('Failed to set screenshot context:', e);
      }

      const shouldSaveDisk =
        (savePng === true || saveToDisk === true || (args as any).saveToDisk === true) &&
        args.savePng !== false &&
        (args as any).saveToDisk !== false;
      if (shouldSaveDisk) {
        this.logInfo(`Saving ${format.toUpperCase()} to temporary storage...`);
        try {
          const actualMime =
            finalImageDataUrl?.match(/^data:(image\/[^;]+);base64,/)?.[1] || targetMimeType;
          const ext =
            actualMime === 'image/webp' ? 'webp' : actualMime === 'image/jpeg' ? 'jpg' : 'png';
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const safeName = (name || 'screenshot').replace(/[^a-z0-9_-]/gi, '_');
          const filename = `${safeName}_${timestamp}.${ext}`;
          const rawBase64 = finalImageDataUrl
            ? finalImageDataUrl.replace(/^data:[^;]+;base64,/, '')
            : '';

          // Primary: save to system temporary directory via native messaging host (zero Downloads pollution)
          const tempSaved = await saveScreenshotToNativeTemp(
            rawBase64,
            filename,
            finalImageDataUrl,
          );

          if (tempSaved && tempSaved.fullPath) {
            results.filename = tempSaved.filename;
            results.fullPath = tempSaved.fullPath;
            results.fileSaved = true;
            results.savedTo = 'system_temp';
          } else if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
            // Secondary fallback: only if native host is unreachable and user explicitly requested disk save
            const downloadId = await chrome.downloads.download({
              url: finalImageDataUrl,
              filename: filename,
              saveAs: false,
              conflictAction: 'uniquify',
            });
            pendingScreenshotFilenames.set(downloadId, filename);

            results.downloadId = downloadId;
            results.filename = filename;
            results.fileSaved = true;
            results.savedTo = 'downloads';

            try {
              await new Promise((resolve) => setTimeout(resolve, 100));
              const [downloadItem] = await chrome.downloads.search({ id: downloadId });
              if (downloadItem && downloadItem.filename) {
                results.fullPath = downloadItem.filename;
              }
            } catch (pathError) {
              console.warn('Could not get full file path:', pathError);
            }
          }
        } catch (error) {
          console.error('Error saving screenshot file:', error);
          results.saveError = String(error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      console.error('Error during screenshot execution:', error);
      return createErrorResponse(
        `Screenshot error: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
    } finally {
      // 3. Reset page only if we prepared it
      if (didPreparePage) {
        try {
          // Only include scroll position if we successfully captured it
          const resetMessage: Record<string, unknown> = {
            action: TOOL_MESSAGE_TYPES.SCREENSHOT_RESET_PAGE_AFTER_CAPTURE,
          };
          if (originalScroll) {
            resetMessage.scrollX = originalScroll.x;
            resetMessage.scrollY = originalScroll.y;
          }
          await this.sendMessageToTab(tab.id!, resetMessage);
        } catch (err) {
          console.warn('Failed to reset page, tab might have closed:', err);
        }
      }

      // 4. Remove Set-of-Mark overlay if we injected it for screenshot
      if (didInjectSoM && tab.id) {
        try {
          const { inPageRemoveHighlights } = await import('./dom-indexer');
          await this.safeExecuteScript(tab.id, {
            target: { tabId: tab.id, allFrames: true },
            func: inPageRemoveHighlights,
          });
        } catch (err) {
          console.warn('Failed to remove Set-of-Mark highlights after screenshot:', err);
        }
      }
    }

    this.logInfo('Screenshot completed!');

    let finalBase64 =
      results.base64 ||
      (finalImageDataUrl ? finalImageDataUrl.replace(/^data:[^;]+;base64,/, '') : undefined);
    let finalMime: 'image/webp' | 'image/png' | 'image/jpeg' =
      format === 'webp' ? 'image/webp' : format === 'png' ? 'image/png' : 'image/jpeg';
    let isThumbnailFinal = false;

    if (finalBase64 && finalBase64.length > 450 * 1024 && finalImageDataUrl) {
      try {
        const isHighClarity = args.highClarity === true || fullPage === true;
        const maxBudget = fullPage
          ? args.highClarity
            ? 2000 * 1024
            : 1500 * 1024
          : args.highClarity
            ? 800 * 1024
            : 450 * 1024;
        const compressed = await smartCompressForTransport(finalImageDataUrl, {
          maxBytes: maxBudget,
          preferredFormat: finalMime,
          quality: isHighClarity ? 0.92 : qualityFraction,
          allowDimensionScaling: fullPage ? Boolean(args.allowDimensionScaling) : !isHighClarity,
        });
        finalBase64 = compressed.dataUrl.replace(/^data:[^;]+;base64,/, '');
        finalMime = compressed.mimeType as any;
        if (compressed.wasDownscaled) {
          isThumbnailFinal = true;
          finalImageWidthCss = compressed.width;
          finalImageHeightCss = compressed.height;
          if (tab.id) {
            const curCtx = screenshotContextManager.getContext(tab.id);
            if (curCtx) {
              screenshotContextManager.setContext(tab.id, {
                ...curCtx,
                screenshotWidth: compressed.width,
                screenshotHeight: compressed.height,
              });
            }
          }
        }
      } catch (smartErr) {
        // Fallback to legacy compressImage if smart transport compression encountered error
        try {
          const scaleRatio = Math.min(
            0.75,
            Math.max(0.2, Math.sqrt((350 * 1024) / finalBase64.length)),
          );
          const thumb = await compressImage(finalImageDataUrl, {
            scale: scaleRatio,
            quality: 0.75,
            format: finalMime,
          });
          const thumbBase64 = thumb.dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
          if (thumbBase64.length < 800 * 1024) {
            finalBase64 = thumbBase64;
            finalMime = thumb.mimeType as 'image/png' | 'image/jpeg' | 'image/webp';
            isThumbnailFinal = true;
          }
        } catch (thumbErr) {
          console.warn('Failed to generate preview thumbnail in final return:', thumbErr);
        }
      }
    }

    delete results.base64;
    const base64Data = finalBase64;

    const returnContent: any[] = [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Screenshot [${name}] captured successfully`,
          tabId: tab.id,
          url: tab.url,
          name: name,
          format,
          quality: args.quality ?? (format === 'png' ? undefined : 80),
          imageWidth: finalImageWidthCss,
          imageHeight: finalImageHeightCss,
          viewportWidth: pageDetails?.viewportWidth ?? finalImageWidthCss,
          viewportHeight: pageDetails?.viewportHeight ?? finalImageHeightCss,
          originX: elementCropOrigin?.x ?? 0,
          originY: elementCropOrigin?.y ?? 0,
          scaleFactor:
            isThumbnailFinal && pageDetails?.viewportWidth
              ? finalImageWidthCss! / pageDetails.viewportWidth
              : 1.0,
          targetIndex: args.targetIndex,
          padding: args.padding,
          selector: args.selector,
          assetIndex: args.assetIndex,
          grid: Boolean(args.grid),
          somApplied: didInjectSoM,
          somMode: enableSoM ? (zoomRequested.length > 0 ? 'zoom' : 'som') : undefined,
          elementMap: enableSoM ? buildElementMap(somLabels) : undefined,
          somLabels: enableSoM ? somLabels : undefined,
          zoomCrops:
            somZoomImages.length > 0
              ? somZoomImages.map((z) => ({ n: z.n, ...z.crop }))
              : undefined,
          ...(storeBase64 === true ? { base64Data } : {}),
          ...results,
          ...(isThumbnailFinal
            ? {
                isThumbnail: true,
                warning:
                  'Payload exceeded 450KB safety budget. High-quality preview thumbnail returned inline; nothing written to disk (pass savePng to save explicitly).',
              }
            : {}),
        }),
      },
    ];

    if (finalBase64) {
      returnContent.push({
        type: 'image',
        data: finalBase64,
        mimeType: finalMime,
      });
      screenshotRingBuffer.push({
        tabId: tab.id!,
        mimeType: finalMime,
        width: finalImageWidthCss || 800,
        height: finalImageHeightCss || 600,
        dataBase64: finalBase64,
      });
    }

    // Zoom crop mode: append one upscaled crop per requested Set-of-Mark label.
    for (const zoom of somZoomImages) {
      const zoomBase64 = zoom.dataUrl.replace(/^data:[^;]+;base64,/, '');
      if (!zoomBase64) continue;
      returnContent.push({
        type: 'image',
        data: zoomBase64,
        mimeType: finalMime,
      });
    }

    return {
      content: returnContent,
      isError: false,
    };
  }

  /**
   * Log information
   */
  private logInfo(message: string) {
    console.log(`[Screenshot Tool] ${message}`);
  }

  /**
   * Capture specific element by selector or compact 1-based index
   */
  /**
   * Send a screenshot-helper message; on timeout/no-answer, re-inject the
   * helper once and retry (stale isolated-world listener after extension
   * reload is the common case).
   */
  private async sendToHelperWithRetry(tabId: number, message: any): Promise<any> {
    try {
      return await this.sendMessageToTab(tabId, message);
    } catch (firstErr) {
      console.warn(
        `screenshot helper no answer for ${message?.action}; re-injecting once`,
        firstErr instanceof Error ? firstErr.message : firstErr,
      );
      await this.injectContentScript(tabId, ['inject-scripts/screenshot-helper.js']);
      await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY));
      return this.sendMessageToTab(tabId, message);
    }
  }

  private async captureTabPng(tab: chrome.tabs.Tab): Promise<string> {
    if (!tab.active && tab.id) {
      // For background tabs, captureVisibleTab would capture whatever tab is currently active
      // in the window, causing an active window data leak. Use CDP Page.captureScreenshot instead.
      const tabId = tab.id;
      const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
      const shot: any = await cdpSessionManager.withSession(tabId, 'screenshot-bg', async () => {
        return await cdpSessionManager.sendCommand(tabId, 'Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
        });
      });
      if (!shot?.data)
        throw new Error('CDP captureScreenshot returned empty data for background tab');
      return `data:image/png;base64,${shot.data}`;
    }

    const dataUrl =
      typeof tab.windowId === 'number'
        ? await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
        : await chrome.tabs.captureVisibleTab({ format: 'png' });
    if (!dataUrl) throw new Error('captureVisibleTab returned empty image');
    return dataUrl;
  }

  /**
   * Quota error retry with exponential backoff for captureVisibleTab
   * Protects against Chrome's MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND rate limit.
   */
  private async captureTabPngWithRetry(tab: chrome.tabs.Tab, maxRetries = 5): Promise<string> {
    let delay = 60;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.captureTabPng(tab);
      } catch (err) {
        const isQuota =
          err &&
          typeof err === 'object' &&
          typeof (err as any).message === 'string' &&
          ((err as any).message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') ||
            (err as any).message.includes('quota') ||
            (err as any).message.includes('Quota'));
        if (isQuota && attempt < maxRetries) {
          this.logInfo(
            `captureVisibleTab quota limit hit (attempt ${attempt + 1}/${maxRetries}), backing off ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(1000, delay * 2);
          continue;
        }
        throw err;
      }
    }
    throw new Error('captureVisibleTab quota exceeded after retries');
  }

  async _captureElement(
    tabId: number,
    options: ScreenshotToolParams,
    pageDpr: number,
    windowId?: number,
  ): Promise<{
    dataUrl: string;
    widthCss: number;
    heightCss: number;
    originX: number;
    originY: number;
  }> {
    let cropRectPx: { x: number; y: number; width: number; height: number };
    let dpr = pageDpr || 1;

    if (typeof options.targetIndex === 'number') {
      const results = await executeInPage({ tabId, allFrames: true }, 'inPageGetIndexCropRect', [
        options.targetIndex,
        options.padding ?? 0,
        options.expandSearchArea ?? options.autoExpand ?? true,
      ]);
      const match = results?.find((r) => r.result?.success);
      const outcome = match?.result;
      if (!outcome?.success || !outcome.rect) {
        throw new Error(
          outcome?.error || `Element with index [${options.targetIndex}] not found for screenshot`,
        );
      }
      dpr = outcome.devicePixelRatio || pageDpr || 1;
      cropRectPx = {
        x: Math.round(outcome.rect.x * dpr),
        y: Math.round(outcome.rect.y * dpr),
        width: Math.round(outcome.rect.width * dpr),
        height: Math.round(outcome.rect.height * dpr),
      };
    } else {
      const elementDetails = await this.sendToHelperWithRetry(tabId, {
        action: TOOL_MESSAGE_TYPES.SCREENSHOT_GET_ELEMENT_DETAILS,
        selector: options.selector,
      });

      dpr = elementDetails.devicePixelRatio || pageDpr || 1;
      const pad = Math.max(0, options.padding ?? 0);
      cropRectPx = {
        x: Math.max(0, Math.round((elementDetails.rect.x - pad) * dpr)),
        y: Math.max(0, Math.round((elementDetails.rect.y - pad) * dpr)),
        width: Math.round((elementDetails.rect.width + pad * 2) * dpr),
        height: Math.round((elementDetails.rect.height + pad * 2) * dpr),
      };
    }

    // Re-align Set-of-Mark visual badges overlay after implicit scrollIntoView (for targetIndex and selector)
    const enableSoM =
      options.som === true || options.highlight === true || options.setOfMark === true;
    if (enableSoM) {
      try {
        await executeInPage({ tabId, allFrames: true }, 'inPageRealignHighlights', []);
      } catch {}
    }

    // Small delay to ensure element is fully rendered after scrollIntoView
    await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY));

    const targetTab = await Promise.resolve(
      typeof chrome !== 'undefined' && chrome.tabs?.get ? chrome.tabs.get(tabId) : null,
    ).catch(() => null);
    const visibleCaptureDataUrl = targetTab
      ? await this.captureTabPngWithRetry(targetTab)
      : typeof windowId === 'number'
        ? await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
        : await chrome.tabs.captureVisibleTab({ format: 'png' });
    if (!visibleCaptureDataUrl) {
      throw new Error('Failed to capture visible tab for element cropping');
    }

    // DPR 1:1 Normalization: enforce output dimensions to exact CSS pixel dimensions
    const finalWidthCss = options.width ?? Math.max(1, Math.round(cropRectPx.width / dpr));
    const finalHeightCss = options.height ?? Math.max(1, Math.round(cropRectPx.height / dpr));

    const croppedCanvas = new OffscreenCanvas(finalWidthCss, finalHeightCss);
    const ctx = croppedCanvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context from OffscreenCanvas');

    const rawImg = await createImageBitmapFromUrl(visibleCaptureDataUrl);
    ctx.drawImage(
      rawImg,
      cropRectPx.x,
      cropRectPx.y,
      cropRectPx.width,
      cropRectPx.height,
      0,
      0,
      finalWidthCss,
      finalHeightCss,
    );

    const format = options.format ?? 'webp';
    const mimeType =
      format === 'webp' ? 'image/webp' : format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const qualityFraction =
      typeof options.quality === 'number' ? Math.max(0, Math.min(1, options.quality / 100)) : 0.8;

    const dataUrl = await canvasToDataURL(croppedCanvas, mimeType, qualityFraction);
    return {
      dataUrl,
      widthCss: finalWidthCss,
      heightCss: finalHeightCss,
      originX: Math.round(cropRectPx.x / dpr),
      originY: Math.round(cropRectPx.y / dpr),
    };
  }

  /**
   * Capture full page with GoFullPage-grade industrial features:
   * - StyleStack fixed/sticky header de-duplication across slices
   * - Page warmup to trigger lazy loading / IntersectionObserver / skeletons
   * - Dynamic height change auto-recovery during scrolling
   * - captureVisibleTab quota error exponential backoff retry
   * - Safe OffscreenCanvas stitching with max dimension bounds
   * - DPR 1:1 CSS pixel normalization
   */
  async _captureFullPage(
    tabId: number,
    options: ScreenshotToolParams,
    initialPageDetails: any,
    windowId?: number,
  ): Promise<{ dataUrl: string; widthCss: number; heightCss: number }> {
    // 1. Warmup page: quick down-and-up scroll to trigger lazy loading, IntersectionObserver & skeleton screens
    try {
      this.logInfo('Warming up page for lazy loading and skeleton rendering...');
      const warmupResp = await this.sendToHelperWithRetry(tabId, {
        action: TOOL_MESSAGE_TYPES.SCREENSHOT_WARMUP_PAGE,
      });
      if (warmupResp && typeof warmupResp.totalHeight === 'number' && warmupResp.totalHeight > 0) {
        initialPageDetails.totalHeight = warmupResp.totalHeight;
        if (typeof warmupResp.totalWidth === 'number' && warmupResp.totalWidth > 0) {
          initialPageDetails.totalWidth = warmupResp.totalWidth;
        }
      }
    } catch (warmupErr) {
      console.warn('Page warmup failed, proceeding with initial dimensions:', warmupErr);
    }

    const dpr = initialPageDetails.devicePixelRatio || 1;
    const totalWidthCss = options.width || initialPageDetails.totalWidth;
    let totalHeightCss = initialPageDetails.totalHeight;

    // Apply maximum height limit for infinite scroll pages
    const maxHeightPx = options.maxHeight || SCREENSHOT_CONSTANTS.MAX_CAPTURE_HEIGHT_PX;
    let limitedHeightCss = Math.min(totalHeightCss, maxHeightPx / dpr);

    const totalWidthPx = totalWidthCss * dpr;
    let totalHeightPx = limitedHeightCss * dpr;

    this.logInfo(
      `Viewport size: ${initialPageDetails.viewportWidth}x${initialPageDetails.viewportHeight} CSS pixels`,
    );
    this.logInfo(
      `Page dimensions: ${totalWidthCss}x${totalHeightCss} CSS pixels (limited to ${limitedHeightCss} height)`,
    );

    const viewportHeightCss = initialPageDetails.viewportHeight;

    // Ensure initial scroll position is (0, 0) before slice 0
    await this.sendMessageToTab(tabId, {
      action: TOOL_MESSAGE_TYPES.SCREENSHOT_SCROLL_PAGE,
      x: 0,
      y: 0,
      scrollDelay: 50,
    }).catch(() => {});

    const capturedParts: { dataUrl: string; y: number }[] = [];
    let currentScrollYCss = 0;
    let capturedHeightPx = 0;
    let partIndex = 0;

    while (capturedHeightPx < totalHeightPx && partIndex < SCREENSHOT_CONSTANTS.MAX_CAPTURE_PARTS) {
      const isLastStep =
        currentScrollYCss + viewportHeightCss >=
        limitedHeightCss - SCREENSHOT_CONSTANTS.PIXEL_TOLERANCE;

      this.logInfo(
        `Capturing part ${partIndex + 1}... (${Math.round((capturedHeightPx / totalHeightPx) * 100)}%) [lastStep: ${isLastStep}]`,
      );

      // 1. Scroll to slice position FIRST (part 0 skips scroll if already at top)
      // Executing scroll first triggers scroll events, lazy loading, and sticky header activation
      if (currentScrollYCss > 0) {
        const scrollResp = await this.sendMessageToTab(tabId, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_SCROLL_PAGE,
          x: 0,
          y: currentScrollYCss,
          scrollDelay: SCREENSHOT_CONSTANTS.SCROLL_DELAY_MS,
        });

        // 2. Dynamic height change recovery: detect page expansion/collapse between steps
        if (
          scrollResp &&
          typeof scrollResp.totalHeight === 'number' &&
          Math.abs(scrollResp.totalHeight - totalHeightCss) > 5
        ) {
          const diff = scrollResp.totalHeight - totalHeightCss;
          this.logInfo(
            `Dynamic height change detected: ${diff > 0 ? '+' : ''}${diff}px (old: ${totalHeightCss}, new: ${scrollResp.totalHeight})`,
          );
          totalHeightCss = scrollResp.totalHeight;
          limitedHeightCss = Math.min(totalHeightCss, maxHeightPx / dpr);
          totalHeightPx = limitedHeightCss * dpr;
        }

        if (scrollResp && typeof scrollResp.newScrollY === 'number') {
          currentScrollYCss = scrollResp.newScrollY;
        }
      }

      // 3. Prepare slice in DOM: GoFullPage StyleStack fixed header hiding / sticky conversion / bottom banner management
      // Executed AFTER scrolling so elements that become sticky/fixed on scroll are accurately detected and handled
      await this.sendToHelperWithRetry(tabId, {
        action: TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_SLICE,
        stepIndex: partIndex,
        isLastStep,
      }).catch((err) => {
        console.warn(`prepareSlice failed on step ${partIndex}:`, err);
      });

      // 4. Ensure rendering after DOM updates
      await new Promise((resolve) =>
        setTimeout(resolve, SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS),
      );

      // 5. Capture with quota retry
      const targetTab = await Promise.resolve(
        typeof chrome !== 'undefined' && chrome.tabs?.get ? chrome.tabs.get(tabId) : null,
      ).catch(() => null);
      const dataUrl = targetTab
        ? await this.captureTabPngWithRetry(targetTab)
        : typeof windowId === 'number'
          ? await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
          : await chrome.tabs.captureVisibleTab({ format: 'png' });
      if (!dataUrl) throw new Error('captureVisibleTab returned empty during full page capture');

      const yOffsetPx = currentScrollYCss * dpr;
      capturedParts.push({ dataUrl, y: yOffsetPx });

      // 6. Immediately pop slice-specific fixed modifications so DOM returns to natural state before next scroll
      await this.sendMessageToTab(tabId, {
        action: TOOL_MESSAGE_TYPES.SCREENSHOT_POP_SLICE_FIXED,
      }).catch(() => {});

      const imgForHeight = await createImageBitmapFromUrl(dataUrl);
      const lastPartEffectiveHeightPx = Math.min(imgForHeight.height, totalHeightPx - yOffsetPx);
      imgForHeight.close?.();
      capturedHeightPx = yOffsetPx + lastPartEffectiveHeightPx;

      if (capturedHeightPx >= totalHeightPx - SCREENSHOT_CONSTANTS.PIXEL_TOLERANCE) break;

      currentScrollYCss += viewportHeightCss;
      // Prevent overscrolling past the document height for the next scroll command
      if (
        currentScrollYCss > limitedHeightCss - viewportHeightCss &&
        currentScrollYCss < limitedHeightCss
      ) {
        currentScrollYCss = limitedHeightCss - viewportHeightCss;
      }
      partIndex++;
    }

    if (partIndex >= SCREENSHOT_CONSTANTS.MAX_CAPTURE_PARTS) {
      this.logInfo(
        `Reached maximum number of capture parts (${SCREENSHOT_CONSTANTS.MAX_CAPTURE_PARTS}). This may be an infinite scroll page.`,
      );
    }
    if (totalHeightCss > limitedHeightCss) {
      this.logInfo(
        `Page height (${totalHeightCss}px) exceeds maximum capture height (${maxHeightPx / dpr}px). Capturing limited portion.`,
      );
    }

    this.logInfo('Stitching image with canvas boundary safety...');
    const finalCanvas = await stitchImages(capturedParts, totalWidthPx, totalHeightPx);

    // DPR 1:1 Normalization: enforce output dimensions to standard CSS pixels
    let targetWidthCss = totalWidthCss;
    let targetHeightCss = limitedHeightCss;

    if (options.width && !options.height) {
      targetWidthCss = options.width;
      const aspectRatio = finalCanvas.height / finalCanvas.width;
      targetHeightCss = Math.round(targetWidthCss * aspectRatio);
    } else if (options.height && !options.width) {
      targetHeightCss = options.height;
      const aspectRatio = finalCanvas.width / finalCanvas.height;
      targetWidthCss = Math.round(targetHeightCss * aspectRatio);
    } else if (options.width && options.height) {
      targetWidthCss = options.width;
      targetHeightCss = options.height;
    }

    const MAX_CANVAS_DIM = 16384;
    const MAX_CANVAS_AREA = 268435456;
    if (
      targetWidthCss > MAX_CANVAS_DIM ||
      targetHeightCss > MAX_CANVAS_DIM ||
      targetWidthCss * targetHeightCss > MAX_CANVAS_AREA
    ) {
      const dimScale = Math.min(MAX_CANVAS_DIM / targetWidthCss, MAX_CANVAS_DIM / targetHeightCss);
      const areaScale = Math.sqrt(MAX_CANVAS_AREA / (targetWidthCss * targetHeightCss));
      const scale = Math.min(dimScale, areaScale);
      targetWidthCss = Math.max(1, Math.floor(targetWidthCss * scale));
      targetHeightCss = Math.max(1, Math.floor(targetHeightCss * scale));
    }

    let outputCanvas: any;
    if (typeof OffscreenCanvas !== 'undefined') {
      outputCanvas = new OffscreenCanvas(targetWidthCss, targetHeightCss);
      const ctx = outputCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(finalCanvas, 0, 0, targetWidthCss, targetHeightCss);
      }
    } else {
      outputCanvas = finalCanvas;
    }

    const format = options.format || 'webp';
    const targetMime =
      format === 'webp' ? 'image/webp' : format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const qualityFraction =
      typeof options.quality === 'number' ? Math.max(0, Math.min(1, options.quality / 100)) : 0.8;
    const finalDataUrl = await canvasToDataURL(outputCanvas, targetMime, qualityFraction);

    return {
      dataUrl: finalDataUrl,
      widthCss: targetWidthCss,
      heightCss: targetHeightCss,
    };
  }
}

export const screenshotTool = new ScreenshotTool();
