import { type Tool } from '@modelcontextprotocol/sdk/types.js';

export type ToolNamespacePrefix = 'browserclaw_' | 'chrome_';

// Default canonical prefix aligned with current environment prefix (browserclaw_)
let activePrefix: ToolNamespacePrefix = 'browserclaw_';

// Check environment variables if available (e.g. Node.js runtime)
if (typeof process !== 'undefined' && process?.env) {
  if (process.env.BROWSERCLAW_TOOL_PREFIX) {
    const envPfx = process.env.BROWSERCLAW_TOOL_PREFIX.endsWith('_')
      ? process.env.BROWSERCLAW_TOOL_PREFIX
      : `${process.env.BROWSERCLAW_TOOL_PREFIX}_`;
    activePrefix = envPfx as ToolNamespacePrefix;
  } else if (process.env.CHROME_MCP_TOOL_PREFIX) {
    const envPfx = process.env.CHROME_MCP_TOOL_PREFIX.endsWith('_')
      ? process.env.CHROME_MCP_TOOL_PREFIX
      : `${process.env.CHROME_MCP_TOOL_PREFIX}_`;
    activePrefix = envPfx as ToolNamespacePrefix;
  }
}

/**
 * Get the currently active tool prefix.
 */
export function getActiveToolPrefix(): ToolNamespacePrefix {
  return activePrefix;
}

/**
 * Dynamically set the active tool prefix.
 */
export function setActiveToolPrefix(prefix: ToolNamespacePrefix | string): void {
  const normalized = prefix.endsWith('_') ? prefix : `${prefix}_`;
  activePrefix = normalized as ToolNamespacePrefix;
}

/**
 * Extract the base name from any tool name (e.g. 'chrome_read_dom' -> 'read_dom', 'browserclaw_read_dom' -> 'read_dom').
 */
export function getBaseToolName(toolIdentifier: string): string {
  if (!toolIdentifier || typeof toolIdentifier !== 'string') return toolIdentifier;
  if (toolIdentifier.startsWith('browserclaw_')) {
    return toolIdentifier.slice('browserclaw_'.length);
  }
  if (toolIdentifier.startsWith('chrome_')) {
    return toolIdentifier.slice('chrome_'.length);
  }
  return toolIdentifier;
}

/**
 * Resolve a tool's canonical runtime name based on active namespace prefix.
 * Examples:
 *   resolveToolName('read_dom') => 'browserclaw_read_dom'
 *   resolveToolName('chrome_read_dom') => 'browserclaw_read_dom'
 *   resolveToolName('get_windows_and_tabs') => 'browserclaw_get_windows_and_tabs'
 */
export function resolveToolName(toolIdentifier: string, prefixOverride?: string): string {
  const prefix =
    prefixOverride !== undefined
      ? prefixOverride.endsWith('_')
        ? prefixOverride
        : `${prefixOverride}_`
      : activePrefix;

  const baseName = getBaseToolName(toolIdentifier);

  if (baseName === 'get_windows_and_tabs') {
    return prefix === 'chrome_' ? 'get_windows_and_tabs' : `${prefix}get_windows_and_tabs`;
  }

  return `${prefix}${baseName}`;
}

/**
 * Normalize an incoming tool name to the internal backend name used by the extension / native host.
 */
export function normalizeIncomingToolName(name: string): {
  canonicalBackendName: string;
  prefix: ToolNamespacePrefix | '';
} {
  if (!name || typeof name !== 'string') {
    return { canonicalBackendName: name, prefix: '' };
  }
  if (name.startsWith('browserclaw_')) {
    if (name === 'browserclaw_get_windows_and_tabs') {
      return { canonicalBackendName: 'get_windows_and_tabs', prefix: 'browserclaw_' };
    }
    return {
      canonicalBackendName: 'chrome_' + name.slice('browserclaw_'.length),
      prefix: 'browserclaw_',
    };
  }
  if (name.startsWith('chrome_')) {
    return { canonicalBackendName: name, prefix: 'chrome_' };
  }
  if (name === 'get_windows_and_tabs') {
    return { canonicalBackendName: name, prefix: '' };
  }
  return { canonicalBackendName: name, prefix: '' };
}

/**
 * Rewrites any tool references inside an agent-facing text/prompt/error to the target prefix.
 */
export function alignToolReferences(text: string, targetPrefix: string = activePrefix): string {
  if (!text || typeof text !== 'string') return text;
  const pfx = targetPrefix.endsWith('_') ? targetPrefix : `${targetPrefix}_`;

  if (pfx === 'chrome_') {
    return text.replace(/\bbrowserclaw_([a-zA-Z0-9_]+)\b/g, (_match, tool) => {
      if (tool === 'get_windows_and_tabs') {
        return 'get_windows_and_tabs';
      }
      return `chrome_${tool}`;
    });
  }

  return text
    .replace(/\bchrome_([a-zA-Z0-9_]+)\b/g, (_match, tool) => {
      return `${pfx}${tool}`;
    })
    .replace(/\bget_windows_and_tabs\b/g, () => {
      return `${pfx}get_windows_and_tabs`;
    });
}

export const TOOL_NAMES = {
  BROWSER: {
    GET_WINDOWS_AND_TABS: 'get_windows_and_tabs',
    NAVIGATE: 'chrome_navigate',
    SCREENSHOT: 'chrome_screenshot',
    CLOSE_TABS: 'chrome_close_tabs',
    SWITCH_TAB: 'chrome_switch_tab',
    WEB_FETCHER: 'chrome_get_web_content',
    CLICK: 'chrome_click_element',
    FILL: 'chrome_fill_or_select',
    NETWORK_CAPTURE: 'chrome_network_capture',
    NETWORK_REQUEST: 'chrome_network_request',
    KEYBOARD: 'chrome_keyboard',
    HISTORY: 'chrome_history',
    BOOKMARK_SEARCH: 'chrome_bookmark_search',
    BOOKMARK_ADD: 'chrome_bookmark_add',
    BOOKMARK_DELETE: 'chrome_bookmark_delete',
    JAVASCRIPT: 'chrome_javascript',
    CONSOLE: 'chrome_console',
    FILE_UPLOAD: 'chrome_upload_file',
    COMPUTER: 'chrome_computer',
    HANDLE_DIALOG: 'chrome_handle_dialog',
    HANDLE_DOWNLOAD: 'chrome_handle_download',
    PERFORMANCE_START_TRACE: 'performance_start_trace',
    PERFORMANCE_STOP_TRACE: 'performance_stop_trace',
    PERFORMANCE_ANALYZE_INSIGHT: 'performance_analyze_insight',
    READ_DOM: 'chrome_read_dom',
    INTERACT_INDEX: 'chrome_interact_index',
    FILL_INDEX: 'chrome_fill_index',
    BATCH_ACTIONS: 'chrome_batch_actions',
    GET_MARKDOWN: 'chrome_get_markdown',
    GET_DROPDOWN_OPTIONS: 'chrome_get_dropdown_options',
    MOVE_TAB: 'chrome_move_tab',
    TAB_GROUP_CREATE: 'chrome_tab_group_create',
    TAB_GROUP_UPDATE: 'chrome_tab_group_update',
    TAB_GROUP_LIST: 'chrome_tab_group_list',
    TAB_GROUP_UNGROUP: 'chrome_tab_group_ungroup',
    TAB_GROUP_CLOSE: 'chrome_tab_group_close',
    ATTACH_TAB: 'chrome_attach_tab',
    DETACH_TAB: 'chrome_detach_tab',
    BURST_INTERACT: 'chrome_burst_interact',
    SMART_SCROLL: 'chrome_smart_scroll',
    STORAGE: 'chrome_storage',
    GET_LINKS: 'chrome_get_links',
    TOOL_DOCS: 'chrome_tool_docs',
    INSPECT_MEDIA: 'chrome_inspect_media',
    REQUEST_HUMAN_INTERVENTION: 'chrome_request_human_intervention',
    UNDO_LAST_ACTION: 'chrome_undo_last_action',
    DOCTOR: 'chrome_doctor',
    INTERCEPT_API: 'chrome_intercept_api',
    CDP_EXECUTE: 'chrome_cdp_execute',
    GREP: 'chrome_grep',
    EXTRACT: 'chrome_extract',
    FORM_PIPELINE: 'chrome_form_pipeline',
    INSERT_MEDIA: 'chrome_insert_media',
    DISMISS_OVERLAY: 'chrome_dismiss_overlay',
    SCROLL_UNTIL_FOUND: 'chrome_scroll_until_found',
  },
  NATIVE: {
    ACT_TOWARD_GOAL: 'chrome_act_toward_goal',
  },
};

