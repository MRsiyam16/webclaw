import { formatErrorForAgent, NativeMessageType } from 'chrome-mcp-shared';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { NATIVE_HOST, STORAGE_KEYS, ERROR_MESSAGES, SUCCESS_MESSAGES } from '@/common/constants';
import { handleCallTool } from './tools';
import { acquireKeepalive } from './keepalive-manager';

const LOG_PREFIX = '[NativeHost]';

let nativePort: chrome.runtime.Port | null = null;
export const HOST_NAME = NATIVE_HOST.NAME;

// ==================== Reconnect Configuration ====================

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_MAX_FAST_ATTEMPTS = 8;
const RECONNECT_COOLDOWN_DELAY_MS = 5 * 60_000;

// ==================== Auto-connect State ====================

let keepaliveRelease: (() => void) | null = null;
let autoConnectEnabled = true;
let autoConnectLoaded = false;
let ensurePromise: Promise<boolean> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let manualDisconnect = false;
let handshakeTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

function clearHandshakeTimer(): void {
  if (handshakeTimeoutTimer) {
    clearTimeout(handshakeTimeoutTimer);
    handshakeTimeoutTimer = null;
  }
}

async function verifyServerViaHttp(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return data.status === 'ok' && data.browserId === getBrowserId() && data.port === port;
    }
  } catch {
    // Ignore error
  }
  return false;
}

function getBrowserId(): 'chrome' | 'edge' {
  return /Edg\//.test(globalThis.navigator?.userAgent ?? '') ? 'edge' : 'chrome';
}

function getDefaultPort(): number {
  return getBrowserId() === 'edge' ? 12307 : NATIVE_HOST.DEFAULT_PORT;
}

/**
 * Server status management interface
 */
interface ServerStatus {
  isRunning: boolean;
  port?: number;
  browserId?: 'chrome' | 'edge';
  token?: string;
  lastUpdated: number;
}

let currentServerStatus: ServerStatus = {
  isRunning: false,
  lastUpdated: Date.now(),
};

/**
 * Save server status to chrome.storage
 */
async function saveServerStatus(status: ServerStatus): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.SERVER_STATUS]: status });
  } catch (error) {
    console.error(ERROR_MESSAGES.SERVER_STATUS_SAVE_FAILED, error);
  }
}

/**
 * Load server status from chrome.storage
 */
async function loadServerStatus(): Promise<ServerStatus> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.SERVER_STATUS]);
    if (result[STORAGE_KEYS.SERVER_STATUS]) {
      return result[STORAGE_KEYS.SERVER_STATUS];
    }
  } catch (error) {
    console.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, error);
  }
  return {
    isRunning: false,
    lastUpdated: Date.now(),
  };
}

/**
 * Broadcast server status change to all listeners
 */
function broadcastServerStatusChange(status: ServerStatus): void {
  chrome.runtime
    .sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED,
      payload: status,
    })
    .catch(() => {
      // Ignore errors if no listeners are present
    });
}

// ==================== Port Normalization ====================

/**
 * Normalize a port value to a valid port number or null.
 */
function normalizePort(value: unknown): number | null {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const port = Math.floor(n);
  if (port <= 0 || port > 65535) return null;
  return port;
}

// ==================== Reconnect Utilities ====================

/**
 * Add jitter to a delay value to avoid thundering herd.
 */
function withJitter(ms: number): number {
  const ratio = 0.7 + Math.random() * 0.6;
  return Math.max(0, Math.round(ms * ratio));
}

/**
 * Calculate reconnect delay based on attempt number.
 * Uses exponential backoff with jitter, then switches to cooldown interval.
 */
function getReconnectDelayMs(attempt: number): number {
  if (attempt >= RECONNECT_MAX_FAST_ATTEMPTS) {
    return withJitter(RECONNECT_COOLDOWN_DELAY_MS);
  }
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt), RECONNECT_MAX_DELAY_MS);
  return withJitter(delay);
}

/**
 * Clear the reconnect timer if active.
 */
function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/**
 * Reset reconnect state after successful connection.
 */
function resetReconnectState(): void {
  reconnectAttempts = 0;
  clearReconnectTimer();
}

// ==================== Keepalive Management ====================

/**
 * Sync keepalive hold based on autoConnectEnabled state.
 * When auto-connect is enabled, we hold a keepalive reference to keep SW alive.
 */
