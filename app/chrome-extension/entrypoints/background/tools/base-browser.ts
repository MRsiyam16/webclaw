import { resolveToolName } from 'chrome-mcp-shared';
import { ToolExecutor } from '../../../common/tool-handler';
import type { ToolResult } from '../../../common/tool-handler';
import { TIMEOUTS, ERROR_MESSAGES } from '../../../common/constants';
import { sessionTabAffinity } from '../../../utils/session-tab-affinity';
import {
  assertTabInjectable,
  isRestrictedChromeUrl,
  pingActionForFiles,
  restrictedUrlErrorMessage,
} from '../../../utils/restricted-url';

const PING_TIMEOUT_MS = 300;
// executeScript can hang forever when the renderer is blocked (native dialog,
// crashed renderer). Without a timeout the tool call deadlocks until the
// native-host 120s kill, which the agent cannot interpret.
const INJECTION_TIMEOUT_MS = 15_000;

const injectedScriptsCache = new Map<number, Set<string>>();

if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' || changeInfo.url) {
      injectedScriptsCache.delete(tabId);
    }
  });
  chrome.tabs.onRemoved?.addListener((tabId) => {
    injectedScriptsCache.delete(tabId);
  });
}

async function raceInjection<T>(p: Promise<T>, ms = INJECTION_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `executeScript timeout: renderer not acking - a native dialog may be open, call ${resolveToolName('handle_dialog')} first`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Base class for browser tool executors
 */
export abstract class BaseBrowserToolExecutor implements ToolExecutor {
  abstract name: string;
  abstract execute(args: any): Promise<ToolResult>;

  /**
   * chrome.scripting.executeScript wrapper that rejects browser internal /
   * web store pages first, so callers get the friendly error instead of the
   * raw "Cannot access a chrome:// URL" exception.
   */
  protected async safeExecuteScript<Args extends any[] = any[], Result = any>(
    tabId: number,
    injection: chrome.scripting.ScriptInjection<Args, Result>,
  ) {
    await assertTabInjectable(tabId);
    if ('args' in injection && Array.isArray((injection as any).args)) {
      (injection as any).args = (injection as any).args.map((a: any) =>
        a === undefined ? null : a,
      );
    }
    return chrome.scripting.executeScript(injection);
  }

  /**
   * Inject content script into tab
   */
  protected async injectContentScript(
    tabId: number,
    files: string[],
    injectImmediately = false,
    world: 'MAIN' | 'ISOLATED' = 'ISOLATED',
    allFrames: boolean = false,
    frameIds?: number[],
  ): Promise<void> {
    console.log(`Injecting ${files.join(', ')} into tab ${tabId}`);

    // Reject browser internal / web store pages up front. Without this, the
    // ping + executeScript both throw "Cannot access a chrome:// URL" and the
    // error panel shows a raw exception preceded by a spurious
    // "ping content script failed" line (see interaction.ts click path).
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (isRestrictedChromeUrl(tab?.url)) {
      throw new Error(restrictedUrlErrorMessage(tab?.url));
    }

    const frameKey =
      frameIds && frameIds.length > 0
        ? frameIds.slice().sort().join(':')
        : allFrames
          ? 'all'
          : 'main';
    const cacheKey = `${files.join(',')}|${world}|${frameKey}`;
    const cachedSet = injectedScriptsCache.get(tabId);
    if (!injectImmediately && cachedSet?.has(cacheKey)) {
      return;
    }

    // check if script is already injected
    try {
      const pingAction = pingActionForFiles(files);
      const pingFrameId = frameIds?.[0];
      let pingTimeoutId: ReturnType<typeof setTimeout> | undefined;
      let response: any;
      try {
        const pingPromise =
          typeof pingFrameId === 'number'
            ? chrome.tabs.sendMessage(tabId, { action: pingAction }, { frameId: pingFrameId })
            : chrome.tabs.sendMessage(tabId, { action: pingAction });

        const timeoutPromise = new Promise((_, reject) => {
          pingTimeoutId = setTimeout(
            () => reject(new Error(`${pingAction} Ping action to tab ${tabId} timed out`)),
            PING_TIMEOUT_MS,
          );
        });

        response = await Promise.race([pingPromise, timeoutPromise]);
      } finally {
        if (pingTimeoutId !== undefined) {
          clearTimeout(pingTimeoutId);
        }
      }

      if (response && response.status === 'pong') {
        console.log(
          `pong received for action '${pingAction}' in tab ${tabId}. Assuming script is active.`,
        );
        let set = injectedScriptsCache.get(tabId);
        if (!set) {
          set = new Set();
          injectedScriptsCache.set(tabId, set);
        }
        set.add(cacheKey);
        return;
      } else {
        console.warn(`Unexpected ping response in tab ${tabId}:`, response);
      }
    } catch (error) {
      console.error(
        `ping content script failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const target: { tabId: number; allFrames?: boolean; frameIds?: number[] } = { tabId };
      if (frameIds && frameIds.length > 0) {
        target.frameIds = frameIds;
      } else if (allFrames) {
        target.allFrames = true;
      }
      await raceInjection(
        chrome.scripting.executeScript({
          target,
          files,
          injectImmediately,
          world,
        } as any),
      );
      console.log(`'${files.join(', ')}' injection successful for tab ${tabId}`);
      let set = injectedScriptsCache.get(tabId);
      if (!set) {
        set = new Set();
        injectedScriptsCache.set(tabId, set);
      }
      set.add(cacheKey);
    } catch (injectionError) {
      const errorMessage =
        injectionError instanceof Error ? injectionError.message : String(injectionError);
      console.error(
        `Content script '${files.join(', ')}' injection failed for tab ${tabId}: ${errorMessage}`,
      );
      throw new Error(
        `${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: Failed to inject content script in tab ${tabId}: ${errorMessage}`,
      );
    }
  }

  /**
   * Send message to tab
   */
  protected async sendMessageToTab(tabId: number, message: any, frameId?: number): Promise<any> {
    try {
      // ponytail: never await before the race — a dead/crashed frame would
      // otherwise suspend here forever and the 5s guard below never fires.
      const send =
        typeof frameId === 'number'
          ? chrome.tabs.sendMessage(tabId, message, { frameId })
          : chrome.tabs.sendMessage(tabId, message);
      const response = await Promise.race([
        Promise.resolve(send),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  'TABS_MESSAGE_TIMEOUT: ' +
                    (message?.action || 'unknown') +
                    ' got no response in tab ' +
                    tabId,
                ),
              ),
            5000,
          ),
        ),
      ]);

      if (response && response.error) {
        throw new Error(String(response.error));
      }

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `Error sending message to tab ${tabId} for action ${message?.action || 'unknown'}: ${errorMessage}`,
      );

      if (error instanceof Error) {
        throw error;
      }
      throw new Error(errorMessage);
    }
  }

  /**
   * Try to get an existing tab by id. Returns null when not found.
   */
  protected async tryGetTab(tabId?: number, sessionId?: string): Promise<chrome.tabs.Tab | null> {
    if (typeof tabId !== 'number') return null;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.id && sessionId) {
        sessionTabAffinity.setAffinity(sessionId, tab.id);
      }
      return tab;
    } catch {
      return null;
    }
  }

  /**
   * Get the active tab in the current window. Throws when not found.
   */
  protected async getActiveTabOrThrow(): Promise<chrome.tabs.Tab> {
    const active = await this.getActiveTabInWindow();
    if (!active || !active.id) throw new Error('Active tab not found');
    return active;
  }

  /**
   * Optionally focus window and/or activate tab. Defaults preserve current behavior
   * when caller sets activate/focus flags explicitly.
   */
  protected async ensureFocus(
    tab: chrome.tabs.Tab,
    options: { activate?: boolean; focusWindow?: boolean } = {},
  ): Promise<void> {
    const activate = options.activate === true;
    const focusWindow = options.focusWindow === true;
    if (focusWindow && typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    if (activate && typeof tab.id === 'number') {
      await chrome.tabs.update(tab.id, { active: true });
    }
  }

  /**
   * Get the active tab. When windowId provided, search within that window; otherwise currentWindow.
   */
  protected async getActiveTabInWindow(windowId?: number): Promise<chrome.tabs.Tab | null> {
    if (typeof windowId === 'number') {
      const tabs = await chrome.tabs.query({ active: true, windowId });
      return tabs && tabs[0] ? tabs[0] : null;
    }
    let [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!active || !active.id) {
      [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    if (!active || !active.id) {
      [active] = await chrome.tabs.query({ active: true });
    }
    return active && active.id ? active : null;
  }

  /**
   * Same as getActiveTabInWindow, but throws if not found.
   * If sessionId provided, checks session tab affinity first.
   */
  protected async getActiveTabOrThrowInWindow(
    windowId?: number,
    sessionId?: string,
  ): Promise<chrome.tabs.Tab> {
    if (sessionId) {
      const affinityTab = await sessionTabAffinity.resolveSessionTab(sessionId);
      if (affinityTab && affinityTab.id) {
        return affinityTab;
      }
    }
    const tab = await this.getActiveTabInWindow(windowId);
    if (!tab || !tab.id) throw new Error('Active tab not found');
    if (sessionId && tab.id) {
      sessionTabAffinity.setAffinity(sessionId, tab.id);
    }
    return tab;
  }

  /**
   * Resolve target tab with Session Tab Affinity support.
   * 1. If explicit tabId provided and exists: binds session affinity and returns tab.
   * 2. If sessionId / sessionContext provided and has an active bound tab: returns bound tab.
   * 3. Falls back to active tab in window/currentWindow, and binds it to sessionId if present.
   */
  protected async resolveAffinityTab(options?: {
    tabId?: number;
    windowId?: number;
    sessionId?: string;
    sessionContext?: string;
  }): Promise<chrome.tabs.Tab> {
    const sessionId = options?.sessionId || options?.sessionContext;

    if (typeof options?.tabId === 'number') {
      const tab = await this.tryGetTab(options.tabId, sessionId);
      if (tab && tab.id) {
        return tab;
      }
      // SECURITY/SAFETY: an explicit tabId that does not resolve must never be
      // silently substituted with a different tab. Doing so let tools act on
      // (or close) an unrelated tab while reporting success for the requested
      // one. Fail loudly instead so the caller re-reads the tab list.
      throw new Error(
        `Tab ${options.tabId} does not exist. Refusing to fall back to another tab — ` +
          `call get_windows_and_tabs to refresh tab IDs, or omit tabId to target the active tab.`,
      );
    }

    if (sessionId) {
      const affinityTab = await sessionTabAffinity.resolveSessionTab(sessionId);
      if (affinityTab && affinityTab.id) {
        return affinityTab;
      }
    }

    const fallbackTab = await this.getActiveTabOrThrowInWindow(options?.windowId, sessionId);
    return fallbackTab;
  }
}
