import { resolveToolName } from 'chrome-mcp-shared';

export interface ElementFingerprint {
  tagName: string;
  text?: string;
  role?: string;
  isInteractive: boolean;
  value?: string;
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

export interface CachedSnapshot {
  snapshotId: string;
  tabId: number;
  url: string;
  timestamp: number;
  elementCount: number;
  revision: number;
  valid: boolean;
  invalidationReason?: string;
  fingerprints?: Map<number, ElementFingerprint>;
}

export interface DomDiffResult {
  isDelta: boolean;
  unchanged: boolean;
  revision: number;
  added: any[];
  modified: any[];
  removed: number[];
  totalCurrent: number;
  truncated?: boolean;
  totalAdded?: number;
  totalModified?: number;
  totalRemoved?: number;
  summary?: string;
  message?: string;
}

export const DEFAULT_MAX_DELTA_CHANGES = 25;

export interface DiffOptions {
  maxDelta?: number;
  filterNoise?: boolean;
}

const COUNTDOWN_TIMER_REGEX =
  /^((\d{1,2}:)?\d{1,2}:\d{2}(\.\d+)?|\d+\s*(s|秒|ms|分|min|小时|h)|(\d+\s*天)?\s*(\d+\s*(小时|h))?\s*(\d+\s*(分|min))?\s*\d+\s*(s|秒)|(\d+\s*天)?\s*(\d+\s*(小时|h))\s*\d+\s*(分|min))$/i;
const COUNTDOWN_PREFIX_REGEX =
  /^(倒计时|距结束|剩余|秒杀|限时|抢购|ends?\s*in|expires?\s*in)\s*[:：]?\s*((\d+\s*天)?\s*(\d{1,2}:)?\d{1,2}:\d{2}(\.\d+)?|(\d+\s*天)?.*?\d+\s*(s|秒|分|min|小时|h))/i;

export function isClockOrTimerNoise(oldText?: string, newText?: string): boolean {
  if (!oldText || !newText || oldText === newText) return false;
  const t1 = oldText.trim();
  const t2 = newText.trim();
  if (COUNTDOWN_TIMER_REGEX.test(t1) && COUNTDOWN_TIMER_REGEX.test(t2)) return true;
  if (COUNTDOWN_PREFIX_REGEX.test(t1) && COUNTDOWN_PREFIX_REGEX.test(t2)) return true;
  return false;
}

const NOISE_ATTR_REGEX =
  /(adsbygoogle|google[-_]?ads?|ad[-_]?banner|taboola|outbrain|sponsored|recommend|guess[-_]?you[-_]?like|feed[-_]?item|elevator|shortcut)/i;

export function isNoiseElement(el: any): boolean {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;

  const idAndClass = `${el.attributes?.id || ''} ${el.attributes?.class || ''}`;
  return NOISE_ATTR_REGEX.test(idAndClass);
}

export function compactDeltaElement(el: any): any {
  if (!el || typeof el !== 'object') return el;
  const cleanAttr: Record<string, string> = {};
  if (el.attributes) {
    const keepKeys = [
      'id',
      'name',
      'type',
      'role',
      'placeholder',
      'checked',
      'selected',
      'disabled',
      'aria-checked',
      'aria-selected',
      'aria-expanded',
      'aria-disabled',
      'href',
      'title',
      'class',
      'value',
    ];
    for (const k of keepKeys) {
      if (el.attributes[k] !== undefined) {
        cleanAttr[k] = String(el.attributes[k]).slice(0, 100);
      }
    }
  }

  const text = el.text ? (el.text.length > 120 ? el.text.slice(0, 120) + '…' : el.text) : undefined;

  return {
    index: el.index,
    tagName: el.tagName,
    ...(el.role ? { role: el.role } : {}),
    ...(text ? { text } : {}),
    ...(el.value !== undefined ? { value: String(el.value).slice(0, 100) } : {}),
    ...(Object.keys(cleanAttr).length > 0
      ? { attributes: cleanAttr }
      : el.attributes
        ? { attributes: el.attributes }
        : {}),
    isInteractive: Boolean(el.isInteractive),
    ...(el.diffHints ? { diffHints: el.diffHints } : {}),
  };
}

export class SnapshotCacheManager {
  private cache = new Map<number | string, CachedSnapshot>();
  private tabRevisions = new Map<number, number>();