function syncKeepaliveHold(): void {
  if (autoConnectEnabled) {
    if (!keepaliveRelease) {
      keepaliveRelease = acquireKeepalive('native-host');
      console.debug(`${LOG_PREFIX} Acquired keepalive`);
    }
    return;
  }
  if (keepaliveRelease) {
    try {
      keepaliveRelease();
      console.debug(`${LOG_PREFIX} Released keepalive`);
    } catch {
      // Ignore
    }
    keepaliveRelease = null;
  }
}

// ==================== Auto-connect Settings ====================

/**
 * Load the nativeAutoConnectEnabled setting from storage.
 */
async function loadNativeAutoConnectEnabled(): Promise<boolean> {
  try {
    const rawResult = await Promise.resolve(
      chrome?.storage?.local?.get?.([STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED]),
    ).catch(() => ({}));
    const result: Record<string, any> = rawResult || {};
    const raw = result[STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED];
    if (typeof raw === 'boolean') return raw;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to load nativeAutoConnectEnabled`, error);
  }
  return true; // Default to enabled
}

/**
 * Set the nativeAutoConnectEnabled setting and persist to storage.
 */
async function setNativeAutoConnectEnabled(enabled: boolean): Promise<void> {
  autoConnectEnabled = enabled;
  autoConnectLoaded = true;
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED]: enabled });
    console.debug(`${LOG_PREFIX} Set nativeAutoConnectEnabled=${enabled}`);
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to persist nativeAutoConnectEnabled`, error);
  }
  syncKeepaliveHold();
}

// ==================== Port Preference ====================

/**
 * Get the preferred port for connecting to native server.
 * Priority: explicit override > user preference > last known port > default
 */
