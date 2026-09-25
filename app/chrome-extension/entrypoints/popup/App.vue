<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

import { CURRENT_VERSION } from 'chrome-mcp-shared';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { isPopupConnectionHealthy } from './connection-status';
import { checkExtensionVersionUpdate } from '@/utils/version-checker';

const agentEnabled = ref(true);
const serverConnected = ref(false);
const browserId = /Edg\//.test(globalThis.navigator?.userAgent ?? '') ? 'edge' : 'chrome';
const serverPort = browserId === 'edge' ? 12307 : 12306;
const cursorMode = ref<'off' | 'auto' | 'always'>('always');
const windowMode = ref<'tab' | 'window'>('tab');
const currentVersion = ref(CURRENT_VERSION);
const versionChecked = ref(false);
const hasUpdate = ref(false);
const latestReleaseUrl = ref('https://github.com/GoldenLoaf24h/browserclaw/releases/latest');

const openRelease = (url?: string) => {
  const target = url || latestReleaseUrl.value;
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    chrome.tabs.create({ url: target });
  } else if (typeof window !== 'undefined') {
    window.open(target, '_blank', 'noopener,noreferrer');
  }
};

const windowModeLabel = computed(() => {
  return windowMode.value === 'window' ? 'Window' : 'Tab';
});

const cursorModeLabel = computed(() => {
  if (cursorMode.value === 'off') return 'Off';
  if (cursorMode.value === 'auto') return 'Auto';
  return 'Always';
});

const setCursorMode = async (mode: 'off' | 'auto' | 'always') => {
  cursorMode.value = mode;
  try {
    await chrome.storage.local.set({ agentCursorMode: mode });
  } catch (e) {
    console.error('Failed to save cursor mode:', e);
  }
};

const setWindowMode = async (mode: 'tab' | 'window') => {
  windowMode.value = mode;
  try {
    await chrome.storage.local.set({ agentWindowMode: mode });
  } catch (e) {
    console.error('Failed to save window mode:', e);
  }
};

const checkServerStatus = async () => {
  try {
    const backgroundStatus = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`http://127.0.0.1:${serverPort}/ping`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json().catch(() => null);
    serverConnected.value = isPopupConnectionHealthy(
      backgroundStatus,
      { ...data, ok: res.ok },
      browserId,
      serverPort,
    );
  } catch {
    serverConnected.value = false;
  }
};

const toggleAgent = async () => {
  agentEnabled.value = !agentEnabled.value;
  try {
    await chrome.storage.session.set({ agentControlEnabled: agentEnabled.value });
  } catch (e) {
    console.error('Failed to save agent control state:', e);
  }
};

onMounted(async () => {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('enable') === '1') {
    try {
      await chrome.storage.session.set({ agentControlEnabled: true });
    } catch {}
  }
  if (urlParams.get('reload') === '1') {
    setTimeout(() => {
      try {
        chrome.runtime.reload();
      } catch {}
    }, 100);
  }

  try {
    const session = await chrome.storage.session.get('agentControlEnabled');
    agentEnabled.value = session.agentControlEnabled !== false;
  } catch {
    agentEnabled.value = true;
  }

  try {
    const local = await chrome.storage.local.get('agentCursorMode');
    if (local.agentCursorMode) {
      cursorMode.value = local.agentCursorMode;
    } else {
      cursorMode.value = 'always';
      await chrome.storage.local.set({ agentCursorMode: 'always' });
    }
  } catch {
    cursorMode.value = 'always';
  }

  try {
    const localWin = await chrome.storage.local.get('agentWindowMode');
    if (localWin.agentWindowMode) {
      windowMode.value = localWin.agentWindowMode;
    } else {
      windowMode.value = 'tab';
    }
  } catch {
    windowMode.value = 'tab';
  }

  await checkServerStatus();

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      const manifest = chrome.runtime.getManifest();
      if (manifest?.version) {
        currentVersion.value = manifest.version;
      }
    }
  } catch {}

  checkExtensionVersionUpdate()
    .then((res) => {
      versionChecked.value = true;
      hasUpdate.value = res.hasUpdate;
      if (res.releaseUrl) {
        latestReleaseUrl.value = res.releaseUrl;
      }
    })
    .catch(() => {
      versionChecked.value = true;
      hasUpdate.value = false;
    });
});
</script>

