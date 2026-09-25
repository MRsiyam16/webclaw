"""Per-browser routing and isolation tests for the BrowserClaw Hermes plugin."""
from __future__ import annotations

import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import mock

import pytest

from test_mcp_session import MockHTTPResponse
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('browserclaw_routing_test_module', Path(__file__).resolve().parents[1] / '__init__.py')
plugin_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin_module
spec.loader.exec_module(plugin_module)

@pytest.fixture
def plugin():
    plugin_module._reset_session(clear_invalid=True)
    yield plugin_module
    plugin_module._reset_session(clear_invalid=True)



def test_per_call_routes_chrome_and_edge_with_isolated_sessions_and_shared_tab_ids(plugin, monkeypatch):
    monkeypatch.setattr(plugin, '_bridge_token', lambda browser_id='chrome': None)
    seen = []

    def urlopen(req, timeout=None):
        body = json.loads(req.data.decode())
        seen.append((req.full_url, body['method'], req.get_header('Mcp-session-id'), body.get('params', {}).get('arguments', {}).copy()))
        browser = 'edge' if ':12307/' in req.full_url else 'chrome'
        if body['method'] == 'initialize':
            return MockHTTPResponse({}, headers={'mcp-session-id': f'{browser}-session'})
        if body['method'] == 'notifications/initialized':
            return MockHTTPResponse({})
        args = body['params']['arguments']
        return MockHTTPResponse({'result': {'browserId': browser, 'tabId': args.get('tabId')}})

    with mock.patch.object(urllib.request, 'urlopen', urlopen):
        chrome = json.loads(plugin._call_browserclaw('browserclaw_read_dom', {'tabId': 9}))
        edge = json.loads(plugin._call_browserclaw('browserclaw_read_dom', {'tabId': 9, 'browserId': 'edge'}))
        again = json.loads(plugin._call_browserclaw('browserclaw_read_dom', {'tabId': 9}))
    assert [chrome['browserId'], edge['browserId'], again['browserId']] == ['chrome', 'edge', 'chrome']
    calls = [x for x in seen if x[1] == 'tools/call']
    assert [x[2] for x in calls] == ['chrome-session', 'edge-session', 'chrome-session']
    assert all(x[3]['browserId'] == expected for x, expected in zip(calls, ['chrome', 'edge', 'chrome']))


def test_concurrent_routes_keep_sessions_identity_and_tier_activation_isolated(plugin, monkeypatch):
    monkeypatch.setattr(plugin, '_bridge_token', lambda browser_id='chrome': None)
    rendezvous = Barrier(2)
    seen = []

    def urlopen(req, timeout=None):
        body = json.loads(req.data.decode()) if req.data else {}
        url = req.full_url
        browser = 'edge' if ':12307/' in url else 'chrome'
        if url.endswith('/ping'):
            return MockHTTPResponse({'status': 'ok', 'message': 'pong', 'browserId': browser, 'port': 12307 if browser == 'edge' else 12306})
        if body.get('method') == 'initialize':
            rendezvous.wait(timeout=2)
            return MockHTTPResponse({}, headers={'mcp-session-id': f'{browser}-concurrent'})
        if body.get('method') == 'notifications/initialized':
            return MockHTTPResponse({})
        args = body['params']['arguments']
        seen.append((browser, req.get_header('Mcp-session-id'), args.copy()))
        return MockHTTPResponse({'result': {'browserId': browser, 'tier': 'power' if args.get('activateForSession') else 'default'}})

    with mock.patch.object(urllib.request, 'urlopen', urlopen), ThreadPoolExecutor(max_workers=2) as pool:
        chrome = pool.submit(plugin._call_browserclaw, 'browserclaw_tool_docs', {'category': 'power', 'activateForSession': True, 'browserId': 'chrome'})
        edge = pool.submit(plugin._call_browserclaw, 'browserclaw_tool_docs', {'category': 'power', 'activateForSession': False, 'browserId': 'edge'})
        results = [json.loads(f.result()) for f in (chrome, edge)]
    assert [r['browserId'] for r in results] == ['chrome', 'edge']
    assert [r['tier'] for r in results] == ['power', 'default']
    assert {(b, s) for b, s, _ in seen} == {('chrome', 'chrome-concurrent'), ('edge', 'edge-concurrent')}
    assert all(args['browserId'] == b for b, _, args in seen)


@pytest.mark.parametrize('payload', [{'result': {'browserId': 'chrome'}}, {'result': {}}])
def test_explicit_edge_rejects_mismatched_or_missing_response_identity(plugin, monkeypatch, payload):
    monkeypatch.setattr(plugin, '_bridge_token', lambda browser_id='chrome': None)
    def urlopen(req, timeout=None):
        body = json.loads(req.data.decode()) if req.data else {}
        if req.full_url.endswith('/ping'):
            return MockHTTPResponse({'status': 'ok', 'browserId': 'edge', 'port': 12307})
        if body.get('method') == 'initialize':
            return MockHTTPResponse({}, headers={'mcp-session-id': 'edge-session'})
        if body.get('method') == 'notifications/initialized':
            return MockHTTPResponse({})
        return MockHTTPResponse(payload)
    with mock.patch.object(urllib.request, 'urlopen', urlopen):
        result = json.loads(plugin._call_browserclaw('browserclaw_read_dom', {'browserId': 'edge'}))
    assert 'error' in result and 'identity' in result['error'].lower()