async function getPreferredPort(override?: unknown): Promise<number> {
  const explicit = normalizePort(override);
  if (explicit) return explicit;

  try {
    const rawResult = await Promise.resolve(
      chrome?.storage?.local?.get?.([STORAGE_KEYS.NATIVE_SERVER_PORT, STORAGE_KEYS.SERVER_STATUS]),
    ).catch(() => ({}));
    const result: Record<string, any> = rawResult || {};

    const userPort = normalizePort(result[STORAGE_KEYS.NATIVE_SERVER_PORT]);
    if (userPort && !(getBrowserId() === 'edge' && userPort === NATIVE_HOST.DEFAULT_PORT))
      return userPort;

    const status = result[STORAGE_KEYS.SERVER_STATUS] as Partial<ServerStatus> | undefined;
    const statusPort = normalizePort(status?.port);
    if (statusPort && !(getBrowserId() === 'edge' && statusPort === NATIVE_HOST.DEFAULT_PORT))
      return statusPort;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to read preferred port`, error);
  }

  const inMemoryPort = normalizePort(currentServerStatus.port);
  if (inMemoryPort && !(getBrowserId() === 'edge' && inMemoryPort === NATIVE_HOST.DEFAULT_PORT))
    return inMemoryPort;

  return getDefaultPort();
}

// ==================== Reconnect Scheduling ====================

/**
 * Schedule a reconnect attempt with exponential backoff.
 */
function scheduleReconnect(reason: string): void {
  if (nativePort) return;
  if (manualDisconnect) return;
  if (!autoConnectEnabled) return;
  if (reconnectTimer) return;

  const delay = getReconnectDelayMs(reconnectAttempts);
  console.debug(
    `${LOG_PREFIX} Reconnect scheduled in ${delay}ms (attempt=${reconnectAttempts}, reason=${reason})`,
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (nativePort) return;
    if (manualDisconnect || !autoConnectEnabled) return;

    reconnectAttempts += 1;
    void ensureNativeConnected(`reconnect:${reason}`).catch(() => {});
  }, delay);
}

// ==================== Server Status Update ====================

/**
 * Mark server as stopped and broadcast the change.
 */
async function markServerStopped(reason: string): Promise<void> {
  currentServerStatus = {
    isRunning: false,
    port: currentServerStatus.port,
    lastUpdated: Date.now(),
  };
  try {
    await saveServerStatus(currentServerStatus);
  } catch {
    // Ignore
  }
  broadcastServerStatusChange(currentServerStatus);
  console.debug(`${LOG_PREFIX} Server marked stopped (${reason})`);
}

// ==================== Core Ensure Function ====================

/**
 * Ensure native connection is established.
 * This is the main entry point for auto-connect logic.
 *
 * @param trigger - Description of what triggered this call (for logging)
 * @param portOverride - Optional explicit port to use
 * @returns Whether the connection is now established
 */
export async function ensureNativeConnected(
  trigger: string,
  portOverride?: unknown,
): Promise<boolean> {
  // Concurrency protection: only one ensure flow at a time
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    // Load auto-connect setting if not yet loaded
    if (!autoConnectLoaded) {
      autoConnectEnabled = await loadNativeAutoConnectEnabled();
      autoConnectLoaded = true;
      syncKeepaliveHold();
    }

    // If auto-connect is disabled, do nothing
    if (!autoConnectEnabled) {
      console.debug(`${LOG_PREFIX} Auto-connect disabled, skipping ensure (trigger=${trigger})`);
      return false;
    }

    // Sync keepalive hold
    syncKeepaliveHold();

    // Already connected
    if (nativePort) {
      console.debug(`${LOG_PREFIX} Already connected (trigger=${trigger})`);
      return true;
    }

    // Get the port to use
    const port = await getPreferredPort(portOverride);
    console.debug(`${LOG_PREFIX} Attempting connection on port ${port} (trigger=${trigger})`);

    // Attempt connection
    const ok = connectNativeHost(port);
    if (!ok) {
      console.warn(`${LOG_PREFIX} Connection failed (trigger=${trigger})`);
      scheduleReconnect(`connect_failed:${trigger}`);
      return false;
    }

    console.debug(`${LOG_PREFIX} Connection initiated successfully (trigger=${trigger})`);
    // Note: Don't reset reconnect state here. Wait for SERVER_STARTED confirmation.
    // Chrome may return a Port but disconnect immediately if native host is missing.
    return true;
  })().finally(() => {
    ensurePromise = null;
  });

  return ensurePromise;
}

import {
  safePostMessage,
  MAX_NATIVE_MESSAGE_BYTES,
  ChunkReassembler,
} from '@/utils/safe-post-message';
export { safePostMessage, MAX_NATIVE_MESSAGE_BYTES, ChunkReassembler };

export type FileOperationResponseCallback = (response: any) => void;
const fileOperationCallbacks = new Map<string, FileOperationResponseCallback>();

export function sendFileOperationToNative(
  message: { type: string; requestId: string; payload: any },
  callback?: FileOperationResponseCallback,
): boolean {
  if (!nativePort) return false;
  if (callback && message.requestId) {
    fileOperationCallbacks.set(message.requestId, callback);
  }
  const posted = safePostMessage(nativePort, message);
  if (!posted && callback && message.requestId) {
    fileOperationCallbacks.delete(message.requestId);
  }
  return posted;
}

export function cancelFileOperation(requestId: string): void {
  fileOperationCallbacks.delete(requestId);
}

/**
 * Sends a Jev semantic matching request to Native Server with timeout and fallback.
 */
export async function sendJevMatchToNative(
  payload: any,
  timeoutMs = 1500,
): Promise<{
  success: boolean;
  matchedId?: string | number;
  confidence?: number;
  engine?: string;
} | null> {
  if (!nativePort) {
    const connected = await ensureNativeConnected('jev_match').catch(() => false);
    if (!connected || !nativePort) return null;
  }
  const requestId = `jev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      fileOperationCallbacks.delete(requestId);
      resolve(null);
    }, timeoutMs);

    const ok = sendFileOperationToNative(
      {
        type: 'jev_semantic_match',
        requestId,
        payload,
      },
      (response: any) => {
        clearTimeout(timer);
        if (response?.payload?.success) {
          resolve(response.payload);
        } else {
          resolve(null);
        }
      },
    );

    if (!ok) {
      clearTimeout(timer);
      fileOperationCallbacks.delete(requestId);
      resolve(null);
    }
  });
}

/**
 * Connect to the native messaging host
 * @returns Whether the connection was initiated successfully
 */
