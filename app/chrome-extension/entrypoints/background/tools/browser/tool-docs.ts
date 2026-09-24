import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, TOOL_SCHEMAS, TOOL_CATEGORIES } from 'chrome-mcp-shared';

interface ToolDocsParams {
  category:
    | 'navigate'
    | 'perceive'
    | 'act'
    | 'observe'
    | 'manage'
    | 'crawl'
    | 'diagnose'
    | 'network'
    | 'power';
  activateForSession?: boolean;
}

type SchemaProp = { type?: string; description?: string; enum?: string[] };

/** Tier-3 power category: disclosed on request, unlocked per session only on explicit opt-in. */
const POWER_CATEGORY = 'power';
const POWER_RISK_TIER = 3;

/**
 * Why this tier is gated: these two tools are deliberately outside every
 * default profile because they can read document.cookie (session material) and
 * drive arbitrary input (any click/keystroke, including destructive ones).
 */
const POWER_WARNING =
  'SAFETY: power tools run unconstrained page code in the target tab. chrome_javascript can read document.cookie and other page secrets, and chrome_cdp_execute can drive arbitrary input (raw Input/Page/Runtime CDP commands) — including clicks and keystrokes the user did not ask for. Only activate these for the current session and only when the task genuinely needs them.';

interface PowerDocsResult extends ToolResult {
  metadata: {
    category: string;
    riskTier: number;
    activatedForSession: boolean;
    tools: string[];
  };
}

/**
 * Compact per-category tool documentation. Lets an agent discover parameter
 * details for tools hidden by the active profile without reloading the
 * server: one text block, ~1-3KB, instead of pulling full schemas.
 *
 * The `power` category is tier 3 (progressive disclosure): the docs and the
 * safety warning are always returned, but the tools are only reported as
 * activated for the session when the caller passes activateForSession: true.
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

    if (category !== POWER_CATEGORY) {
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

    // Tier 3: disclosure is unconditional, activation is opt-in per session.
    const activatedForSession = args?.activateForSession === true;
    const tools = Array.from(names);
    const status = activatedForSession
      ? `TIER-3 POWER TOOLS — ACTIVATED for this session (risk tier ${POWER_RISK_TIER}). They are callable now and stay callable until the session ends.`
      : `TIER-3 POWER TOOLS — NOT ACTIVATED. The tools below are documented but not callable in this session. To unlock them for this session, call browser_tool_docs(category:'power', activateForSession:true).`;
    const text = [
      `[${category}] ${status}`,
      POWER_WARNING,
      docs,
      `riskTier: ${POWER_RISK_TIER} tools: ${tools.join(', ')} activatedForSession: ${activatedForSession}`,
    ].join('\n\n');

    const result: PowerDocsResult = {
      content: [
        {
          type: 'text',
          text,
        },
      ],
      isError: false,
      metadata: {
        category,
        riskTier: POWER_RISK_TIER,
        activatedForSession,
        tools,
      },
    };
    return result;
  }
}

export const toolDocsTool = new ToolDocsTool();
