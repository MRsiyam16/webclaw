/**
 * browser_extract — the callable, advertised surface for schema-typed extraction.
 *
 * Kept out of extract.ts on purpose: entrypoints/inpage-engine.ts bundles
 * extract.ts into the injected page-side IIFE, so that module must stay free of
 * background-only imports (BaseBrowserToolExecutor pulls chrome.tabs listeners
 * and the shared tool layer — measured +52KB in the injected bundle). The DOM
 * work is delegated to the in-page entrypoint (inPageExtract) because the MV3
 * service worker has no document/DOMParser.
 */

import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { executeInPage } from './in-page-engine';
import type { JsonSchema, ExtractResult } from './extract';

export interface ExtractParams {
  /** JSON Schema describing the fields to extract (required). */
  schema?: JsonSchema;
  /** Optional CSS selector scoping extraction to a subtree. */
  selector?: string;
  tabId?: number;
  windowId?: number;
  sessionId?: string;
  sessionContext?: string;
}

export class ExtractTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.EXTRACT;
  description =
    'Extract declared fields from the page with source attribution; absent values are reported in `missing`, never invented.';

  async execute(args: ExtractParams): Promise<ToolResult> {
    if (!args?.schema || typeof args.schema !== 'object' || Array.isArray(args.schema)) {
      return createErrorResponse(
        'schema parameter is required and must be a JSON Schema object describing the fields to extract',
      );
    }

    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab?.id) {
        return createErrorResponse('No active tab found for chrome_extract');
      }

      const results = await executeInPage<ExtractResult | { error: string }>(
        { tabId: tab.id },
        'inPageExtract',
        [args.schema, args.selector],
      );

      const result = results?.[0]?.result;
      if (!result || typeof result !== 'object' || 'error' in result) {
        const message =
          result && typeof result === 'object' && 'error' in result
            ? String((result as { error: string }).error)
            : 'Extraction produced no result for chrome_extract';
        return createErrorResponse(message);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              data: result.data ?? {},
              missing: result.missing ?? [],
              sourceRefs: result.sourceRefs ?? {},
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        'Error executing chrome_extract: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

export const extractTool = new ExtractTool();