<template>
  <div class="popup-box">
    <!-- Row 1: Agent Control Switch -->
    <div class="row">
      <span class="label">{{ agentEnabled ? 'Agent on' : 'Agent off' }}</span>
      <button
        class="switch"
        :class="{ active: agentEnabled }"
        type="button"
        role="switch"
        :aria-checked="agentEnabled"
        @click="toggleAgent"
      >
        <span class="slider"></span>
      </button>
    </div>

    <!-- Row 2: Service Status Indicator -->
    <div class="row">
      <span class="label">{{ serverConnected ? 'Connected' : 'Disconnected' }}</span>
      <div class="status">
        <span class="dot" :class="{ online: serverConnected }"></span>
      </div>
    </div>

    <!-- Row 3: Agent Cursor Mode 3-Step Slider -->
    <div class="cursor-row">
      <div class="cursor-header">
        <span class="label">Agent Cursor</span>
        <span class="badge">{{ cursorModeLabel }}</span>
      </div>
      <div class="segmented-control">
        <div class="segment-indicator" :class="cursorMode"></div>
        <button
          type="button"
          class="segment-btn"
          :class="{ active: cursorMode === 'off' }"
          @click="setCursorMode('off')"
        >
          Off
        </button>
        <button
          type="button"
          class="segment-btn"
          :class="{ active: cursorMode === 'auto' }"
          @click="setCursorMode('auto')"
        >
          Auto
        </button>
        <button
          type="button"
          class="segment-btn"
          :class="{ active: cursorMode === 'always' }"
          @click="setCursorMode('always')"
        >
          Always
        </button>
      </div>
    </div>

    <!-- Row 4: Window Mode (Tab vs Window) -->
    <div class="cursor-row">
      <div class="cursor-header">
        <div class="label-with-tooltip">
          <span class="label">Window Mode</span>
          <span
            class="info-icon"
            title="Tab: Works quietly in color-grouped tabs in your current window.&#10;Window: Opens a separate dedicated OS window for agent tasks."
            >i</span
          >
        </div>
        <span class="badge">{{ windowModeLabel }}</span>
      </div>
      <div class="segmented-control two-step">
        <div class="segment-indicator-two" :class="windowMode"></div>
        <button
          type="button"
          class="segment-btn"
          :class="{ active: windowMode === 'tab' }"
          @click="setWindowMode('tab')"
        >
          Tab
        </button>
        <button
          type="button"
          class="segment-btn"
          :class="{ active: windowMode === 'window' }"
          @click="setWindowMode('window')"
        >
          Window
        </button>
      </div>
    </div>

    <!-- Row 5: Version & Update Status (Bottom Row) -->
    <div class="version-row">
      <span class="version-text">v{{ currentVersion }}</span>
      <span v-if="versionChecked && !hasUpdate" class="status-latest">latest</span>
      <div v-if="versionChecked && hasUpdate" class="update-info">
        <span class="update-text">new version</span>
        <a
          class="view-link"
          :href="latestReleaseUrl"
          target="_blank"
          rel="noopener noreferrer"
          @click.prevent="openRelease(latestReleaseUrl)"
          >view</a
        >
      </div>
    </div>
  </div>
</template>

<style scoped>
.popup-box {
  width: 220px;
  padding: 14px 16px;
  box-sizing: border-box;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  user-select: none;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 24px;
}

.label {
  font-size: 13px;
  font-weight: 500;
  color: #1f2937;
}

.switch {
  position: relative;
  width: 36px;
  height: 20px;
  background: #e5e7eb;
  border-radius: 9999px;
  border: none;
  cursor: pointer;
  padding: 2px;
  transition: background-color 0.2s ease;
  outline: none;
}

.switch.active {
  background: #10b981;
}

.slider {
  display: block;
  width: 16px;
  height: 16px;
  background: #ffffff;
  border-radius: 50%;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 0.2s ease;
  transform: translateX(0);
}

.switch.active .slider {
  transform: translateX(16px);
}

.status {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ef4444;
  transition: background-color 0.2s ease;
}

.dot.online {
  background: #10b981;
  box-shadow: 0 0 4px rgba(16, 185, 129, 0.6);
}

.status-text {
  font-size: 12px;
  color: #4b5563;
}

.cursor-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid #f3f4f6;
}

.cursor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.badge {
  font-size: 11px;
  font-weight: 600;
  color: #3b82f6;
  background: #eff6ff;
  padding: 1px 6px;
  border-radius: 4px;
}

.segmented-control {
  position: relative;
  display: flex;
  background: #f3f4f6;
  border-radius: 8px;
  padding: 2px;
}

.segment-indicator {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc((100% - 4px) / 3);
  background: #ffffff;
  border-radius: 6px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.segment-indicator.off {
  transform: translateX(0%);
}

.segment-indicator.auto {
  transform: translateX(100%);
}

.segment-indicator.always {
  transform: translateX(200%);
}

.label-with-tooltip {
  display: flex;
  align-items: center;
  gap: 5px;
}

.info-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #e5e7eb;
  color: #4b5563;
  font-size: 10px;
  font-weight: 700;
  font-style: italic;
  cursor: help;
  user-select: none;
  line-height: 1;
}

.info-icon:hover {
  background: #3b82f6;
  color: #ffffff;
}

.segmented-control.two-step .segment-indicator-two {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc((100% - 4px) / 2);
  background: #ffffff;
  border-radius: 6px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.segment-indicator-two.tab {
  transform: translateX(0%);
}

.segment-indicator-two.window {
  transform: translateX(100%);
}

.segment-btn {
  position: relative;
  z-index: 1;
  flex: 1;
  height: 24px;
  background: transparent;
  border: none;
  outline: none;
  font-size: 11px;
  font-weight: 500;
  color: #6b7280;
  cursor: pointer;
  transition: color 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.segment-btn.active {
  color: #111827;
  font-weight: 600;
}

.version-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 8px;
  border-top: 1px solid #f3f4f6;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
}

.version-text {
  font-size: 11px;
  color: #9ca3af;
  font-weight: 400;
  user-select: text;
}

.status-latest {
  font-size: 11px;
  color: #9ca3af;
  font-weight: 400;
}

.update-info {
  display: flex;
  align-items: center;
  gap: 5px;
}

.update-text {
  font-size: 11px;
  color: #ea580c;
  font-weight: 500;
}

.view-link {
  font-size: 11px;
  color: #2563eb;
  text-decoration: underline;
  cursor: pointer;
  font-weight: 500;
}

.view-link:hover {
  color: #1d4ed8;
}
</style>
