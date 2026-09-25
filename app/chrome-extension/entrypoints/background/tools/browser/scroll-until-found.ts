import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  type ScrollUntilFoundOptions,
  type ScrollUntilFoundResult,
} from 'chrome-mcp-shared';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { executeInPage } from './in-page-engine';

export interface ScrollUntilFoundParams {
  query?: string;
  selector?: string;
  isRegex?: boolean;
  maxSteps?: number;
  stepPx?: number;
  direction?: 'down' | 'up';
  timeoutMs?: number;
  containerSelector?: string;
  settleMs?: number;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  sessionContext?: string;
}

export class ScrollUntilFoundTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SCROLL_UNTIL_FOUND;

  async execute(args: ScrollUntilFoundParams): Promise<ToolResult> {
    const query = args?.query?.trim();
    const selector = args?.selector?.trim();

    if (!query && !selector) {
      return createErrorResponse(
        'Either query or selector is required for chrome_scroll_until_found',
      );
    }

    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });

      if (!tab?.id) {
        return createErrorResponse('No active tab found for chrome_scroll_until_found');
      }

      const tabId = tab.id;
      const timeoutMs = Math.min(Math.max(1000, args.timeoutMs ?? 15000), 60000);

      const inPageOptions: ScrollUntilFoundOptions = {
        query: args.query,
        selector: args.selector,
        isRegex: args.isRegex,
        maxSteps: args.maxSteps,
        stepPx: args.stepPx,
        direction: args.direction,
        timeoutMs,
        containerSelector: args.containerSelector,
        settleMs: args.settleMs,
      };

      const maxSteps = Math.min(Math.max(1, inPageOptions.maxSteps ?? 10), 50);
      let res: ScrollUntilFoundResult | undefined;
      let stepsTaken = 0;
      let scrolledPx = 0;
      // Run one step at a time so the background tool can stop immediately at
      // the scroll boundary instead of spending the remaining step budget.
      for (let step = 0; step < maxSteps; step++) {
        const results = await executeInPage<ScrollUntilFoundResult>(
          { tabId },
          'inPageScrollUntilFound',
          [{ ...inPageOptions, maxSteps: 1 }],
          timeoutMs + 3000,
        );
        res = results?.[0]?.result;
        if (!res) break;
        stepsTaken += res.stepsTaken;
        scrolledPx += res.scrolledPx;
        if (res.found) break;

        const targets = await executeInPage<any>({ tabId }, 'inPageFindSmartScrollTarget', [
          {
            direction: inPageOptions.direction ?? 'down',
            selector: inPageOptions.containerSelector,
          },
        ]);
        const target = targets?.[0]?.result;
        const bottomReached =
          inPageOptions.direction !== 'up' && target && target.canScrollDown === false;
        const topReached =
          inPageOptions.direction === 'up' && target && target.canScrollUp === false;
        if (bottomReached || topReached) {
          res = {
            ...res,
            found: false,
            stepsTaken,
            scrolledPx,
            reason: bottomReached ? 'bottom_reached' : 'top_reached',
            closestMatches: [],
            message: `Target "${query || selector}" not found; scroll boundary reached.`,
          } as ScrollUntilFoundResult;
          break;
        }
        if (res.found) break;
      }

      if (!res) {
        return createErrorResponse('Failed to execute scroll_until_found in active tab');
      }

      if (!res.found && !(res as any).reason) {
        res = { ...res, reason: 'max_steps', closestMatches: [] } as ScrollUntilFoundResult;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(res, null, 2),
          },
        ],
        isError: !res.found,
      };
    } catch (error) {
      return createErrorResponse(
        'Error executing chrome_scroll_until_found: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

export const scrollUntilFoundTool = new ScrollUntilFoundTool();