export function connectNativeHost(port: number = NATIVE_HOST.DEFAULT_PORT): boolean {
  if (nativePort) {
    return true;
  }

  if (typeof chrome === 'undefined' || typeof chrome.runtime?.connectNative !== 'function') {
    return false;
  }

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
    const chunkReassembler = new ChunkReassembler();

    nativePort.onMessage.addListener(async (rawMessage) => {
      const handleMessage = async (message: any) => {
        if (!message) return;
        if (message.type === NativeMessageType.PROCESS_DATA && message.requestId) {
          const requestId = message.requestId;
          const requestPayload = message.payload;

          safePostMessage(nativePort, {
            responseToRequestId: requestId,
            payload: {
              status: 'success',
              message: SUCCESS_MESSAGES.TOOL_EXECUTED,
              data: requestPayload,
            },
          });
        } else if (message.type === NativeMessageType.CALL_TOOL && message.requestId) {
          const requestId = message.requestId;
          try {
            const result = await handleCallTool(message.payload);
            safePostMessage(
              nativePort,
              {
                responseToRequestId: requestId,
                payload: {
                  status: 'success',
                  message: SUCCESS_MESSAGES.TOOL_EXECUTED,
                  data: result,
                },
              },
              requestId,
            );
          } catch (error) {
            safePostMessage(nativePort, {
              responseToRequestId: requestId,
              payload: {
                status: 'error',
                message: ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
                error: formatErrorForAgent(error),
              },
            });
          }
        } else if (message.type === 'set_agent_control') {
          const raw = message.payload?.enabled;
          const enabled = raw === true || raw === 'true' || raw === 1 || raw === '1';
          await chrome.storage.session.set({ agentControlEnabled: enabled });
          if (message.requestId) {
            safePostMessage(nativePort, {
              responseToRequestId: message.requestId,
              payload: { status: 'success', agentControlEnabled: enabled },
            });
          }
        } else if (message.type === 'get_agent_control') {
          const session = await chrome.storage.session.get('agentControlEnabled');
          const enabled = session.agentControlEnabled !== false;
          if (message.requestId) {
            safePostMessage(nativePort, {
              responseToRequestId: message.requestId,
              payload: { status: 'success', agentControlEnabled: enabled },
            });
          }
        } else if (message.type === 'reload_extension') {
          if (message.requestId) {
            safePostMessage(nativePort, {
              responseToRequestId: message.requestId,
              payload: { status: 'success', message: 'Reloading extension' },
            });
          }
          setTimeout(() => {
            chrome.runtime.reload();
          }, 100);
        } else if (message.type === NativeMessageType.SERVER_STARTED) {
          clearHandshakeTimer();
          const port = message.payload?.port;
          const browserId = message.payload?.browserId;
          const token = message.payload?.token;
          if (browserId !== getBrowserId() || port !== getDefaultPort()) {
            console.warn(
              `${LOG_PREFIX} Ignoring mismatched native handshake browser=${browserId} port=${port}`,
            );
            nativePort?.disconnect();
            nativePort = null;
            void markServerStopped('browser_identity_mismatch');
            return;
          }
          currentServerStatus = {
            isRunning: true,
            port: port,
            browserId,
            token: token || currentServerStatus.token,
            lastUpdated: Date.now(),
          };
          await saveServerStatus(currentServerStatus);
          broadcastServerStatusChange(currentServerStatus);
          // Server is confirmed running - now we can reset reconnect state
          resetReconnectState();
          console.log(`${SUCCESS_MESSAGES.SERVER_STARTED} on port ${port}`);
        } else if (message.type === 'server_info_response') {
          if (message.payload) {
            if (
              message.payload.browserId !== getBrowserId() ||
              message.payload.port !== getDefaultPort()
            ) {
              return;
            }
            currentServerStatus = {
              isRunning: message.payload.isRunning ?? currentServerStatus.isRunning,
              port: message.payload.port ?? currentServerStatus.port,
              browserId: message.payload.browserId,
              token: message.payload.token ?? currentServerStatus.token,
              lastUpdated: Date.now(),
            };
            await saveServerStatus(currentServerStatus);
            broadcastServerStatusChange(currentServerStatus);
          }
        } else if (message.type === NativeMessageType.SERVER_STOPPED) {
          clearHandshakeTimer();
          currentServerStatus = {
            isRunning: false,
            port: currentServerStatus.port, // Keep last known port for reconnection
            lastUpdated: Date.now(),
          };
          await saveServerStatus(currentServerStatus);
          broadcastServerStatusChange(currentServerStatus);
          console.log(SUCCESS_MESSAGES.SERVER_STOPPED);
        } else if (
          message.type === NativeMessageType.ERROR_FROM_NATIVE_HOST ||
          message.type === NativeMessageType.ERROR
        ) {
          const errorMsg = message.payload?.message || message.payload || message.error || '';
          const isBenign =
            typeof errorMsg === 'string' &&
            (errorMsg.includes('already running') || errorMsg.includes('EADDRINUSE'));
          if (isBenign) {
            console.log('[NativeHost] Server notice (already running / active):', errorMsg);
          } else {
            console.error('Error from native host:', errorMsg);
          }
          // If error indicates already running or port occupied, self-heal via HTTP /ping probe immediately
          if (isBenign) {
            const targetPort = port || currentServerStatus.port || NATIVE_HOST.DEFAULT_PORT;
            verifyServerViaHttp(targetPort).then(async (isAlive) => {
              if (isAlive) {
                clearHandshakeTimer();
                currentServerStatus = {
                  isRunning: true,
                  port: targetPort,
                  lastUpdated: Date.now(),
                };
                await saveServerStatus(currentServerStatus);
                broadcastServerStatusChange(currentServerStatus);
                resetReconnectState();
                console.log(
                  `${LOG_PREFIX} Self-healed existing running server via HTTP /ping on port ${targetPort}`,
                );
              }
            });
          }
        } else if (message.type === 'file_operation_response') {
          const reqId = message.responseToRequestId;
          if (reqId && fileOperationCallbacks.has(reqId)) {
            const cb = fileOperationCallbacks.get(reqId)!;
            fileOperationCallbacks.delete(reqId);
            try {
              cb(message);
            } catch (e) {
              console.error('[NativeHost] Error in file operation callback:', e);
            }
          }
          // Forward file operation response back to the requesting tool (compat fallback)
          chrome.runtime.sendMessage(message).catch(() => {
            // Ignore if no listeners
          });
        }
      };

      if (
        chunkReassembler.processMessage(rawMessage, (fullMessage) => {
          void handleMessage(fullMessage);
        })
      ) {
        return;
      }
      await handleMessage(rawMessage);
    });

    nativePort.onDisconnect.addListener(() => {
      clearHandshakeTimer();
      console.warn(ERROR_MESSAGES.NATIVE_DISCONNECTED, chrome.runtime.lastError);
      nativePort = null;

      // Fail and clean up all pending file operations immediately
      for (const [reqId, cb] of fileOperationCallbacks.entries()) {
        try {
          cb({
            type: 'file_operation_response',
            responseToRequestId: reqId,
            payload: { success: false, error: 'Native host disconnected' },
          });
        } catch {}
      }
      fileOperationCallbacks.clear();

      // Mark server as stopped since native host disconnection means server is down
      void markServerStopped('native_port_disconnected');

      // Handle reconnection based on disconnect reason
      if (manualDisconnect) {
        manualDisconnect = false;
        return;
      }
      if (!autoConnectEnabled) return;
      scheduleReconnect('native_port_disconnected');
    });

    clearHandshakeTimer();
    safePostMessage(nativePort, { type: NativeMessageType.START, payload: { port } });

    // Self-healing handshake watchdog: If SERVER_STARTED is not received within 2s, verify via /ping
    handshakeTimeoutTimer = setTimeout(async () => {
      if (!currentServerStatus.isRunning && nativePort) {
        console.warn(
          `${LOG_PREFIX} Handshake timeout waiting for SERVER_STARTED on port ${port}, probing /ping...`,
        );
        const isAlive = await verifyServerViaHttp(port);
        if (isAlive) {
          currentServerStatus = {
            isRunning: true,
            port,
            lastUpdated: Date.now(),
          };
          await saveServerStatus(currentServerStatus);
          broadcastServerStatusChange(currentServerStatus);
          resetReconnectState();
          console.log(
            `${LOG_PREFIX} Successfully self-healed connection status via HTTP /ping on port ${port}`,
          );
        } else {
          // Re-send start message once before disconnecting
          safePostMessage(nativePort, { type: NativeMessageType.START, payload: { port } });
        }
      }
    }, 2000);
    // Note: Don't reset reconnect state here. Wait for SERVER_STARTED confirmation.
    // Chrome may return a Port but disconnect immediately if native host is missing.
    return true;
  } catch (error) {
    console.warn(ERROR_MESSAGES.NATIVE_CONNECTION_FAILED, error);
    nativePort = null;
    return false;
  }
}

