import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, TOOL_SCHEMAS, TOOL_CATEGORIES } from 'chrome-mcp-shared';

interface ToolDocsParams {
  category:
    'navigate' | 'perceive' | 'act' | 'observe' | 'manage' | 'crawl' | 'diagnose' | 'network';
  activateForSession?: boolean;
}

type SchemaProp = { type?: string; description?: string; enum?: string[] };

/**
 * Compact per-category tool documentation. Lets an agent discover parameter
 * details for tools hidden by the active profile without reloading the
 * server: one text block, ~1-3KB, instead of pulling full schemas.
 */
export class ToolDocsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.TOOL_DOCS;

  async execute(args: ToolDocsParams): Promise<ToolResult> {
    const category = args?.category;
    if (!category || typeof category !== 'string') {
      // Previously returned `Unknown category 'undefined'`, which reads like a
      // bad value rather than a missing required argument.
      return createErrorResponse(
        `category is required. Valid: ${Object.keys(TOOL_CATEGORIES).join(', ')}`,
      );
    }
    const names = new Set((TOOL_CATEGORIES[category] || '').split(' ').filter(Boolean));
    if (names.size === 0) {
      return createErrorResponse(
        `Unknown category '${category}'. Valid: ${Object.keys(TOOL_CATEGORIES).join(', ')}`,
      );
    }
    const docs = TOOL_SCHEMAS.filter((t) => names.has(t.name))
      .map((t) => {
        const props = (t.inputSchema as any)?.properties ?? {};
        const required: string[] = (t.inputSchema as any)?.required ?? [];
        const params = Object.entries(props as Record<string, SchemaProp>)
          .map(([k, v]) => {
            const enums = v.enum ? `:${v.enum.join('|')}` : '';
            const req = required.includes(k) ? ' (required)' : '';
            const desc = (v.description || '').split('\n')[0].slice(0, 90);
            return `  ${k}${enums}${req}: ${desc}`;
          })
          .join('\n');
        const desc = (t.description || '').split('\n')[0].slice(0, 140);
        return `${t.name} - ${desc}\n${params}`;
      })
      .join('\n\n');
    return {
      content: [
        {
          type: 'text',
          text: `[${args.category}] ${docs}`,
        },
      ],
      isError: false,
    };
  }
}

export const toolDocsTool = new ToolDocsTool();
