import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { executeInPage } from './in-page-engine';
import { budgetText, DEFAULT_OUTPUT_BUDGET_CHARS } from './text-budget';

export interface GetMarkdownParams {
  includeLinks?: boolean;
  /** Content-only mode: strip nav/header/footer/aside/form and scope to the main region */
  fit?: boolean;
  /**
   * CSS selector: limit extraction to that subtree (querySelector) instead of
   * converting the whole body.
   */
  selector?: string;
  /**
   * Hard character budget for the returned markdown (default: 120000). Longer
   * markdown is cut and a notice carrying the TRUE original length is appended.
   */
  maxLength?: number;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  sessionContext?: string;
}

/**
 * The in-page markdown serializer always walks `document.body`, so scoping to a
 * subtree is done by mounting a clone of the selected element as the body's
 * only child for the duration of the (synchronous) call and restoring the real
 * nodes immediately afterwards. The live page is never mutated permanently:
 * the original nodes are moved out and put back untouched.
 *
 * Returns null when the in-page engine is not reachable (the caller falls back
 * to the unscoped path), or '' when the selector matched nothing.
 */
async function extractScopedMarkdown(
  tabId: number,
  selector: string,
  includeLinks: boolean,
  fit: boolean,
): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel: string, links: boolean, useFit: boolean) => {
          const engine = (globalThis as any).__MCP_INPAGE__;
          if (typeof engine?.inPageExtractMarkdown !== 'function') return null;
          const el = document.querySelector(sel);
          if (!el) return '';
          const body = document.body;
          const original = Array.from(body.childNodes);
          try {
            body.replaceChildren(el.cloneNode(true));
            return engine.inPageExtractMarkdown(links, useFit) as string;
          } finally {
            body.replaceChildren(...original);
          }
        },
        args: [selector, includeLinks, fit],
      });
      const value = results?.[0]?.result;
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };

  let scoped = await run();
  if (scoped === null) {
    // The in-page bundle is injected lazily by executeInPage; force it through a
    // harmless entrypoint and retry once.
    await executeInPage({ tabId }, 'inPageGetFrameOrigin', []).catch(() => {});
    scoped = await run();
  }
  return scoped;
}

export class GetMarkdownTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_MARKDOWN;

  async execute(args: GetMarkdownParams = {}): Promise<ToolResult> {
    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id) {
        return createErrorResponse('No active tab found for chrome_get_markdown');
      }

      const includeLinks = args.includeLinks ?? true;
      const fit = args.fit ?? false;

      let markdown: string | null = null;
      if (args.selector) {
        markdown = await extractScopedMarkdown(tab.id, args.selector, includeLinks, fit);
      }
      if (markdown === null) {
        const results = await executeInPage<string>({ tabId: tab.id }, 'inPageExtractMarkdown', [
          includeLinks,
          fit,
        ]);
        markdown = results?.[0]?.result ?? '';
      }

      // Hard output budget: a heavy article converts to hundreds of KB of
      // markdown, which is unusable in a single turn.
      const budgeted = budgetText(markdown, args.maxLength ?? DEFAULT_OUTPUT_BUDGET_CHARS);

      return {
        content: [
          {
            type: 'text',
            text: budgeted.text,
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing chrome_get_markdown: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const getMarkdownTool = new GetMarkdownTool();
