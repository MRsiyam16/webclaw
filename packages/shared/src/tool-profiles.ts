import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Tool exposure profiles.
 *
 * The full tool list is 49 schemas (48 extension tools + 1 native loop tool) / ~59KB / ~16k tokens of fixed cost in every
 * session, and the agent pays it whether or not it ever touches tab groups or
 * performance traces. Profiles let a deployment expose only the tools a
 * browsing workflow actually needs.
 *
 * NOTE on the achievable saving: the biggest schemas (chrome_computer 5.2KB,
 * chrome_click_element 3.4KB, chrome_screenshot 3.2KB) are all core interaction
 * tools, so a usable core set cannot go below ~42KB. The real gain is ~25%
 * (~4.1k tokens/session), not the 80% a naive "13 tools" split suggests — those
 * 13 omit navigation entirely.
 */
export type ToolProfile = 'core' | 'crawl' | 'full';

/**
 * Tools an agent needs to browse, act, and verify. Everything here is either
 * taught in skill/SKILL.md or required to complete a basic session (navigation,
 * tab discovery). The omitted tools are management (tab groups, move/attach
 * tab), history/bookmarks, performance tracing, and the chrome_network_* pair.
 */
export const CORE_TOOL_NAMES: Set<string> = new Set([
  // Navigate (4)
  'chrome_navigate',
  'chrome_switch_tab',
  'chrome_close_tabs',
  'get_windows_and_tabs',
  // Perceive (4)
  'chrome_read_dom',
  'chrome_get_markdown',
  'chrome_inspect_media',
  'chrome_grep',
  // Act (3)
  'chrome_interact_index',
  'chrome_fill_index',
  'chrome_batch_actions',
  // Observe (2)
  'chrome_screenshot',
  'chrome_smart_scroll',
]);

// Tool discovery is part of every profile: chrome_tool_docs is how an agent
// learns about tools its current profile hides.
CORE_TOOL_NAMES.add('chrome_tool_docs');

/**
 * Resolve the active profile. Accepts the env value verbatim so callers can
 * pass process.env.CHROME_MCP_TOOL_PROFILE directly.
 *
 * Default is now "core" to drastically reduce token overhead and avoid decision paralysis.
 * Set CHROME_MCP_TOOL_PROFILE=full to expose all 49 tools, or crawl for crawl workflows.
 */
export function resolveToolProfile(raw?: string | null): ToolProfile {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  return v === 'full' ? 'full' : v === 'crawl' ? 'crawl' : 'core';
}

/**
 * Crawl-focused profile: page fetch/extract + scroll + storage + network.
 * For batch site-reading workflows without interaction-heavy tools.
 */
export const CRAWL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'chrome_navigate',
  'chrome_get_markdown',
  'chrome_inspect_media',
  'chrome_read_dom',
  'chrome_grep',
  'chrome_smart_scroll',
  'chrome_javascript',
  'chrome_storage',
  'chrome_cdp_execute',
  'chrome_network_request',
  'chrome_screenshot',
  'chrome_tool_docs',
]);

/**
 * Tool categories, space-separated name lists. chrome_tool_docs reads this
 * so an agent can request one category's full schema set on demand.
 */
export const TOOL_CATEGORIES: Record<string, string> = {
  navigate: [
    'chrome_navigate',
    'chrome_switch_tab',
    'chrome_close_tabs',
    'chrome_move_tab',
    'chrome_attach_tab',
    'chrome_detach_tab',
    'get_windows_and_tabs',
  ].join(' '),
  perceive: [
    'chrome_read_dom',
    'chrome_get_markdown',
    'chrome_inspect_media',
    'chrome_grep',
    'chrome_extract',
    'chrome_get_dropdown_options',
    'chrome_tool_docs',
  ].join(' '),
  act: [
    'chrome_act_toward_goal',
    'chrome_interact_index',
    'chrome_fill_index',
    'chrome_keyboard',
    'chrome_upload_file',
    'chrome_insert_media',
    'chrome_handle_dialog',
    'chrome_handle_download',
    'chrome_batch_actions',
    'chrome_computer',
    'chrome_cdp_execute',
    'chrome_request_human_intervention',
    'chrome_undo_last_action',
    'chrome_form_pipeline',
    'chrome_dismiss_overlay',
  ].join(' '),
  observe: [
    'chrome_screenshot',
    'chrome_smart_scroll',
    'chrome_scroll_until_found',
    'chrome_console',
  ].join(' '),
  manage: [
    'chrome_history',
    'chrome_bookmark_search',
    'chrome_bookmark_add',
    'chrome_bookmark_delete',
    'chrome_tab_group_create',
    'chrome_tab_group_update',
    'chrome_tab_group_list',
    'chrome_tab_group_ungroup',
    'chrome_tab_group_close',
  ].join(' '),
  diagnose: [
    'chrome_doctor',
    'chrome_javascript',
    'chrome_storage',
    'chrome_intercept_api',
    'chrome_console',
    'performance_start_trace',
    'performance_stop_trace',
    'performance_analyze_insight',
  ].join(' '),
  /**
   * Tier 3 — power tools. Never in the default profile view: they can read
   * document.cookie and drive arbitrary input, so they are disclosed by
   * chrome_tool_docs(category:'power') and only unlocked for the session when
   * that call passes activateForSession:true.
   */
  power: ['chrome_javascript', 'chrome_cdp_execute'].join(' '),
  network: ['chrome_network_request', 'chrome_network_capture'].join(' '),
  crawl: Array.from(CRAWL_TOOL_NAMES).join(' '),
};

/**
 * Reverse mapping from tool name to its primary functional category.
 * Used by Native Server to auto-unlock a tool category upon first call.
 */
export const TOOL_NAME_TO_CATEGORY: Record<string, string> = {};
for (const [category, toolList] of Object.entries(TOOL_CATEGORIES)) {
  if (category === 'crawl') continue;
  for (const name of toolList.split(' ').filter(Boolean)) {
    if (!TOOL_NAME_TO_CATEGORY[name]) {
      TOOL_NAME_TO_CATEGORY[name] = category;
    }
  }
}

/** Filter the schema list for a profile. Unknown names are simply not exposed. */
export function filterToolSchemas(schemas: Tool[], profile: ToolProfile): Tool[] {
  if (profile === 'full') return schemas;
  const allow = profile === 'crawl' ? CRAWL_TOOL_NAMES : CORE_TOOL_NAMES;
  return schemas.filter((tool) => allow.has(tool.name));
}

/**
 * Message returned when a known tool is called outside the active profile.
 * Returning "not found" would be misleading — the tool exists, it is just not
 * exposed — and it would hide the fix from the caller.
 */
export function profileBlockedMessage(name: string, profile: ToolProfile): string {
  const cat = TOOL_NAME_TO_CATEGORY[name];
  const catHint = cat ? ` (in category "${cat}")` : '';
  return `Tool "${name}"${catHint} is not exposed under the "${profile}" tool profile. Call chrome_tool_docs(category: "${cat || 'act'}") to inspect its parameters, or call it directly to auto-activate the category for this session.`;
}
