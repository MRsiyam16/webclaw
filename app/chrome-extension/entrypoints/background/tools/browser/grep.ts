import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  resolveToolName,
  type IndexedElement,
  type PrunedDOMTreeResult,
} from 'chrome-mcp-shared';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { executeInPage } from './in-page-engine';

export interface GrepParams {
  query: string;
  isRegex?: boolean;
  searchType?: 'interactive_only' | 'all_dom' | 'page_text';
  limit?: number;
  autoScroll?: boolean;
  maxSteps?: number;
  stepPx?: number;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  sessionContext?: string;
}

export function extractContextualSnippet(line: string, pattern: RegExp): string {
  if (line.length <= 120) return line;
  try {
    const nonGlobal = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    const m = nonGlobal.exec(line);
    if (m && typeof m.index === 'number') {
      const start = Math.max(0, m.index - 40);
      const end = Math.min(line.length, m.index + m[0].length + 40);
      return (
        (start > 0 ? '...' : '') + line.slice(start, end).trim() + (end < line.length ? '...' : '')
      );
    }
  } catch {}
  return line.slice(0, 117) + '...';
}

export class GrepTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GREP;

  async execute(args: GrepParams): Promise<ToolResult> {
    if (!args?.query || typeof args.query !== 'string') {
      return createErrorResponse('query parameter is required and must be a non-empty string');
    }

    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });

      if (!tab?.id) {
        return createErrorResponse('No active tab found for chrome_grep');
      }

      const tabId = tab.id;
      const limitRequested = args.limit ?? 20;
      const limit = Math.min(Math.max(1, limitRequested), 50);
      const limitClamped = limit !== limitRequested;
      const searchType = args.searchType || 'interactive_only';

      let pattern: RegExp;
      try {
        pattern = args.isRegex
          ? new RegExp(args.query, 'i')
          : new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      } catch (regexErr) {
        return createErrorResponse(
          'Invalid regular expression: ' +
            (regexErr instanceof Error ? regexErr.message : String(regexErr)),
        );
      }

      if (searchType === 'page_text') {
        let fullText = '';
        try {
          const inPageRes = await executeInPage<string>(
            { tabId, allFrames: true },
            'inPageExtractDeepPageText',
            [],
          );
          fullText = inPageRes
            .map((r) => r.result || '')
            .filter(Boolean)
            .join('\n');
        } catch {}

        if (!fullText) {
          const scriptRes = await this.safeExecuteScript(tabId, {
            target: { tabId },
            func: () => {
              function getSr(el: Element): ShadowRoot | null {
                try {
                  if (typeof chrome !== 'undefined' && chrome?.dom?.openOrClosedShadowRoot) {
                    const sr = chrome.dom.openOrClosedShadowRoot(el as HTMLElement);
                    if (sr) return sr;
                  }
                } catch {}
                return el.shadowRoot || null;
              }
              function collect(node: Node): string[] {
                const out: string[] = [];
                if (!node) return out;
                if (node.nodeType === 3) {
                  const t = node.textContent?.trim();
                  if (t) out.push(t);
                  return out;
                }
                if (node.nodeType !== 1 && node.nodeType !== 11) return out;
                const el = node as Element;
                const tag = (el.tagName || '').toLowerCase();
                if (['script', 'style', 'noscript', 'template', 'svg'].includes(tag)) return out;
                const aria = el.getAttribute?.('aria-label')?.trim();
                if (aria && !el.textContent?.includes(aria)) out.push(`[${aria}]`);
                const sr = getSr(el);
                if (sr) out.push(...collect(sr));
                for (const c of Array.from(node.childNodes)) {
                  out.push(...collect(c));
                }
                if (
                  /^(div|p|h[1-6]|li|section|article|header|footer|nav|blockquote|tr|table|shreddit-|faceplate-)/i.test(
                    tag,
                  )
                ) {
                  out.push('\n');
                }
                return out;
              }
              return collect(document.body || document.documentElement).join(' ');
            },
          });
          fullText = String(scriptRes?.[0]?.result || '');
        }

        const lines = fullText
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n[ \t]+/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .split('\n');
        const matches: Array<{ line: number; text: string; index: number | null }> = [];
        let pageTextHitCount = 0;

        for (let idx = 0; idx < lines.length; idx++) {
          const line = lines[idx].trim();
          if (line && pattern.test(line)) {
            pageTextHitCount++;
            if (matches.length < limit) {
              matches.push({
                line: idx + 1,
                text: extractContextualSnippet(line, pattern),
                // page-text hits are not addressable; keep the field present and
                // explicitly null so consumers get one stable match shape.
                index: null,
              });
            }
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  query: args.query,
                  searchType: 'page_text',
                  totalMatches: pageTextHitCount,
                  returnedCount: matches.length,
                  truncated: pageTextHitCount > matches.length,
                  limit,
                  limitRequested,
                  ...(limitClamped ? { limitClamped: true } : {}),
                  matches,
                },
                null,
                2,
              ),
            },
          ],
          isError: false,
        };
      }

      let prunerResults: Array<{ frameId?: number; result?: PrunedDOMTreeResult }> = [];
      try {
        prunerResults = await executeInPage<PrunedDOMTreeResult>(
          { tabId, allFrames: true },
          'inPageDOMPruner',
          [
            {
              viewportThreshold: 1000,
              highlight: false,
            },
          ],
        );
      } catch {
        // Fallback to main frame only if allFrames fails
        prunerResults = await executeInPage<PrunedDOMTreeResult>({ tabId }, 'inPageDOMPruner', [
          {
            viewportThreshold: 1000,
            highlight: false,
          },
        ]);
      }

      const mainFrame = prunerResults?.find((r) => r.frameId === 0) || prunerResults?.[0];
      const elements: IndexedElement[] = [...(mainFrame?.result?.indexedElements || [])];
      const indexMap: Record<number, any> = { ...(mainFrame?.result?.indexMap || {}) };

      let currentIndex = elements.length + 1;
      for (const frame of prunerResults || []) {
        if (frame === mainFrame || !frame.result) continue;
        const subElements = frame.result.indexedElements;
        if (subElements && subElements.length > 0) {
          const frameOffset = currentIndex - 1;
          for (const el of subElements) {
            const remappedIndex = currentIndex++;
            elements.push({
              ...el,
              index: remappedIndex,
            });
            indexMap[remappedIndex] = {
              selector: el.attributes?.id
                ? `#${el.attributes.id}`
                : `${el.tagName}[data-mcp-idx="${remappedIndex}"]`,
              frameId: String(frame.frameId),
              tagName: el.tagName,
            };
          }
        }
      }
      const matches: Array<{
        index: number;
        tagName: string;
        role?: string;
        text: string;
        isInteractive: boolean;
        selector?: string;
      }> = [];
      // True number of matches found, independent of the returned page size.
      // Reporting matches.length as totalMatches made a capped result look
      // like the complete truth ("only 50 elements matched" when 300 did).
      let totalHitCount = 0;

      for (const el of elements) {
        if (searchType === 'interactive_only' && !el.isInteractive) {
          continue;
        }

        const elText = el.text || '';
        const placeholder =
          (el as any).placeholder || el.attributes?.['placeholder'] || el.attributes?.placeholder;
        const ariaLabel =
          (el as any).ariaLabel || el.attributes?.['aria-label'] || el.attributes?.ariaLabel;
        const title = (el as any).title || el.attributes?.['title'] || el.attributes?.title;
        const id = el.attributes?.id;
        const name = el.attributes?.name;
        const value = (el as any).value || el.attributes?.['value'] || el.attributes?.value;
        const testId = el.attributes?.['data-testid'];
        const action = el.attributes?.['data-action'];
        const desc = el.attributes?.['aria-description'];
        const clickId = el.attributes?.['data-click-id'];

        const searchableParts = [
          elText,
          el.role,
          el.tagName,
          placeholder,
          ariaLabel,
          title,
          id,
          name,
          value,
          testId,
          action,
          desc,
          clickId,
        ]
          .filter(Boolean)
          .join(' ');

        if (pattern.test(searchableParts)) {
          totalHitCount++;
          if (matches.length < limit) {
            matches.push({
              index: el.index,
              tagName: el.tagName,
              role: el.role,
              text: elText.length > 100 ? elText.slice(0, 97) + '...' : elText,
              isInteractive: el.isInteractive,
              selector: indexMap[el.index]?.selector,
            });
          }
        }
      }

      // If interactive search yielded 0 matches, check if autoScroll was requested
      let autoScrollOutcome: any = undefined;
      if (matches.length === 0 && args.autoScroll) {
        try {
          const scrollRes = await executeInPage(
            { tabId },
            'inPageScrollUntilFound',
            [
              {
                query: args.query,
                isRegex: args.isRegex,
                maxSteps: args.maxSteps ?? 10,
                stepPx: args.stepPx ?? 800,
              },
            ],
            20000,
          );
          const sHit = scrollRes?.[0]?.result;
          if (sHit?.found && typeof sHit.index === 'number') {
            autoScrollOutcome = sHit;
            matches.push({
              index: sHit.index,
              tagName: sHit.tagName || 'element',
              text: sHit.text || args.query,
              isInteractive: true,
              selector: `[data-mcp-idx="${sHit.index}"]`,
            });
          }
        } catch {}
      }

      // If interactive search yielded 0 matches, perform automatic deep page text fallback
      let textFallbackMatches: Array<{ line: number; text: string }> | undefined;
      let textFallbackHitCount = 0;
      if (matches.length === 0 && searchType === 'interactive_only') {
        try {
          const inPageRes = await executeInPage<string>(
            { tabId, allFrames: true },
            'inPageExtractDeepPageText',
            [],
          );
          const deepText = inPageRes
            .map((r) => r.result || '')
            .filter(Boolean)
            .join('\n');
          if (deepText) {
            const lines = deepText.split('\n');
            const found: Array<{ line: number; text: string }> = [];
            for (let idx = 0; idx < lines.length; idx++) {
              const line = lines[idx].trim();
              if (line && pattern.test(line)) {
                textFallbackHitCount++;
                if (found.length < limit) {
                  found.push({
                    line: idx + 1,
                    text: extractContextualSnippet(line, pattern),
                  });
                }
              }
            }
            if (found.length > 0) {
              textFallbackMatches = found;
            }
          }
        } catch {}
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query: args.query,
                searchType,
                totalMatches:
                  totalHitCount > 0
                    ? totalHitCount
                    : (textFallbackHitCount ?? textFallbackMatches?.length ?? 0),
                returnedCount:
                  matches.length > 0 ? matches.length : (textFallbackMatches?.length ?? 0),
                truncated:
                  totalHitCount > matches.length ||
                  (textFallbackHitCount ?? textFallbackMatches?.length ?? 0) >
                    (matches.length > 0 ? matches.length : (textFallbackMatches?.length ?? 0)),
                limit,
                limitRequested,
                ...(limitClamped ? { limitClamped: true } : {}),
                scanScope: textFallbackMatches ? 'page_text' : 'indexed_elements',
                fallbackUsed: Boolean(textFallbackMatches),
                matches: matches.length > 0 ? matches : (textFallbackMatches ?? []),
                ...(autoScrollOutcome
                  ? {
                      autoScrolled: true,
                      scrollSteps: autoScrollOutcome.stepsTaken,
                      scrolledPx: autoScrollOutcome.scrolledPx,
                      coordinates: autoScrollOutcome.coordinates,
                    }
                  : {}),
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        'Error executing chrome_grep: ' + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

export const grepTool = new GrepTool();