/**
 * Initialize native host listeners and load initial state
 */
export const initNativeHostListener = () => {
  // Initialize server status from storage
  loadServerStatus()
    .then((status) => {
      currentServerStatus = status;
    })
    .catch((error) => {
      console.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, error);
    });

  // Auto-connect on SW activation (covers SW restart after idle termination)
  void ensureNativeConnected('sw_startup').catch(() => {});

  // Auto-connect on Chrome browser startup
  chrome.runtime.onStartup.addListener(() => {
    void ensureNativeConnected('onStartup').catch(() => {});
  });

  // Auto-connect on extension install/update
  chrome.runtime.onInstalled.addListener(() => {
    void ensureNativeConnected('onInstalled').catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Validate sender: strictly reject messages from content scripts (which have _sender.tab) or external extensions
    if (_sender.id !== chrome.runtime.id || _sender.tab) {
      return false;
    }

    // Allow UI to call tools directly
    if (message && message.type === 'call_tool' && message.name) {
      handleCallTool({ name: message.name, args: message.args, sessionId: message.sessionId })
        .then((res) => sendResponse({ success: true, result: res }))
        .catch((err) =>
          sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return true;
    }

    const msgType = typeof message === 'string' ? message : message?.type;

    // ENSURE_NATIVE: Trigger ensure without changing autoConnectEnabled
    if (msgType === NativeMessageType.ENSURE_NATIVE) {
      const portOverride = typeof message === 'object' ? message.port : undefined;
      ensureNativeConnected('ui_ensure', portOverride)
        .then((connected) => {
          sendResponse({ success: true, connected, autoConnectEnabled });
        })
        .catch((e) => {
          sendResponse({ success: false, connected: nativePort !== null, error: String(e) });
        });
      return true;
    }

    // CONNECT_NATIVE: Explicit user connect, re-enables auto-connect
    if (msgType === NativeMessageType.CONNECT_NATIVE) {
      const portOverride = typeof message === 'object' ? message.port : undefined;
      const normalized = normalizePort(portOverride);

      (async () => {
        // Explicit user connect: re-enable auto-connect
        await setNativeAutoConnectEnabled(true);

        if (normalized) {
          // Best-effort: persist preferred port
          try {
            await chrome.storage.local.set({ [STORAGE_KEYS.NATIVE_SERVER_PORT]: normalized });
          } catch {
            // Ignore
          }
        }

        return ensureNativeConnected('ui_connect', normalized ?? undefined);
      })()
        .then((connected) => {
          sendResponse({ success: true, connected });
        })
        .catch((e) => {
          sendResponse({ success: false, connected: nativePort !== null, error: String(e) });
        });
      return true;
    }

    if (msgType === NativeMessageType.PING_NATIVE) {
      const connected = nativePort !== null;
      sendResponse({ connected, autoConnectEnabled });
      return true;
    }

    // DISCONNECT_NATIVE: Explicit user disconnect, disables auto-connect
    if (msgType === NativeMessageType.DISCONNECT_NATIVE) {
      (async () => {
        // Explicit user disconnect: disable auto-connect and stop reconnect loop
        await setNativeAutoConnectEnabled(false);
        clearReconnectTimer();
        reconnectAttempts = 0;
        syncKeepaliveHold();

        if (nativePort) {
          // Only set manualDisconnect if we actually have a port to disconnect.
          // This prevents the flag from persisting when there's no active connection.
          manualDisconnect = true;
          try {
            nativePort.disconnect();
          } catch {
            // Ignore
          }
          nativePort = null;
        }
        await markServerStopped('manual_disconnect');
      })()
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((e) => {
          sendResponse({ success: false, error: String(e) });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS) {
      sendResponse({
        success: true,
        serverStatus: currentServerStatus,
        connected: nativePort !== null,
      });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.REFRESH_SERVER_STATUS) {
      loadServerStatus()
        .then(async (storedStatus) => {
          currentServerStatus = storedStatus;
          if (!currentServerStatus.isRunning && nativePort) {
            const probePort = currentServerStatus.port || NATIVE_HOST.DEFAULT_PORT;
            const isAlive = await verifyServerViaHttp(probePort);
            if (isAlive) {
              currentServerStatus = {
                isRunning: true,
                port: probePort,
                lastUpdated: Date.now(),
              };
              await saveServerStatus(currentServerStatus);
              broadcastServerStatusChange(currentServerStatus);
            }
          }
          sendResponse({
            success: true,
            serverStatus: currentServerStatus,
            connected: nativePort !== null,
          });
        })
        .catch((error) => {
          console.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, error);
          sendResponse({
            success: false,
            error: ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED,
            serverStatus: currentServerStatus,
            connected: nativePort !== null,
          });
        });
      return true;
    }

    // Forward file operation messages to native host
    if (message.type === 'forward_to_native' && message.message) {
      if (nativePort) {
        safePostMessage(nativePort, message.message);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Native host not connected' });
      }
      return true;
    }
  });
};