  constructor() {
    this.setupListeners();
  }

  private setupListeners(): void {
    if (typeof chrome === 'undefined') return;

    try {
      if (chrome.tabs?.onRemoved?.addListener) {
        chrome.tabs.onRemoved.addListener((tabId: number) => {
          this.clear(tabId);
        });
      }

      if (chrome.tabs?.onUpdated?.addListener) {
        chrome.tabs.onUpdated.addListener(
          (tabId: number, changeInfo: { url?: string; status?: string }) => {
            if (changeInfo.url || changeInfo.status === 'loading') {
              this.invalidate(
                tabId,
                `Tab navigation or reload detected (${changeInfo.url || 'loading'})`,
              );
            }
          },
        );
      }

      if (chrome.webNavigation?.onBeforeNavigate?.addListener) {
        chrome.webNavigation.onBeforeNavigate.addListener(
          (details: { tabId: number; frameId: number }) => {
            if (details.frameId === 0) {
              this.invalidate(details.tabId, 'Main frame navigation initiated');
            }
          },
        );
      }
    } catch {
      // Ignore in non-extension environments (e.g. unit tests)
    }
  }

  public setSnapshot(
    tabId: number,
    data: { url: string; elementCount: number; elements?: any[] },
    cacheKey: number | string = tabId,
  ): CachedSnapshot {
    const currentRev = (this.tabRevisions.get(tabId) ?? 0) + 1;
    this.tabRevisions.set(tabId, currentRev);

    const fingerprints = new Map<number, ElementFingerprint>();
    if (Array.isArray(data.elements)) {
      for (const el of data.elements) {
        if (typeof el.index === 'number') {
          fingerprints.set(el.index, {
            tagName: el.tagName || '',
            text: el.text || '',
            role: el.role || '',
            isInteractive: Boolean(el.isInteractive),
            value: el.value || '',
            scopeHash:
              el.scopeHash ||
              el.attributes?.['data-scope-hash'] ||
              (el.scopeText ? computeScopeHash(el.scopeText) : undefined),
          });
        }
      }
    }

    const snapshot: CachedSnapshot = {
      snapshotId: `snap-${tabId}-${Date.now()}`,
      tabId,
      url: data.url,
      timestamp: Date.now(),
      elementCount: data.elementCount,
      revision: currentRev,
      valid: true,
      fingerprints,
    };
    this.cache.set(cacheKey, snapshot);
    return snapshot;
  }

