import { isCloudMetadataUrl, restrictedUrlErrorMessage } from '@/utils/restricted-url';
import { actionHistoryManager } from '@/utils/action-history-manager';
import { tabGroupManager } from './tab-group-manager';
import { tabFaviconManager } from './tab-favicon';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import { isPopupUrl } from '@/utils/popup-guard';
import { waitForPageSettle } from '@/utils/action-watchdog';
import { executeInPage } from './in-page-engine';

export { isPopupUrl };

// Default window dimensions
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 720;

interface NavigateToolParams {
  url?: string;
  action?: 'back' | 'forward' | string;
  newWindow?: boolean;
  width?: number;
  height?: number;
  refresh?: boolean;
  tabId?: number;
  windowId?: number;
  background?: boolean; // when true, do not activate tab or focus window
  groupTitle?: string;
  groupColor?: 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
  autoGroup?: boolean;
  dismissOverlays?: boolean;
}

export function hasIpOrCustomPort(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (u.port && u.port !== '80' && u.port !== '443') return true;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return true;
    if (h.includes(':') || h.startsWith('[')) return true;
  } catch {}
  return false;
}

/**
 * Tool for navigating to URLs in browser tabs or windows
 */
class NavigateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NAVIGATE;

  private async navigateAndWait(
    tabId: number,
    action: () => Promise<any>,
    timeoutMs = 15000,
  ): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated?.addListener) {
      await action();
      return;
    }

    let cleanup: (() => void) | undefined;
    const navPromise = new Promise<void>((resolve) => {
      const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          if (cleanup) cleanup();
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      const timer = setTimeout(() => {
        if (cleanup) cleanup();
        resolve();
      }, timeoutMs);
      cleanup = () => {
        clearTimeout(timer);
        try {
          chrome.tabs.onUpdated.removeListener(listener);
        } catch {}
      };
    });

    try {
      await action();
      if (process.env.NODE_ENV !== 'test') {
        await navPromise;
      }
    } finally {
      if (cleanup) cleanup();
    }

    await waitForPageSettle(tabId, { timeoutMs: 1500, quietPeriodMs: 100 }).catch(() => {});
    void tabFaviconManager.markTabActive(tabId);
  }

  private async waitForTabNavigationComplete(tabId: number, timeoutMs = 15000): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated?.addListener) {
      return;
    }
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.status !== 'complete') {
        let cleanup: (() => void) | undefined;
        await new Promise<void>((resolve) => {
          const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
              if (cleanup) cleanup();
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          const timer = setTimeout(() => {
            if (cleanup) cleanup();
            resolve();
          }, timeoutMs);
          cleanup = () => {
            clearTimeout(timer);
            try {
              chrome.tabs.onUpdated.removeListener(listener);
            } catch {}
          };
        });
      }

      await waitForPageSettle(tabId, { timeoutMs: 1500, quietPeriodMs: 100 }).catch(() => {});
      void tabFaviconManager.markTabActive(tabId);
    } catch {
      // Non-blocking fallback
    }
  }

  async execute(args: NavigateToolParams): Promise<ToolResult> {
    const { newWindow = false, width, height, refresh = false, tabId, background, windowId } = args;
    const url =
      args.url || (args.action === 'back' || args.action === 'forward' ? args.action : undefined);

    console.log(
      `Attempting to ${refresh ? 'refresh current tab' : `open URL: ${url}`} with options:`,
      args,
    );

    const sessionId = (args as any)?.sessionId || (args as any)?.sessionContext;

    try {
      // Handle refresh option first
      if (refresh) {
        console.log('Refreshing current active tab');
        const targetTab = await this.resolveAffinityTab({ tabId, windowId, sessionId });
        if (!targetTab.id) return createErrorResponse('No target tab found to refresh');
        if (targetTab.url && targetTab.id) {
          actionHistoryManager.pushAction(targetTab.id, {
            type: 'navigate',
            prevUrl: targetTab.url,
            timestamp: Date.now(),
          });
        }
        const targetTabId = targetTab.id;

        await this.navigateAndWait(targetTabId, () => chrome.tabs.reload(targetTabId));

        if (args.autoGroup !== false && typeof targetTab.windowId === 'number') {
          await tabGroupManager
            .ensureAgentTabGroup(targetTabId, {
              title: args.groupTitle,
              color: args.groupColor,
              windowId: targetTab.windowId,
            })
            .catch(() => {});
        }
        await tabFaviconManager.setAgentFavicon(targetTabId).catch(() => {});

        if (args.dismissOverlays) {
          try {
            const dismissRes = await executeInPage(
              { tabId: targetTabId },
              'inPageDismissOverlays',
              [],
            );
            const count = dismissRes?.[0]?.result?.dismissedCount ?? 0;
            if (count > 0) {
              await waitForPageSettle(targetTabId, { timeoutMs: 500 }).catch(() => {});
            } else {
              await new Promise((r) => setTimeout(r, 100));
            }
          } catch {}
        }

        console.log(`Refreshed and settled tab ID: ${targetTabId}`);

        // Get updated tab information
        const updatedTab = await chrome.tabs.get(targetTabId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Successfully refreshed current tab',
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url,
              }),
            },
          ],
          isError: false,
        };
      }

      // Validate that url is provided when not refreshing
      if (!url) {
        return createErrorResponse('URL parameter is required when refresh is not true');
      }

      // Guard against popup.html (P1-5: agent code paths must never open popup.html)
      if (isPopupUrl(url)) {
        return createErrorResponse(
          'Access denied: popup.html cannot be opened or navigated to by agent code paths. Popup is reserved exclusively for user manual interaction.',
        );
      }

      // Pre-flight check for file:// scheme permissions
      if (url.startsWith('file://')) {
        try {
          const isAllowed = await chrome.extension.isAllowedFileSchemeAccess();
          if (!isAllowed) {
            return createErrorResponse(
              `Navigation to 'file://' URLs is blocked by Chrome security policy. Please enable "Allow access to file URLs" for the Chrome MCP extension in chrome://extensions/?id=${chrome.runtime.id} and retry.`,
            );
          }
        } catch {
          // If extension check throws in test/mock environment, continue
        }
      }

      // Handle history navigation: url="back" or url="forward"
      if (url === 'back' || url === 'forward') {
        const targetTab = await this.resolveAffinityTab({ tabId, windowId, sessionId });
        if (!targetTab.id) {
          return createErrorResponse('No target tab found for history navigation');
        }

        try {
          if (url === 'forward') {
            await this.navigateAndWait(targetTab.id, () => chrome.tabs.goForward(targetTab.id!));
            console.log(`Navigated forward in tab ID: ${targetTab.id}`);
          } else {
            await this.navigateAndWait(targetTab.id, () => chrome.tabs.goBack(targetTab.id!));
            console.log(`Navigated back in tab ID: ${targetTab.id}`);
          }
        } catch (historyErr: any) {
          const errMsg = historyErr instanceof Error ? historyErr.message : String(historyErr);
          if (errMsg.toLowerCase().includes('cannot go')) {
            return createErrorResponse(
              `Cannot navigate ${url}: tab is already at the ${url === 'back' ? 'beginning' : 'end'} of browsing history`,
            );
          }
          return createErrorResponse(`History navigation failed: ${errMsg}`);
        }

        const updatedTab = await chrome.tabs.get(targetTab.id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                action: url,
                message: `Successfully navigated ${url} in browser history`,
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url,
              }),
            },
          ],
          isError: false,
        };
      }

      // Validate the URL *before* any tab matching. A scheme-less or malformed
      // string used to reach chrome.tabs.update/create unresolved, so Chrome
      // resolved it against the extension origin and the navigation silently
      // "succeeded" onto chrome-extension://<id>/<garbage>.
      if (typeof url === 'string' && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
        return createErrorResponse(
          `Invalid URL '${url}': missing a scheme. Pass an absolute URL such as ` +
            `'https://example.com/path' (scheme-less hosts are not resolved relative to any page).`,
        );
      }
      try {
        new URL(url);
      } catch {
        return createErrorResponse(
          `Invalid URL '${url}': could not be parsed. Pass an absolute URL such as 'https://example.com/path'.`,
        );
      }

      // 1. Check if URL is already open
      // Prefer Chrome's URL match patterns for robust matching (host/path variations)
      console.log(`Checking if URL is already open: ${url}`);

      // Build robust match patterns from the provided URL.
      // This mirrors the approach in CloseTabsTool: ensure wildcard path and
      // add common variants (www/no-www, http/https) to handle real-world redirects.
      const buildUrlPatterns = (input: string): string[] => {
        if (input.startsWith('file://')) {
          return [input];
        }
        const patterns = new Set<string>();
        try {
          if (!input.includes('*')) {
            const u = new URL(input);
            // Use host-level wildcard to include all paths; we'll do precise selection later
            const pathWildcard = '/*';

            const hostNoWww = u.host.replace(/^www\./, '');
            const hostWithWww = hostNoWww.startsWith('www.') ? hostNoWww : `www.${hostNoWww}`;

            // Keep original host
            patterns.add(`${u.protocol}//${u.host}${pathWildcard}`);
            // Add no-www variant
            patterns.add(`${u.protocol}//${hostNoWww}${pathWildcard}`);
            // Add www variant
            patterns.add(`${u.protocol}//${hostWithWww}${pathWildcard}`);

            // Add protocol variant to catch http↔https redirects
            const altProtocol = u.protocol === 'https:' ? 'http:' : 'https:';
            patterns.add(`${altProtocol}//${u.host}${pathWildcard}`);
            patterns.add(`${altProtocol}//${hostNoWww}${pathWildcard}`);
            patterns.add(`${altProtocol}//${hostWithWww}${pathWildcard}`);
          } else {
            patterns.add(input);
          }
        } catch {
          // Fallback: best-effort wildcard suffix
          patterns.add(input.endsWith('/') ? `${input}*` : `${input}/*`);
        }
        return Array.from(patterns);
      };

      let candidateTabs: chrome.tabs.Tab[] = [];
      if (hasIpOrCustomPort(url) || url.startsWith('file://')) {
        const allTabs = await chrome.tabs.query({});
        try {
          const targetUrl = new URL(url);
          const targetHost = targetUrl.host.toLowerCase();
          candidateTabs = allTabs.filter((t) => {
            if (!t.url) return false;
            try {
              const tu = new URL(t.url);
              return tu.host.toLowerCase() === targetHost;
            } catch {
              return false;
            }
          });
        } catch {
          const allTabs = (await chrome.tabs.query({})) || [];
          candidateTabs = allTabs.filter((t) => t.url && t.url.startsWith(url));
        }
        console.log(
          `Found ${candidateTabs.length} matching tabs via memory filter for IP/port URL: ${url}`,
        );
      } else {
        const urlPatterns = buildUrlPatterns(url);
        try {
          candidateTabs = (await chrome.tabs.query({ url: urlPatterns })) || [];
        } catch {
          // A pattern Chrome rejects must NOT widen the search to every open
          // tab — that turned a typo'd URL into "activate an arbitrary tab".
          console.warn('URL pattern matching failed; not falling back to all tabs', urlPatterns);
          candidateTabs = [];
        }
        if (!Array.isArray(candidateTabs)) candidateTabs = [];
        console.log(`Found ${candidateTabs.length} matching tabs with patterns:`, urlPatterns);
      }

      // Prefer strict match when user specifies a concrete path/query.
      // Only fall back to host-level activation when the target is site root.
      const pickBestMatch = (target: string, tabsToPick: chrome.tabs.Tab[]) => {
        let targetUrl: URL | undefined;
        try {
          targetUrl = new URL(target);
        } catch {
          // Not a fully-qualified URL; cannot do structured comparison
          return tabsToPick[0];
        }

        const normalizePath = (p: string) => {
          if (!p) return '/';
          // Ensure leading slash
          const withLeading = p.startsWith('/') ? p : `/${p}`;
          // Remove trailing slash except when root
          return withLeading !== '/' && withLeading.endsWith('/')
            ? withLeading.slice(0, -1)
            : withLeading;
        };

        const hostBase = (h: string) => h.replace(/^www\./, '').toLowerCase();
        const isRootTarget = normalizePath(targetUrl.pathname) === '/' && !targetUrl.search;
        const targetPath = normalizePath(targetUrl.pathname);
        const targetSearch = targetUrl.search || '';
        const targetHostBase = hostBase(targetUrl.host);

        let best: { tab?: chrome.tabs.Tab; score: number } = { score: -1 };

        for (const tab of tabsToPick) {
          const tabUrlStr = tab.url || '';
          let tabUrl: URL | undefined;
          try {
            tabUrl = new URL(tabUrlStr);
          } catch {
            continue;
          }

          const tabHostBase = hostBase(tabUrl.host);
          if (tabHostBase !== targetHostBase) continue;

          const tabPath = normalizePath(tabUrl.pathname);
          const tabSearch = tabUrl.search || '';

          // Scoring:
          // 3 - exact path match and (if target has query) exact query match
          // 2 - exact path match ignoring query (target without query)
          // 1 - same host, any path (only if target is root)
          let score = -1;
          const pathEqual = tabPath === targetPath;
          const searchEqual = tabSearch === targetSearch;

          if (pathEqual && (targetSearch ? searchEqual : true)) {
            score = 3;
          } else if (pathEqual && !targetSearch) {
            score = 2;
          }

          if (score > best.score) {
            best = { tab, score };
            if (score === 3) break; // Cannot do better
          }
        }

        return best.tab;
      };

      const explicitTab = await this.tryGetTab(tabId, sessionId);

      // Active Tab Protection Guard (P0 Non-Intrusive Human-First Coexistence):
      // If the caller specified a tabId that is currently active (user is actively looking at it)
      // AND that tab does NOT belong to an Agent-managed tab group,
      // it is a protected personal user tab! Never hijack or overwrite it in place.
      let protectedPersonalTab = false;
      if (explicitTab && explicitTab.active && background !== false) {
        const isManaged =
          typeof explicitTab.groupId === 'number' && explicitTab.groupId > 0
            ? await tabGroupManager.isManagedGroup(explicitTab.groupId)
            : false;
        if (!isManaged) {
          console.log(
            `[NavigateTool] Tab ID ${explicitTab.id} is user's active unmanaged personal tab. Protecting it from overwrite; opening in background instead.`,
          );
          protectedPersonalTab = true;
        }
      }

      const existingTab = protectedPersonalTab
        ? null
        : explicitTab || pickBestMatch(url, candidateTabs);
      if (existingTab?.id !== undefined) {
        if (sessionId && typeof existingTab.id === 'number') {
          sessionTabAffinity.setAffinity(sessionId, existingTab.id);
        }
        console.log(
          `URL already open in Tab ID: ${existingTab.id}, Window ID: ${existingTab.windowId}`,
        );
        // Update URL when explicit tab specified or when existingTab URL differs from requested url
        if (typeof existingTab.id === 'number' && (explicitTab || existingTab.url !== url)) {
          await this.navigateAndWait(existingTab.id, () =>
            chrome.tabs.update(existingTab.id!, { url }),
          );
        }

        if (typeof existingTab.id === 'number') {
          if (args.autoGroup !== false) {
            await tabGroupManager
              .ensureAgentTabGroup(existingTab.id, {
                title: args.groupTitle,
                color: args.groupColor,
                windowId: existingTab.windowId,
              })
              .catch(() => {});
          }
          await tabFaviconManager.setAgentFavicon(existingTab.id).catch(() => {});

          if (args.dismissOverlays) {
            try {
              const dismissRes = await executeInPage(
                { tabId: existingTab.id },
                'inPageDismissOverlays',
                [],
              );
              const count = dismissRes?.[0]?.result?.dismissedCount ?? 0;
              if (count > 0) {
                await waitForPageSettle(existingTab.id, { timeoutMs: 500 }).catch(() => {});
              } else {
                await new Promise((r) => setTimeout(r, 100));
              }
            } catch {}
          }
        }

        // Optionally bring to foreground only if background is explicitly false (P0-1)
        await this.ensureFocus(existingTab, {
          activate: background === false,
          focusWindow: background === false,
        });

        console.log(`Activated existing Tab ID: ${existingTab.id}`);
        // Get updated tab information and return it
        const updatedTab = await chrome.tabs.get(existingTab.id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Activated existing tab',
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url || (updatedTab as any).pendingUrl || url,
              }),
            },
          ],
          isError: false,
        };
      }

      // 2. If URL is not already open, decide how to open it based on options
      let agentWindowPreference: string | undefined;
      try {
        const stored = await chrome.storage.local.get('agentWindowMode');
        agentWindowPreference = stored?.agentWindowMode;
      } catch {}

      const openInNewWindow =
        newWindow ||
        agentWindowPreference === 'window' ||
        typeof width === 'number' ||
        typeof height === 'number';

      if (openInNewWindow) {
        console.log('Opening URL in a new window.');

        // Create new window (default focused: false to never steal user focus)
        const newWindow = await chrome.windows.create({
          url: url,
          width: typeof width === 'number' ? width : DEFAULT_WINDOW_WIDTH,
          height: typeof height === 'number' ? height : DEFAULT_WINDOW_HEIGHT,
          focused: background === false,
        });

        if (newWindow && newWindow.id !== undefined) {
          console.log(`URL opened in new Window ID: ${newWindow.id}`);

          const firstTab = newWindow.tabs?.[0];
          if (firstTab?.id && sessionId) {
            sessionTabAffinity.setAffinity(sessionId, firstTab.id);
          }
          if (firstTab?.id) {
            if (args.autoGroup !== false) {
              await tabGroupManager
                .ensureAgentTabGroup(firstTab.id, {
                  title: args.groupTitle,
                  color: args.groupColor,
                  windowId: newWindow.id,
                })
                .catch(() => {});
            }
            await tabFaviconManager.setAgentFavicon(firstTab.id).catch(() => {});
            await this.waitForTabNavigationComplete(firstTab.id);
            if (args.dismissOverlays) {
              try {
                const dismissRes = await executeInPage(
                  { tabId: firstTab.id },
                  'inPageDismissOverlays',
                  [],
                );
                const count = dismissRes?.[0]?.result?.dismissedCount ?? 0;
                if (count > 0) {
                  await waitForPageSettle(firstTab.id, { timeoutMs: 500 }).catch(() => {});
                } else {
                  await new Promise((r) => setTimeout(r, 100));
                }
              } catch {}
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Opened URL in new window',
                  windowId: newWindow.id,
                  tabs: newWindow.tabs
                    ? newWindow.tabs.map((tab) => ({
                        tabId: tab.id,
                        url: tab.url || (tab as any).pendingUrl || url,
                      }))
                    : [],
                }),
              },
            ],
            isError: false,
          };
        }
      } else {
        console.log('Opening URL in the last active window.');
        // Try to open a new tab in the specified window, otherwise the most recently active window
        let targetWindow: chrome.windows.Window | null = null;
        if (typeof windowId === 'number') {
          targetWindow = await chrome.windows.get(windowId, { populate: false });
        }
        if (!targetWindow) {
          targetWindow = await chrome.windows.getLastFocused({ populate: false });
        }

        if (targetWindow && targetWindow.id !== undefined) {
          console.log(`Found target Window ID: ${targetWindow.id}`);

          const newTab = await chrome.tabs.create({
            url: url,
            windowId: targetWindow.id,
            active: background === false,
          });
          if (newTab.id) {
            if (args.autoGroup !== false) {
              await tabGroupManager
                .ensureAgentTabGroup(newTab.id, {
                  title: args.groupTitle,
                  color: args.groupColor,
                  windowId: targetWindow.id,
                })
                .catch(() => {});
            }
            await tabFaviconManager.setAgentFavicon(newTab.id).catch(() => {});
            await this.waitForTabNavigationComplete(newTab.id);
            if (args.dismissOverlays) {
              try {
                const dismissRes = await executeInPage(
                  { tabId: newTab.id },
                  'inPageDismissOverlays',
                  [],
                );
                const count = dismissRes?.[0]?.result?.dismissedCount ?? 0;
                if (count > 0) {
                  await waitForPageSettle(newTab.id, { timeoutMs: 500 }).catch(() => {});
                } else {
                  await new Promise((r) => setTimeout(r, 100));
                }
              } catch {}
            }
          }
          if (sessionId && newTab.id) {
            sessionTabAffinity.setAffinity(sessionId, newTab.id);
          }
          if (background === false) {
            await chrome.windows.update(targetWindow.id, { focused: true });
          }

          console.log(
            `URL opened in new Tab ID: ${newTab.id} in existing Window ID: ${targetWindow.id}`,
          );

          let resolvedTabUrl = newTab.url || (newTab as any).pendingUrl;
          if (!resolvedTabUrl && newTab.id !== undefined) {
            try {
              const freshTab = await chrome.tabs.get(newTab.id);
              resolvedTabUrl = freshTab?.url || freshTab?.pendingUrl;
            } catch {}
          }
          const finalUrl = resolvedTabUrl || url;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Opened URL in new tab in existing window',
                  tabId: newTab.id,
                  windowId: targetWindow.id,
                  url: finalUrl,
                }),
              },
            ],
            isError: false,
          };
        } else {
          // In rare cases, if there's no recently active window (e.g., browser just started with no windows)
          // Fall back to opening in a new window
          console.warn('No last focused window found, falling back to creating a new window.');

          const fallbackWindow = await chrome.windows.create({
            url: url,
            width: DEFAULT_WINDOW_WIDTH,
            height: DEFAULT_WINDOW_HEIGHT,
            focused: background === false,
          });

          if (fallbackWindow && fallbackWindow.id !== undefined) {
            console.log(`URL opened in fallback new Window ID: ${fallbackWindow.id}`);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'Opened URL in new window',
                    windowId: fallbackWindow.id,
                    tabs: fallbackWindow.tabs
                      ? fallbackWindow.tabs.map((tab) => ({
                          tabId: tab.id,
                          url: tab.url || (tab as any).pendingUrl || url,
                        }))
                      : [],
                  }),
                },
              ],
              isError: false,
            };
          }
        }
      }

      // If all attempts fail, return a generic error
      return createErrorResponse('Failed to open URL: Unknown error occurred');
    } catch (error) {
      if (chrome.runtime?.lastError) {
        console.error(`Chrome API Error: ${chrome.runtime.lastError.message}`, error);
        return createErrorResponse(`Chrome API Error: ${chrome.runtime.lastError.message}`);
      } else {
        console.error('Error in navigate:', error);
        return createErrorResponse(
          `Error navigating to URL: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
export const navigateTool = new NavigateTool();

interface CloseTabsToolParams {
  tabIds?: number[];
  tabId?: number;
  url?: string;
  confirm?: boolean;
  sessionId?: string;
  sessionContext?: string;
  allManagedGroups?: boolean;
}

/**
 * Tool for closing browser tabs
 */
class CloseTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLOSE_TABS;

  async execute(args: CloseTabsToolParams): Promise<ToolResult> {
    const rawTabIds = args.tabIds ?? (typeof args.tabId === 'number' ? [args.tabId] : undefined);
    const tabIds = Array.isArray(rawTabIds)
      ? rawTabIds
      : typeof rawTabIds === 'number'
        ? [rawTabIds]
        : undefined;
    const { url } = args;
    const sessionId = args.sessionId || args.sessionContext;
    let urlPattern = url;
    console.log(`Attempting to close tabs with options:`, args);

    try {
      if (args.allManagedGroups === true || (args as any).agentGroups === true) {
        const closedCount = await tabGroupManager.closeAllManagedGroups();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Closed all Agent managed tab groups (${closedCount} groups closed)`,
                closedCount,
              }),
            },
          ],
          isError: false,
        };
      }

      // If URL is provided, close all tabs matching that URL
      if (urlPattern) {
        console.log(`Searching for tabs with URL: ${url}`);
        const isIpOrPort = (uStr: string) => {
          try {
            const u = new URL(uStr);
            if (u.port && u.port !== '80' && u.port !== '443') return true;
            const h = u.hostname.toLowerCase();
            return (
              h === 'localhost' ||
              h === '127.0.0.1' ||
              /^(\d{1,3}\.){3}\d{1,3}$/.test(h) ||
              h.includes(':')
            );
          } catch {
            return false;
          }
        };

        let tabs: chrome.tabs.Tab[] = [];
        if (isIpOrPort(urlPattern) || urlPattern.startsWith('file://')) {
          const allTabs = await chrome.tabs.query({});
          try {
            const targetUrl = new URL(urlPattern);
            const targetHost = targetUrl.host.toLowerCase();
            const targetPath = targetUrl.pathname.replace(/\/+$/, '');
            tabs = allTabs.filter((t) => {
              if (!t.url) return false;
              try {
                const tu = new URL(t.url);
                if (tu.host.toLowerCase() !== targetHost) return false;
                if (!targetPath || targetPath === '') return true;
                const tuPath = tu.pathname.replace(/\/+$/, '');
                return tuPath.startsWith(targetPath) || targetPath.startsWith(tuPath);
              } catch {
                return false;
              }
            });
          } catch {
            tabs = allTabs.filter(
              (t) => t.url && (t.url === urlPattern || t.url.startsWith(urlPattern!)),
            );
          }
        } else {
          try {
            if (!urlPattern.includes('*')) {
              try {
                const u = new URL(urlPattern);
                const basePath = u.pathname || '/';
                urlPattern = `${u.protocol}//${u.host}${basePath}*`;
              } catch {
                urlPattern = urlPattern.endsWith('*') ? urlPattern : `${urlPattern}*`;
              }
            }
          } catch {
            if (!urlPattern.startsWith('file://')) {
              urlPattern = urlPattern.endsWith('*') ? urlPattern : `${urlPattern}*`;
            }
          }

          try {
            tabs = await chrome.tabs.query({ url: urlPattern });
          } catch {
            tabs = [];
          }

          if (!tabs || tabs.length === 0) {
            const allTabs = await chrome.tabs.query({});
            const cleanPattern = urlPattern.replace(/\*+$/, '');
            tabs = allTabs.filter((t) => {
              if (!t.url) return false;
              if (t.url === cleanPattern || t.url.startsWith(cleanPattern)) {
                return true;
              }
              try {
                const tu = new URL(t.url);
                const pu = new URL(cleanPattern);
                return (
                  tu.origin === pu.origin &&
                  (tu.pathname === pu.pathname || tu.pathname.startsWith(pu.pathname))
                );
              } catch {
                return false;
              }
            });
          }
        }

        if ((!tabs || tabs.length === 0) && urlPattern && urlPattern.startsWith('file://')) {
          const targetPattern = urlPattern;
          const allTabs = await chrome.tabs.query({});
          tabs = allTabs.filter(
            (t) =>
              t.url &&
              (t.url === targetPattern ||
                (targetPattern.endsWith('*') && t.url.startsWith(targetPattern.slice(0, -1)))),
          );
        }

        if (!tabs || tabs.length === 0) {
          console.log(`No tabs found with URL pattern: ${urlPattern}`);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: `No tabs found with URL pattern: ${urlPattern}`,
                  closedCount: 0,
                }),
              },
            ],
            isError: false,
          };
        }

        console.log(`Found ${tabs.length} tabs with URL pattern: ${urlPattern}`);
        const tabIdsToClose = tabs
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined);

        if (tabIdsToClose.length === 0) {
          return createErrorResponse('Found tabs but could not get their IDs');
        }

        for (const tid of tabIdsToClose) {
          await tabFaviconManager.restoreFavicon(tid).catch(() => {});
        }
        await chrome.tabs.remove(tabIdsToClose);
        await tabGroupManager.cleanupEmptyOrOrphanGroups().catch(() => {});

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Closed ${tabIdsToClose.length} tabs with URL: ${url}`,
                closedCount: tabIdsToClose.length,
                closedTabIds: tabIdsToClose,
              }),
            },
          ],
          isError: false,
        };
      }

      // If tabIds are provided, close those tabs
      if (tabIds && tabIds.length > 0) {
        console.log(`Closing tabs with IDs: ${tabIds.join(', ')}`);

        // Verify that all tabIds exist
        const existingTabs = await Promise.all(
          tabIds.map(async (tabId) => {
            try {
              return await chrome.tabs.get(tabId);
            } catch (error) {
              console.warn(`Tab with ID ${tabId} not found`);
              return null;
            }
          }),
        );

        const validTabIds = existingTabs
          .filter((tab): tab is chrome.tabs.Tab => tab !== null)
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined);

        if (validTabIds.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: 'None of the provided tab IDs exist',
                  closedCount: 0,
                }),
              },
            ],
            isError: false,
          };
        }

        for (const tid of validTabIds) {
          await tabFaviconManager.restoreFavicon(tid).catch(() => {});
        }
        await chrome.tabs.remove(validTabIds);
        await tabGroupManager.cleanupEmptyOrOrphanGroups().catch(() => {});

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Closed ${validTabIds.length} tabs`,
                closedCount: validTabIds.length,
                closedTabIds: validTabIds,
                invalidTabIds: tabIds.filter((id) => !validTabIds.includes(id)),
              }),
            },
          ],
          isError: false,
        };
      }

      // If no tabIds or URL provided, protect active tab against accidental closure
      // Require explicit confirmation (or explicit targets) in all cases.
      const affinityTab = sessionId ? await sessionTabAffinity.resolveSessionTab(sessionId) : null;
      let targetTabId = affinityTab?.id;
      if (args.confirm !== true) {
        // Session affinity is a routing hint, not user intent: a bare
        // close_tabs call previously destroyed the session-bound tab (often the
        // user's real page) with no confirmation at all.
        return createErrorResponse(
          'No tabIds or url specified. To close the current active tab, pass confirm: true or specify tabIds explicitly to prevent unintended tab destruction.',
        );
      }
      if (!targetTabId) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || !activeTab.id) {
          return createErrorResponse('No active tab found');
        }
        targetTabId = activeTab.id;
      }

      await tabFaviconManager.restoreFavicon(targetTabId).catch(() => {});
      await chrome.tabs.remove(targetTabId);
      if (sessionId && affinityTab?.id === targetTabId) {
        sessionTabAffinity.removeAffinity(sessionId);
      }
      await tabGroupManager.cleanupEmptyOrOrphanGroups().catch(() => {});

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Closed ${affinityTab ? 'session tab' : 'active tab'}`,
              closedCount: 1,
              closedTabIds: [targetTabId],
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in CloseTabsTool.execute:', error);
      return createErrorResponse(
        `Error closing tabs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const closeTabsTool = new CloseTabsTool();