def test_explicit_browser_accepts_mcp_content_after_verified_ping(plugin, monkeypatch):
    """Real MCP tools/call returns content/isError, not a top-level browserId."""
    monkeypatch.setattr(plugin, '_bridge_token', lambda browser_id='chrome': None)

    def urlopen(req, timeout=None):
        if req.full_url.endswith('/ping'):
            return MockHTTPResponse({'status': 'ok', 'browserId': 'chrome', 'port': 12306})
        body = json.loads(req.data.decode())
        if body['method'] == 'initialize':
            return MockHTTPResponse({}, headers={'mcp-session-id': 'chrome-session'})
        if body['method'] == 'notifications/initialized':
            return MockHTTPResponse({})
        return MockHTTPResponse({'result': {'content': [{'type': 'text', 'text': 'windows listed'}], 'isError': False}})

    with mock.patch.object(urllib.request, 'urlopen', urlopen):
        result = json.loads(plugin._call_browserclaw('browserclaw_get_windows_and_tabs', {'browserId': 'chrome'}))
    assert result == {'browserId': 'chrome', 'content': [{'type': 'text', 'text': 'windows listed'}], 'isError': False}


def test_explicit_browser_rejects_mcp_content_without_verified_ping(plugin, monkeypatch):
    monkeypatch.setattr(plugin, '_bridge_token', lambda browser_id='chrome': None)

    def urlopen(req, timeout=None):
        if req.full_url.endswith('/ping'):
            raise OSError('identity endpoint unavailable')
        body = json.loads(req.data.decode())
        if body['method'] == 'initialize':
            return MockHTTPResponse({}, headers={'mcp-session-id': 'chrome-session'})
        if body['method'] == 'notifications/initialized':
            return MockHTTPResponse({})
        return MockHTTPResponse({'result': {'content': [{'type': 'text', 'text': 'unverified'}], 'isError': False}})

    with mock.patch.object(urllib.request, 'urlopen', urlopen):
        result = json.loads(plugin._call_browserclaw('browserclaw_get_windows_and_tabs', {'browserId': 'chrome'}))
    assert 'identity missing' in result['error'].lower()


def test_omitted_browser_keeps_legacy_chrome_route(plugin, monkeypatch):
    monkeypatch.setattr(plugin, '_bridge_token', lambda browser_id='chrome': None)
    contacted = []
    def urlopen(req, timeout=None):
        contacted.append(req.full_url)
        body = json.loads(req.data.decode()) if req.data else {}
        if req.full_url.endswith('/ping'):
            return MockHTTPResponse({'status': 'ok', 'browserId': 'chrome', 'port': 12306})
        if body.get('method') == 'initialize':
            return MockHTTPResponse({}, headers={'mcp-session-id': 'chrome-legacy'})
        if body.get('method') == 'notifications/initialized':
            return MockHTTPResponse({})
        return MockHTTPResponse({'result': {'browserId': 'chrome'}})
    with mock.patch.object(urllib.request, 'urlopen', urlopen):
        result = json.loads(plugin._call_browserclaw('browserclaw_read_dom', {'tabId': 9}))
    assert result['browserId'] == 'chrome'
    assert any(':12306/' in url for url in contacted)
    assert not any(':12307/' in url for url in contacted)


def test_unknown_browser_rejected_without_network(plugin):
    with mock.patch.object(urllib.request, 'urlopen') as open_url:
        result = json.loads(plugin._call_browserclaw('browserclaw_read_dom', {'browserId': 'firefox'}))
    assert 'error' in result and 'browserId' in result['error']
    open_url.assert_not_called()


def test_unavailable_selected_endpoint_does_not_fallback(plugin, monkeypatch):
    monkeypatch.setattr(plugin, '_bridge_token', lambda browser_id='chrome': None)
    def urlopen(req, timeout=None):
        if ':12307/' in req.full_url:
            raise OSError('edge unavailable')
        raise AssertionError('must not contact Chrome as fallback')
    with mock.patch.object(urllib.request, 'urlopen', urlopen):
        result = json.loads(plugin._call_browserclaw('browserclaw_read_dom', {'browserId': 'edge'}))
    assert 'error' in result
    assert 'edge' in result['error'].lower() or '12307' in result['error']


def test_reject_endpoint_identity_mismatch(plugin, monkeypatch):
    monkeypatch.setattr(plugin, '_bridge_token', lambda browser_id='chrome': None)
    def urlopen(req, timeout=None):
        body = json.loads(req.data.decode())
        if body['method'] == 'initialize':
            return MockHTTPResponse({}, headers={'mcp-session-id': 'chrome-session'})
        if body['method'] == 'notifications/initialized':
            return MockHTTPResponse({})
        return MockHTTPResponse({'result': {'browserId': 'chrome'}})
    with mock.patch.object(urllib.request, 'urlopen', urlopen):
        result = json.loads(plugin._call_browserclaw('browserclaw_read_dom', {'browserId': 'edge'}))
    assert 'error' in result and 'identity' in result['error'].lower()
