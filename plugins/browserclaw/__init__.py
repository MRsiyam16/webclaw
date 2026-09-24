"""BrowserClaw — Native Hermes Agent Plugin.

Ultra-fast dual-brain Chrome browser automation with 1-based DOM indexing,
Set-of-Mark 2.0 visual fallbacks, Jev System 1 micro-loop, and local MCP bridge.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import re
import sys
import threading
from typing import Any, Callable, Dict, List, Optional
import urllib.error
import urllib.request

# Ensure UTF-8 output encoding across Windows consoles to eliminate GBK UnicodeEncodeError
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

logger = logging.getLogger(__name__)

_plugin_config: Dict[str, Any] = {
    'native_server_port': 12306,
    'auth_token': None,
    'isolate_modal': False,
}

DEFAULT_URLS = [
    os.getenv('BROWSERCLAW_MCP_URL', 'http://127.0.0.1:12306/mcp'),
    'http://127.0.0.1:12306/mcp',
]

# Same lookup order as app/native-server/src/server/token.ts::resolveBridgeToken,
# with BROWSERCLAW_MCP_TOKEN as a plugin-specific override.
BRIDGE_TOKEN_ENV_VARS = ('BROWSERCLAW_MCP_TOKEN', 'CHROME_MCP_TOKEN')
BRIDGE_TOKEN_FILE = Path('.chrome-mcp') / 'bridge-token'

# Optional pre-configured session ID env vars
SESSION_ID_ENV_VARS = ('BROWSERCLAW_MCP_SESSION_ID', 'CHROME_MCP_SESSION_ID')

MCP_PROTOCOL_VERSION = '2024-11-05'
CLIENT_INFO = {
    'name': 'browserclaw-python-plugin',
    'version': '3.1.0',
}

_AUTH_HELP = (
    'BrowserClaw bridge rejected the request (HTTP 401): bridge token missing or invalid. '
    'Set BROWSERCLAW_MCP_TOKEN or CHROME_MCP_TOKEN to the token the native server uses, '
    'or make sure ~/.chrome-mcp/bridge-token (written by the native server) is readable.'
)

# Session state management
_session_lock = threading.RLock()
_active_session_id: Optional[str] = None
_active_session_url: Optional[str] = None
_invalid_configured_sessions: set[str] = set()
_request_counter: int = 0


def _next_request_id() -> int:
    """Return incrementing request id for JSON-RPC 2.0 messages."""
    global _request_counter
    with _session_lock:
        _request_counter += 1
        return _request_counter


def _get_configured_session_id() -> Optional[str]:
    """Check if a session ID is pre-configured via environment variable and not known to be invalid."""
    for name in SESSION_ID_ENV_VARS:
        val = os.getenv(name, '').strip()
        if val and val not in _invalid_configured_sessions:
            return val
    return None


def _get_active_session_id() -> Optional[str]:
    """Retrieve active session id, if any."""
    with _session_lock:
        return _active_session_id or _get_configured_session_id()


def _set_active_session_id(session_id: Optional[str], url: Optional[str] = None) -> None:
    """Explicitly update active session id (used internally or by tests)."""
    global _active_session_id, _active_session_url
    with _session_lock:
        _active_session_id = session_id
        _active_session_url = url


def _reset_session(clear_invalid: bool = False) -> None:
    """Invalidate currently cached session to trigger re-initialization on next call."""
    global _active_session_id, _active_session_url
    with _session_lock:
        if clear_invalid:
            _invalid_configured_sessions.clear()
        else:
            if _active_session_id:
                _invalid_configured_sessions.add(_active_session_id)
            for name in SESSION_ID_ENV_VARS:
                val = os.getenv(name, '').strip()
                if val:
                    _invalid_configured_sessions.add(val)
        _active_session_id = None
        _active_session_url = None


def _get_target_urls() -> List[str]:
    """Return deduplicated list of target MCP endpoints."""
    urls: List[str] = []
    env_url = os.getenv('BROWSERCLAW_MCP_URL', '').strip()
    if env_url:
        urls.append(env_url)
    port = _plugin_config.get('native_server_port') or 12306
    default_url = f'http://127.0.0.1:{port}/mcp'
    if default_url not in urls:
        urls.append(default_url)
    return urls


def _extract_result_or_error(raw: str) -> str:
    """Extract JSON-RPC result or error string from SSE stream or JSON response."""
    if 'data: ' in raw:
        for line in raw.splitlines():
            if line.startswith('data: '):
                try:
                    parsed = json.loads(line[6:].strip())
                    if 'result' in parsed:
                        return json.dumps(parsed['result'], ensure_ascii=False)
                    elif 'error' in parsed:
                        return json.dumps({'error': parsed['error']}, ensure_ascii=False)
                except Exception:
                    pass
    try:
        parsed = json.loads(raw)
        if 'result' in parsed:
            return json.dumps(parsed['result'], ensure_ascii=False)
        elif 'error' in parsed:
            return json.dumps({'error': parsed['error']}, ensure_ascii=False)
    except Exception:
        pass
    return raw


def _perform_handshake(url: str, token: Optional[str]) -> str:
    """Execute MCP 2024-11-05 initialize handshake and send notifications/initialized.

    Returns the session ID issued by the server.
    """
    req_id = _next_request_id()
    init_payload = json.dumps({
        'jsonrpc': '2.0',
        'id': req_id,
        'method': 'initialize',
        'params': {
            'protocolVersion': MCP_PROTOCOL_VERSION,
            'capabilities': {
                'roots': {'listChanged': False},
                'sampling': {},
            },
            'clientInfo': CLIENT_INFO,
        },
    }).encode('utf-8')

    headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    }
    if token:
        headers['Authorization'] = f'Bearer {token}'

    init_req = urllib.request.Request(
        url,
        data=init_payload,
        headers=headers,
        method='POST',
    )

    session_id = None
    try:
        with urllib.request.urlopen(init_req, timeout=30) as resp:
            resp_headers = getattr(resp, 'headers', None)
            if resp_headers:
                session_id = (
                    resp_headers.get('mcp-session-id')
                    or resp_headers.get('Mcp-Session-Id')
                    or (getattr(resp, 'getheader', lambda k: None)('mcp-session-id'))
                    or (getattr(resp, 'getheader', lambda k: None)('Mcp-Session-Id'))
                )

            raw = resp.read().decode('utf-8', errors='replace')
            if raw:
                try:
                    if 'data: ' in raw:
                        for line in raw.splitlines():
                            if line.startswith('data: '):
                                line_data = line[6:].strip()
                                if not line_data:
                                    continue
                                parsed = json.loads(line_data)
                                if 'error' in parsed:
                                    err = parsed['error']
                                    err_msg = err.get('message', str(err)) if isinstance(err, dict) else str(err)
                                    raise RuntimeError(f'MCP initialize rejected: {err_msg}')
                                if not session_id:
                                    session_id = parsed.get('result', {}).get('sessionId')
                                if session_id:
                                    break
                    else:
                        parsed = json.loads(raw)
                        if 'error' in parsed:
                            err = parsed['error']
                            err_msg = err.get('message', str(err)) if isinstance(err, dict) else str(err)
                            raise RuntimeError(f'MCP initialize rejected: {err_msg}')
                        if not session_id:
                            session_id = parsed.get('result', {}).get('sessionId')
                except RuntimeError:
                    raise
                except Exception:
                    pass
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise
        err_body = ''
        try:
            err_body = exc.read().decode('utf-8', errors='replace').strip()
        except Exception:
            pass
        logger.warning('MCP initialize handshake HTTP %d: %s', exc.code, err_body or exc.reason)
        raise RuntimeError(f'MCP initialize handshake failed (HTTP {exc.code}): {err_body or exc.reason}') from exc

    session_id = (session_id or '').strip()

    # Step 2: Send notifications/initialized according to MCP lifecycle spec
    notify_payload = json.dumps({
        'jsonrpc': '2.0',
        'method': 'notifications/initialized',
    }).encode('utf-8')

    notify_headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    }
    if session_id:
        notify_headers['mcp-session-id'] = session_id
    if token:
        notify_headers['Authorization'] = f'Bearer {token}'

    notify_req = urllib.request.Request(
        url,
        data=notify_payload,
        headers=notify_headers,
        method='POST',
    )

    try:
        with urllib.request.urlopen(notify_req, timeout=10) as _:
            # Handshake notification acknowledged; do not read indefinitely on SSE keepalive
            pass
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise
        logger.debug('notifications/initialized HTTP error (ignored): %s', exc)
    except Exception as exc:
        logger.debug('notifications/initialized warning (ignored): %s', exc)

    return session_id


def _ensure_session(url: str, force_refresh: bool = False) -> Optional[str]:
    """Ensure an active MCP session exists for the target URL."""
    configured = _get_configured_session_id()
    if configured and not force_refresh:
        return configured

    global _active_session_id, _active_session_url
    with _session_lock:
        if not force_refresh and _active_session_id and _active_session_url == url:
            return _active_session_id

        token = _bridge_token()
        session_id = _perform_handshake(url, token)
        _active_session_id = session_id or None
        _active_session_url = url
        return _active_session_id


def _bridge_token() -> Optional[str]:
    """Resolve the native-bridge auth token, or None when nothing is configured.

    Read lazily on every call: the file is tiny and the native server may
    regenerate it between calls.
    """
    cfg_token = _plugin_config.get('auth_token')
    if cfg_token:
        return str(cfg_token).strip()
    for name in BRIDGE_TOKEN_ENV_VARS:
        value = os.getenv(name, '').strip()
        if value:
            return value
    try:
        value = (Path.home() / BRIDGE_TOKEN_FILE).read_text(encoding='utf-8').strip()
        if value:
            return value
    except OSError:
        pass

    # Loopback mutual-trust fallback: query native bridge token endpoint directly
    try:
        port = _plugin_config.get('native_server_port') or 12306
        req = urllib.request.Request(
            f'http://127.0.0.1:{port}/token',
            headers={'x-hermes-auth': 'local', 'x-local-trust': 'true'},
        )
        with urllib.request.urlopen(req, timeout=0.5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            token = data.get('token')
            if token and isinstance(token, str):
                return token.strip()
    except Exception:
        pass

    return None


def _align_response_tool_names(text: str) -> str:
    """Rewrite legacy chrome_* tool names and get_windows_and_tabs to browserclaw_* in agent-facing output."""
    if not text:
        return text
    text = re.sub(r'\bchrome_([a-zA-Z0-9_]+)\b', r'browserclaw_\1', text)
    text = re.sub(r'\bget_windows_and_tabs\b', 'browserclaw_get_windows_and_tabs', text)
    return text


def _call_browserclaw(tool_name: str, arguments: dict) -> str:
    if tool_name == 'browserclaw_read_dom' and isinstance(arguments, dict):
        if 'isolateModal' not in arguments and _plugin_config.get('isolate_modal'):
            arguments['isolateModal'] = True
    remote_name = tool_name
    if tool_name == 'browserclaw_get_windows_and_tabs':
        remote_name = 'get_windows_and_tabs'
    elif tool_name.startswith('browserclaw_'):
        remote_name = 'chrome_' + tool_name[len('browserclaw_'):]

    token = _bridge_token()
    last_error = None
    urls = _get_target_urls()

    for url in urls:
        for attempt in range(2):
            try:
                session_id = _ensure_session(url, force_refresh=(attempt > 0))

                req_id = _next_request_id()
                payload = json.dumps({
                    'jsonrpc': '2.0',
                    'id': req_id,
                    'method': 'tools/call',
                    'params': {
                        'name': remote_name,
                        'arguments': arguments or {},
                    },
                }).encode('utf-8')

                headers = {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream',
                    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
                }
                if token:
                    headers['Authorization'] = f'Bearer {token}'
                if session_id:
                    headers['mcp-session-id'] = session_id

                req = urllib.request.Request(
                    url,
                    data=payload,
                    headers=headers,
                    method='POST',
                )

                with urllib.request.urlopen(req, timeout=45) as resp:
                    raw = resp.read().decode('utf-8', errors='replace')
                    res_str = _extract_result_or_error(raw)
                    try:
                        res_obj = json.loads(res_str)
                        if isinstance(res_obj, dict) and 'error' in res_obj:
                            err_msg = str(res_obj.get('error', '')).lower()
                            if ('session' in err_msg or 'not initialized' in err_msg) and attempt == 0:
                                logger.info(
                                    'BrowserClaw MCP session invalid in payload (%s). Re-initializing...',
                                    err_msg,
                                )
                                _reset_session()
                                continue
                    except Exception:
                        pass
                    return _align_response_tool_names(res_str)

            except RuntimeError as e:
                if attempt == 0:
                    logger.info('BrowserClaw handshake error (%s). Retrying...', e)
                    _reset_session()
                    continue
                return json.dumps({'error': str(e)}, ensure_ascii=False)

            except urllib.error.HTTPError as e:
                if e.code == 401:
                    return json.dumps({'error': _AUTH_HELP})

                err_body = ''
                try:
                    err_body = e.read().decode('utf-8', errors='replace').strip()
                except Exception:
                    pass

                # Session expired or invalid session header (HTTP 400 or 404)
                if e.code in (400, 404) and attempt == 0:
                    logger.info(
                        'BrowserClaw MCP session invalid or expired (HTTP %d). Re-initializing session...',
                        e.code,
                    )
                    _reset_session()
                    continue

                if err_body:
                    try:
                        err_parsed = json.loads(err_body)
                        if isinstance(err_parsed, dict):
                            msg = err_parsed.get('error') or err_parsed.get('message')
                            hint = err_parsed.get('hint')
                            if hint and msg:
                                return json.dumps({'error': f'{msg} ({hint})'}, ensure_ascii=False)
                            return json.dumps(err_parsed, ensure_ascii=False)
                    except Exception:
                        pass
                    return json.dumps({'error': f'BrowserClaw HTTP {e.code}: {err_body}'}, ensure_ascii=False)

                last_error = f'HTTP {e.code}'
                break
            except urllib.error.URLError as e:
                last_error = str(e)
                break
            except Exception as e:
                last_error = str(e)
                break

    port = _plugin_config.get('native_server_port') or 12306
    return json.dumps({
        'error': f'BrowserClaw server not reachable ({last_error}). Ensure Chrome extension is loaded and native server is running on http://127.0.0.1:{port}/mcp.',
    })

def _register_bundled_skill(ctx: Any) -> None:
    skill_md = Path(__file__).resolve().parent / 'skills' / 'browserclaw' / 'SKILL.md'
    if not skill_md.is_file() or not hasattr(ctx, 'register_skill'):
        return
    try:
        ctx.register_skill(
            'browserclaw',
            skill_md,
            description='High-efficiency Chrome browser control and automation via BrowserClaw',
        )
    except Exception as exc:
        logger.debug('Failed to register bundled browserclaw skill: %s', exc)

TOOL_DEFINITIONS = {
    "browserclaw_get_windows_and_tabs": {
        "description": "Get all currently open browser windows and tabs",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    "browserclaw_navigate": {
        "description": "Navigate to a URL, refresh the current tab, or navigate browser history (back/forward)",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "URL to navigate to. Special values: \"back\" or \"forward\" to navigate browser history in the target tab."
                },
                "newWindow": {
                    "type": "boolean",
                    "description": "Create a new window to navigate to the URL or not. Defaults to false"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target an existing tab by ID (if provided, navigate/refresh/back/forward that tab instead of the active tab)."
                },
                "windowId": {
                    "type": "number",
                    "description": "Target an existing window by ID (when creating a new tab in existing window, or picking active tab if tabId is not provided)."
                },
                "background": {
                    "type": "boolean",
                    "description": "Perform the operation without stealing focus (do not activate the tab or focus the window). Default: true (set false only if user explicitly asks to bring tab to foreground)"
                },
                "width": {
                    "type": "number",
                    "description": "Window width in pixels (default: 1280). When width or height is provided, a new window will be created."
                },
                "height": {
                    "type": "number",
                    "description": "Window height in pixels (default: 720). When width or height is provided, a new window will be created."
                },
                "refresh": {
                    "type": "boolean",
                    "description": "Refresh the current active tab instead of navigating to a URL. When true, the url parameter is ignored. Defaults to false"
                },
                "groupTitle": {
                    "type": "string",
                    "description": "Task-aligned title for the Chrome tab group in user language (e.g. \"GitHub 搜索\", \"Flight Tracker\"). Fallback: \"Agent\""
                },
                "groupColor": {
                    "type": "string",
                    "enum": [
                        "grey",
                        "blue",
                        "red",
                        "yellow",
                        "green",
                        "pink",
                        "purple",
                        "cyan",
                        "orange"
                    ],
                    "description": "Color for the Chrome tab group. Fallback: \"blue\""
                },
                "autoGroup": {
                    "type": "boolean",
                    "description": "Automatically place newly opened tab into an Agent-managed tab group with dedicated title and color. Default: true"
                }
            },
            "required": []
        }
    },
    "browserclaw_screenshot": {
        "description": "[Prefer browserclaw_read_dom over taking a screenshot] Take a screenshot of the current page or a specific element. Returns base64 image directly in MCP image content block without writing to disk. By default, output is compressed JPEG with maxWidth <= 1280px. Debug disk save is available via savePng/saveToDisk into system temporary directory.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Name or label for the screenshot. Purely in-memory by default; only written to disk if savePng/saveToDisk is explicitly set to true."
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector for element to screenshot"
                },
                "assetIndex": {
                    "type": "number",
                    "description": "View one visual asset listed by browserclaw_read_dom ([asset N] lines): returns the real image resource; falls back to a viewport crop when bytes are unavailable"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID to capture from (default: active tab)."
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID to pick active tab from when tabId is not provided."
                },
                "background": {
                    "type": "boolean",
                    "description": "Attempt capture without bringing tab/window to foreground. CDP-based capture is used for viewport captures. Default: true"
                },
                "width": {
                    "type": "number",
                    "description": "Width in pixels (default: 800)"
                },
                "height": {
                    "type": "number",
                    "description": "Height in pixels (default: 600)"
                },
                "maxWidth": {
                    "type": "number",
                    "description": "Maximum width in pixels for compression (default: 1280)"
                },
                "storeBase64": {
                    "type": "boolean",
                    "description": "Return screenshot in base64 format in text content (image content is always returned directly)"
                },
                "fullPage": {
                    "type": "boolean",
                    "description": "Capture a full-page scroll screenshot with GoFullPage-grade industrial stitching: automatic StyleStack fixed/sticky header de-duplication, page warmup for lazy-loading/skeletons, dynamic height change recovery, and captureVisibleTab quota backoff retry (default: false)."
                },
                "maxHeight": {
                    "type": "number",
                    "description": "Maximum height in pixels to capture for full-page screenshots (default: 50000, protects against infinite scroll runaway)."
                },
                "savePng": {
                    "type": "boolean",
                    "description": "Save screenshot to system temporary directory for debugging (default: false, zero disk write by default)"
                },
                "saveToDisk": {
                    "type": "boolean",
                    "description": "Deprecated alias for savePng (default: false, zero disk write by default; saves to system temp, not Downloads). Prefer savePng."
                },
                "som": {
                    "type": "boolean",
                    "description": "Overlay Set-of-Mark numbered badges on interactive elements before capturing the screenshot"
                },
                "highlight": {
                    "type": "boolean",
                    "description": "Deprecated alias for som; still accepted but hidden from the schema to keep it small. Prefer som."
                },
                "setOfMark": {
                  "type": "boolean",
                  "description": "Alias for som (Set-of-Mark overlay); accepted for parity with som."
                },
                "mode": {
                  "type": "string",
                  "description": "Capture mode. \"som\" = Set-of-Mark: annotated image plus a textual element map on one shared numbering scheme."
                },
                "zoom": {
                  "type": "array",
                  "items": { "type": "number" },
                  "description": "Zoom crop mode: label numbers to zoom into (crop around each label's safe click point, scaled up)."
                },
                "targetIndex": {
                    "type": "number",
                    "description": "Compact 1-based numeric index of target element from browserclaw_read_dom to crop and capture only this specific region of interest"
                },
                "index": {
                    "type": "number",
                    "description": "Alias for targetIndex: compact 1-based numeric index of target element from browserclaw_read_dom to crop and capture"
                },
                "padding": {
                    "type": "number",
                    "description": "Padding in pixels to expand around targetIndex crop area (default: 0)"
                },
                "region": {
                    "type": "object",
                    "description": "Lossless high-density ROI crop: capture only a specific sub-region { x0, y0, x1, y1 } in CSS pixels or polymorphic [ymin, xmin, ymax, xmax]. Completely avoids downscaling and preserves full pixel clarity for fine details like small text or dice dots.",
                    "properties": {
                        "x0": {
                            "type": "number"
                        },
                        "y0": {
                            "type": "number"
                        },
                        "x1": {
                            "type": "number"
                        },
                        "y1": {
                            "type": "number"
                        }
                    }
                },
                "crop": {
                    "type": "object",
                    "description": "Alias for region: { x, y, width, height } or { x0, y0, x1, y1 }."
                },
                "grid": {
                    "type": "boolean",
                    "description": "Overlay semi-transparent coordinate reference grid with perimeter tape measure rulers (20/50/100px ticks) and interior reticle crosshairs (+) to eliminate visual estimation hallucination (default: false)"
                },
                "enableGrid": {
                    "type": "boolean",
                    "description": "Alias for grid: overlay semi-transparent coordinate reference grid with perimeter tape measure rulers and crosshairs"
                },
                "expandSearchArea": {
                    "type": "boolean",
                    "description": "For small elements (< 100x100), adaptively expand the crop bounding box to preserve surrounding headers and text context (default: true)"
                },
                "format": {
                    "type": "string",
                    "enum": [
                        "png",
                        "jpeg",
                        "webp"
                    ],
                    "description": "Image output format: webp (default, high compression for LLM), jpeg, or png"
                },
                "quality": {
                    "type": "number",
                    "description": "Image compression quality from 0 to 100 for webp/jpeg formats (default: 80)"
                },
                "highClarity": {
                    "type": "boolean",
                    "description": "Prioritize 100% full-resolution clarity without downsampling (disables dimension scaling, keeps 1:1 CSS pixel sharpness for reading fine details or dice dots)."
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                }
            },
            "required": []
        }
    },
    "browserclaw_close_tabs": {
        "description": "Close one or more browser tabs",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {
                    "type": "number",
                    "description": "Single tab ID to close (convenience alternative to tabIds array)."
                },
                "tabIds": {
                    "type": "array",
                    "items": {
                        "type": "number"
                    },
                    "description": "Array of tab IDs to close. If not provided, will close the active tab (requires confirm: true or session affinity)."
                },
                "url": {
                    "type": "string",
                    "description": "Close tabs matching this URL. Can be used instead of tabIds."
                },
                "confirm": {
                    "type": "boolean",
                    "description": "Explicit confirmation required to close the active tab when tabIds or url are not specified."
                },
                "allManagedGroups": {
                    "type": "boolean",
                    "description": "Close all Agent-managed tab groups and their tabs created during automation sessions. Default: false"
                }
            },
            "required": []
        }
    },
    "browserclaw_switch_tab": {
        "description": "Switch to a specific browser tab",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {
                    "type": "number",
                    "description": "The ID of the tab to switch to."
                },
                "windowId": {
                    "type": "number",
                    "description": "The ID of the window where the tab is located."
                },
                "background": {
                    "type": "boolean",
                    "description": "If true, binds session affinity only without activating the tab in the Chrome UI or stealing user focus. Default: false"
                }
            },
            "required": [
                "tabId"
            ]
        }
    },
    "browserclaw_read_dom": {
        "description": "Extract and prune interactive DOM tree with compact 1-based index assignment, viewport boundary filtering, and occlusion pruning. Supports scoped container targeting (selector) and noise exclusion (exclude) to eliminate full DOM dump overhead.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "CSS selector to scope parsing to a specific container/element (e.g. \"#main-cart\", \".dialog-box\"). Only descendants and self within matching containers are indexed."
                },
                "scope": {
                    "type": "string",
                    "description": "Alias for selector. CSS selector to scope parsing to a specific container/element (e.g. \"#main-cart\", \".dialog-box\"). Only descendants and self within matching containers are indexed."
                },
                "isolateModal": {
                    "type": "boolean",
                    "description": "When true and an active modal dialog is detected, restricts indexing to the active modal while strictly protecting portals, dropdowns, and alert containers."
                },
                "exclude": {
                    "oneOf": [
                        {
                            "type": "string"
                        },
                        {
                            "type": "array",
                            "items": {
                                "type": "string"
                            }
                        }
                    ],
                    "description": "CSS selector(s) to exclude from parsing (e.g. \"#footer, #recommendations, .ad-banner\"). Matching elements and their entire subtrees are pruned."
                },
                "viewportThreshold": {
                    "type": "number",
                    "description": "Vertical threshold in pixels for viewport boundary checking (default 1000)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "highlight": {
                    "type": "boolean",
                    "description": "Whether to visually highlight indexed elements"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                },
                "cursor": {
                    "type": "number",
                    "description": "Pagination cursor offset for traversing very large DOM pages incrementally (default: 0)"
                },
                "limit": {
                    "type": "number",
                    "description": "Maximum number of indexed elements to return for current page cursor slice (default: unlimited)"
                },
                "maxTextLength": {
                    "type": "number",
                    "description": "Maximum text length before truncation for element text content (default: 120)"
                },
                "maxChars": {
                  "type": "number",
                  "description": "Hard character budget for the serialized response (default: 120000). When the response would exceed it the payload is cut and carries \"truncated\": true plus \"totalChars\" (the true untruncated length)."
                },
                "includeDetails": {
                    "type": "boolean",
                    "description": "Also return the bulky indexedElements/indexMap detail blocks (geometry, occlusion flags, safe click points). Off by default because the tree already carries index/tag/attributes/text; enable only when you need per-element rects or visibility flags."
                },
                "viewportOnly": {
                    "type": "boolean",
                    "description": "When true, only index elements inside or immediately near the visible viewport (default: false)"
                },
                "activeViewportOnly": {
                    "type": "boolean",
                    "description": "When true, strictly constrains indexing to elements currently visible within the active viewport (threshold = 0) with horizontal/vertical frustum clipping, eliminating ghost elements from SPA wizards, carousels, and multi-step forms."
                },
                "format": {
                    "type": "string",
                    "enum": [
                        "compact",
                        "html"
                    ],
                    "description": "Output format for treeString. \"compact\" (default) produces a concise, accessibility-tree-inspired representation without closing tags, slashing token usage by 60%+. \"html\" returns legacy pseudo-HTML tags."
                },
                "deltaOnly": {
                    "type": "boolean",
                    "description": "Delta mode (default: true). A repeat read that sees a changed DOM returns only changed/added/removed diffs against the previous snapshot, saving 90%+ tokens. Set false to always receive the full tree."
                }
            },
            "required": []
        }
    },
    "browserclaw_interact_index": {
        "description": "Click, hover, or interact with an element using its compact 1-based numeric index from browserclaw_read_dom. When performing predictable multi-step actions (e.g. form submission or chain navigation), prefer browserclaw_batch_actions to finish in a single round-trip.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "number",
                    "description": "Compact 1-based numeric index of the target element"
                },
                "coordinate": {
                    "oneOf": [
                        {
                            "type": "object",
                            "properties": {
                                "x": {
                                    "type": "number",
                                    "description": "X coordinate in viewport/CSS pixels"
                                },
                                "y": {
                                    "type": "number",
                                    "description": "Y coordinate in viewport/CSS pixels"
                                }
                            },
                            "required": [
                                "x",
                                "y"
                            ],
                            "description": "{ x, y } coordinate object"
                        },
                        {
                            "type": "array",
                            "items": {
                                "type": "number"
                            },
                            "description": "Point [x, y] or bounding box [ymin, xmin, ymax, xmax]"
                        }
                    ],
                    "description": "Visual fallback coordinates in viewport/CSS pixels: { x, y } object, [x, y] point, or [ymin, xmin, ymax, xmax] bounding box (supports 0~1.0 normalized, 0~1000 per-mille, or absolute viewport pixels across modern vision agents)."
                },
                "coordinateSpace": {
                    "type": "string",
                    "enum": [
                        "viewport",
                        "screenshot"
                    ],
                    "description": "Coordinate reference space. \"viewport\" (default) assumes standard CSS viewport pixels. \"screenshot\" scales coordinates based on the latest screenshot capture resolution."
                },
                "autoSnap": {
                    "type": "boolean",
                    "description": "When clicking via coordinates or visual fallback, magnetically snap to the closest interactive element if clicked within 24px of whitespace. Default: true."
                },
                "points": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "x": {
                                "type": "number",
                                "description": "X coordinate in viewport/CSS pixels"
                            },
                            "y": {
                                "type": "number",
                                "description": "Y coordinate in viewport/CSS pixels"
                            }
                        },
                        "required": [
                            "x",
                            "y"
                        ]
                    },
                    "description": "Click sequence: dispatch a full CDP click at each viewport point with intervalMs pacing (rapid burst for moving canvas targets)"
                },
                "intervalMs": {
                    "type": "number",
                    "description": "Delay between points in the click sequence, 5-500ms (default 35)"
                },
                "action": {
                    "type": "string",
                    "enum": [
                        "click",
                        "hover",
                        "double_click",
                        "right_click",
                        "drag"
                    ],
                    "description": "Interaction action to perform (default: click). \"drag\" requires `end` and moves from the indexed element to that target."
                },
                "path": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "x": {
                                "type": "number",
                                "description": "X coordinate in viewport/CSS pixels"
                            },
                            "y": {
                                "type": "number",
                                "description": "Y coordinate in viewport/CSS pixels"
                            }
                        },
                        "required": [
                            "x",
                            "y"
                        ]
                    },
                    "description": "Continuous drag path: an ordered array of { x, y } coordinates to smoothly drag the mouse through while pressed. Ideal for circular gestures, sliders, and drawing on canvas."
                },
                "end": {
                    "type": "object",
                    "properties": {
                        "index": {
                            "type": "number",
                            "description": "1-based index (from browserclaw_read_dom) of the drag destination element"
                        },
                        "coordinate": {
                            "type": "object",
                            "properties": {
                                "x": {
                                    "type": "number",
                                    "description": "X coordinate in viewport/CSS pixels"
                                },
                                "y": {
                                    "type": "number",
                                    "description": "Y coordinate in viewport/CSS pixels"
                                }
                            },
                            "required": [
                                "x",
                                "y"
                            ],
                            "description": "Drag destination as viewport coordinates when no index is available"
                        }
                    },
                    "description": "Drag destination: { index } for an indexed element, or { coordinate: { x, y } } for a raw point. Required when action is \"drag\"."
                },
                "steps": {
                    "type": "number",
                    "description": "Number of intermediate mouse-move steps for drag (default 48; lower is faster, higher is smoother)"
                },
                "holdMs": {
                    "type": "number",
                    "description": "How long to hold the mouse button before dragging, in ms (default 80, range 0-3000)"
                },
                "dnd": {
                    "type": "boolean",
                    "description": "Use HTML5 drag-and-drop events (dragstart/dragover/drop) instead of raw mouse moves. Needed for React/HTML5 DnD lists."
                },
                "modifiers": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": [
                            "Alt",
                            "Control",
                            "Meta",
                            "Shift"
                        ]
                    },
                    "description": "Keyboard modifiers to hold during interaction"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "waitForSettle": {
                    "type": "boolean",
                    "description": "Wait for DOM mutations to settle (quiet for 150ms or timeout) after interaction before returning (default: false)"
                },
                "settleTimeoutMs": {
                    "type": "number",
                    "description": "Maximum settle timeout in milliseconds (default: 1500, range: 200-10000)"
                },
                "humanize": {
                    "type": "boolean",
                    "description": "Simulate realistic human-like cursor trajectory with micro-jitter before clicking (default: false)"
                },
                "includeDelta": {
                    "type": "boolean",
                    "description": "Automatically capture and return DOM changes caused by this interaction in the delta field (default: false)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                },
                "pierceOverlay": {
                    "type": "boolean",
                    "description": "Automatically pierce non-opaque or transient backdrop masks/loading stubs when intercepted (default: true)"
                },
                "waitForNetworkQuiescence": {
                    "type": "boolean",
                    "description": "Wait for in-flight network requests to settle after this interaction before returning (default: false)"
                },
                "quiescenceTimeoutMs": {
                    "type": "number",
                    "description": "Network quiescence timeout in ms (default: 2000)"
                },
                "captureNetwork": {
                    "type": "object",
                    "properties": {
                        "urlPattern": {
                            "type": "string",
                            "description": "URL pattern or substring to match (e.g. \"*/api/order*\", \"/checkout\")"
                        },
                        "method": {
                            "type": "string",
                            "description": "Optional HTTP method to filter by (GET, POST, PUT, DELETE, etc.)"
                        },
                        "timeoutMs": {
                            "type": "number",
                            "description": "Maximum time in milliseconds to wait for the matching network response (default: 5000ms)"
                        },
                        "statusCodes": {
                            "type": "array",
                            "items": {
                                "type": "number"
                            },
                            "description": "Optional HTTP status codes to accept (e.g. [200, 201])"
                        }
                    },
                    "required": [
                        "urlPattern"
                    ],
                    "description": "Inline capture of network response triggered by this interaction in a single round-trip"
                },
                "postConditions": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "condition": {
                        "type": "string",
                        "enum": ["value_equals", "element_exists", "text_present", "url_matches", "list_count_delta", "element_state"],
                        "description": "Post-action assertion kind evaluated against the page after the action completes."
                      },
                      "expected": {
                        "description": "Expected value for the condition. Pass uses JSON equality, except text_present (substring) and url_matches (exact string or /regex/ literal)."
                      }
                    },
                    "required": ["condition", "expected"]
                  },
                  "description": "Optional post-action assertions; one auditable result per spec is reported top-level and via the result envelope (verdict/outcome)."
                }
            },
            "required": []
        }
    },
    "browserclaw_fill_index": {
        "description": "Fill text into an input or textarea element using its compact 1-based numeric index. For single search/form submission, pass pressEnter: true to fill and submit in 1 turn without needing a separate click. When filling multiple fields or clicking submit, use browserclaw_batch_actions to pipeline in 1 turn.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "number",
                    "description": "Compact 1-based numeric index of the target element"
                },
                "text": {
                    "type": "string",
                    "description": "Text content to fill into the element"
                },
                "value": {
                    "type": "string",
                    "description": "Alias for text parameter"
                },
                "clear": {
                    "type": "boolean",
                    "description": "Whether to clear existing field content before typing (default: true)"
                },
                "pressEnter": {
                    "type": "boolean",
                    "description": "Whether to dispatch an Enter key event immediately after filling the text (default: false). Strongly recommended for search boxes and single-input queries to trigger immediate submission in 1 turn."
                },
                "submit": {
                    "type": "boolean",
                    "description": "Whether to automatically submit the form after filling (default: false). If true, clicks the detected submit button or presses Enter, completing fill + submit in 1 turn."
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "waitForSettle": {
                    "type": "boolean",
                    "description": "Wait for DOM mutations to settle after filling text before returning (default: false)"
                },
                "settleTimeoutMs": {
                    "type": "number",
                    "description": "Maximum settle timeout in milliseconds (default: 1500, range: 200-10000)"
                },
                "includeDelta": {
                    "type": "boolean",
                    "description": "Automatically capture and return DOM changes caused by filling in the delta field (default: false)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                },
                "postConditions": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "condition": {
                        "type": "string",
                        "enum": ["value_equals", "element_exists", "text_present", "url_matches", "list_count_delta", "element_state"],
                        "description": "Post-action assertion kind evaluated against the page after the action completes."
                      },
                      "expected": {
                        "description": "Expected value for the condition. Pass uses JSON equality, except text_present (substring) and url_matches (exact string or /regex/ literal)."
                      }
                    },
                    "required": ["condition", "expected"]
                  },
                  "description": "Optional post-action assertions; one auditable result per spec is reported top-level and via the result envelope (verdict/outcome)."
                }
            },
            "required": [
                "index"
            ]
        }
    },
    "browserclaw_batch_actions": {
        "description": "Execute a sequential multi-step pipeline of browser actions in a single round-trip without waiting for intermediate model turns.\n* CRITICAL EFFICIENCY RULE: When the next 2+ actions are predictable (e.g. form filling: [fill username, fill password, click submit]; or search flow: [fill query, press Enter, wait]), ALWAYS use browserclaw_batch_actions instead of individual tool calls. It completes the entire sequence in 1 turn (3~5x faster, 75%+ lower token cost).\n* Supported action types: click, double_click, right_click, fill, hover, scroll, press_key, wait, fill_form, assert, extract.\n* Set includeDelta: true to automatically inspect DOM changes after the pipeline completes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "enum": [
                                    "click",
                                    "double_click",
                                    "right_click",
                                    "fill",
                                    "hover",
                                    "scroll",
                                    "press_key",
                                    "wait",
                                    "key",
                                    "fill_form",
                                    "assert",
                                    "extract"
                                ],
                                "description": "Action type to perform"
                            },
                            "index": {
                                "type": "number",
                                "description": "Element index (for click, fill, hover)"
                            },
                            "ref": {
                                "type": [
                                    "string",
                                    "number"
                                ],
                                "description": "Target element numeric index or ref from browserclaw_read_dom"
                            },
                            "selector": {
                                "type": "string",
                                "description": "CSS selector or XPath for target element"
                            },
                            "clear": {
                                "type": "boolean",
                                "description": "Clear field before typing (default: true)"
                            },
                            "pressEnter": {
                                "type": "boolean",
                                "description": "Whether to dispatch an Enter key event immediately after filling the text (for type: fill)"
                            },
                            "submit": {
                                "type": "boolean",
                                "description": "Whether to automatically submit the form after filling (clicks detected submit button or presses Enter) (for type: fill)"
                            },
                            "fields": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "ref": {
                                            "type": [
                                                "string",
                                                "number"
                                            ],
                                            "description": "Target element numeric index or ref from browserclaw_read_dom"
                                        },
                                        "index": {
                                            "type": "number",
                                            "description": "Alias for ref"
                                        },
                                        "selector": {
                                            "type": "string",
                                            "description": "CSS selector or XPath for target field"
                                        },
                                        "value": {
                                            "type": [
                                                "string",
                                                "number",
                                                "boolean"
                                            ],
                                            "description": "Value to fill or select"
                                        },
                                        "text": {
                                            "type": "string",
                                            "description": "Alias for value"
                                        },
                                        "clear": {
                                            "type": "boolean",
                                            "description": "Clear field before typing (default: true)"
                                        }
                                    },
                                    "required": []
                                },
                                "description": "Array of field descriptors to fill sequentially (for fill_form)"
                            },
                            "text": {
                                "type": "string",
                                "description": "Text to type/fill"
                            },
                            "value": {
                                "type": "string",
                                "description": "Alias for text"
                            },
                            "key": {
                                "type": "string",
                                "description": "Key name (for press_key)"
                            },
                            "coordinate": {
                                "oneOf": [
                                    {
                                        "type": "object",
                                        "properties": {
                                            "x": {
                                                "type": "number",
                                                "description": "X coordinate in viewport/CSS pixels"
                                            },
                                            "y": {
                                                "type": "number",
                                                "description": "Y coordinate in viewport/CSS pixels"
                                            }
                                        },
                                        "required": [
                                            "x",
                                            "y"
                                        ],
                                        "description": "{ x, y } coordinate object"
                                    },
                                    {
                                        "type": "array",
                                        "items": {
                                            "type": "number"
                                        },
                                        "description": "Point [x, y] or bounding box [ymin, xmin, ymax, xmax]"
                                    }
                                ],
                                "description": "Unified coordinate object or array for click or scroll"
                            },
                            "x": {
                                "type": "number",
                                "description": "Coordinate X (for scroll/click, alias)"
                            },
                            "y": {
                                "type": "number",
                                "description": "Coordinate Y (for scroll/click, alias)"
                            },
                            "at": {
                                "type": "number",
                                "description": "Absolute epoch-ms deadline: sleep until this instant before executing this action (extension-side timer, no extra round-trip)"
                            },
                            "direction": {
                                "type": "string",
                                "enum": [
                                    "up",
                                    "down",
                                    "left",
                                    "right"
                                ],
                                "description": "Scroll direction (left/right dispatch horizontal wheel deltas)"
                            },
                            "amount": {
                                "type": "number",
                                "description": "Scroll pixel amount"
                            },
                            "durationMs": {
                                "type": "number",
                                "description": "Wait duration in ms"
                            },
                            "waitForSettle": {
                                "type": "boolean",
                                "description": "Wait for DOM mutations to settle after this specific action (default: false)"
                            },
                            "settleTimeoutMs": {
                                "type": "number",
                                "description": "Maximum settle timeout in milliseconds for this action (default: 1500)"
                            },
                            "waitForNetworkQuiescence": {
                                "type": "boolean",
                                "description": "Wait for in-flight network requests to settle before proceeding to next action (default: false)"
                            },
                            "quiescenceTimeoutMs": {
                                "type": "number",
                                "description": "Network quiescence timeout in ms (default: 2000)"
                            },
                            "pierceOverlay": {
                                "type": "boolean",
                                "description": "Automatically pierce non-opaque or transient backdrop masks for click actions (default: true)"
                            },
                            "preferComposer": {
                                "type": "boolean",
                                "description": "Prioritize rich composer/editor elements over generic search inputs when resolving textbox (default: false)"
                            },
                            "expectedText": {
                                "type": "string",
                                "description": "Expected text substring or exact match"
                            },
                            "condition": {
                                "type": "string",
                                "enum": [
                                    "contains",
                                    "not_contains",
                                    "equals",
                                    "matches",
                                    "visible",
                                    "not_visible",
                                    "enabled",
                                    "disabled",
                                    "valid",
                                    "invalid",
                                    "checked",
                                    "unchecked"
                                ],
                                "description": "Assertion condition: contains, not_contains, equals, matches (regex), visible, not_visible, enabled, disabled, valid, invalid, checked, unchecked (default: \"contains\")"
                            },
                            "timeoutMs": {
                                "type": "number",
                                "description": "Async polling timeout in milliseconds for assertion settling (default: 300ms)"
                            },
                            "abortOnFailure": {
                                "type": "boolean",
                                "description": "Abort batch if assertion fails (default: true)"
                            },
                            "property": {
                                "type": "string",
                                "enum": [
                                    "text",
                                    "value",
                                    "attribute"
                                ],
                                "description": "Property to extract (default: \"text\")"
                            },
                            "attributeName": {
                                "type": "string",
                                "description": "Attribute name when property is \"attribute\""
                            },
                            "variableName": {
                                "type": "string",
                                "description": "Key name under extractedData to store the result"
                            },
                            "captureNetwork": {
                                "type": "object",
                                "properties": {
                                    "urlPattern": {
                                        "type": "string",
                                        "description": "URL pattern or substring to match (e.g. \"*/api/order*\")"
                                    },
                                    "method": {
                                        "type": "string",
                                        "description": "Optional HTTP method to filter by (GET, POST, etc.)"
                                    },
                                    "timeoutMs": {
                                        "type": "number",
                                        "description": "Maximum time in milliseconds to wait for the network response (default: 5000ms)"
                                    },
                                    "statusCodes": {
                                        "type": "array",
                                        "items": {
                                            "type": "number"
                                        },
                                        "description": "Optional HTTP status codes to accept"
                                    }
                                },
                                "required": [
                                    "urlPattern"
                                ],
                                "description": "Inline capture of network response triggered by this action"
                            }
                        },
                        "required": [
                            "type"
                        ]
                    },
                    "description": "List of actions to execute sequentially"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "waitForSettle": {
                    "type": "boolean",
                    "description": "Wait for DOM mutations to settle after all actions before returning (default: false)"
                },
                "settleTimeoutMs": {
                    "type": "number",
                    "description": "Maximum settle timeout in milliseconds (default: 1500, range: 200-10000)"
                },
                "waitForNetworkQuiescence": {
                    "type": "boolean",
                    "description": "Wait for in-flight network requests to settle after all actions before returning (default: false)"
                },
                "quiescenceTimeoutMs": {
                    "type": "number",
                    "description": "Network quiescence timeout in ms (default: 2000)"
                },
                "includeDelta": {
                    "type": "boolean",
                    "description": "Automatically capture and return DOM changes caused by the batch in the delta field (default: false)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                },
                "captureNetwork": {
                    "type": "object",
                    "properties": {
                        "urlPattern": {
                            "type": "string",
                            "description": "URL pattern or substring to match (e.g. \"*/api/order*\", \"/checkout\")"
                        },
                        "method": {
                            "type": "string",
                            "description": "Optional HTTP method to filter by (GET, POST, PUT, DELETE, etc.)"
                        },
                        "timeoutMs": {
                            "type": "number",
                            "description": "Maximum time in milliseconds to wait for the matching network response (default: 5000ms)"
                        },
                        "statusCodes": {
                            "type": "array",
                            "items": {
                                "type": "number"
                            },
                            "description": "Optional HTTP status codes to accept (e.g. [200, 201])"
                        }
                    },
                    "required": [
                        "urlPattern"
                    ],
                    "description": "Inline capture of network response triggered during batch execution in a single round-trip"
                }
            },
            "required": [
                "actions"
            ]
        }
    },
    "browserclaw_get_markdown": {
        "description": "Extract clean, structured hierarchical markdown from the active tab DOM stripped of SPA state blobs, hidden text, and scripts.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "includeLinks": {
                    "type": "boolean",
                    "description": "Whether to preserve hyperlinks in markdown (default: true)"
                },
                "fit": {
                    "type": "boolean",
                    "description": "Content-only extraction: restrict to the main content region and strip nav/header/footer/aside/form noise before conversion (default: false)"
                },
                "selector": {
                  "type": "string",
                  "description": "CSS selector limiting markdown extraction to that subtree (querySelector) instead of the whole body"
                },
                "maxLength": {
                  "type": "number",
                  "description": "Hard character budget for the returned markdown (default: 120000). Longer markdown is cut and a notice carrying the true original length is appended."
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                }
            },
            "required": []
        }
    },
    "browserclaw_smart_scroll": {
        "description": "Intelligently detects and scrolls the most prominent scrollable container on the page, or targets a specific container by selector, ref, or coordinate with automatic progress calculation.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Session ID for tab affinity (optional)"
                },
                "direction": {
                    "type": "string",
                    "enum": [
                        "down",
                        "up",
                        "left",
                        "right"
                    ],
                    "description": "Scroll direction (default: \"down\")"
                },
                "amount": {
                    "type": "string",
                    "description": "Scroll amount: number in pixels, \"page\" (viewport height), or \"half_page\" (default: \"page\")"
                },
                "selector": {
                    "type": "string",
                    "description": "Optional CSS selector of the scroll container to target"
                },
                "ref": {
                    "type": "number",
                    "description": "Optional 1-based numeric index of the scroll container to target"
                },
                "index": {
                    "type": "number",
                    "description": "Alias for ref: 1-based numeric index of the scroll container to target"
                },
                "coordinate": {
                    "oneOf": [
                        {
                            "type": "object",
                            "properties": {
                                "x": {
                                    "type": "number",
                                    "description": "X coordinate"
                                },
                                "y": {
                                    "type": "number",
                                    "description": "Y coordinate"
                                }
                            },
                            "required": [
                                "x",
                                "y"
                            ],
                            "description": "{ x, y } coordinate object"
                        },
                        {
                            "type": "array",
                            "items": {
                                "type": "number"
                            },
                            "description": "Point [x, y] or bounding box [ymin, xmin, ymax, xmax]"
                        }
                    ],
                    "description": "Optional coordinate to locate the scrollable container under pointer: { x, y } object, [x, y] point, or [ymin, xmin, ymax, xmax] bounding box"
                },
                "smooth": {
                    "type": "boolean",
                    "description": "Whether to use smooth scrolling behavior (default: true)"
                },
                "waitForSettle": {
                    "type": "boolean",
                    "description": "Wait for DOM and network activity to settle after scroll completes (default: true)"
                },
                "settleTimeoutMs": {
                    "type": "number",
                    "description": "Maximum settle wait timeout in ms (default: 1500)"
                }
            },
            "required": []
        }
    },
    "browserclaw_tool_docs": {
        "description": "Return compact parameter documentation for a category of BrowserClaw tools (navigate | perceive | act | observe | manage | crawl | diagnose | network | power). Use when a workflow needs a tool that is not in the current profile view. The \"power\" category is tier 3 (javascript, cdp_execute): it can read document.cookie and drive arbitrary input, so it is session-gated — it is disclosed here but only unlocked for the session when activateForSession is true.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "enum": [
                        "navigate",
                        "perceive",
                        "act",
                        "observe",
                        "manage",
                        "crawl",
                        "diagnose",
                        "network",
                        "power"
                        ],
                    "description": "Tool category to document"
                },
                "activateForSession": {
                    "type": "boolean",
                    "description": "When true, dynamically exposes all tools in this category for the current MCP session without server restart. Default: false"
                }
            },
            "required": [
                "category"
            ]
        }
    },
    "browserclaw_inspect_media": {
        "description": "Inspect and extract high-fidelity media assets (images, canvas, captchas, icons) directly by element index or selector. Uses in-memory lossless extraction for <img>/<canvas>, with super-sampled 200%+ crop fallback for complex DOM containers.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "number",
                    "description": "1-based element index from browserclaw_read_dom"
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector fallback"
                },
                "zoom": {
                    "type": "number",
                    "description": "Super-sampling zoom factor (default: 2.0)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID"
                }
            }
        }
    },
    "browserclaw_grep": {
        "description": "Search the page without dumping full DOM tree. Supports searching interactive elements (returning indices for browserclaw_interact_index), all DOM nodes, or raw visible text lines.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search term or regex pattern"
                },
                "isRegex": {
                    "type": "boolean",
                    "description": "Whether to evaluate query as a regular expression (default: false)"
                },
                "searchType": {
                    "type": "string",
                    "enum": [
                        "interactive_only",
                        "all_dom",
                        "page_text"
                    ],
                    "description": "Search target: \"interactive_only\" (default, matches clickable/fillable elements and returns indices), \"all_dom\" (matches all elements), \"page_text\" (scans visible text lines)."
                },
                "limit": {
                    "type": "number",
                    "description": "Maximum matching results to return (default: 20, max: 50)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Session identifier for tab affinity (optional)"
                }
            },
            "required": [
                "query"
            ]
        }
    },
    "browserclaw_act_toward_goal": {
        "description": "Autonomous semantic micro-loop that perceives, decides, and acts toward a natural-language goal within a local Native Server loop (~200-400ms/step). Powered by TypeSafe Jev System One with seamless fallback to heuristic scoring when no API key is available or on quota/network degradation. Automatically escalates ambiguous, destructive, or complex actions back to the macro planner with pre-fetched page context.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": "Natural language goal or objective to advance toward on the current page"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional, defaults to active tab)"
                },
                "maxSteps": {
                    "type": "number",
                    "description": "Maximum decision steps before terminating (default: 10, max: 60; heuristic capped at <= 5)"
                },
                "timeoutMs": {
                    "type": "number",
                    "description": "Total execution timeout in milliseconds (default: 90000, max: 300000)"
                },
                "textHint": {
                    "type": "string",
                    "description": "Explicit text hint to enter when typing, if not clearly quoted in goal"
                },
                "confidenceThreshold": {
                    "type": "number",
                    "description": "Minimum confidence threshold to commit an action (default: 0.55)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                },
                "sessionContext": {
                    "type": "string",
                    "description": "Optional alias for sessionId"
                }
            },
            "required": [
                "goal"
            ]
        }
    },
    "browserclaw_scroll_until_found": {
        "description": "Performs client-side step-by-step scrolling until an element matching a text query, regex, or selector is found. Waits for virtual lists (DOM recycling) to settle at each step, searches light and shadow DOM, centers the target in the viewport, and returns its 1-based index and safe coordinates.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Text query or keyword to search for during scrolling"
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector to search for during scrolling (supports >>> and /deep/ shadow piercing)"
                },
                "isRegex": {
                    "type": "boolean",
                    "description": "Treat query as a regular expression pattern (default: false)"
                },
                "maxSteps": {
                    "type": "number",
                    "description": "Maximum number of scroll steps before giving up (default: 10, max: 50)"
                },
                "stepPx": {
                    "type": "number",
                    "description": "Scroll distance in pixels per step (default: 800)"
                },
                "direction": {
                    "type": "string",
                    "enum": ["down", "up"],
                    "description": "Scroll direction (default: \"down\")"
                },
                "timeoutMs": {
                    "type": "number",
                    "description": "Timeout in milliseconds for the overall scrolling operation (default: 15000)"
                },
                "containerSelector": {
                    "type": "string",
                    "description": "CSS selector for a custom scrollable container (defaults to window)"
                },
                "settleMs": {
                    "type": "number",
                    "description": "Delay in milliseconds to wait for virtual lists / DOM recycling after each scroll (default: 150)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional, defaults to active tab)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Session identifier for tab affinity binding"
                },
                "sessionContext": {
                    "type": "string",
                    "description": "Optional alias for sessionId"
                }
            },
            "required": []
        }
    },
        "browserclaw_extract": {
            "description": "Tier-2 schema-typed extraction (browser_extract): extracts the fields a JSON Schema declares from the page/HTML root, with source attribution. Each key resolves via [data-field=\"key\"] -> #key -> [name=\"key\"] -> class match -> optional per-property selector -> label text; form controls read value, other elements read textContent, and declared number/integer/boolean types are coerced. Returns { data, missing, sourceRefs } — a key with no source element is reported in missing and is never invented into data.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "schema": {
                        "type": "object",
                        "description": "JSON Schema object describing the fields to extract: { type: 'object', properties: { <key>: { type: 'string'|'number'|'integer'|'boolean', description?, selector? } }, required?: string[] }"
                    },
                    "selector": {
                        "type": "string",
                        "description": "CSS selector scoping extraction to a subtree (optional; defaults to the whole document)"
                    },
                    "tabId": {
                        "type": "number",
                        "description": "Target tab ID (optional, defaults to the active/affinity tab)"
                    },
                    "sessionId": {
                        "type": "string",
                        "description": "Session identifier for tab affinity binding (optional)"
                    }
                },
                "required": [
                    "schema"
                ]
            }
        },
        "browserclaw_insert_media": {
            "description": "Injects an image or media asset from local disk, URL, or base64 into a rich-text composer (e.g. Reddit, Twitter/X, Notion, Discord, Slack, GitHub) or targeted element via synthesized ClipboardEvent(\"paste\") and DragEvent(\"drop\") containing a real File object in DataTransfer, bypassing browser clipboard security sandboxes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filePath": {
                        "type": "string",
                        "description": "Absolute or relative path to the image or media file on local disk (e.g. \"C:/images/diagram.png\" or \"/tmp/photo.jpg\")"
                    },
                    "fileUrl": {
                        "type": "string",
                        "description": "Remote HTTP/HTTPS URL to fetch the image or media asset from"
                    },
                    "base64Data": {
                        "type": "string",
                        "description": "Base64-encoded media data string, optionally with \"data:<mime>;base64,\" prefix"
                    },
                    "fileName": {
                        "type": "string",
                        "description": "Optional filename to associate with the injected file (e.g. \"architecture.png\")"
                    },
                    "mimeType": {
                        "type": "string",
                        "description": "MIME type of the media (e.g. \"image/png\", \"image/jpeg\", \"image/gif\", \"image/webp\", \"image/svg+xml\"). Auto-detected if omitted."
                    },
                    "index": {
                        "type": "number",
                        "description": "1-based compact element index from browserclaw_read_dom targeting the rich-text editor or composer. Defaults to active element or discovered composer."
                    },
                    "selector": {
                        "type": "string",
                        "description": "CSS selector for the target container (optional fallback for index)"
                    },
                    "tabId": {
                        "type": "number",
                        "description": "Target tab ID (optional, defaults to active tab)"
                    },
                    "windowId": {
                        "type": "number",
                        "description": "Target window ID (optional)"
                    },
                    "sessionId": {
                        "type": "string",
                        "description": "Session identifier for tab affinity binding"
                    },
                    "sessionContext": {
                        "type": "string",
                        "description": "Optional alias for sessionId"
                    }
                },
                "required": []
            }
        }
}

def _make_handler(tool_name: str) -> Callable:
    def handler(args: dict, **kwargs: Any) -> str:
        try:
            return _call_browserclaw(tool_name, args)
        except Exception as e:
            return json.dumps({'error': str(e)}, ensure_ascii=False)
    return handler

# ── BROWSERCLAW DISPLAY & HUMANIZATION SPEC ───────────────────────────

def _clip_display_text(text: Any, n: int = 0) -> str:
    if text is None:
        return ""
    s = " ".join(str(text).split())
    return f"{s[:n]}..." if (n and n > 0 and len(s) > n) else s

NO_PREVIEW_TOOLS = frozenset({
    "browserclaw_get_windows_and_tabs",
    "get_windows_and_tabs",
    "chrome_get_windows_and_tabs",
    "browserclaw_tab_group_list",
    "chrome_tab_group_list",
    "browserclaw_doctor",
    "chrome_doctor",
})

BROWSERCLAW_SPECS: Dict[str, Dict[str, Any]] = {
    # 1. 核心导航与感知 (15 tools)
    "browserclaw_act_toward_goal": {
        "emoji": "💫",
        "verb": "Autonomous micro-looping",
        "primary_arg": "goal",
        "builder": lambda a, m: _clip_display_text(str(a["goal"]).replace('"', ''), m) if a.get("goal") is not None else None,
    },
    "browserclaw_navigate": {
        "emoji": "🌐",
        "verb": "Navigating to",
        "primary_arg": "url",
        "builder": lambda a, m: a.get("url") or a.get("action") or ("refresh" if a.get("refresh") else None),
    },
    "browserclaw_read_dom": {
        "emoji": "🔍",
        "verb": "Reading DOM structure",
        "primary_arg": "selector",
        "builder": lambda a, m: f"scoped to '{a.get('selector') or a.get('scope')}'" if (a.get("selector") or a.get("scope")) else "viewport",
    },
    "browserclaw_interact_index": {
        "emoji": "🎯",
        "verb": "Interacting with",
        "primary_arg": "index",
        "builder": lambda a, m: f"element [#{a.get('index') if a.get('index') is not None else ''}] ({a.get('action') or 'click'})",
    },
    "browserclaw_fill_index": {
        "emoji": "✍️",
        "verb": "Typing into",
        "primary_arg": "text",
        "builder": lambda a, m: f"element [#{a.get('index') if a.get('index') is not None else ''}]: \"{_clip_display_text(a.get('text') if a.get('text') is not None else a.get('value', ''), 20)}\"",
    },
    "browserclaw_batch_actions": {
        "emoji": "⚡",
        "verb": "Executing batch pipeline",
        "primary_arg": "actions",
        "builder": lambda a, m: f"{len(a['actions'])} actions" if isinstance(a.get("actions"), list) else None,
    },
    "browserclaw_screenshot": {
        "emoji": "📸",
        "verb": "Capturing screenshot",
        "primary_arg": "fullPage",
        "builder": lambda a, m: "full page" if a.get("fullPage") else "viewport",
    },
    "browserclaw_smart_scroll": {
        "emoji": "📜",
        "verb": "Scrolling view",
        "primary_arg": "direction",
        "builder": lambda a, m: f"{(a.get('direction') or 'down')} ({(a.get('amount') or 'page')})",
    },
    "browserclaw_inspect_media": {
        "emoji": "🖼️",
        "verb": "Inspecting media",
        "primary_arg": "index",
        "builder": lambda a, m: f"element [#{a.get('index') if a.get('index') is not None else ''}]",
    },
    "browserclaw_grep": {
        "emoji": "🔎",
        "verb": "Searching DOM",
        "primary_arg": "query",
        "builder": lambda a, m: f'query: "{_clip_display_text(a.get("query", ""), 25)}"',
    },
    "browserclaw_scroll_until_found": {
        "emoji": "📜",
        "verb": "Auto-scrolling until found",
        "primary_arg": "query",
        "builder": lambda a, m: f'target: "{_clip_display_text(a.get("query") or a.get("selector") or "", 25)}"',
    },
    "browserclaw_get_markdown": {
        "emoji": "📄",
        "verb": "Extracting clean markdown",
        "primary_arg": "fit",
        "builder": lambda a, m: "fitted article" if a.get("fit") else "full page",
    },
    "browserclaw_switch_tab": {
        "emoji": "🔀",
        "verb": "Switching tab",
        "primary_arg": "tabId",
        "builder": lambda a, m: f"tab [#{a.get('tabId') if a.get('tabId') is not None else ''}]",
    },
    "browserclaw_close_tabs": {
        "emoji": "❌",
        "verb": "Closing tabs",
        "primary_arg": "tabIds",
        "builder": lambda a, m: (
            f"{len(a['tabIds'])} tabs"
            if isinstance(a.get("tabIds"), list)
            else (
                f"tab [#{a['tabId']}]"
                if a.get("tabId") is not None
                else (
                    f"url: {a['url']}"
                    if a.get("url")
                    else "current"
                )
            )
        ),
    },
    "browserclaw_get_windows_and_tabs": {
        "emoji": "🪟",
        "verb": "Listing open tabs",
        "primary_arg": None,
        "builder": lambda a, m: "active windows",
    },
    "browserclaw_tool_docs": {
        "emoji": "📚",
        "verb": "Reading tool docs",
        "primary_arg": "category",
        "builder": lambda a, m: f"category: {a.get('category') or 'all'}",
    },

    # 2. 开发者与底层逃生门 (5 tools)
    "browserclaw_javascript": {
        "emoji": "💻",
        "verb": "Executing script",
        "primary_arg": "code",
        "builder": lambda a, m: f'script: "{_clip_display_text(a.get("code", ""), 40)}"',
    },
    "browserclaw_cdp_execute": {
        "emoji": "⚡",
        "verb": "Executing CDP command",
        "primary_arg": "method",
        "builder": lambda a, m: f'method: "{a.get("method") or ""}"',
    },
    "browserclaw_console": {
        "emoji": "🖥️",
        "verb": "Reading console",
        "primary_arg": None,
        "builder": lambda a, m: "browser console logs",
    },
    "browserclaw_doctor": {
        "emoji": "🩺",
        "verb": "Running doctor check",
        "primary_arg": None,
        "builder": lambda a, m: "diagnostic probe",
    },
    "browserclaw_undo_last_action": {
        "emoji": "↩️",
        "verb": "Undoing action",
        "primary_arg": None,
        "builder": lambda a, m: "reverting last DOM mutation",
    },

    # 3. 文件、媒体与弹窗/人工干预 (5 tools)
    "browserclaw_upload_file": {
        "emoji": "📤",
        "verb": "Uploading file",
        "primary_arg": "filePath",
        "builder": lambda a, m: f'"{a.get("filePath") or ""}" -> element [#{a.get("index") if a.get("index") is not None else (a.get("clickTargetIndex") if a.get("clickTargetIndex") is not None else "")}]',
    },
    "browserclaw_insert_media": {
        "emoji": "📋",
        "verb": "Pasting media",
        "primary_arg": "filePath",
        "builder": lambda a, m: f'media: "{a.get("filePath") or a.get("fileName") or ""}"',
    },
    "browserclaw_handle_download": {
        "emoji": "📥",
        "verb": "Managing download",
        "primary_arg": "filenameContains",
        "builder": lambda a, m: f'filename: "{a.get("filenameContains") or a.get("action") or ""}"',
    },
    "browserclaw_handle_dialog": {
        "emoji": "💬",
        "verb": "Handling dialog",
        "primary_arg": "action",
        "builder": lambda a, m: f'action: {a.get("action") or "accept"} (prompt: "{a.get("promptText")}")' if a.get("promptText") else f'action: {a.get("action") or "accept"}',
    },
    "browserclaw_request_human_intervention": {
        "emoji": "🙋",
        "verb": "Requesting human help",
        "primary_arg": "reason",
        "builder": lambda a, m: f'reason: "{_clip_display_text(a.get("reason", ""), 40)}"',
    },

    # 4. 遮罩、按键与系统视觉兜底 (3 tools)
    "browserclaw_dismiss_overlay": {
        "emoji": "🛡️",
        "verb": "Dismissing overlay",
        "primary_arg": None,
        "builder": lambda a, m: "clearing modal backdrop",
    },
    "browserclaw_keyboard": {
        "emoji": "⌨️",
        "verb": "Pressing key",
        "primary_arg": "keys",
        "builder": lambda a, m: f'keys: "{a.get("keys") or a.get("key") or ""}"',
    },
    "browserclaw_computer": {
        "emoji": "🖱️",
        "verb": "Controlling cursor",
        "primary_arg": "action",
        "builder": lambda a, m: (
            f"action: {a.get('action') or 'click'} at ({a['coordinate'][0]}, {a['coordinate'][1]})"
            if isinstance(a.get("coordinate"), (list, tuple)) and len(a["coordinate"]) >= 2
            else (
                f"action: {a.get('action') or 'click'} at ({a.get('x')}, {a.get('y')})"
                if a.get("x") is not None and a.get("y") is not None
                else f"action: {a.get('action') or 'click'}"
            )
        ),
    },

    # 5. 高级表单与网络捕获 (5 tools)
    "browserclaw_form_pipeline": {
        "emoji": "📝",
        "verb": "Filling form pipeline",
        "primary_arg": "fields",
        "builder": lambda a, m: f"fields: {len(a['fields'])} items" if isinstance(a.get("fields"), list) else "fields: 0 items",
    },
    "browserclaw_get_dropdown_options": {
        "emoji": "🔽",
        "verb": "Reading options",
        "primary_arg": "index",
        "builder": lambda a, m: f"element [#{a.get('index') if a.get('index') is not None else ''}]",
    },
    "browserclaw_intercept_api": {
        "emoji": "📡",
        "verb": "Intercepting API",
        "primary_arg": "urlPattern",
        "builder": lambda a, m: f'urlPattern: "{a.get("urlPattern") or ""}"',
    },
    "browserclaw_network_request": {
        "emoji": "🌐",
        "verb": "Sending HTTP request",
        "primary_arg": "url",
        "builder": lambda a, m: f'{(a.get("method") or "GET").upper()}: "{a.get("url") or ""}"',
    },
    "browserclaw_network_capture": {
        "emoji": "🛰️",
        "verb": "Capturing traffic",
        "primary_arg": "action",
        "builder": lambda a, m: f'action: {a.get("action") or "capture"} (pattern: "{a.get("urlPattern") or a.get("pattern") or "*"}")',
    },

    # 6. 标签组与标签移动 (8 tools)
    "browserclaw_tab_group_create": {
        "emoji": "🏷️",
        "verb": "Creating tab group",
        "primary_arg": "title",
        "builder": lambda a, m: (
            f'title: "{a.get("title") or ""}" ({len(a["tabIds"])} tabs)'
            if isinstance(a.get("tabIds"), list)
            else (
                f'title: "{a.get("title") or ""}" ({len(a["tabs"])} tabs)'
                if isinstance(a.get("tabs"), list)
                else f'title: "{a.get("title") or ""}" (0 tabs)'
            )
        ),
    },
    "browserclaw_tab_group_update": {
        "emoji": "🏷️",
        "verb": "Updating tab group",
        "primary_arg": "groupId",
        "builder": lambda a, m: (
            f'group [#{a.get("groupId") if a.get("groupId") is not None else ""}]: title="{a.get("title")}"'
            if a.get("title") is not None
            else (
                f'group [#{a.get("groupId") if a.get("groupId") is not None else ""}]: color="{a.get("color")}"'
                if a.get("color") is not None
                else f'group [#{a.get("groupId") if a.get("groupId") is not None else ""}]'
            )
        ),
    },
    "browserclaw_tab_group_list": {
        "emoji": "📋",
        "verb": "Listing tab groups",
        "primary_arg": None,
        "builder": lambda a, m: "active window groups",
    },
    "browserclaw_tab_group_close": {
        "emoji": "❌",
        "verb": "Closing tab group",
        "primary_arg": "groupId",
        "builder": lambda a, m: f"group [#{a.get('groupId') if a.get('groupId') is not None else ''}]",
    },
    "browserclaw_tab_group_ungroup": {
        "emoji": "🔓",
        "verb": "Ungrouping tabs",
        "primary_arg": "tabId",
        "builder": lambda a, m: f"tab [#{a.get('tabId') if a.get('tabId') is not None else ''}]",
    },
    "browserclaw_move_tab": {
        "emoji": "📦",
        "verb": "Moving tab",
        "primary_arg": "tabId",
        "builder": lambda a, m: f"tab [#{a.get('tabId') if a.get('tabId') is not None else ''}] -> window [#{a.get('windowId') if a.get('windowId') is not None else ''}]",
    },
    "browserclaw_attach_tab": {
        "emoji": "🔗",
        "verb": "Attaching tab",
        "primary_arg": "tabId",
        "builder": lambda a, m: f"tab [#{a.get('tabId') if a.get('tabId') is not None else ''}] to debugger",
    },
    "browserclaw_detach_tab": {
        "emoji": "⛓️",
        "verb": "Detaching tab",
        "primary_arg": "tabId",
        "builder": lambda a, m: f"tab [#{a.get('tabId') if a.get('tabId') is not None else ''}] from debugger",
    },

    # 7. 存储、历史与书签 (5 tools)
    "browserclaw_storage": {
        "emoji": "💾",
        "verb": "Accessing storage",
        "primary_arg": "types",
        "builder": lambda a, m: f"types: {', '.join(a['types']) if isinstance(a.get('types'), list) else (a.get('types') or 'local')}",
    },
    "browserclaw_history": {
        "emoji": "🕒",
        "verb": "Searching history",
        "primary_arg": "text",
        "builder": lambda a, m: f'query: "{_clip_display_text(a.get("text") or a.get("query", ""), 30)}"',
    },
    "browserclaw_bookmark_search": {
        "emoji": "🔖",
        "verb": "Searching bookmarks",
        "primary_arg": "query",
        "builder": lambda a, m: f'query: "{_clip_display_text(a.get("query", ""), 30)}"',
    },
    "browserclaw_bookmark_add": {
        "emoji": "⭐",
        "verb": "Adding bookmark",
        "primary_arg": "title",
        "builder": lambda a, m: f'title: "{_clip_display_text(a.get("title", ""), 30)}"',
    },
    "browserclaw_bookmark_delete": {
        "emoji": "🗑️",
        "verb": "Deleting bookmark",
        "primary_arg": "bookmarkId",
        "builder": lambda a, m: f'id: "{a.get("bookmarkId") or a.get("id") or ""}"',
    },

    # 8. 性能分析 (3 tools)
    "browserclaw_performance_start_trace": {
        "emoji": "⏱️",
        "verb": "Starting trace",
        "primary_arg": "categories",
        "builder": lambda a, m: f"categories: {', '.join(a['categories']) if isinstance(a.get('categories'), list) else (a.get('categories') or 'timeline')}",
    },
    "browserclaw_performance_stop_trace": {
        "emoji": "⏹️",
        "verb": "Stopping trace",
        "primary_arg": None,
        "builder": lambda a, m: "saving trace file",
    },
    "browserclaw_performance_analyze_insight": {
        "emoji": "📊",
        "verb": "Analyzing performance",
        "primary_arg": "insightName",
        "builder": lambda a, m: f'insight: "{a.get("insightName") or ""}"',
    },
}


def _get_tool_aliases(name: Any) -> list[str]:
    if not isinstance(name, str) or not name:
        return []
    aliases = [name]
    if name == "browserclaw_get_windows_and_tabs":
        aliases.extend(["get_windows_and_tabs", "chrome_get_windows_and_tabs"])
    elif name.startswith("browserclaw_"):
        suffix = name[len("browserclaw_"):]
        aliases.append(f"chrome_{suffix}")
        if suffix == "get_windows_and_tabs":
            aliases.append("get_windows_and_tabs")
    elif name.startswith("chrome_"):
        suffix = name[len("chrome_"):]
        aliases.append(f"browserclaw_{suffix}")
        if suffix == "get_windows_and_tabs":
            aliases.append("get_windows_and_tabs")
    elif name == "get_windows_and_tabs":
        aliases.extend(["browserclaw_get_windows_and_tabs", "chrome_get_windows_and_tabs"])
    return list(dict.fromkeys(aliases))


def _resolve_browserclaw_spec(tool_name: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(tool_name, str) or not tool_name:
        return None
    if tool_name in BROWSERCLAW_SPECS:
        return BROWSERCLAW_SPECS[tool_name]
    if tool_name in ("get_windows_and_tabs", "chrome_get_windows_and_tabs"):
        return BROWSERCLAW_SPECS.get("browserclaw_get_windows_and_tabs")
    if tool_name.startswith("chrome_"):
        canonical = "browserclaw_" + tool_name[len("chrome_"):]
        if canonical in BROWSERCLAW_SPECS:
            return BROWSERCLAW_SPECS[canonical]
    elif tool_name.startswith("browserclaw_"):
        chrome_name = "chrome_" + tool_name[len("browserclaw_"):]
        if chrome_name in BROWSERCLAW_SPECS:
            return BROWSERCLAW_SPECS[chrome_name]
    return None


def _unwrap_deferred_tool_call(tool_name: str, args: dict | None = None) -> tuple[str, dict]:
    """Unwrap Hermes Deferred Tool bridge calls (`tool_call`) to their underlying tool name & arguments."""
    if tool_name == "tool_call" and isinstance(args, dict):
        calls = args.get("calls")
        if isinstance(calls, list) and len(calls) > 0 and isinstance(calls[0], dict):
            inner_name = calls[0].get("name")
            inner_args = calls[0].get("arguments")
            if isinstance(inner_name, str) and inner_name:
                safe_inner_args = inner_args if isinstance(inner_args, dict) else {}
                return inner_name, safe_inner_args
    return tool_name, args if isinstance(args, dict) else {}


def _register_display_formatters() -> None:
    """Safely register tool previews, verbs, and emojis into agent.display and tools.registry."""
    try:
        from agent import display
        for name, spec in BROWSERCLAW_SPECS.items():
            for alias in _get_tool_aliases(name):
                if spec.get("primary_arg") and hasattr(display, "_PRIMARY_ARGS"):
                    display._PRIMARY_ARGS[alias] = spec["primary_arg"]
                if spec.get("builder") and hasattr(display, "_PREVIEW_BUILDERS"):
                    display._PREVIEW_BUILDERS[alias] = spec["builder"]
                if spec.get("verb") and hasattr(display, "_TOOL_VERBS"):
                    display._TOOL_VERBS[alias] = spec["verb"]

        # Register tools whose verb should render alone without preview suffix
        if hasattr(display, "_TOOL_VERBS_NO_PREVIEW") and isinstance(display._TOOL_VERBS_NO_PREVIEW, frozenset):
            display._TOOL_VERBS_NO_PREVIEW = display._TOOL_VERBS_NO_PREVIEW | NO_PREVIEW_TOOLS

        # Wrap get_tool_verb for dynamic fallback when unlisted browserclaw/chrome tools are called
        orig_get_tool_verb = getattr(display, "get_tool_verb", None)
        if orig_get_tool_verb is not None and not getattr(orig_get_tool_verb, "_is_browserclaw_wrapped", False):
            def _browserclaw_get_tool_verb(tool_name: str) -> str | None:
                if not isinstance(tool_name, str) or not tool_name:
                    return None
                real_name, _ = _unwrap_deferred_tool_call(tool_name, None)
                v = orig_get_tool_verb(real_name)
                if v:
                    return v
                if getattr(display, "_friendly_tool_labels", True):
                    if real_name.startswith("browserclaw_") or real_name.startswith("chrome_"):
                        raw = real_name[len("browserclaw_"):] if real_name.startswith("browserclaw_") else real_name[len("chrome_"):]
                        words = raw.replace("_", " ").strip()
                        return f"Executing {words}"
                return None

            _browserclaw_get_tool_verb._is_browserclaw_wrapped = True
            display.get_tool_verb = _browserclaw_get_tool_verb

            import sys
            for mod in list(sys.modules.values()):
                if mod is not None:
                    d = getattr(mod, "__dict__", None)
                    if isinstance(d, dict):
                        if d.get("get_tool_verb") is orig_get_tool_verb:
                            d["get_tool_verb"] = _browserclaw_get_tool_verb
                        if d.get("_get_tool_verb") is orig_get_tool_verb:
                            d["_get_tool_verb"] = _browserclaw_get_tool_verb

        # Ensure build_tool_preview invokes BrowserClaw builders even for zero-argument or default calls,
        # and unwraps deferred bridge `tool_call` payloads to the underlying tool.
        orig_build_tool_preview = getattr(display, "build_tool_preview", None)
        if orig_build_tool_preview is not None and not getattr(orig_build_tool_preview, "_is_browserclaw_wrapped", False):
            def _browserclaw_build_tool_preview(tool_name: str, args: dict | None = None, max_len: int | None = None) -> str | None:
                if not isinstance(tool_name, str) or not tool_name:
                    return None
                real_name, real_args = _unwrap_deferred_tool_call(tool_name, args)
                safe_args = real_args if isinstance(real_args, dict) else {}
                spec = _resolve_browserclaw_spec(real_name)
                if spec is not None:
                    builder = spec.get("builder")
                    if builder is not None:
                        cap = max_len if max_len is not None else getattr(display, "_tool_preview_max_len", 0)
                        try:
                            res = builder(safe_args, cap)
                            if res is not None:
                                return res
                        except Exception:
                            pass
                try:
                    return orig_build_tool_preview(real_name, safe_args, max_len)
                except Exception:
                    return None

            _browserclaw_build_tool_preview._is_browserclaw_wrapped = True
            display.build_tool_preview = _browserclaw_build_tool_preview

            import sys
            for mod in list(sys.modules.values()):
                if mod is not None:
                    d = getattr(mod, "__dict__", None)
                    if isinstance(d, dict):
                        if d.get("build_tool_preview") is orig_build_tool_preview:
                            d["build_tool_preview"] = _browserclaw_build_tool_preview
                        if d.get("_build_tool_preview") is orig_build_tool_preview:
                            d["_build_tool_preview"] = _browserclaw_build_tool_preview

        # Fallback emoji resolution for BrowserClaw tools if not yet populated in registry
        orig_get_tool_emoji = getattr(display, "get_tool_emoji", None)
        if orig_get_tool_emoji is not None and not getattr(orig_get_tool_emoji, "_is_browserclaw_wrapped", False):
            def _browserclaw_get_tool_emoji(tool_name: str, default: str = "⚡") -> str:
                if not isinstance(tool_name, str) or not tool_name:
                    return default
                spec = _resolve_browserclaw_spec(tool_name)
                if spec and "emoji" in spec:
                    return spec["emoji"]
                if tool_name.startswith("browserclaw_") or tool_name.startswith("chrome_") or tool_name == "get_windows_and_tabs":
                    return "🌐"
                return orig_get_tool_emoji(tool_name, default=default)

            _browserclaw_get_tool_emoji._is_browserclaw_wrapped = True
            display.get_tool_emoji = _browserclaw_get_tool_emoji

            import sys
            for mod in list(sys.modules.values()):
                if mod is not None:
                    d = getattr(mod, "__dict__", None)
                    if isinstance(d, dict):
                        if d.get("get_tool_emoji") is orig_get_tool_emoji:
                            d["get_tool_emoji"] = _browserclaw_get_tool_emoji
                        if d.get("_get_tool_emoji") is orig_get_tool_emoji:
                            d["_get_tool_emoji"] = _browserclaw_get_tool_emoji

        # Wrap prepare_tool_preview to unwrap deferred `tool_call` bridges seamlessly
        orig_prepare_tool_preview = getattr(display, "prepare_tool_preview", None)
        if orig_prepare_tool_preview is not None and not getattr(orig_prepare_tool_preview, "_is_browserclaw_wrapped", False):
            def _browserclaw_prepare_tool_preview(tool_name: str, args: dict | None, *, fallback: str, max_len: int):
                real_name, real_args = _unwrap_deferred_tool_call(tool_name, args)
                return orig_prepare_tool_preview(real_name, real_args, fallback=fallback, max_len=max_len)

            _browserclaw_prepare_tool_preview._is_browserclaw_wrapped = True
            display.prepare_tool_preview = _browserclaw_prepare_tool_preview

            import sys
            for mod in list(sys.modules.values()):
                if mod is not None:
                    d = getattr(mod, "__dict__", None)
                    if isinstance(d, dict):
                        if d.get("prepare_tool_preview") is orig_prepare_tool_preview:
                            d["prepare_tool_preview"] = _browserclaw_prepare_tool_preview
                        if d.get("_prepare_tool_preview") is orig_prepare_tool_preview:
                            d["_prepare_tool_preview"] = _browserclaw_prepare_tool_preview

        # Wrap format_tool_event in BasePlatformAdapter if available, so Telegram/Discord/Slack
        # unwrap deferred `tool_call` bridges when formatting stream chunks.
        try:
            from gateway.platforms.base import BasePlatformAdapter
            orig_format_tool_event = getattr(BasePlatformAdapter, "format_tool_event", None)
            if orig_format_tool_event is not None and not getattr(orig_format_tool_event, "_is_browserclaw_wrapped", False):
                def _browserclaw_format_tool_event(self, event: Any, *, mode: str = "all", preview_max_len: int = 40):
                    from gateway.stream_events import ToolCallChunk
                    if isinstance(event, ToolCallChunk) and event.tool_name == "tool_call":
                        real_name, real_args = _unwrap_deferred_tool_call(event.tool_name, event.args)
                        if real_name != "tool_call":
                            # Create an unwrapped chunk
                            from agent.display import prepare_tool_preview
                            cap = preview_max_len if preview_max_len > 0 else 40
                            p = prepare_tool_preview(real_name, real_args, fallback="", max_len=cap)
                            unwrapped_event = ToolCallChunk(
                                tool_name=real_name,
                                preview=p.text or event.preview,
                                args=real_args,
                                index=getattr(event, "index", 0)
                            )
                            return orig_format_tool_event(self, unwrapped_event, mode=mode, preview_max_len=preview_max_len)
                    return orig_format_tool_event(self, event, mode=mode, preview_max_len=preview_max_len)

                _browserclaw_format_tool_event._is_browserclaw_wrapped = True
                BasePlatformAdapter.format_tool_event = _browserclaw_format_tool_event
        except Exception:
            pass

        # Wrap TurnRunner._progress_build_message if available in gateway.run_turn_runner
        try:
            from gateway.run_turn_runner import TurnRunner
            orig_progress_build_message = getattr(TurnRunner, "_progress_build_message", None)
            if orig_progress_build_message is not None and not getattr(orig_progress_build_message, "_is_browserclaw_wrapped", False):
                def _browserclaw_progress_build_message(self, tool_name, preview, args):
                    real_name, real_args = _unwrap_deferred_tool_call(tool_name, args)
                    if real_name != tool_name:
                        # Auto-compute fresh preview for the unwrapped tool
                        from agent.display import build_tool_preview
                        unwrapped_preview = build_tool_preview(real_name, real_args) or preview
                        return orig_progress_build_message(self, real_name, unwrapped_preview, real_args)
                    return orig_progress_build_message(self, tool_name, preview, args)

                _browserclaw_progress_build_message._is_browserclaw_wrapped = True
                TurnRunner._progress_build_message = _browserclaw_progress_build_message
        except Exception:
            pass

        # Quiet mode CLI renderers (┊ {emoji} {verb:9} {detail})
        if hasattr(display, "_CUTE_LINES"):
            for name, spec in BROWSERCLAW_SPECS.items():
                emoji = spec["emoji"]
                verb = spec["verb"]
                short_verb = verb.split()[0][:9]
                for alias in _get_tool_aliases(name):
                    display._CUTE_LINES[alias] = (
                        lambda a, r, n=alias, em=emoji, v=short_verb:
                        f"┊ {em} {v:9} {getattr(display, '_cute_trunc', lambda s: s)(display.build_tool_preview(n, a) or '')}"
                    )

        logger.debug("Successfully registered BrowserClaw formatters into agent.display")
    except Exception as e:
        logger.warning(f"Could not hook agent.display formatters: {e}")

    try:
        from tools.registry import registry
        for name, spec in BROWSERCLAW_SPECS.items():
            for alias in _get_tool_aliases(name):
                entry = registry.get_entry(alias)
                if entry is not None and hasattr(entry, "emoji"):
                    entry.emoji = spec.get("emoji", entry.emoji)

        orig_registry_get_emoji = getattr(registry, "get_emoji", None)
        if orig_registry_get_emoji is not None and not getattr(orig_registry_get_emoji, "_is_browserclaw_wrapped", False):
            def _browserclaw_registry_get_emoji(name: str, default: str = "⚡") -> str:
                if not isinstance(name, str) or not name:
                    return default
                spec = _resolve_browserclaw_spec(name)
                if spec and "emoji" in spec:
                    return spec["emoji"]
                if name.startswith("browserclaw_") or name.startswith("chrome_") or name == "get_windows_and_tabs":
                    return "🌐"
                return orig_registry_get_emoji(name, default=default)

            _browserclaw_registry_get_emoji._is_browserclaw_wrapped = True
            registry.get_emoji = _browserclaw_registry_get_emoji
    except Exception:
        pass

def register(ctx: Any) -> None:
    global _plugin_config
    if hasattr(ctx, 'config') and ctx.config:
        try:
            if hasattr(ctx.config, 'get'):
                _plugin_config['native_server_port'] = int(ctx.config.get('native_server_port', 12306) or 12306)
                _plugin_config['auth_token'] = ctx.config.get('auth_token', None)
                _plugin_config['isolate_modal'] = bool(ctx.config.get('isolate_modal', False))
            elif isinstance(ctx.config, dict):
                _plugin_config['native_server_port'] = int(ctx.config.get('native_server_port', 12306) or 12306)
                _plugin_config['auth_token'] = ctx.config.get('auth_token', None)
                _plugin_config['isolate_modal'] = bool(ctx.config.get('isolate_modal', False))
        except Exception as exc:
            logger.debug('Failed to parse plugin config: %s', exc)

    _register_bundled_skill(ctx)
    _register_display_formatters()

    is_mock = any('mock' in getattr(cls, '__module__', '').lower() for cls in type(ctx).__mro__)

    for tool_name, meta in TOOL_DEFINITIONS.items():
        spec = BROWSERCLAW_SPECS.get(tool_name, {})
        emoji = spec.get("emoji", "🌐")
        schema = {
            'name': tool_name,
            'description': meta['description'],
            'parameters': meta['inputSchema'],
        }
        handler = _make_handler(tool_name)
        if hasattr(ctx, 'register_tool'):
            ctx.register_tool(
                name=tool_name,
                toolset='browserclaw',
                schema=schema,
                handler=handler,
                description=meta['description'],
                emoji=emoji,
            )

        if is_mock:
            try:
                from tools.registry import registry
                registry.register(
                    name=tool_name,
                    toolset='browserclaw',
                    schema=schema,
                    handler=handler,
                    description=meta['description'],
                    emoji=emoji,
                    override=True,
                )
            except Exception:
                pass

    # Ensure registry entries have emoji updated after registration
    _register_display_formatters()


def browserclaw_scroll_until_found(
    query: Optional[str] = None,
    selector: Optional[str] = None,
    is_regex: bool = False,
    max_steps: int = 10,
    step_px: int = 800,
    direction: str = 'down',
    timeout_ms: int = 15000,
    container_selector: Optional[str] = None,
    settle_ms: int = 150,
    tab_id: Optional[int] = None,
    session_id: Optional[str] = None,
) -> str:
    """Scroll step-by-step in the active page until an element matching query or selector is found.

    Executes in-page client-side RAF/step scrolling, waiting for virtual lists to render at each step,
    probing open and shadow DOM trees. Upon finding, stops scrolling, centers the element in the viewport,
    and returns its 1-based index and safe coordinates.
    """
    args: Dict[str, Any] = {
        'isRegex': is_regex,
        'maxSteps': max_steps,
        'stepPx': step_px,
        'direction': direction,
        'timeoutMs': timeout_ms,
        'settleMs': settle_ms,
    }
    if query:
        args['query'] = query
    if selector:
        args['selector'] = selector
    if container_selector:
        args['containerSelector'] = container_selector
    if tab_id is not None:
        args['tabId'] = tab_id
    if session_id:
        args['sessionId'] = session_id

    return _call_browserclaw('browserclaw_scroll_until_found', args)


def browserclaw_eval(script: str, tab_id: Optional[int] = None) -> str:
    """Execute raw JavaScript in the active tab context as a high-privilege fallback."""
    args: Dict[str, Any] = {'code': script, 'script': script}
    if tab_id is not None:
        args['tabId'] = tab_id
    return _call_browserclaw('browserclaw_javascript', args)


def browserclaw_execute_script(script: str, tab_id: Optional[int] = None) -> str:
    """Alias for browserclaw_eval."""
    return browserclaw_eval(script, tab_id=tab_id)