interface SwitchTabToolParams {
  tabId: number;
  windowId?: number;
  background?: boolean;
  focusWindow?: boolean;
}

/**
 * Tool for switching the active tab
 */
class SwitchTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SWITCH_TAB;

  async execute(args: SwitchTabToolParams): Promise<ToolResult> {
    const { tabId, windowId } = args;

    console.log(`Attempting to switch to tab ID: ${tabId} in window ID: ${windowId}`);

    try {
      // Activation is the whole point of this tool: without it the call was a
      // no-op that still reported success, so agents could not tell that the
      // target tab was never brought forward (and CDP input kept going to the
      // previously active tab). Activate unless the caller explicitly opts out
      // with background: true.
      // Default is "activate": only an explicit background:true opts out.
      const keepBackground = args.background === true;
      if (!keepBackground) {
        await chrome.tabs.update(tabId, { active: true });
        // Only focus window if caller explicitly asked for it via focusWindow: true.
        // Never steal OS desktop focus by default.
        if (args.focusWindow === true) {
          const resolvedWindowId = windowId ?? (await chrome.tabs.get(tabId)).windowId;
          if (resolvedWindowId !== undefined) {
            try {
              const win = await chrome.windows.get(resolvedWindowId);
              if (win.state === 'minimized') {
                await chrome.windows.update(resolvedWindowId, {
                  state: 'maximized',
                  focused: true,
                });
              } else {
                await chrome.windows.update(resolvedWindowId, { focused: true });
              }
            } catch (focusErr) {
              console.warn('switch_tab: window focus failed (tab still activated):', focusErr);
            }
          }
        }
      }

      const updatedTab = await chrome.tabs.get(tabId);
      const sessionId = (args as any)?.sessionId || (args as any)?.sessionContext;
      if (sessionId && updatedTab?.id) {
        sessionTabAffinity.setAffinity(sessionId, updatedTab.id);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: keepBackground
                ? `Tab ID ${tabId} resolved (background: true, not activated)`
                : `Activated tab ID: ${tabId}`,
              tabId: updatedTab.id,
              windowId: updatedTab.windowId,
              url: updatedTab.url,
              activated: !keepBackground,
              active: updatedTab.active ?? false,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      if (chrome.runtime.lastError) {
        console.error(`Chrome API Error: ${chrome.runtime.lastError.message}`, error);
        return createErrorResponse(`Chrome API Error: ${chrome.runtime.lastError.message}`);
      } else {
        console.error('Error in SwitchTabTool.execute:', error);
        return createErrorResponse(
          `Error switching tab: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

export const switchTabTool = new SwitchTabTool();
