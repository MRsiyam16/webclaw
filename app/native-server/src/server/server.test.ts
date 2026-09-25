import { describe, expect, test, afterAll, beforeAll } from '@jest/globals';
import supertest from 'supertest';
import Server from './index';
import nativeMessagingHostInstance from '../native-messaging-host';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import fileHandler, {
  assertSafeUrl,
  assertSafeUrlAsync,
  isPrivateOrBlockedIp,
  safeLookup,
  MAX_DOWNLOAD_SIZE,
} from '../file-handler';
import { getBridgeToken } from './token';
import { checkIsAdmin } from '../scripts/utils';
import { getAllowedExtensionIds, DEFAULT_EXTENSION_ID } from '../constant';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TEST_PORT = 14567;

describe('Fastify MCP Native Server Integration Tests', () => {
  beforeAll(async () => {
    Server.setNativeHost(nativeMessagingHostInstance);
    nativeMessagingHostInstance.setServer(Server);
    await Server.start(TEST_PORT, nativeMessagingHostInstance);
  });

  afterAll(async () => {
    await Server.stop();
  });

  test('GET /ping 应返回正确响应', async () => {
    const response = await supertest(Server.getInstance().server)
      .get('/ping')
      .expect(200)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      status: 'ok',
      message: 'pong',
      browserId: 'chrome',
      port: expect.any(Number),
    });
  });

  describe('Security: Fastify 12306 Token Authentication (P0 Hardening)', () => {
    test('rejects /mcp request without token with 401 Unauthorized', async () => {
      const response = await supertest(Server.getInstance().server)
        .post('/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/unauthorized/i);
    });

    test('rejects /mcp request with invalid token with 401 Unauthorized', async () => {
      const response = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Authorization', 'Bearer invalid-dummy-token-12345678')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/unauthorized/i);
    });

    test('rejects /ask-extension without token with 401 Unauthorized', async () => {
      const response = await supertest(Server.getInstance().server)
        .get('/ask-extension')
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });

    test('accepts /mcp with valid x-mcp-token header', async () => {
      const response = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('x-mcp-token', getBridgeToken())
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(400); // Passes auth and reaches JSON-RPC handler (returns 400 because uninitialized)

      expect(response.body).toHaveProperty('error');
    });

    test('rejects /mcp from Chrome Extension origin without token (prevents local spoofing bypass)', async () => {
      const allowedId = getAllowedExtensionIds()[0] || DEFAULT_EXTENSION_ID;
      const response = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Origin', `chrome-extension://${allowedId}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/unauthorized/i);
    });

    test('rejects /ask-extension from Chrome Extension origin without token (blocks local spoofing)', async () => {
      const allowedId = getAllowedExtensionIds()[0] || DEFAULT_EXTENSION_ID;
      const response = await supertest(Server.getInstance().server)
        .get('/ask-extension')
        .set('Origin', `chrome-extension://${allowedId}`)
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/unauthorized/i);
    });

    test('rejects /agent-control without token with 401 Unauthorized', async () => {
      const response = await supertest(Server.getInstance().server)
        .get('/agent-control')
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/unauthorized/i);
    });

    test('accepts /agent-control with token and fails cleanly if native host is absent', async () => {
      const response = await supertest(Server.getInstance().server)
        .get('/agent-control')
        .set('Authorization', `Bearer ${getBridgeToken()}`)
        .expect(500);

      expect(response.body).toHaveProperty('status', 'error');
      expect(response.body.message).toMatch(/not connected|not available/i);
    });

    test('GET /token returns active bridge token on loopback', async () => {
      const response = await supertest(Server.getInstance().server).get('/token').expect(200);

      expect(response.body).toEqual({
        status: 'ok',
        token: getBridgeToken(),
      });
    });

    test('POST /eval rejects without valid script', async () => {
      const response = await supertest(Server.getInstance().server)
        .post('/eval')
        .set('x-hermes-auth', 'local')
        .send({})
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });

    test('POST /eval passes auth with x-hermes-auth local header', async () => {
      const response = await supertest(Server.getInstance().server)
        .post('/eval')
        .set('x-hermes-auth', 'local')
        .send({ script: '1 + 1' });

      // Either succeeds (200) or returns 500 when extension host is not running in unit test
      expect([200, 500]).toContain(response.status);
    });

    test('POST /eval accepts code parameter alias', async () => {
      const response = await supertest(Server.getInstance().server)
        .post('/eval')
        .set('x-hermes-auth', 'local')
        .send({ code: '1 + 1' });

      expect([200, 500]).toContain(response.status);
    });
  });

  test('POST /mcp without session or initialize should return 400 Bad Request', async () => {
    const response = await supertest(Server.getInstance().server)
      .post('/mcp')
      .set('Authorization', `Bearer ${getBridgeToken()}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(400);

    expect(response.body).toHaveProperty('error');
  });

  test('POST /mcp with invalid session should return 404 Not Found', async () => {
    const response = await supertest(Server.getInstance().server)
      .post('/mcp')
      .set('Authorization', `Bearer ${getBridgeToken()}`)
      .set('mcp-session-id', 'non-existent-session-id')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(404);

    expect(response.body).toHaveProperty('error');
  });

  test('GET /mcp without session should return 400 Bad Request', async () => {
    const response = await supertest(Server.getInstance().server)
      .get('/mcp')
      .set('Authorization', `Bearer ${getBridgeToken()}`)
      .expect(400);

    expect(response.body).toHaveProperty('error');
  });

  test('DELETE /mcp without valid session should return 404 Not Found', async () => {
    const response = await supertest(Server.getInstance().server)
      .delete('/mcp')
      .set('Authorization', `Bearer ${getBridgeToken()}`)
      .set('mcp-session-id', 'invalid-uuid')
      .expect(404);

    expect(response.body).toHaveProperty('error');
  });

  test('Full MCP client lifecycle over Streamable HTTP', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${TEST_PORT}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${getBridgeToken()}` },
        },
      },
    );
    const client = new Client({ name: 'jest-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    expect(transport.sessionId).toBeDefined();

    const tools = await client.listTools();
    expect(tools.tools.length).toBe(14); // Core profile exposes exactly 14 primary tools

    // Call tool when extension is disconnected -> returns isError: true immediately without blocking
    const t0 = Date.now();
    const toolRes = (await client.callTool({
      name: 'chrome_click_index',
      arguments: { index: 1 },
    })) as any;
    const duration = Date.now() - t0;
    expect(duration).toBeLessThan(1000);
    expect(toolRes.isError).toBe(true);

    // Auto-Unlock on Call: calling unexposed tool (chrome_history in "manage" category)
    // triggers category activation and expands tools/list
    await client.callTool({
      name: 'chrome_history',
      arguments: { query: 'google' },
    });
    const afterAutoUnlock = await client.listTools();
    expect(afterAutoUnlock.tools.length).toBeGreaterThan(14);
    expect(afterAutoUnlock.tools.some((t: any) => t.name === 'chrome_history')).toBe(true);
    expect(afterAutoUnlock.tools.some((t: any) => t.name === 'chrome_bookmark_search')).toBe(true);

    await client.close();
  });

  test('Full MCP client lifecycle over SSE transport', async () => {
    const transport = new SSEClientTransport(
      new URL(`http://127.0.0.1:${TEST_PORT}/sse?token=${getBridgeToken()}`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${getBridgeToken()}` },
        },
      },
    );
    const client = new Client({ name: 'jest-sse-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);

    await client.close();
  });

  test('Concurrent MCP clients maintain isolated sessions and do not interfere', async () => {
    const tA = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${getBridgeToken()}` },
      },
    });
    const cA = new Client({ name: 'client-A', version: '1.0.0' }, { capabilities: {} });
    await cA.connect(tA);

    const tB = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${TEST_PORT}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${getBridgeToken()}` },
      },
    });
    const cB = new Client({ name: 'client-B', version: '1.0.0' }, { capabilities: {} });
    await cB.connect(tB);

    expect(tA.sessionId).toBeDefined();
    expect(tB.sessionId).toBeDefined();
    expect(tA.sessionId).not.toEqual(tB.sessionId);

    // Concurrent tool listing
    const [toolsA, toolsB] = await Promise.all([cA.listTools(), cB.listTools()]);
    expect(toolsA.tools.length).toBeGreaterThan(0);
    expect(toolsB.tools.length).toBeGreaterThan(0);

    // Closing client A does not affect client B
    await cA.close();
    const toolsBAfter = await cB.listTools();
    expect(toolsBAfter.tools.length).toBeGreaterThan(0);

    await cB.close();
  });

  describe('Security: CORS and Origin Whitelisting', () => {
    test('allows allowed extension ID origin', async () => {
      const allowedId = getAllowedExtensionIds()[0] || DEFAULT_EXTENSION_ID;
      const response = await supertest(Server.getInstance().server)
        .options('/mcp')
        .set('Origin', `chrome-extension://${allowedId}`)
        .set('Access-Control-Request-Method', 'POST');

      expect(response.headers['access-control-allow-origin']).toBe(
        `chrome-extension://${allowedId}`,
      );
    });

    test('rejects unauthorized extension ID origin', async () => {
      const response = await supertest(Server.getInstance().server)
        .options('/mcp')
        .set('Origin', 'chrome-extension://unauthorizedfakeextensionid12345678')
        .set('Access-Control-Request-Method', 'POST');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    test('rejects arbitrary external web origin', async () => {
      const response = await supertest(Server.getInstance().server)
        .options('/mcp')
        .set('Origin', 'https://malicious-site.com')
        .set('Access-Control-Request-Method', 'POST');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    test('allows local origin (127.0.0.1 and localhost)', async () => {
      const resLocalhost = await supertest(Server.getInstance().server)
        .options('/mcp')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST');

      expect(resLocalhost.headers['access-control-allow-origin']).toBe('http://localhost:3000');

      const res127 = await supertest(Server.getInstance().server)
        .options('/mcp')
        .set('Origin', 'http://127.0.0.1:8080')
        .set('Access-Control-Request-Method', 'POST');

      expect(res127.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8080');
    });
  });

  describe('Security: SSRF and Private IP Range Protection', () => {
    test('isPrivateOrBlockedIp flags loopback, RFC1918, CGNAT, and link-local addresses', () => {
      expect(isPrivateOrBlockedIp('127.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIp('127.8.9.1')).toBe(true);
      expect(isPrivateOrBlockedIp('10.0.0.5')).toBe(true);
      expect(isPrivateOrBlockedIp('10.200.1.1')).toBe(true);
      expect(isPrivateOrBlockedIp('172.16.0.1')).toBe(true);
      expect(isPrivateOrBlockedIp('172.31.255.1')).toBe(true);
      expect(isPrivateOrBlockedIp('192.168.0.1')).toBe(true);
      expect(isPrivateOrBlockedIp('169.254.169.254')).toBe(true);
      expect(isPrivateOrBlockedIp('::1')).toBe(true);
      expect(isPrivateOrBlockedIp('0:0:0:0:0:0:0:1')).toBe(true);
      expect(isPrivateOrBlockedIp('::')).toBe(true);
      expect(isPrivateOrBlockedIp('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIp('::ffff:7f00:1')).toBe(true);
      expect(isPrivateOrBlockedIp('0:0:0:0:0:ffff:7f00:1')).toBe(true);
      expect(isPrivateOrBlockedIp('2002:7f00:0001::')).toBe(true);
      expect(isPrivateOrBlockedIp('fe80::1')).toBe(true);
      expect(isPrivateOrBlockedIp('fc00::1')).toBe(true);

      expect(isPrivateOrBlockedIp('8.8.8.8')).toBe(false);
      expect(isPrivateOrBlockedIp('1.1.1.1')).toBe(false);
      expect(isPrivateOrBlockedIp('2607:f8b0:4005:805::200e')).toBe(false);
    });

    test('assertSafeUrl rejects non-http protocols and local/internal hosts', () => {
      expect(() => assertSafeUrl('file:///C:/Windows/win.ini')).toThrow(/Disallowed protocol/);
      expect(() => assertSafeUrl('ftp://example.com/file')).toThrow(/Disallowed protocol/);
      expect(() => assertSafeUrl('http://localhost:8080/')).toThrow(/forbidden/);
      expect(() => assertSafeUrl('http://localhost.:8080/')).toThrow(/forbidden/);
      expect(() => assertSafeUrl('http://server.local/api')).toThrow(/forbidden/);
      expect(() => assertSafeUrl('http://127.0.0.1:3000')).toThrow(/forbidden/);
      expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data')).toThrow(/forbidden/);
    });

    test('assertSafeUrlAsync rejects IP literals resolving to private space', async () => {
      await expect(assertSafeUrlAsync('http://127.0.0.1:8080')).rejects.toThrow(/forbidden/);
    });
  });

  describe('Security: Path Traversal & Sandbox Boundaries', () => {
    test('readBase64File and cleanupFile reject traversal outside temporary directory', async () => {
      const escapePath = path.resolve(os.tmpdir(), 'chrome-mcp-uploads', '..', 'arbitrary.txt');
      const readRes = await fileHandler.handleFileRequest({
        action: 'readBase64File',
        filePath: escapePath,
      });
      expect(readRes.success).toBe(false);
      expect(readRes.error).toMatch(/strictly within the temp directory/i);

      const cleanupRes = await fileHandler.handleFileRequest({
        action: 'cleanupFile',
        filePath: escapePath,
      });
      expect(cleanupRes.success).toBe(false);
      expect(cleanupRes.error).toMatch(/strictly within temp directory/i);

      const analyzeRes = await fileHandler.handleFileRequest({
        action: 'analyzeTrace',
        traceFilePath: escapePath,
      });
      expect(analyzeRes.success).toBe(false);
      expect(analyzeRes.error).toMatch(/strictly within the temp directory/i);
    });

    test('safeLookup rejects private and loopback destinations directly in DNS resolution', (done) => {
      safeLookup('127.0.0.1', {} as any, (err) => {
        expect(err).toBeInstanceOf(Error);
        expect(err?.message).toMatch(/SSRF Protection/i);

        safeLookup('localhost', {} as any, (err2) => {
          expect(err2).toBeInstanceOf(Error);
          expect(err2?.message).toMatch(/SSRF Protection/i);
          done();
        });
      });
    });

    test('safeLookup allows safe external addresses', (done) => {
      const dns = require('dns');
      const origLookup = dns.lookup;
      dns.lookup = (host: string, opts: any, cb: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        callback(null, [{ address: '93.184.216.34', family: 4 }]);
      };

      safeLookup('example.com', {} as any, (err, addr) => {
        dns.lookup = origLookup;
        try {
          expect(err).toBeNull();
          expect(addr).toBe('93.184.216.34');
          done();
        } catch (e) {
          done(e as any);
        }
      });
    });

    test('safeLookup returns ENOTFOUND on empty records', (done) => {
      const dns = require('dns');
      const origLookup = dns.lookup;
      dns.lookup = (host: string, opts: any, cb: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        callback(null, []);
      };

      safeLookup('nonexistent.example-empty-dns.com', {} as any, (err) => {
        dns.lookup = origLookup;
        try {
          expect(err).toBeInstanceOf(Error);
          expect((err as any).code).toBe('ENOTFOUND');
          done();
        } catch (e) {
          done(e as any);
        }
      });
    });

    test('saveBase64File rejects payloads exceeding MAX_DOWNLOAD_SIZE (50MB)', async () => {
      // Mock data exceeding MAX_DOWNLOAD_SIZE (50MB)
      const hugeBuffer = Buffer.alloc(MAX_DOWNLOAD_SIZE + 1024);
      const hugeBase64 = hugeBuffer.toString('base64');
      const res = await fileHandler.handleFileRequest({
        action: 'prepareFile',
        base64Data: hugeBase64,
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/exceeds limit of/i);
    }, 15000);

    test('readBase64File rejects reading files exceeding MAX_DOWNLOAD_SIZE (50MB)', async () => {
      const tempDir = path.join(os.tmpdir(), 'chrome-mcp-uploads');
      const testFile = path.join(tempDir, 'huge-existing.bin');
      const existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation(((p: any) => {
        if (p === testFile) return true;
        return (jest.requireActual('fs') as any).existsSync(p);
      }) as any);
      const statSpy = jest.spyOn(fs, 'statSync').mockImplementation(((p: any) => {
        if (p === testFile) {
          return { isFile: () => true, size: MAX_DOWNLOAD_SIZE + 2048 } as any;
        }
        return (jest.requireActual('fs') as any).statSync(p);
      }) as any);

      try {
        const res = await fileHandler.handleFileRequest({
          action: 'readBase64File',
          filePath: testFile,
        });
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/exceeds limit of/i);
      } finally {
        existsSpy.mockRestore();
        statSpy.mockRestore();
      }
    });
  });

  describe('Architecture: Admin Privilege Hardening', () => {
    test('checkIsAdmin executes without ESM dependency and returns boolean', () => {
      const result = checkIsAdmin();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('Architecture: Native Messaging Host Ceiling Defense', () => {
    test('sendRequestToExtensionAndWait immediately rejects requests exceeding 1MB ceiling without hanging', async () => {
      nativeMessagingHostInstance.isConnected = true;
      try {
        const hugePayload = 'x'.repeat(1024 * 1024 + 100);
        await expect(
          nativeMessagingHostInstance.sendRequestToExtensionAndWait(
            hugePayload,
            'test_request',
            1000,
          ),
        ).rejects.toThrow(/exceeds Chrome Native Messaging 1MB ceiling/i);
      } finally {
        nativeMessagingHostInstance.isConnected = false;
      }
    });
  });
});