  public diffWithPrevious(
    tabId: number,
    currentElements: any[],
    options?: DiffOptions & { cacheKey?: number | string },
  ): DomDiffResult {
    const prev = this.cache.get(options?.cacheKey ?? tabId);
    const currentRev = (this.tabRevisions.get(tabId) ?? 0) + 1;
    const maxDelta = options?.maxDelta ?? DEFAULT_MAX_DELTA_CHANGES;
    const filterNoise = options?.filterNoise ?? true;

    if (!prev || !prev.valid || !prev.fingerprints || prev.fingerprints.size === 0) {
      // First snapshot on this page or invalidated, no prior baseline to diff
      const isTruncated = currentElements.length > maxDelta;
      const rawAdded = isTruncated ? currentElements.slice(0, maxDelta) : currentElements;
      return {
        isDelta: false,
        unchanged: false,
        revision: currentRev,
        added: rawAdded.map(compactDeltaElement),
        modified: [],
        removed: [],
        totalCurrent: currentElements.length,
        ...(isTruncated
          ? {
              truncated: true,
              totalAdded: currentElements.length,
              summary: `Initial baseline capture truncated from ${currentElements.length} to ${maxDelta} elements.`,
            }
          : {}),
      };
    }

    const oldMap = prev.fingerprints;
    const currentIndices = new Set<number>();
    const added: any[] = [];
    const modified: any[] = [];

    for (const el of currentElements) {
      const idx = el.index;
      currentIndices.add(idx);

      if (filterNoise && isNoiseElement(el)) {
        continue;
      }

      const old = oldMap.get(idx);

      if (!old) {
        added.push(el);
      } else {
        const textChanged = (el.text || '') !== (old.text || '');
        const roleChanged = (el.role || '') !== (old.role || '');
        const interactiveChanged = Boolean(el.isInteractive) !== old.isInteractive;
        const valChanged = (el.value || '') !== (old.value || '');

        const isTimerNoise =
          filterNoise &&
          textChanged &&
          !roleChanged &&
          !interactiveChanged &&
          !valChanged &&
          isClockOrTimerNoise(old.text, el.text);

        if (!isTimerNoise && (textChanged || roleChanged || interactiveChanged || valChanged)) {
          modified.push({
            ...el,
            diffHints: {
              oldText: textChanged ? old.text : undefined,
              oldValue: valChanged ? old.value : undefined,
            },
          });
        }
      }
    }

    const removed: number[] = [];
    for (const oldIdx of Array.from(oldMap.keys())) {
      if (!currentIndices.has(oldIdx)) {
        removed.push(oldIdx);
      }
    }

    const totalAdded = added.length;
    const totalModified = modified.length;
    const totalRemoved = removed.length;
    const isTruncated =
      totalAdded > maxDelta || totalModified > maxDelta || totalRemoved > maxDelta;

    const finalAdded = (isTruncated ? added.slice(0, maxDelta) : added).map(compactDeltaElement);
    const finalModified = (isTruncated ? modified.slice(0, maxDelta) : modified).map(
      compactDeltaElement,
    );
    const finalRemoved = isTruncated ? removed.slice(0, maxDelta) : removed;

    const unchanged = totalAdded === 0 && totalModified === 0 && totalRemoved === 0;

    return {
      isDelta: true,
      unchanged,
      revision: currentRev,
      added: finalAdded,
      modified: finalModified,
      removed: finalRemoved,
      totalCurrent: currentElements.length,
      ...(isTruncated
        ? {
            truncated: true,
            totalAdded,
            totalModified,
            totalRemoved,
            summary: `Delta truncated: showing ${finalAdded.length}/${totalAdded} added, ${finalModified.length}/${totalModified} modified, ${finalRemoved.length}/${totalRemoved} removed. Call ${resolveToolName('read_dom')} for full DOM tree.`,
          }
        : {}),
    };
  }

  public getSnapshot(tabId: number): CachedSnapshot | undefined {
    return Array.from(this.cache.values())
      .filter((snapshot) => snapshot.tabId === tabId)
      .sort((a, b) => b.revision - a.revision)[0];
  }

  public isSnapshotValid(tabId: number): boolean {
    const s = this.getSnapshot(tabId);
    return s !== undefined && s.valid === true;
  }

  public isScopeValid(tabId: number, index: number, currentScopeHash?: string): boolean {
    const s = this.getSnapshot(tabId);
    if (!s || !s.fingerprints) return false;
    const fp = s.fingerprints.get(index);
    if (!fp) return false;
    if (currentScopeHash && fp.scopeHash) {
      return fp.scopeHash === currentScopeHash;
    }
    return Boolean(s.valid);
  }

  public invalidate(tabId: number, reason = 'DOM or URL mutated'): void {
    for (const snapshot of this.cache.values()) {
      if (snapshot.tabId === tabId) {
        snapshot.valid = false;
        snapshot.invalidationReason = reason;
      }
    }
  }

  public getInvalidationMessage(tabId: number): string {
    const s = Array.from(this.cache.values()).find((snapshot) => snapshot.tabId === tabId);
    const reason = s?.invalidationReason ? ` (${s.invalidationReason})` : '';
    return `Snapshot refs invalidated: DOM or URL changed since last ${resolveToolName('read_dom')}${reason}. ACTION REQUIRED: Please call '${resolveToolName('read_dom')}' to refresh the index tree before re-attempting interaction.`;
  }

  public clear(tabId?: number): void {
    if (typeof tabId === 'number') {
      for (const [key, snapshot] of this.cache.entries()) {
        if (snapshot.tabId === tabId) this.cache.delete(key);
      }
      this.tabRevisions.delete(tabId);
    } else {
      this.cache.clear();
      this.tabRevisions.clear();
    }
  }
}

export const snapshotCacheManager = new SnapshotCacheManager();