export const RAW_TOOL_SCHEMAS: Tool[] = [
  {
    name: TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS,
    annotations: {
      title: 'Get Windows and Tabs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: 'Get all currently open browser windows and tabs',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_START_TRACE,
    annotations: {
      title: 'Start Performance Trace',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description:
      'Starts a performance trace recording on the selected page. Optionally reloads the page and/or auto-stops after a short duration.',
    inputSchema: {
      type: 'object',
      properties: {
        reload: {
          type: 'boolean',
          description:
            'Determines if, once tracing has started, the page should be automatically reloaded (ignore cache).',
        },
        autoStop: {
          type: 'boolean',
          description: 'Determines if the trace should be automatically stopped (default false).',
        },
        durationMs: {
          type: 'number',
          description: 'Auto-stop duration in milliseconds when autoStop is true (default 5000).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_STOP_TRACE,
    annotations: {
      title: 'Stop Performance Trace',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: 'Stops the active performance trace recording on the selected page.',
    inputSchema: {
      type: 'object',
      properties: {
        saveToDownloads: {
          type: 'boolean',
          description: 'Whether to save the trace as a JSON file in Downloads (default true).',
        },
        filenamePrefix: {
          type: 'string',
          description: 'Optional filename prefix for the downloaded trace JSON.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.PERFORMANCE_ANALYZE_INSIGHT,
    annotations: {
      title: 'Analyze Performance Trace',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Provides a lightweight summary of the last recorded trace. For deep insights (CWV, breakdowns), integrate native-side DevTools trace engine.',
    inputSchema: {
      type: 'object',
      properties: {
        insightName: {
          type: 'string',
          description:
            'Optional insight name for future deep analysis (e.g., "DocumentLatency"). Currently informational only.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Timeout for deep analysis via native host (milliseconds). Default 60000. Increase for large traces.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.COMPUTER,
    annotations: {
      title: 'Coordinate Action',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Use a mouse and keyboard to interact with a web browser, and take screenshots.\n* Whenever you intend to click on an element like an icon, you should consult ${resolveToolName('read_dom')} to determine the index or ref of the element before moving the cursor.\n* If you tried clicking on an element but it failed to load, try taking a screenshot (with visual grid) and adjusting your click location.\n* Universal multimodal coordinate support: Cartesian { x, y } object, [x, y] / [y, x] points, or [ymin, xmin, ymax, xmax] bounding boxes (supports normalized 0~1.0, per-mille 0~1000, and absolute viewport pixels).\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.`,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
        groupTitle: {
          type: 'string',
          description:
            'Title for the Chrome tab group created or joined for this task. Agent should generate a short, task-aligned title in the user language. Default: "Agent"',
        },
        groupColor: {
          type: 'string',
          enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
          description: 'Color for the Chrome tab group. Default: "blue"',
        },
        autoGroup: {
          type: 'boolean',
          description:
            'Automatically place the newly opened tab into an Agent-managed tab group with dedicated title and color. Default: true',
        },
        background: {
          type: 'boolean',
          description:
            'Avoid focusing/activating tab/window for operations (best-effort). Default: true (runs quietly in background without stealing user focus)',
        },
        dwellMs: {
          type: 'number',
          description:
            'For click actions: milliseconds to hold the button down before release (0-2000). Use 50-150 for targets that reject instant clicks',
        },
        action: {
          type: 'string',
          enum: [
            'left_click',
            'right_click',
            'double_click',
            'triple_click',
            'left_click_drag',
            'scroll',
            'scroll_to',
            'type',
            'key',
            'fill',
            'fill_form',
            'hover',
            'wait',
            'resize_page',
            'zoom',
            'screenshot',
          ],
          description: 'Action to perform. There is no plain "click" — use left_click.',
        },
        ref: {
          type: 'string',
          description:
            'Element ref/index from chrome_read_dom. For click/scroll/scroll_to/key/type and drag end when provided; takes precedence over coordinates.',
        },
        coordinates: {
          oneOf: [
            {
              type: 'object',
              properties: {
                x: { type: 'number', description: 'X coordinate' },
                y: { type: 'number', description: 'Y coordinate' },
              },
              required: ['x', 'y'],
              description: '{ x, y } coordinate object',
            },
            {
              type: 'array',
              items: { type: 'number' },
              description: 'Point [x, y] or bounding box [ymin, xmin, ymax, xmax]',
            },
          ],
          description:
            'Coordinates for actions: { x, y } object, [x, y] point, or [ymin, xmin, ymax, xmax] bounding box (supports 0~1.0 normalized, 0~1000 per-mille, or absolute viewport pixels across modern vision agents). Interpreted in the space set by coordinateSpace (default: viewport). Required for click/scroll and as end point for drag.',
        },
        coordinateSpace: {
          type: 'string',
          enum: ['viewport', 'screenshot'],
          description:
            'Space of coordinates: viewport (default, absolute CSS pixels) or screenshot (mapped through the most recent screenshot context for this tab).',
        },
        autoSnap: {
          type: 'boolean',
          description:
            'Magnetically snap coordinate clicks to the closest interactive element if clicked within 24px of whitespace. Default: true.',
        },
        startCoordinates: {
          oneOf: [
            {
              type: 'object',
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
              },
              required: ['x', 'y'],
              description: '{ x, y } coordinate object',
            },
            {
              type: 'array',
              items: { type: 'number' },
              description: 'Point [x, y] or bounding box [ymin, xmin, ymax, xmax]',
            },
          ],
          description:
            'Starting coordinates for drag action: { x, y } object, [x, y] point, or [ymin, xmin, ymax, xmax] bounding box.',
        },
        startRef: {
          type: 'string',
          description:
            'Drag start ref/index from chrome_read_dom (alternative to startCoordinates).',
        },
        scrollDirection: {
          type: 'string',
          description: 'Scroll direction: up | down | left | right',
        },
        scrollAmount: {
          type: 'number',
          description: 'Scroll ticks (1-10), default 3',
        },
        text: {
          type: 'string',
          description:
            'Text to type (for action=type) or keys/chords separated by space (for action=key, e.g. "Backspace Enter" or "cmd+a")',
        },
        repeat: {
          type: 'number',
          description:
            'For action=key: number of times to repeat the key sequence (integer 1-100, default 1).',
        },
        modifiers: {
          type: 'object',
          description:
            'Modifier keys for click actions (left_click/right_click/double_click/triple_click).',
          properties: {
            altKey: { type: 'boolean' },
            ctrlKey: { type: 'boolean' },
            metaKey: { type: 'boolean' },
            shiftKey: { type: 'boolean' },
          },
        },
        region: {
          oneOf: [
            {
              type: 'object',
              properties: {
                x0: { type: 'number' },
                y0: { type: 'number' },
                x1: { type: 'number' },
                y1: { type: 'number' },
              },
              required: ['x0', 'y0', 'x1', 'y1'],
              description: 'Rectangular region object { x0, y0, x1, y1 }',
            },
            {
              type: 'array',
              items: { type: 'number' },
              description: 'Row-first bounding box [ymin, xmin, ymax, xmax]',
            },
          ],
          description:
            'For action=zoom: rectangular region to capture (x0,y0)-(x1,y1) in viewport pixels or row-first bounding box [ymin, xmin, ymax, xmax].',
        },
        crop: {
          type: 'object',
          description: 'Alias for region: { x, y, width, height } or { x0, y0, x1, y1 }.',
        },
        grid: {
          oneOf: [
            { type: 'boolean' },
            {
              type: 'string',
              enum: ['ruler', 'crosshair', 'classic', '1000'],
              description:
                'Grid style: "ruler" (perimeter tape measure rulers), "crosshair" (reticle + markers without screen-crossing lines), "classic" (dashed red lines), or "1000" (normalized 0-1000 coordinates).',
            },
          ],
          description:
            'For action=zoom or action=screenshot: overlay coordinate reference grid or reticle crosshairs.',
        },
        highClarity: {
          type: 'boolean',
          description:
            'For action=screenshot or action=zoom: preserve 100% full-resolution sharpness without downsampling.',
        },
        format: {
          type: 'string',
          enum: ['png', 'jpeg', 'webp'],
          description: 'Image format for action=screenshot or action=zoom.',
        },
        quality: {
          type: 'number',
          description: 'Image compression quality from 0 to 100.',
        },
        // For action=fill
        selector: {
          type: 'string',
          description: 'CSS selector for fill (alternative to ref).',
        },
        value: {
          oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'number' }],
          description: 'Value to set for action=fill (string | boolean | number)',
        },
        elements: {
          type: 'array',
          description: 'For action=fill_form: list of elements to fill (ref + value)',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Element ref/index from chrome_read_dom' },
              value: { type: 'string', description: 'Value to set (stringified if non-string)' },
            },
            required: ['ref', 'value'],
          },
        },
        width: { type: 'number', description: 'For action=resize_page: viewport width' },
        height: { type: 'number', description: 'For action=resize_page: viewport height' },
        appear: {
          type: 'boolean',
          description:
            'For action=wait with text: whether to wait for the text to appear (true, default) or disappear (false)',
        },
        timeout: {
          type: 'number',
          description:
            'For action=wait with text: timeout in milliseconds (default 10000, max 120000)',
        },
        duration: {
          type: 'number',
          description: 'Seconds to wait for action=wait (max 30s)',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID (optional)',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NAVIGATE,
    annotations: {
      title: 'Navigate Tab',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Navigate to a URL, refresh the current tab, or navigate browser history (back/forward)',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to navigate to. Special values: "back" or "forward" to navigate browser history in the target tab.',
        },
        action: {
          type: 'string',
          enum: ['back', 'forward'],
          description:
            'Alternative to url="back"|"forward": navigate browser history backward or forward.',
        },
        newWindow: {
          type: 'boolean',
          description: 'Create a new window to navigate to the URL or not. Defaults to false',
        },
        tabId: {
          type: 'number',
          description:
            'Target an existing tab by ID (if provided, navigate/refresh/back/forward that tab instead of the active tab).',
        },
        windowId: {
          type: 'number',
          description:
            'Target an existing window by ID (when creating a new tab in existing window, or picking active tab if tabId is not provided).',
        },
        background: {
          type: 'boolean',
          description:
            'Perform the operation without stealing focus (do not activate the tab or focus the window). Default: true (set false only if user explicitly asks to bring tab to foreground)',
        },
        width: {
          type: 'number',
          description:
            'Window width in pixels (default: 1280). When width or height is provided, a new window will be created.',
        },
        height: {
          type: 'number',
          description:
            'Window height in pixels (default: 720). When width or height is provided, a new window will be created.',
        },
        refresh: {
          type: 'boolean',
          description:
            'Refresh the current active tab instead of navigating to a URL. When true, the url parameter is ignored. Defaults to false',
        },
        groupTitle: {
          type: 'string',
          description:
            'Concise, task-aligned title for the Chrome tab group reflecting user intent in user language (e.g. "Best 4K Monitors on Amazon", "GitHub PR Review"). If omitted, the extension derives a smart title dynamically from the destination domain and page title instead of generic fallback.',
        },
        groupColor: {
          type: 'string',
          enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
          description: 'Color for the Chrome tab group. Fallback: "blue"',
        },
        autoGroup: {
          type: 'boolean',
          description:
            'Automatically place newly opened tab into an Agent-managed tab group with dedicated title and color. Default: true',
        },
        dismissOverlays: {
          type: 'boolean',
          description:
            'Automatically detect and dismiss visible marketing popups, coupon modals, and promotional overlays after navigation completes (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SCREENSHOT,
    annotations: {
      title: 'Capture Screenshot',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      '[Prefer chrome_read_dom over taking a screenshot] Take a screenshot of the current page or a specific element. Returns base64 image directly in MCP image content block without writing to disk. By default, output is compressed JPEG with maxWidth <= 1280px. Debug disk save is available via savePng/saveToDisk into system temporary directory.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Name or label for the screenshot. Purely in-memory by default; only written to disk if savePng/saveToDisk is explicitly set to true.',
        },
        selector: { type: 'string', description: 'CSS selector for element to screenshot' },
        assetIndex: {
          type: 'number',
          description:
            'View one visual asset listed by chrome_read_dom ([asset N] lines): returns the real image resource; falls back to a viewport crop when bytes are unavailable',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID to capture from (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab from when tabId is not provided.',
        },
        background: {
          type: 'boolean',
          description:
            'Attempt capture without bringing tab/window to foreground. CDP-based capture is used for viewport captures. Default: true',
        },
        width: { type: 'number', description: 'Width in pixels (default: 800)' },
        height: { type: 'number', description: 'Height in pixels (default: 600)' },
        maxWidth: {
          type: 'number',
          description: 'Maximum width in pixels for compression (default: 1280)',
        },
        storeBase64: {
          type: 'boolean',
          description:
            'Return screenshot in base64 format in text content (image content is always returned directly)',
        },
        fullPage: {
          type: 'boolean',
          description:
            'Capture a full-page scroll screenshot with GoFullPage-grade industrial stitching: automatic StyleStack fixed/sticky header de-duplication, page warmup for lazy-loading/skeletons, dynamic height change recovery, and captureVisibleTab quota backoff retry (default: false).',
        },
        maxHeight: {
          type: 'number',
          description:
            'Maximum height in pixels to capture for full-page screenshots (default: 50000, protects against infinite scroll runaway).',
        },
        savePng: {
          type: 'boolean',
          description:
            'Save screenshot to system temporary directory for debugging (default: false, zero disk write by default)',
        },
        saveToDisk: {
          type: 'boolean',
          description:
            'Deprecated alias for savePng (default: false, zero disk write by default; saves to system temp, not Downloads). Prefer savePng.',
        },
        som: {
          type: 'boolean',
          description:
            'Overlay Set-of-Mark numbered badges on interactive elements before capturing the screenshot',
        },
        highlight: {
          type: 'boolean',
          description:
            'Deprecated alias for som; still accepted but hidden from the schema to keep it small. Prefer som.',
        },
        setOfMark: {
          type: 'boolean',
          description: 'Alias for som (Set-of-Mark overlay); accepted for parity with som.',
        },
        mode: {
          type: 'string',
          description:
            'Capture mode. "som" = Set-of-Mark: annotated image plus a textual element map on one shared numbering scheme.',
        },
        zoom: {
          type: 'array',
          items: { type: 'number' },
          description:
            "Zoom crop mode: label numbers to zoom into (crop around each label's safe click point, scaled up).",
        },
        targetIndex: {
          type: 'number',
          description:
            'Compact 1-based numeric index of target element from chrome_read_dom to crop and capture only this specific region of interest',
        },
        index: {
          type: 'number',
          description:
            'Alias for targetIndex: compact 1-based numeric index of target element from chrome_read_dom to crop and capture',
        },
        padding: {
          type: 'number',
          description: 'Padding in pixels to expand around targetIndex crop area (default: 0)',
        },
        region: {
          type: 'object',
          description:
            'Lossless high-density ROI crop: capture only a specific sub-region { x0, y0, x1, y1 } in CSS pixels or polymorphic [ymin, xmin, ymax, xmax]. Completely avoids downscaling and preserves full pixel clarity for fine details like small text or dice dots.',
          properties: {
            x0: { type: 'number' },
            y0: { type: 'number' },
            x1: { type: 'number' },
            y1: { type: 'number' },
          },
        },
        crop: {
          type: 'object',
          description: 'Alias for region: { x, y, width, height } or { x0, y0, x1, y1 }.',
        },
        grid: {
          type: 'boolean',
          description:
            'Overlay semi-transparent coordinate reference grid with perimeter tape measure rulers (20/50/100px ticks) and interior reticle crosshairs (+) to eliminate visual estimation hallucination (default: false)',
        },
        enableGrid: {
          type: 'boolean',
          description:
            'Alias for grid: overlay semi-transparent coordinate reference grid with perimeter tape measure rulers and crosshairs',
        },
        expandSearchArea: {
          type: 'boolean',
          description:
            'For small elements (< 100x100), adaptively expand the crop bounding box to preserve surrounding headers and text context (default: true)',
        },
        format: {
          type: 'string',
          enum: ['png', 'jpeg', 'webp'],
          description:
            'Image output format: webp (default, high compression for LLM), jpeg, or png',
        },
        quality: {
          type: 'number',
          description:
            'Image compression quality from 0 to 100 for webp/jpeg formats (default: 80)',
        },
        highClarity: {
          type: 'boolean',
          description:
            'Prioritize 100% full-resolution clarity without downsampling (disables dimension scaling, keeps 1:1 CSS pixel sharpness for reading fine details or dice dots).',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLOSE_TABS,
    annotations: {
      title: 'Close Tabs',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: 'Close one or more browser tabs',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Single tab ID to close (convenience alternative to tabIds array).',
        },
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Array of tab IDs to close. If not provided, will close the active tab (requires confirm: true or session affinity).',
        },
        url: {
          type: 'string',
          description: 'Close tabs matching this URL. Can be used instead of tabIds.',
        },
        confirm: {
          type: 'boolean',
          description:
            'Explicit confirmation required to close the active tab when tabIds or url are not specified.',
        },
        allManagedGroups: {
          type: 'boolean',
          description:
            'Close all Agent-managed tab groups and their tabs created during automation sessions. Default: false',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SWITCH_TAB,
    annotations: {
      title: 'Switch Active Tab',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: 'Switch to a specific browser tab',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab to switch to.',
        },
        windowId: {
          type: 'number',
          description: 'The ID of the window where the tab is located.',
        },
        background: {
          type: 'boolean',
          description:
            'If true, binds session affinity only without activating the tab in the Chrome UI or stealing user focus. Default: false',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.WEB_FETCHER,
    annotations: {
      title: 'Extract Page Content',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description: 'Fetch content from a web page',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to fetch content from. If not provided, uses the current active tab',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        background: {
          type: 'boolean',
          description: 'Do not activate tab/focus window while fetching (default: true)',
        },
        htmlContent: {
          type: 'boolean',
          description:
            'Get the visible HTML content of the page. If true, textContent will be ignored (default: false)',
        },
        textContent: {
          type: 'boolean',
          description:
            'Get the visible text content of the page with metadata. Ignored if htmlContent is true (default: true)',
        },

        selector: {
          type: 'string',
          description:
            'CSS selector to get content from a specific element. If provided, only content from this element will be returned',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_REQUEST,
    annotations: {
      title: 'Send Network Request',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: 'Send a network request from the browser with cookies and other browser context',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to send the request to',
        },
        method: {
          type: 'string',
          description: 'HTTP method to use (default: GET)',
        },
        headers: {
          type: 'object',
          description: 'Headers to include in the request',
        },
        body: {
          type: 'string',
          description: 'Body of the request (for POST, PUT, etc.)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
        formData: {
          type: 'object',
          description:
            'Multipart/form-data descriptor. If provided, overrides body and builds FormData with optional file attachments. Shape: { fields?: Record<string,string|number|boolean>, files?: Array<{ name: string, fileUrl?: string, filePath?: string, base64Data?: string, filename?: string, contentType?: string }> }. Also supports a compact array form: [ [name, fileSpec, filename?], ... ] where fileSpec may be url:, file:, or base64:.',
        },
        tabId: {
          type: 'number',
          description:
            'Optional ID of the tab to execute the request within (defaults to active tab)',
        },
        tabUrl: {
          type: 'string',
          description: 'Optional URL of the tab to execute the request within',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
        sessionContext: {
          type: 'string',
          description: 'Optional alias for sessionId',
        },
      },
      required: ['url'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.NETWORK_CAPTURE,
    annotations: {
      title: 'Capture Network Traffic',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Unified network capture tool. Use action="start" to begin capturing, action="stop" to end and retrieve results. Set needResponseBody=true to capture response bodies (uses Debugger API, may conflict with DevTools). Default mode uses webRequest API (lightweight, no debugger conflict, but no response body).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop'],
          description: 'Action to perform: "start" begins capture, "stop" ends and returns results',
        },
        needResponseBody: {
          type: 'boolean',
          description:
            'When true, captures response body using Debugger API (default: false). Only use when you need to inspect response content.',
        },
        url: {
          type: 'string',
          description:
            'URL to capture network requests from. For action="start". If not provided, uses the current active tab.',
        },
        maxCaptureTime: {
          type: 'number',
          description: 'Maximum capture time in milliseconds (default: 180000)',
        },
        inactivityTimeout: {
          type: 'number',
          description: 'Stop after inactivity in milliseconds (default: 60000). Set 0 to disable.',
        },
        includeStatic: {
          type: 'boolean',
          description: 'Include static resources like images/scripts/styles (default: false)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HANDLE_DOWNLOAD,
    annotations: {
      title: 'Handle Download',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: 'Wait for a browser download and return details (id, filename, url, state, size)',
    inputSchema: {
      type: 'object',
      properties: {
        filenameContains: { type: 'string', description: 'Filter by substring in filename or URL' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 60000, max 300000)' },
        waitForComplete: { type: 'boolean', description: 'Wait until completed (default true)' },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HISTORY,
    annotations: {
      title: 'Search History',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: 'Retrieve and search browsing history from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Text to search for in history URLs and titles. Leave empty to retrieve all history entries within the time range.',
        },
        startTime: {
          type: 'string',
          description:
            'Start time as a date string. Supports ISO format (e.g., "2023-10-01", "2023-10-01T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: 24 hours ago',
        },
        endTime: {
          type: 'string',
          description:
            'End time as a date string. Supports ISO format (e.g., "2023-10-31", "2023-10-31T14:30:00"), relative times (e.g., "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"), and special keywords ("now", "today", "yesterday"). Default: current time',
        },
        maxResults: {
          type: 'number',
          description:
            'Maximum number of history entries to return. Use this to limit results for performance or to focus on the most relevant entries. (default: 100)',
        },
        excludeCurrentTabs: {
          type: 'boolean',
          description:
            "When set to true, filters out URLs that are currently open in any browser tab. Useful for finding pages you've visited but don't have open anymore. (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_SEARCH,
    annotations: {
      title: 'Search Bookmarks',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: 'Search Chrome bookmarks by title and URL',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query to match against bookmark titles and URLs. Leave empty to retrieve all bookmarks.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of bookmarks to return (default: 50)',
        },
        folderPath: {
          type: 'string',
          description:
            'Optional folder path or ID to limit search to a specific bookmark folder. Can be a path string (e.g., "Work/Projects") or a folder ID.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_ADD,
    annotations: {
      title: 'Add Bookmark',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: 'Add a new bookmark to Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to bookmark. If not provided, uses the current active tab URL.',
        },
        title: {
          type: 'string',
          description: 'Title for the bookmark. If not provided, uses the page title from the URL.',
        },
        parentId: {
          type: 'string',
          description:
            'Parent folder path or ID to add the bookmark to. Can be a path string (e.g., "Work/Projects") or a folder ID. If not provided, adds to the "Bookmarks Bar" folder.',
        },
        createFolder: {
          type: 'boolean',
          description: 'Whether to create the parent folder if it does not exist (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BOOKMARK_DELETE,
    annotations: {
      title: 'Delete Bookmark',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: 'Delete a bookmark from Chrome',
    inputSchema: {
      type: 'object',
      properties: {
        bookmarkId: {
          type: 'string',
          description: 'ID of the bookmark to delete. Either bookmarkId or url must be provided.',
        },
        url: {
          type: 'string',
          description: 'URL of the bookmark to delete. Used if bookmarkId is not provided.',
        },
        title: {
          type: 'string',
          description: 'Title of the bookmark to help with matching when deleting by URL.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.JAVASCRIPT,
    annotations: {
      title: 'Execute JavaScript',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Execute JavaScript code in a browser tab and return the result. Built-in "mcp" helper supports end-to-end in-page agent workflows: mcp.run(async () => ...), mcp.waitFor, mcp.click, mcp.fill, mcp.check, mcp.sleep, mcp.queryAll, and :has-text("...") pseudo-selector support, eliminating multi-turn LLM ping-pong latency. Uses CDP Runtime.evaluate with awaitPromise and returnByValue; automatically falls back to chrome.scripting.executeScript if the debugger is busy. Output is sanitized (sensitive data redacted) and truncated by default.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript code to execute. Runs inside an async function body, so top-level await and "return ..." are supported.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Execution timeout in milliseconds (default: 15000).',
        },
        maxOutputBytes: {
          type: 'number',
          description:
            'Maximum output size in bytes after sanitization (default: 51200). Output exceeding this limit will be truncated.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CLICK,
    annotations: {
      title: 'Click Element',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Click on an element in a web page. Follows a unified 4-tier degradation chain: ref/index (default) -> CSS/XPath selector -> text/role -> coordinate (fallback). Reports actual resolutionPath in response. Note: Visual coordinate mode is intended strictly as a fallback for elements that DOM/accessibility snapshots cannot express (e.g. Canvas, WebGL, SVG charts, or pages lacking accessibility info).',
    inputSchema: {
      type: 'object',
      properties: {
        index: {
          type: 'number',
          description:
            'Compact 1-based index of the target element from chrome_read_dom (alias for ref).',
        },
        selector: {
          type: 'string',
          description: 'CSS selector or XPath for the element to click.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Type of selector (default: "css").',
        },
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_dom (takes precedence over selector).',
        },
        text: {
          type: 'string',
          description:
            'Target element by visible text content (evaluated after ref and selector in degradation chain).',
        },
        role: {
          type: 'string',
          description: 'Target element by ARIA role attribute (e.g. "button", "tab", "link").',
        },
        coordinate: {
          description:
            'Coordinates to click at: { x, y } object, [x, y] point, or [ymin, xmin, ymax, xmax] bounding box (preferred unified parameter). Interpreted in the space set by coordinateSpace (default: viewport).',
          oneOf: [
            {
              type: 'object',
              properties: {
                x: { type: 'number', description: 'X coordinate in viewport/CSS pixels' },
                y: { type: 'number', description: 'Y coordinate in viewport/CSS pixels' },
              },
              required: ['x', 'y'],
              description: '{ x, y } coordinate object',
            },
            {
              type: 'array',
              items: { type: 'number' },
              description: 'Point [x, y] or bounding box [ymin, xmin, ymax, xmax]',
            },
          ],
        },
        coordinates: {
          description: 'Deprecated alias for coordinate. Prefer coordinate.',
          oneOf: [
            {
              type: 'object',
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
              },
              required: ['x', 'y'],
              description: '{ x, y } coordinate object',
            },
            {
              type: 'array',
              items: { type: 'number' },
              description: 'Point [x, y] or bounding box [ymin, xmin, ymax, xmax]',
            },
          ],
        },
        double: {
          type: 'boolean',
          description: 'Perform double click when true (default: false).',
        },
        coordinateSpace: {
          type: 'string',
          enum: ['viewport', 'screenshot'],
          description: 'Space of coordinate/coordinates (default: viewport).',
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button to click (default: "left").',
        },
        modifiers: {
          type: 'object',
          description: 'Modifier keys to hold during click.',
          properties: {
            altKey: { type: 'boolean' },
            ctrlKey: { type: 'boolean' },
            metaKey: { type: 'boolean' },
            shiftKey: { type: 'boolean' },
          },
        },
        waitForNavigation: {
          type: 'boolean',
          description: 'Wait for navigation to complete after click (default: false).',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds for waiting (default: 5000).',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
        frameId: {
          type: 'number',
          description: 'Target frame ID for iframe support.',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILL,
    annotations: {
      title: 'Fill Form or Select',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Fill or select a form element on a web page. Follows unified locator degradation: ref/index (default) -> CSS/XPath selector -> targetText/role -> coordinate (CDP click & type fallback). Reports actual resolutionPath in response.',
    inputSchema: {
      type: 'object',
      properties: {
        index: {
          type: 'number',
          description:
            'Compact 1-based index of the target element from chrome_read_dom (alias for ref).',
        },
        selector: {
          type: 'string',
          description: 'CSS selector or XPath for the form element.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Type of selector (default: "css").',
        },
        ref: {
          type: 'string',
          description: 'Element ref from chrome_read_dom (takes precedence over selector).',
        },
        targetText: {
          type: 'string',
          description:
            'Target element by label or visible text content (used for locating target element).',
        },
        role: {
          type: 'string',
          description: 'Target element by ARIA role attribute (e.g. "textbox", "combobox").',
        },
        coordinate: {
          type: 'object',
          description:
            'Viewport coordinates to click and focus before typing (fallback when ref/selector unavailable).',
          properties: {
            x: { type: 'number', description: 'X coordinate in viewport/CSS pixels' },
            y: { type: 'number', description: 'Y coordinate in viewport/CSS pixels' },
          },
          required: ['x', 'y'],
        },
        coordinates: {
          type: 'object',
          description: 'Deprecated alias for coordinate. Prefer coordinate.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['x', 'y'],
        },
        text: {
          type: 'string',
          description:
            'Text content to fill into the form element (preferred unified naming, alias for value).',
        },
        value: {
          type: ['string', 'number', 'boolean'],
          description:
            'Value to fill. For text inputs: string. For checkboxes/radios: boolean. For selects: option value or text.',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
        frameId: {
          type: 'number',
          description: 'Target frame ID for iframe support.',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
      },
      required: [],
    },
  },

  {
    name: TOOL_NAMES.BROWSER.KEYBOARD,
    annotations: {
      title: 'Send Key Combination',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description:
      'Simulate keyboard input on a web page. Supports single keys (Enter, Tab, Escape), key combinations (Ctrl+C, Ctrl+V), and text input. Can target a specific element or send to the focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'string',
          description:
            'Keys or key combinations to simulate. Examples: "Enter", "Tab", "Ctrl+C", "Shift+Tab", "Hello World".',
        },
        index: {
          type: 'integer',
          description:
            'Target element index (1-based integer from chrome_read_dom) to focus before sending keyboard events.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector or XPath for target element to receive keyboard events.',
        },
        selectorType: {
          type: 'string',
          enum: ['css', 'xpath'],
          description: 'Type of selector (default: "css").',
        },
        delay: {
          type: 'number',
          description: 'Delay between keystrokes in milliseconds (default: 50).',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID. If omitted, uses the current active tab.',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to select active tab from (when tabId is omitted).',
        },
        frameId: {
          type: 'number',
          description: 'Target frame ID for iframe support.',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
      },
      required: ['keys'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CONSOLE,
    annotations: {
      title: 'Read Console Logs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Capture console output from a browser tab. Supports snapshot mode (default; one-time capture with ~2s wait) and buffer mode (persistent per-tab buffer you can read/clear instantly without waiting).',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL to navigate to and capture console from. If not provided, uses the current active tab',
        },
        tabId: {
          type: 'number',
          description: 'Target an existing tab by ID (default: active tab).',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted.',
        },
        background: {
          type: 'boolean',
          description: 'Do not activate tab/focus window when capturing via CDP. Default: true',
        },
        includeExceptions: {
          type: 'boolean',
          description: 'Include uncaught exceptions in the output (default: true)',
        },
        maxMessages: {
          type: 'number',
          description:
            'Maximum number of console messages to capture in snapshot mode (default: 100). If limit is provided, it takes precedence.',
        },
        mode: {
          type: 'string',
          enum: ['snapshot', 'buffer'],
          description:
            'Console capture mode: snapshot (default; waits ~2s for messages) or buffer (persistent per-tab buffer; reads from memory instantly).',
        },
        buffer: {
          type: 'boolean',
          description: 'Deprecated alias for mode="buffer". Prefer mode.',
        },
        clear: {
          type: 'boolean',
          description:
            'Buffer mode only: clear the buffered logs for this tab before reading (default: false). Use clearAfterRead instead to clear after reading (mcp-tools.js style).',
        },
        clearAfterRead: {
          type: 'boolean',
          description:
            'Buffer mode only: clear the buffered logs for this tab AFTER reading, to avoid duplicate messages on subsequent calls (default: false). This matches mcp-tools.js behavior.',
        },
        pattern: {
          type: 'string',
          description:
            'Optional regex filter applied to message/exception text. Supports /pattern/flags syntax.',
        },
        onlyErrors: {
          type: 'boolean',
          description:
            'Only return error-level console messages (and exceptions when includeExceptions=true). Default: false.',
        },
        limit: {
          type: 'number',
          description: 'Deprecated alias for maxMessages. Prefer maxMessages.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILE_UPLOAD,
    annotations: {
      title: 'Upload File',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Upload files to web forms with file input elements using Chrome DevTools Protocol',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
        windowId: {
          type: 'number',
          description: 'Target window ID to pick active tab when tabId is omitted',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for the file input element (optional if index is provided)',
        },
        index: {
          type: 'number',
          description:
            'Compact 1-based numeric index of the file input element from chrome_read_dom',
        },
        clickTargetIndex: {
          type: 'number',
          description:
            'Compact 1-based numeric index of a button/element from chrome_read_dom to click that triggers a dynamic file chooser dialog (e.g. Ant Design, Element Plus upload buttons) intercepted via CDP Page.setInterceptFileChooserDialog',
        },
        filePath: {
          type: 'string',
          description: 'Local file path to upload',
        },
        fileUrl: {
          type: 'string',
          description: 'URL to download file from before uploading',
        },
        base64Data: {
          type: 'string',
          description: 'Base64 encoded file data to upload',
        },
        fileName: {
          type: 'string',
          description: 'Optional filename when using base64 or URL (default: "uploaded-file")',
        },
        multiple: {
          type: 'boolean',
          description: 'Whether the input accepts multiple files (default: false)',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.HANDLE_DIALOG,
    annotations: {
      title: 'Handle Dialog',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: 'Handle JavaScript dialogs (alert/confirm/prompt) via CDP',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['accept', 'dismiss'],
          description: 'accept: click OK and submit promptText if provided. dismiss: click Cancel.',
        },
        promptText: {
          type: 'string',
          description: 'Optional prompt text when accepting a prompt',
        },
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        windowId: { type: 'number', description: 'Target window ID (optional)' },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
      },
      required: ['action'],
    },
  },

  {
    name: TOOL_NAMES.BROWSER.READ_DOM,
    annotations: {
      title: 'Read DOM',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Extract and prune interactive DOM tree with compact 1-based index assignment, viewport boundary filtering, and occlusion pruning. Supports scoped container targeting (selector) and noise exclusion (exclude) to eliminate full DOM dump overhead.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'CSS selector to scope parsing to a specific container/element (e.g. "#main-cart", ".dialog-box"). Only descendants and self within matching containers are indexed.',
        },
        scope: {
          type: 'string',
          description:
            'Alias for selector. CSS selector to scope parsing to a specific container/element (e.g. "#main-cart", ".dialog-box"). Only descendants and self within matching containers are indexed.',
        },
        isolateModal: {
          type: 'boolean',
          description:
            'When true and an active modal dialog is detected, restricts indexing to the active modal while strictly protecting portals, dropdowns, and alert containers.',
        },
        exclude: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description:
            'CSS selector(s) to exclude from parsing (e.g. "#footer, #recommendations, .ad-banner"). Matching elements and their entire subtrees are pruned.',
        },
        viewportThreshold: {
          type: 'number',
          description: 'Vertical threshold in pixels for viewport boundary checking (default 1000)',
        },
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        windowId: { type: 'number', description: 'Target window ID (optional)' },
        highlight: {
          type: 'boolean',
          description: 'Whether to visually highlight indexed elements',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
        cursor: {
          type: 'number',
          description:
            'Pagination cursor offset for traversing very large DOM pages incrementally (default: 0)',
        },
        limit: {
          type: 'number',
          description:
            'Maximum number of indexed elements to return for current page cursor slice (default: unlimited)',
        },
        maxTextLength: {
          type: 'number',
          description:
            'Maximum text length before truncation for element text content (default: 120)',
        },
        maxChars: {
          type: 'number',
          description:
            'Hard character budget for the serialized response (default: 120000). When the response would exceed it the payload is cut and carries "truncated": true plus "totalChars" (the true untruncated length).',
        },
        includeDetails: {
          type: 'boolean',
          description:
            'Also return the bulky indexedElements/indexMap detail blocks (geometry, occlusion flags, safe click points). Off by default because the tree already carries index/tag/attributes/text; enable only when you need per-element rects or visibility flags.',
        },
        viewportOnly: {
          type: 'boolean',
          description:
            'When true, only index elements inside or immediately near the visible viewport (default: false)',
        },
        activeViewportOnly: {
          type: 'boolean',
          description:
            'When true, strictly constrains indexing to elements currently visible within the active viewport (threshold = 0) with horizontal/vertical frustum clipping, eliminating ghost elements from SPA wizards, carousels, and multi-step forms.',
        },
        format: {
          type: 'string',
          enum: ['compact', 'html', 'fast'],
          description:
            'Output format for treeString. "compact" (default) produces a concise, accessibility-tree-inspired representation without closing tags, slashing token usage by 60%+. "html" returns legacy pseudo-HTML tags. "fast" activates ultrafast atomic snapshot mode (10-30ms, <=15KB).',
        },
        fast: {
          type: 'boolean',
          description:
            'When true, activates the ultrafast atomic DOM snapshot engine (10-30ms, <=15KB payload) with WeakMap caching and native checkVisibility.',
        },
        legacyVisibility: {
          type: 'boolean',
          description:
            'When true, uses legacy visibility fallback (computedStyle display/visibility/opacity) instead of element.checkVisibility.',
        },
        deltaOnly: {
          type: 'boolean',
          description:
            'Delta mode (default: true). A repeat read that sees a changed DOM returns only changed/added/removed diffs against the previous snapshot, saving 90%+ tokens. Set false to always receive the full tree.',
        },
        dismissOverlays: {
          type: 'boolean',
          description:
            'When true, automatically detects and dismisses visible marketing popups, coupon modals, and promotional overlays before indexing DOM nodes, preventing modal overlays from polluting the DOM tree (default: false)',
        },
        virtualizeViewport: {
          type: 'boolean',
          description:
            'When true (enabled by default on infinite scroll, long feeds, and waterfall pages when selector/scope is omitted), intelligently virtualizes and folds repetitive offscreen subtrees into compact summaries, drastically slashing token usage while strictly preserving visible viewport elements and key navigation.',
        },
        flattenCards: {
          type: 'boolean',
          description:
            'When true (default: true), identifies composite card containers (article, [role="article"], [role="listitem"], li) and aggregates fragmented leaf nodes into unified structured card summaries while preserving actionable link/click indices. Slashes token usage by 60%+ on eCommerce, search feeds, and news listings.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.INTERACT_INDEX,
    annotations: {
      title: 'Interact Index',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Click, hover, or interact with an element using its compact 1-based numeric index from chrome_read_dom. When performing predictable multi-step actions (e.g. form submission or chain navigation), prefer chrome_batch_actions to finish in a single round-trip.',
    inputSchema: {
      type: 'object',
      properties: {
        index: {
          type: 'number',
          description: 'Compact 1-based numeric index of the target element',
        },
        coordinate: {
          oneOf: [
            {
              type: 'object',
              properties: {
                x: { type: 'number', description: 'X coordinate in viewport/CSS pixels' },
                y: { type: 'number', description: 'Y coordinate in viewport/CSS pixels' },
              },
              required: ['x', 'y'],
              description: '{ x, y } coordinate object',
            },
            {
              type: 'array',
              items: { type: 'number' },
              description: 'Point [x, y] or bounding box [ymin, xmin, ymax, xmax]',
            },
          ],
          description:
            'Visual fallback coordinates in viewport/CSS pixels: { x, y } object, [x, y] point, or [ymin, xmin, ymax, xmax] bounding box (supports 0~1.0 normalized, 0~1000 per-mille, or absolute viewport pixels across modern vision agents).',
        },
        coordinateSpace: {
          type: 'string',
          enum: ['viewport', 'screenshot'],
          description:
            'Coordinate reference space. "viewport" (default) assumes standard CSS viewport pixels. "screenshot" scales coordinates based on the latest screenshot capture resolution.',
        },
        autoSnap: {
          type: 'boolean',
          description:
            'When clicking via coordinates or visual fallback, magnetically snap to the closest interactive element if clicked within 24px of whitespace. Default: true.',
        },
        points: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'X coordinate in viewport/CSS pixels' },
              y: { type: 'number', description: 'Y coordinate in viewport/CSS pixels' },
            },
            required: ['x', 'y'],
          },
          description:
            'Click sequence: dispatch a full CDP click at each viewport point with intervalMs pacing (rapid burst for moving canvas targets)',
        },
        intervalMs: {
          type: 'number',
          description: 'Delay between points in the click sequence, 5-500ms (default 35)',
        },
        action: {
          type: 'string',
          enum: ['click', 'hover', 'double_click', 'right_click', 'drag'],
          description:
            'Interaction action to perform (default: click). "drag" requires `end` and moves from the indexed element to that target.',
        },
        path: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'X coordinate in viewport/CSS pixels' },
              y: { type: 'number', description: 'Y coordinate in viewport/CSS pixels' },
            },
            required: ['x', 'y'],
          },
          description:
            'Continuous drag path: an ordered array of { x, y } coordinates to smoothly drag the mouse through while pressed. Ideal for circular gestures, sliders, and drawing on canvas.',
        },
        end: {
          type: 'object',
          properties: {
            index: {
              type: 'number',
              description: '1-based index (from chrome_read_dom) of the drag destination element',
            },
            coordinate: {
              type: 'object',
              properties: {
                x: { type: 'number', description: 'X coordinate in viewport/CSS pixels' },
                y: { type: 'number', description: 'Y coordinate in viewport/CSS pixels' },
              },
              required: ['x', 'y'],
              description: 'Drag destination as viewport coordinates when no index is available',
            },
          },
          description:
            'Drag destination: { index } for an indexed element, or { coordinate: { x, y } } for a raw point. Required when action is "drag".',
        },
        steps: {
          type: 'number',
          description:
            'Number of intermediate mouse-move steps for drag (default 48; lower is faster, higher is smoother)',
        },
        holdMs: {
          type: 'number',
          description:
            'How long to hold the mouse button before dragging, in ms (default 80, range 0-3000)',
        },
        dnd: {
          type: 'boolean',
          description:
            'Use HTML5 drag-and-drop events (dragstart/dragover/drop) instead of raw mouse moves. Needed for React/HTML5 DnD lists.',
        },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
          description: 'Keyboard modifiers to hold during interaction',
        },
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        windowId: { type: 'number', description: 'Target window ID (optional)' },
        waitForSettle: {
          type: 'boolean',
          description:
            'Wait for DOM mutations to settle (quiet for 150ms or timeout) after interaction before returning (default: false)',
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Maximum settle timeout in milliseconds (default: 1500, range: 200-10000)',
        },
        humanize: {
          type: 'boolean',
          description:
            'Simulate realistic human-like cursor trajectory with micro-jitter before clicking (default: false)',
        },
        includeDelta: {
          type: 'boolean',
          description:
            'Automatically capture and return DOM changes caused by this interaction in the delta field (default: false)',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
        pierceOverlay: {
          type: 'boolean',
          description:
            'Automatically pierce non-opaque or transient backdrop masks/loading stubs when intercepted (default: true)',
        },
        waitForNetworkQuiescence: {
          type: 'boolean',
          description:
            'Wait for in-flight network requests to settle after this interaction before returning (default: false)',
        },
        quiescenceTimeoutMs: {
          type: 'number',
          description: 'Network quiescence timeout in ms (default: 2000)',
        },
        captureNetwork: {
          type: 'object',
          properties: {
            urlPattern: {
              type: 'string',
              description: 'URL pattern or substring to match (e.g. "*/api/order*", "/checkout")',
            },
            method: {
              type: 'string',
              description: 'Optional HTTP method to filter by (GET, POST, PUT, DELETE, etc.)',
            },
            timeoutMs: {
              type: 'number',
              description:
                'Maximum time in milliseconds to wait for the matching network response (default: 5000ms)',
            },
            statusCodes: {
              type: 'array',
              items: { type: 'number' },
              description: 'Optional HTTP status codes to accept (e.g. [200, 201])',
            },
          },
          required: ['urlPattern'],
          description:
            'Inline capture of network response triggered by this interaction in a single round-trip',
        },
        postConditions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              condition: {
                type: 'string',
                enum: [
                  'value_equals',
                  'element_exists',
                  'text_present',
                  'url_matches',
                  'list_count_delta',
                  'element_state',
                ],
                description:
                  'Post-action assertion kind evaluated against the page after the action completes.',
              },
              expected: {
                description:
                  'Expected value for the condition. Pass uses JSON equality, except text_present (substring) and url_matches (exact string or /regex/ literal).',
              },
            },
            required: ['condition', 'expected'],
          },
          description:
            'Optional post-action assertions; one auditable result per spec is reported top-level and via the result envelope (verdict/outcome).',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FILL_INDEX,
    annotations: {
      title: 'Fill Index',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Fill text into an input or textarea element using its compact 1-based numeric index. For single search/form submission, pass pressEnter: true to fill and submit in 1 turn without needing a separate click. When filling multiple fields or clicking submit, use chrome_batch_actions to pipeline in 1 turn.',
    inputSchema: {
      type: 'object',
      properties: {
        index: {
          type: 'number',
          description: 'Compact 1-based numeric index of the target element',
        },
        text: { type: 'string', description: 'Text content to fill into the element' },
        value: { type: 'string', description: 'Alias for text parameter' },
        clear: {
          type: 'boolean',
          description: 'Whether to clear existing field content before typing (default: true)',
        },
        pressEnter: {
          type: 'boolean',
          description:
            'Whether to dispatch an Enter key event immediately after filling the text (default: false). Strongly recommended for search boxes and single-input queries to trigger immediate submission in 1 turn.',
        },
        submit: {
          type: 'boolean',
          description:
            'Whether to automatically submit the form after filling (default: false). If true, clicks the detected submit button or presses Enter, completing fill + submit in 1 turn.',
        },
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        windowId: { type: 'number', description: 'Target window ID (optional)' },
        waitForSettle: {
          type: 'boolean',
          description:
            'Wait for DOM mutations to settle after filling text before returning (default: false)',
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Maximum settle timeout in milliseconds (default: 1500, range: 200-10000)',
        },
        includeDelta: {
          type: 'boolean',
          description:
            'Automatically capture and return DOM changes caused by filling in the delta field (default: false)',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
        postConditions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              condition: {
                type: 'string',
                enum: [
                  'value_equals',
                  'element_exists',
                  'text_present',
                  'url_matches',
                  'list_count_delta',
                  'element_state',
                ],
                description:
                  'Post-action assertion kind evaluated against the page after the action completes.',
              },
              expected: {
                description:
                  'Expected value for the condition. Pass uses JSON equality, except text_present (substring) and url_matches (exact string or /regex/ literal).',
              },
            },
            required: ['condition', 'expected'],
          },
          description:
            'Optional post-action assertions; one auditable result per spec is reported top-level and via the result envelope (verdict/outcome).',
        },
      },
      required: ['index'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BATCH_ACTIONS,
    annotations: {
      title: 'Batch Actions',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Execute a sequential multi-step pipeline of browser actions in a single round-trip without waiting for intermediate model turns.\n' +
      '* CRITICAL EFFICIENCY RULE: When the next 2+ actions are predictable (e.g. form filling: [fill username, fill password, click submit]; or search flow: [fill query, press Enter, wait]), ALWAYS use chrome_batch_actions instead of individual tool calls. It completes the entire sequence in 1 turn (3~5x faster, 75%+ lower token cost).\n' +
      '* Supported action types: click, double_click, right_click, fill, hover, scroll, press_key, wait, fill_form, assert, extract.\n' +
      '* Set includeDelta: true to automatically inspect DOM changes after the pipeline completes.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [
                  'click',
                  'double_click',
                  'right_click',
                  'fill',
                  'hover',
                  'scroll',
                  'press_key',
                  'wait',
                  'key',
                  'fill_form',
                  'assert',
                  'extract',
                ],
                description: 'Action type to perform',
              },
              index: { type: 'number', description: 'Element index (for click, fill, hover)' },
              ref: {
                type: ['string', 'number'],
                description: 'Target element numeric index or ref from chrome_read_dom',
              },
              selector: {
                type: 'string',
                description: 'CSS selector or XPath for target element',
              },
              clear: {
                type: 'boolean',
                description: 'Clear field before typing (default: true)',
              },
              pressEnter: {
                type: 'boolean',
                description:
                  'Whether to dispatch an Enter key event immediately after filling the text (for type: fill)',
              },
              submit: {
                type: 'boolean',
                description:
                  'Whether to automatically submit the form after filling (clicks detected submit button or presses Enter) (for type: fill)',
              },
              fields: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    ref: {
                      type: ['string', 'number'],
                      description: 'Target element numeric index or ref from chrome_read_dom',
                    },
                    index: {
                      type: 'number',
                      description: 'Alias for ref',
                    },
                    selector: {
                      type: 'string',
                      description: 'CSS selector or XPath for target field',
                    },
                    value: {
                      type: ['string', 'number', 'boolean'],
                      description: 'Value to fill or select',
                    },
                    text: {
                      type: 'string',
                      description: 'Alias for value',
                    },
                    clear: {
                      type: 'boolean',
                      description: 'Clear field before typing (default: true)',
                    },
                  },
                  required: [],
                },
                description: 'Array of field descriptors to fill sequentially (for fill_form)',
              },
              text: { type: 'string', description: 'Text to type/fill' },
              value: { type: 'string', description: 'Alias for text' },
              key: { type: 'string', description: 'Key name (for press_key)' },
              coordinate: {
                oneOf: [
                  {
                    type: 'object',
                    properties: {
                      x: { type: 'number', description: 'X coordinate in viewport/CSS pixels' },
                      y: { type: 'number', description: 'Y coordinate in viewport/CSS pixels' },
                    },
                    required: ['x', 'y'],
                    description: '{ x, y } coordinate object',
                  },
                  {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Point [x, y] or bounding box [ymin, xmin, ymax, xmax]',
                  },
                ],
                description: 'Unified coordinate object or array for click or scroll',
              },
              x: { type: 'number', description: 'Coordinate X (for scroll/click, alias)' },
              y: { type: 'number', description: 'Coordinate Y (for scroll/click, alias)' },
              at: {
                type: 'number',
                description:
                  'Absolute epoch-ms deadline: sleep until this instant before executing this action (extension-side timer, no extra round-trip)',
              },
              direction: {
                type: 'string',
                enum: ['up', 'down', 'left', 'right'],
                description: 'Scroll direction (left/right dispatch horizontal wheel deltas)',
              },
              amount: { type: 'number', description: 'Scroll pixel amount' },
              durationMs: { type: 'number', description: 'Wait duration in ms' },
              waitForSettle: {
                type: 'boolean',
                description:
                  'Wait for DOM mutations to settle after this specific action (default: false)',
              },
              settleTimeoutMs: {
                type: 'number',
                description:
                  'Maximum settle timeout in milliseconds for this action (default: 1500)',
              },
              waitForNetworkQuiescence: {
                type: 'boolean',
                description:
                  'Wait for in-flight network requests to settle before proceeding to next action (default: false)',
              },
              quiescenceTimeoutMs: {
                type: 'number',
                description: 'Network quiescence timeout in ms (default: 2000)',
              },
              pierceOverlay: {
                type: 'boolean',
                description:
                  'Automatically pierce non-opaque or transient backdrop masks for click actions (default: true)',
              },
              preferComposer: {
                type: 'boolean',
                description:
                  'Prioritize rich composer/editor elements over generic search inputs when resolving textbox (default: false)',
              },
              // For type: 'assert'
              expectedText: {
                type: 'string',
                description: 'Expected text substring or exact match',
              },
              condition: {
                type: 'string',
                enum: [
                  'contains',
                  'not_contains',
                  'equals',
                  'matches',
                  'visible',
                  'not_visible',
                  'enabled',
                  'disabled',
                  'valid',
                  'invalid',
                  'checked',
                  'unchecked',
                ],
                description:
                  'Assertion condition: contains, not_contains, equals, matches (regex), visible, not_visible, enabled, disabled, valid, invalid, checked, unchecked (default: "contains")',
              },
              timeoutMs: {
                type: 'number',
                description:
                  'Async polling timeout in milliseconds for assertion settling (default: 300ms)',
              },
              abortOnFailure: {
                type: 'boolean',
                description: 'Abort batch if assertion fails (default: true)',
              },
              // For type: 'extract'
              property: {
                type: 'string',
                enum: ['text', 'value', 'attribute'],
                description: 'Property to extract (default: "text")',
              },
              attributeName: {
                type: 'string',
                description: 'Attribute name when property is "attribute"',
              },
              variableName: {
                type: 'string',
                description: 'Key name under extractedData to store the result',
              },
              captureNetwork: {
                type: 'object',
                properties: {
                  urlPattern: {
                    type: 'string',
                    description: 'URL pattern or substring to match (e.g. "*/api/order*")',
                  },
                  method: {
                    type: 'string',
                    description: 'Optional HTTP method to filter by (GET, POST, etc.)',
                  },
                  timeoutMs: {
                    type: 'number',
                    description:
                      'Maximum time in milliseconds to wait for the network response (default: 5000ms)',
                  },
                  statusCodes: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Optional HTTP status codes to accept',
                  },
                },
                required: ['urlPattern'],
                description: 'Inline capture of network response triggered by this action',
              },
            },
            required: ['type'],
          },
          description: 'List of actions to execute sequentially',
        },
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        windowId: { type: 'number', description: 'Target window ID (optional)' },
        waitForSettle: {
          type: 'boolean',
          description:
            'Wait for DOM mutations to settle after all actions before returning (default: false)',
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Maximum settle timeout in milliseconds (default: 1500, range: 200-10000)',
        },
        waitForNetworkQuiescence: {
          type: 'boolean',
          description:
            'Wait for in-flight network requests to settle after all actions before returning (default: false)',
        },
        quiescenceTimeoutMs: {
          type: 'number',
          description: 'Network quiescence timeout in ms (default: 2000)',
        },
        includeDelta: {
          type: 'boolean',
          description:
            'Automatically capture and return DOM changes caused by the batch in the delta field (default: false)',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
        captureNetwork: {
          type: 'object',
          properties: {
            urlPattern: {
              type: 'string',
              description: 'URL pattern or substring to match (e.g. "*/api/order*", "/checkout")',
            },
            method: {
              type: 'string',
              description: 'Optional HTTP method to filter by (GET, POST, PUT, DELETE, etc.)',
            },
            timeoutMs: {
              type: 'number',
              description:
                'Maximum time in milliseconds to wait for the matching network response (default: 5000ms)',
            },
            statusCodes: {
              type: 'array',
              items: { type: 'number' },
              description: 'Optional HTTP status codes to accept (e.g. [200, 201])',
            },
          },
          required: ['urlPattern'],
          description:
            'Inline capture of network response triggered during batch execution in a single round-trip',
        },
      },
      required: ['actions'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GET_MARKDOWN,
    annotations: {
      title: 'Get Markdown',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Extract clean, structured hierarchical markdown from the active tab DOM stripped of SPA state blobs, hidden text, and scripts.',
    inputSchema: {
      type: 'object',
      properties: {
        includeLinks: {
          type: 'boolean',
          description: 'Whether to preserve hyperlinks in markdown (default: true)',
        },
        fit: {
          type: 'boolean',
          description:
            'Content-only extraction: restrict to the main content region and strip nav/header/footer/aside/form noise before conversion (default: false)',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector limiting markdown extraction to that subtree (querySelector) instead of the whole body',
        },
        maxLength: {
          type: 'number',
          description:
            'Hard character budget for the returned markdown (default: 120000). Longer markdown is cut and a notice carrying the true original length is appended.',
        },
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        windowId: { type: 'number', description: 'Target window ID (optional)' },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GET_DROPDOWN_OPTIONS,
    annotations: {
      title: 'Get Dropdown Options',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Get all options from a native `<select>` dropdown, ARIA combobox, or custom menu list.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Element numeric index from chrome_read_dom' },
        selector: { type: 'string', description: 'CSS selector of the dropdown or combobox' },
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        windowId: { type: 'number', description: 'Target window ID (optional)' },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.MOVE_TAB,
    annotations: {
      title: 'Move Tab',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: 'Move one or more tabs to a new position index or to another window.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Single tab ID to move (optional if tabIds provided)',
        },
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Multiple tab IDs to move',
        },
        index: {
          type: 'number',
          description: 'Target position index in the window (0-based, or -1 for end of window)',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID (optional, defaults to current window)',
        },
      },
      required: ['index'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.TAB_GROUP_CREATE,
    annotations: {
      title: 'Create Tab Group',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: 'Create a new tab group with specified tabs or add tabs to an existing group.',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of tab IDs to add to the group',
        },
        groupId: { type: 'number', description: 'Optional existing group ID to add tabs into' },
        title: { type: 'string', description: 'Optional title label for the tab group' },
        color: {
          type: 'string',
          enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
          description: 'Optional color for the tab group',
        },
        collapsed: {
          type: 'boolean',
          description: 'Whether the tab group should be collapsed (default: false)',
        },
        windowId: { type: 'number', description: 'Target window ID (optional)' },
      },
      required: ['tabIds'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.TAB_GROUP_UPDATE,
    annotations: {
      title: 'Update Tab Group',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: 'Update properties (title, color, collapsed state) of an existing tab group.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'number', description: 'The ID of the tab group to update' },
        title: { type: 'string', description: 'New title for the tab group' },
        color: {
          type: 'string',
          enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'],
          description: 'New color for the tab group',
        },
        collapsed: { type: 'boolean', description: 'Whether the group should be collapsed' },
      },
      required: ['groupId'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.TAB_GROUP_LIST,
    annotations: {
      title: 'List Tab Groups',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: 'List all open tab groups in the browser or within a specific window.',
    inputSchema: {
      type: 'object',
      properties: {
        windowId: { type: 'number', description: 'Optional window ID to filter groups by' },
        title: { type: 'string', description: 'Optional group title to filter by' },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.TAB_GROUP_UNGROUP,
    annotations: {
      title: 'Ungroup Tabs',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: 'Remove one or more tabs from their current tab group.',
    inputSchema: {
      type: 'object',
      properties: {
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of tab IDs to ungroup',
        },
      },
      required: ['tabIds'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.TAB_GROUP_CLOSE,
    annotations: {
      title: 'Close Tab Group',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: 'Close all tabs in a tab group and delete the group.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'number', description: 'The ID of the tab group to close' },
      },
      required: ['groupId'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.ATTACH_TAB,
    annotations: {
      title: 'Attach Tab',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "Explicitly attach CDP debugger and session affinity to a specific tab (by tabId) or the user's currently active tab. WARNING / SIDE EFFECT: Attaching to the user's active tab displays Chrome's debugger warning banner ('browserclaw is debugging this browser') and directly shares execution state with the user. Avoid calling unless interaction with the user's active tab is explicitly requested.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            "The target tab ID to attach. If omitted, attaches to the user's currently active foreground tab.",
        },
        sessionId: {
          type: 'string',
          description: 'Session identifier to bind affinity to this tab.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.DETACH_TAB,
    annotations: {
      title: 'Detach Tab',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Detach CDP debugger from the tab and release session affinity, dismissing the Chrome debugger banner.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'The target tab ID to detach (defaults to session bound tab or active tab).',
        },
        sessionId: {
          type: 'string',
          description: 'Session identifier to release affinity from.',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.BURST_INTERACT,
    annotations: {
      title: 'Burst Interact',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Execute ultra-low latency rapid interaction sequences: high-frequency clicks (burst), mouse trajectories, or rapid keyboard inputs directly over CDP without per-action roundtrip lag.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        sessionId: { type: 'string', description: 'Session ID for tab affinity (optional)' },
        coordinateSpace: {
          type: 'string',
          enum: ['viewport', 'screenshot'],
          description: 'Coordinate space for coordinates (default: "viewport")',
        },
        burstClicks: {
          type: 'object',
          properties: {
            center: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    x: {
                      type: 'number',
                      description: 'Center X coordinate in viewport CSS pixels',
                    },
                    y: {
                      type: 'number',
                      description: 'Center Y coordinate in viewport CSS pixels',
                    },
                  },
                  required: ['x', 'y'],
                  description: '{ x, y } coordinate object',
                },
                {
                  type: 'array',
                  items: { type: 'number' },
                  description: 'Point [x, y] or bounding box [ymin, xmin, ymax, xmax]',
                },
              ],
              description:
                'Center point for burst clicks: { x, y } object, [x, y] point, or [ymin, xmin, ymax, xmax] bounding box',
            },
            count: {
              type: 'number',
              description: 'Number of clicks in the burst (1-100, default: 5)',
            },
            radius: {
              type: 'number',
              description: 'Random dispersion radius in pixels around center (default: 0)',
            },
            intervalMs: {
              type: 'number',
              description: 'Delay between consecutive clicks in ms (default: 10)',
            },
            button: {
              type: 'string',
              enum: ['left', 'right', 'middle'],
              description: 'Mouse button (default: left)',
            },
          },
          required: ['center'],
          description: 'High-frequency burst clicking around a center point',
        },
        trajectory: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'X coordinate' },
              y: { type: 'number', description: 'Y coordinate' },
              pauseMs: {
                type: 'number',
                description: 'Pause duration at this trajectory node in ms',
              },
              click: { type: 'boolean', description: 'Whether to dispatch a click at this node' },
              button: { type: 'string', enum: ['left', 'right', 'middle'] },
            },
            required: ['x', 'y'],
          },
          description: 'Smooth or micro-paused mouse movement trajectory sequence',
        },
        keySequence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Key name (e.g. Enter, ArrowDown, a)' },
              text: { type: 'string', description: 'Text character if printable' },
              delayMs: { type: 'number', description: 'Delay in ms before next key' },
            },
            required: ['key'],
          },
          description: 'Rapid keyboard keypress sequence',
        },
        waitForSettle: {
          type: 'boolean',
          description: 'Wait for DOM settle after sequence completes',
        },
        settleTimeoutMs: { type: 'number', description: 'Settle timeout in ms' },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SMART_SCROLL,
    annotations: {
      title: 'Smart Scroll',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Intelligently detects and scrolls the most prominent scrollable container on the page, or targets a specific container by selector, ref, or coordinate with automatic progress calculation.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        sessionId: { type: 'string', description: 'Session ID for tab affinity (optional)' },
        direction: {
          type: 'string',
          enum: ['down', 'up', 'left', 'right'],
          description: 'Scroll direction (default: "down")',
        },
        amount: {
          type: 'string',
          description:
            'Scroll amount: number in pixels, "page" (viewport height), or "half_page" (default: "page")',
        },
        selector: {
          type: 'string',
          description: 'Optional CSS selector of the scroll container to target',
        },
        ref: {
          type: 'number',
          description: 'Optional 1-based numeric index of the scroll container to target',
        },
        index: {
          type: 'number',
          description: 'Alias for ref: 1-based numeric index of the scroll container to target',
        },
        coordinate: {
          oneOf: [
            {
              type: 'object',
              properties: {
                x: { type: 'number', description: 'X coordinate' },
                y: { type: 'number', description: 'Y coordinate' },
              },
              required: ['x', 'y'],
              description: '{ x, y } coordinate object',
            },
            {
              type: 'array',
              items: { type: 'number' },
              description: 'Point [x, y] or bounding box [ymin, xmin, ymax, xmax]',
            },
          ],
          description:
            'Optional coordinate to locate the scrollable container under pointer: { x, y } object, [x, y] point, or [ymin, xmin, ymax, xmax] bounding box',
        },
        smooth: {
          type: 'boolean',
          description: 'Whether to use smooth scrolling behavior (default: true)',
        },
        waitForSettle: {
          type: 'boolean',
          description:
            'Wait for DOM and network activity to settle after scroll completes (default: true)',
        },
        settleTimeoutMs: {
          type: 'number',
          description: 'Maximum settle wait timeout in ms (default: 1500)',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.STORAGE,
    annotations: {
      title: 'Read Storage',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Read localStorage, sessionStorage, and cookies for the current tab. Cookies include HttpOnly entries that document.cookie cannot see.',
    inputSchema: {
      type: 'object',
      properties: {
        types: {
          type: 'array',
          items: { type: 'string', enum: ['localStorage', 'sessionStorage', 'cookies'] },
          description: 'Which stores to read (default: all three)',
        },
        filter: {
          type: 'string',
          description:
            'Only return entries whose key or value contains this substring (case-insensitive)',
        },
        limit: {
          type: 'number',
          description: 'Maximum entries returned per store (default 200)',
        },
        includeHttpOnly: {
          type: 'boolean',
          description:
            'Include HttpOnly cookies (default true). Their values are redacted (valueIncluded: false) regardless; set includeHttpOnly:false to drop the entries entirely',
        },
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        windowId: { type: 'number', description: 'Target window ID (optional)' },
        sessionId: { type: 'string', description: 'Session ID for tab affinity (optional)' },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GET_LINKS,
    annotations: {
      title: 'Extract Page Links',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Extract all links on the page for crawling: absolute URL, anchor text, internal/external classification, rel=nofollow flag. Supports an optional CSS selector to scope extraction, and a sameOriginOnly filter.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
        selector: {
          type: 'string',
          description: 'Optional CSS selector to scope the link search (default: whole document)',
        },
        sameOriginOnly: {
          type: 'boolean',
          description: 'Only return same-origin links (default: false)',
        },
        includeEmptyHref: {
          type: 'boolean',
          description: 'Include anchors without href (default: false)',
        },
        sessionId: { type: 'string', description: 'Session ID for tab affinity (optional)' },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.TOOL_DOCS,
    annotations: {
      title: 'Tool Category Docs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Return compact parameter documentation for a category of BrowserClaw tools (navigate | perceive | act | observe | manage | crawl | diagnose | network | power). Use when a workflow needs a tool that is not in the current profile view. The "power" category is tier 3 (javascript, cdp_execute): it is disclosed here but only unlocked for the session when activateForSession is true.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: [
            'navigate',
            'perceive',
            'act',
            'observe',
            'manage',
            'crawl',
            'diagnose',
            'network',
            'power',
          ],
          description: 'Tool category to document',
        },
        activateForSession: {
          type: 'boolean',
          description:
            'When true, dynamically exposes all tools in this category for the current MCP session without server restart. Default: false',
        },
      },
      required: ['category'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.CDP_EXECUTE,
    annotations: {
      title: 'Execute Raw CDP Command',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Execute raw Chrome DevTools Protocol (CDP) commands directly on a target tab. Gives advanced reasoning agents full, unconstrained, low-level browser automation capabilities (e.g. Page, DOM, Input, Runtime, Network, Emulation domains). Requires debugger permission.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description:
            'Target tab ID to attach and execute CDP on. Defaults to current active/affinity tab.',
        },
        method: {
          type: 'string',
          description:
            'CDP method name (e.g. "Page.navigate", "Runtime.evaluate", "Input.dispatchMouseEvent", "DOMSnapshot.captureSnapshot").',
        },
        params: {
          type: 'object',
          description: 'Parameters object passed to the CDP method.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds for this CDP command. Default: 10000.',
        },
      },
      required: ['method'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.INSPECT_MEDIA,
    annotations: {
      title: 'Inspect Media Element',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Inspect and extract high-fidelity media assets (images, canvas, captchas, icons) directly by element index or selector. Uses in-memory lossless extraction for `<img>`/`<canvas>`, with super-sampled 200%+ crop fallback for complex DOM containers.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '1-based element index from chrome_read_dom' },
        selector: { type: 'string', description: 'CSS selector fallback' },
        zoom: { type: 'number', description: 'Super-sampling zoom factor (default: 2.0)' },
        tabId: { type: 'number', description: 'Target tab ID' },
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.REQUEST_HUMAN_INTERVENTION,
    annotations: {
      title: 'Request Human Intervention',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Request user assistance for high-friction barriers (SMS 2FA, puzzle captcha, payment confirmation). Renders an in-page glassmorphism overlay bar with explanation, moves agent cursor to standby, and resumes cleanly when human finishes or clicks continue.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Clear instruction explaining what the human user needs to do',
        },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default: 60000)' },
        tabId: { type: 'number', description: 'Target tab ID' },
      },
      required: ['reason'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.DOCTOR,
    annotations: {
      title: 'Environment Doctor',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Diagnose BrowserClaw environment, Native Host connectivity, Chrome silent-debugger flags, port availability, and token security.',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: {
          type: 'boolean',
          description: 'Return full path and configuration details (default: false)',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.BROWSER.UNDO_LAST_ACTION,
    annotations: {
      title: 'Undo Last Action',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Rolls back the most recent mutating action on this tab (e.g. reverts form field input to previous value, or triggers browser history back navigation for mistaken links).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
      },
    },
  },
  {
    name: TOOL_NAMES.BROWSER.INTERCEPT_API,
    annotations: {
      title: 'Intercept API Response',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Intercepts backend JSON API responses matching a URL pattern (e.g. "*/api/v1/data*") via CDP Network domain, bypassing messy HTML DOM scraping to obtain 100% structured ground-truth data.',
    inputSchema: {
      type: 'object',
      properties: {
        urlPattern: { type: 'string', description: 'Glob pattern to match API endpoint URL' },
        triggerAction: {
          type: 'string',
          enum: ['inspect_recent', 'wait_next'],
          description:
            'Wait for next response or inspect most recent match (default: inspect_recent)',
        },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default: 10000)' },
        tabId: { type: 'number', description: 'Target tab ID' },
      },
      required: ['urlPattern'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.GREP,
    annotations: {
      title: 'Search Page (Grep)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Search the page without dumping full DOM tree. Supports searching interactive elements (returning indices for chrome_interact_index), all DOM nodes, or raw visible text lines.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or regex pattern' },
        isRegex: {
          type: 'boolean',
          description: 'Whether to evaluate query as a regular expression (default: false)',
        },
        searchType: {
          type: 'string',
          enum: ['interactive_only', 'all_dom', 'page_text'],
          description:
            'Search target: "interactive_only" (default, matches clickable/fillable elements and returns indices), "all_dom" (matches all elements), "page_text" (scans visible text lines).',
        },
        limit: {
          type: 'number',
          description: 'Maximum matching results to return (default: 20, max: 50)',
        },
        autoScroll: {
          type: 'boolean',
          description:
            'When true, automatically executes client-side RAF auto-scrolling to probe and detect off-screen virtualized elements (virtual list / infinite scroll streams like X/Twitter). Default: false',
        },
        maxSteps: {
          type: 'number',
          description:
            'Maximum scroll iterations to attempt when autoScroll is enabled (default: 10)',
        },
        stepPx: {
          type: 'number',
          description: 'Pixel distance to scroll on each probing step (default: 800)',
        },
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        sessionId: {
          type: 'string',
          description: 'Session identifier for tab affinity (optional)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.EXTRACT,
    annotations: {
      title: 'Schema-Typed Extract',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Schema-typed extraction: pull the fields a JSON Schema declares out of the page (or an HTML string), with source attribution. Each key resolves via [data-field="key"] -> #key -> [name="key"] -> class match -> optional per-property selector -> label text; form controls read value, other elements read textContent, and declared number/integer/boolean types are coerced. Returns { data, missing, sourceRefs } — a key with no source element is reported in `missing` and is never invented into `data`.',
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'object',
          description:
            'JSON Schema object describing the fields to extract: { type: "object", properties: { <key>: { type: "string"|"number"|"integer"|"boolean", description?, selector? } }, required?: string[] }',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector scoping extraction to a subtree (optional; defaults to the whole document)',
        },
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        sessionId: {
          type: 'string',
          description: 'Session identifier for tab affinity (optional)',
        },
      },
      required: ['schema'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.FORM_PIPELINE,
    annotations: {
      title: 'Autonomous Form Pipeline',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Autonomously fill and advance multi-step forms / wizards (e.g. Typeform, onboarding, multi-page surveys) in a local execution loop without multi-turn LLM ping-pong. Automatically matches fields, selects choices, triggers step advancement (via Enter or OK/Next button), and yields structured interrupts upon CAPTCHA or blocking validation errors.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description:
                  'Question label, field name, placeholder, or keyword to match against active screen',
              },
              value: {
                type: 'string',
                description: 'Value to type or choice option text to select',
              },
              type: {
                type: 'string',
                enum: ['text', 'choice', 'enter'],
                description:
                  'Input method: "text" (default fill), "choice" (click matching button/option), "enter" (submit via Enter key)',
              },
            },
            required: ['query', 'value'],
          },
          description: 'Ordered list of fields and values to fulfill throughout the form flow',
        },
        maxSteps: {
          type: 'number',
          description: 'Maximum form advancement steps to attempt before returning (default: 20)',
        },
        autoAdvance: {
          type: 'boolean',
          description:
            'Automatically trigger step advance via Enter or clicking OK/Next button after input (default: true)',
        },
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        windowId: { type: 'number', description: 'Target window ID (optional)' },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
        sessionContext: {
          type: 'string',
          description: 'Optional alias for sessionId',
        },
      },
      required: ['fields'],
    },
  },
  {
    name: TOOL_NAMES.NATIVE.ACT_TOWARD_GOAL,
    annotations: {
      title: 'Act Toward Goal',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Autonomous semantic micro-loop that perceives, decides, and acts toward a natural-language goal within a local Native Server loop (~200-400ms/step). Powered by TypeSafe Jev System One with seamless fallback to heuristic scoring when no API key is available or on quota/network degradation. Automatically escalates ambiguous, destructive, or complex actions back to the macro planner with pre-fetched page context.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'Natural language goal or objective to advance toward on the current page',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID (optional, defaults to active tab)',
        },
        maxSteps: {
          type: 'number',
          description:
            'Maximum decision steps before terminating (default: 10, max: 60; heuristic capped at <= 5)',
        },
        timeoutMs: {
          type: 'number',
          description: 'Total execution timeout in milliseconds (default: 90000, max: 300000)',
        },
        textHint: {
          type: 'string',
          description: 'Explicit text hint to enter when typing, if not clearly quoted in goal',
        },
        confidenceThreshold: {
          type: 'number',
          description: 'Minimum confidence threshold to commit an action (default: 0.55)',
        },
        pauseBeforeKeywords: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of keywords (e.g. ["Post", "Submit", "Pay"]). If the predicted action targets an element whose label, text, or role matches any keyword, the micro-loop suspends before execution and returns status "paused" with target element context for System 2 confirmation.',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to bind affinity to a specific tab context',
        },
        sessionContext: {
          type: 'string',
          description: 'Optional alias for sessionId',
        },
      },
      required: ['goal'],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.INSERT_MEDIA,
    annotations: {
      title: 'Insert Media Asset',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Injects an image or media asset from local disk, URL, or base64 into a rich-text composer (e.g. Reddit, Twitter/X, Notion, Discord, Slack, GitHub) or targeted element via synthesized ClipboardEvent("paste") and DragEvent("drop") containing a real File object in DataTransfer, bypassing browser clipboard security sandboxes.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Absolute or relative path to the image or media file on local disk (e.g. "C:\\Users\\...\\diagram.png" or "/home/.../photo.jpg")',
        },
        fileUrl: {
          type: 'string',
          description: 'Remote HTTP/HTTPS URL to fetch the image or media asset from',
        },
        base64Data: {
          type: 'string',
          description:
            'Base64-encoded media data string, optionally with "data:<mime>;base64," prefix',
        },
        fileName: {
          type: 'string',
          description:
            'Optional filename to associate with the injected file (e.g. "architecture.png")',
        },
        mimeType: {
          type: 'string',
          description:
            'MIME type of the media (e.g. "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"). Auto-detected if omitted.',
        },
        index: {
          type: 'number',
          description:
            '1-based compact element index from chrome_read_dom targeting the rich-text editor or composer. Defaults to active element or discovered composer.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for the target container (optional fallback for index)',
        },
        tabId: {
          type: 'number',
          description: 'Target tab ID (optional, defaults to active tab)',
        },
        windowId: {
          type: 'number',
          description: 'Target window ID (optional)',
        },
        sessionId: {
          type: 'string',
          description: 'Session identifier for tab affinity binding',
        },
        sessionContext: {
          type: 'string',
          description: 'Optional alias for sessionId',
        },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.DISMISS_OVERLAY,
    annotations: {
      title: 'Dismiss Overlay',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      'Fast 1-step dismissal for visible high-z-index marketing popups, coupon dialogs, promotional banners, and cookie consent overlays (e.g. promotional banners, modals with "Close", "Skip", "Cancel", "×"). Locates close buttons and dismisses top-level dialogs without dumping hundreds of DOM nodes or wasting roundtrips.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (optional)' },
        windowId: { type: 'number', description: 'Target window ID (optional)' },
        maxOverlays: {
          type: 'number',
          description: 'Maximum number of stacked overlays to dismiss (default: 5)',
        },
        waitForSettle: {
          type: 'boolean',
          description: 'Wait for DOM settle after dismissal (default: true)',
        },
        sessionId: { type: 'string', description: 'Session ID for tab affinity routing' },
        sessionContext: { type: 'string', description: 'Session context alias' },
      },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.BROWSER.SCROLL_UNTIL_FOUND,
    annotations: {
      title: 'Semantic Auto-Scroll (Scroll Until Found)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      'Performs automated client-side RAF auto-scrolling and live DOM / Shadow-DOM detection to locate target text, regex, or selector without multi-turn LLM polling loops. Designed specifically for infinite scroll and virtualized feeds (e.g. X/Twitter, Reddit, Weibo). Immediately stops when target appears, centers element in viewport, and returns its 1-based interactive index.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text string or regex pattern to search for during scrolling.',
        },
        isRegex: {
          type: 'boolean',
          description: 'Whether to evaluate query as a regular expression (default: false).',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector for the target element (supports Shadow DOM piercing combinators like >>>).',
        },
        role: {
          type: 'string',
          description: 'ARIA role to filter matching elements (e.g. "button", "article", "link").',
        },
        direction: {
          type: 'string',
          enum: ['down', 'up'],
          description: 'Scroll direction (default: "down").',
        },
        stepPx: {
          type: 'number',
          description: 'Pixel offset to scroll on each step (default: 800).',
        },
        maxSteps: {
          type: 'number',
          description: 'Maximum scroll iterations before stopping (default: 10, max: 30).',
        },
        scrollDelayMs: {
          type: 'number',
          description:
            'Pause duration in ms after each step to allow virtual list rendering (default: 250ms).',
        },
        containerSelector: {
          type: 'string',
          description:
            'Optional CSS selector of specific scrollable container instead of window/document.',
        },
        actionOnFound: {
          type: 'string',
          enum: ['none', 'scroll_into_view', 'click', 'focus'],
          description:
            'Action to perform automatically when element is found (default: "scroll_into_view").',
        },
        tabId: { type: 'number', description: 'Target tab ID (optional).' },
        windowId: { type: 'number', description: 'Target window ID (optional).' },
        sessionId: {
          type: 'string',
          description: 'Session identifier for tab affinity (optional).',
        },
        sessionContext: { type: 'string', description: 'Session context alias (optional).' },
      },
      required: [],
    },
  },
];

function alignSchemaDescriptions(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    return schema.map(alignSchemaDescriptions);
  }
  const copy: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description' && typeof value === 'string') {
      copy[key] = alignToolReferences(value);
    } else if (typeof value === 'object' && value !== null) {
      copy[key] = alignSchemaDescriptions(value);
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

export const PURGED_TOOL_NAMES = new Set([
  'chrome_click_element',
  'chrome_burst_interact',
  'chrome_fill_or_select',
  'chrome_get_web_content',
  'chrome_get_links',
]);

export const TOOL_SCHEMAS: Tool[] = RAW_TOOL_SCHEMAS.filter(
  (tool) => !PURGED_TOOL_NAMES.has(tool.name),
).map((tool) => alignSchemaDescriptions(tool));
