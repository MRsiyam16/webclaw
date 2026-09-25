/**
 * HTTP Server - Core server implementation.
 *
 * Responsibilities:
 * - Fastify instance management
 * - Plugin registration (CORS, etc.)
 * - Route delegation to specialized modules
 * - MCP transport handling
 * - Server lifecycle management
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  NATIVE_SERVER_PORT,
  TIMEOUTS,
  SERVER_CONFIG,
  HTTP_STATUS,
  ERROR_MESSAGES,
  getAllowedExtensionIds,
} from '../constant';
import { NativeMessagingHost } from '../native-messaging-host';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpSessionManager } from '../mcp/session-manager';
import { NativeMessageType } from 'chrome-mcp-shared';
import { BROWSER_IDENTITY } from '../browser-identity';

import { resolveBridgeToken, getBridgeToken, isValidBridgeToken } from './token';
export { resolveBridgeToken, getBridgeToken, isValidBridgeToken };

export function safeWriteError(
  reply: FastifyReply,
  statusCode: number,
  payload: Record<string, unknown> | string,
): void {
  const raw = reply.raw;
  if (raw.writableEnded || raw.destroyed) {
    return;
  }
  if (raw.headersSent) {
    try {
      raw.end();
    } catch {
      // Socket already closed
    }
    return;
  }
  try {
    const body =
      typeof payload === 'string' ? JSON.stringify({ error: payload }) : JSON.stringify(payload);
    raw.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    raw.end(body);
  } catch {
    // Ignore network drop
  }
}

// ============================================================
// Types
// ============================================================

interface ExtensionRequestPayload {
  data?: unknown;
}

import { MediaAssetEntry, mediaAssetStore } from '../media-asset-store';
export { MediaAssetEntry, mediaAssetStore };

// ============================================================
// Server Class
// ============================================================

export class Server {
  private fastify: FastifyInstance;
  public isRunning = false;
  public port: number = BROWSER_IDENTITY.port;
  private nativeHost: NativeMessagingHost | null = null;

  constructor() {
    this.fastify = Fastify({ logger: SERVER_CONFIG.LOGGER_ENABLED });
    this.setupPlugins();
    this.setupRoutes();
  }

  /**
   * Associate NativeMessagingHost instance.
   */
  public setNativeHost(nativeHost: NativeMessagingHost): void {
    this.nativeHost = nativeHost;
  }

  private setupPlugins(): void {
    this.fastify.register(cors, {
      origin: (origin, cb) => {
        // Allow requests with no origin (e.g., curl, server-to-server)
        if (!origin) {
          return cb(null, true);
        }
        try {
          const parsed = new URL(origin);
          // Strict matching for browser extension origins
          if (parsed.protocol === 'chrome-extension:') {
            const extId = parsed.hostname.toLowerCase();
            const allowedIds = getAllowedExtensionIds().map((id) => id.toLowerCase());
            if (allowedIds.includes(extId)) {
              return cb(null, true);
            }
            return cb(null, false);
          }
          // Strict exact match for local hostnames; disallow prefix matching
          const host = parsed.hostname.toLowerCase();
          const configuredHost = SERVER_CONFIG.HOST.toLowerCase();
          if (
            host === '127.0.0.1' ||
            host === 'localhost' ||
            host === '::1' ||
            host === configuredHost
          ) {
            return cb(null, true);
          }
        } catch {
          return cb(null, false);
        }
        return cb(null, false);
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
    });

    // Global preHandler hook for Fastify 12306 token authorization
    this.fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      // 1. Allow CORS preflight requests
      if (request.method === 'OPTIONS') {
        return;
      }

      // 2. Allow health check endpoint (handshake) and temporary media asset streaming
      const pathOnly = (request.raw.url || request.url || '').split('?')[0];
      if (pathOnly === '/ping' || pathOnly.startsWith('/media-asset/')) {
        return;
      }

      const isLoopback =
        request.ip === '127.0.0.1' ||
        request.ip === '::1' ||
        request.socket.remoteAddress === '127.0.0.1' ||
        request.socket.remoteAddress === '::1' ||
        request.socket.remoteAddress === '::ffff:127.0.0.1';

      if (pathOnly === '/token' && isLoopback) {
        return;
      }

      // Mutual trust for local host Hermes agent / automation scripts on loopback
      const hasLocalTrust =
        isLoopback &&
        (request.headers['x-hermes-auth'] === 'local' ||
          request.headers['x-hermes-auth'] === 'true' ||
          request.headers['x-local-trust'] === 'true');

      if (hasLocalTrust && (pathOnly === '/eval' || pathOnly === '/execute-script')) {
        return;
      }

      // 3. Extract candidate token
      let candidateToken: string | undefined;
      const authHeader = request.headers['authorization'];
      if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        candidateToken = authHeader.slice(7).trim();
      } else if (typeof request.headers['x-mcp-token'] === 'string') {
        candidateToken = request.headers['x-mcp-token'].trim();
      } else if (typeof (request.query as any)?.token === 'string') {
        candidateToken = (request.query as any).token.trim();
      }

      if (candidateToken && isValidBridgeToken(candidateToken)) {
        return;
      }

      return reply.status(HTTP_STATUS.UNAUTHORIZED || 401).send({
        error: 'Unauthorized: Valid bridge token required. Provide Authorization: Bearer <token>',
      });
    });
  }

  private setupRoutes(): void {
    // Health check
    this.setupHealthRoutes();

    // Extension communication
    this.setupExtensionRoutes();

    // MCP routes
    this.setupMcpRoutes();
  }

  // ============================================================
  // Health Routes
  // ============================================================

  private setupHealthRoutes(): void {
    this.fastify.get('/ping', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(HTTP_STATUS.OK).send({
        status: 'ok',
        message: 'pong',
        browserId: BROWSER_IDENTITY.browserId,
        port: this.port,
      });
    });

    // GET /token: Return current active bridge token for loopback clients (Hermes, local scripts)
    this.fastify.get('/token', async (request: FastifyRequest, reply: FastifyReply) => {
      const isLoopback =
        request.ip === '127.0.0.1' ||
        request.ip === '::1' ||
        request.socket.remoteAddress === '127.0.0.1' ||
        request.socket.remoteAddress === '::1' ||
        request.socket.remoteAddress === '::ffff:127.0.0.1';

      if (!isLoopback) {
        return reply.status(HTTP_STATUS.FORBIDDEN || 403).send({
          error: 'Forbidden: /token is only accessible from local loopback (127.0.0.1)',
        });
      }

      return reply.status(HTTP_STATUS.OK).send({
        status: 'ok',
        token: getBridgeToken(),
      });
    });
  }

  // ============================================================
  // Extension Routes
  // ============================================================

  private setupExtensionRoutes(): void {
    this.fastify.get(
      '/ask-extension',
      async (request: FastifyRequest<{ Body: ExtensionRequestPayload }>, reply: FastifyReply) => {
        if (!this.nativeHost) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
        }
        if (!this.isRunning) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
        }

        try {
          const messageType = ((request.query as any)?.type as string) || 'process_data';
          const extensionResponse = await this.nativeHost.sendRequestToExtensionAndWait(
            request.query,
            messageType,
            TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
          );
          return reply.status(HTTP_STATUS.OK).send({ status: 'success', data: extensionResponse });
        } catch (error: unknown) {
          const err = error as Error;
          if (err.message.includes('timed out')) {
            return reply
              .status(HTTP_STATUS.GATEWAY_TIMEOUT)
              .send({ status: 'error', message: ERROR_MESSAGES.REQUEST_TIMEOUT });
          } else {
            return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
              status: 'error',
              message: `Failed to get response from extension: ${err.message}`,
            });
          }
        }
      },
    );

    // GET /agent-control: Query current Agent Control switch status
    this.fastify.get('/agent-control', async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!this.nativeHost) {
        return reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
      }
      if (!this.isRunning) {
        return reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
      }

      try {
        const response = await this.nativeHost.sendRequestToExtensionAndWait(
          {},
          'get_agent_control',
          TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
        );
        const enabled = response?.agentControlEnabled !== false;
        return reply.status(HTTP_STATUS.OK).send({ status: 'success', enabled });
      } catch (error: unknown) {
        const err = error as Error;
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          status: 'error',
          message: `Failed to query agent control: ${err.message}`,
        });
      }
    });

    // POST /agent-control: Update Agent Control switch status
    this.fastify.post(
      '/agent-control',
      async (request: FastifyRequest<{ Body: { enabled?: unknown } }>, reply: FastifyReply) => {
        if (!this.nativeHost) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
        }
        if (!this.isRunning) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
        }

        try {
          const raw = (request.body as any)?.enabled;
          const enabled = raw === true || raw === 'true' || raw === 1 || raw === '1';
          const response = await this.nativeHost.sendRequestToExtensionAndWait(
            { enabled },
            'set_agent_control',
            TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
          );
          return reply.status(HTTP_STATUS.OK).send({
            status: 'success',
            enabled: response?.agentControlEnabled ?? enabled,
          });
        } catch (error: unknown) {
          const err = error as Error;
          return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
            status: 'error',
            message: `Failed to set agent control: ${err.message}`,
          });
        }
      },
    );

    // POST /reload-extension: Hot reload extension from disk
    this.fastify.post(
      '/reload-extension',
      async (_request: FastifyRequest, reply: FastifyReply) => {
        if (!this.nativeHost) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
        }
        try {
          const response = await this.nativeHost.sendRequestToExtensionAndWait(
            {},
            'reload_extension',
            TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
          );
          return reply.status(HTTP_STATUS.OK).send(response);
        } catch (error: unknown) {
          const err = error as Error;
          return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
            status: 'error',
            message: `Failed to reload extension: ${err.message}`,
          });
        }
      },
    );

    // GET /media-asset/:assetId: Stream media asset for extension chrome_insert_media
    this.fastify.get(
      '/media-asset/:assetId',
      async (request: FastifyRequest<{ Params: { assetId: string } }>, reply: FastifyReply) => {
        const { assetId } = request.params;
        const entry = mediaAssetStore.get(assetId);
        if (!entry) {
          return reply.status(404).send({ error: 'Media asset not found or expired' });
        }
        reply.header('Content-Type', entry.mimeType || 'application/octet-stream');
        reply.header('Content-Disposition', `inline; filename="${entry.fileName}"`);
        if (entry.buffer) {
          return reply.send(entry.buffer);
        }
        if (entry.filePath) {
          const fs = await import('fs');
          return reply.send(fs.createReadStream(entry.filePath));
        }
        return reply.status(404).send({ error: 'No media content' });
      },
    );

    // POST /eval and POST /execute-script: High-privilege script evaluation for local Hermes / scripts
    const handleScriptEval = async (
      request: FastifyRequest<{ Body: { script: string; tabId?: number; timeoutMs?: number } }>,
      reply: FastifyReply,
    ) => {
      if (!this.nativeHost) {
        return reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
      }
      if (!this.isRunning) {
        return reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
      }

      const script = (request.body as any)?.script ?? (request.body as any)?.code;
      if (!script || typeof script !== 'string') {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST || 400)
          .send({ error: 'script or code parameter is required in request body' });
      }

      try {
        const timeoutMs = (request.body as any)?.timeoutMs || 30000;
        const response = await this.nativeHost.sendRequestToExtensionAndWait(
          {
            name: 'chrome_javascript',
            args: {
              code: script,
              script,
              ...((request.body as any)?.tabId ? { tabId: (request.body as any).tabId } : {}),
            },
          },
          NativeMessageType.CALL_TOOL,
          timeoutMs,
        );
        return reply.status(HTTP_STATUS.OK).send({ status: 'success', data: response });
      } catch (error: unknown) {
        const err = error as Error;
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          status: 'error',
          message: `Failed to evaluate script: ${err.message}`,
        });
      }
    };

    this.fastify.post('/eval', handleScriptEval);
    this.fastify.post('/execute-script', handleScriptEval);
  }

  // ============================================================
  // MCP Routes
  // ============================================================

  private setupMcpRoutes(): void {
    // SSE endpoint
    this.fastify.get('/sse', async (req, reply) => {
      reply.hijack();
      try {
        const transport = new SSEServerTransport('/messages', reply.raw);
        const { sessionId } = await mcpSessionManager.createSession(transport, transport.sessionId);
        reply.raw.on('close', () => {
          mcpSessionManager.closeSession(sessionId).catch(() => {});
        });
        req.raw.on('close', () => {
          mcpSessionManager.closeSession(sessionId).catch(() => {});
        });
      } catch (error) {
        safeWriteError(
          reply,
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        );
      }
    });

    // SSE messages endpoint
    this.fastify.post('/messages', async (req, reply) => {
      reply.hijack();
      try {
        const { sessionId } = req.query as { sessionId?: string };
        const session = sessionId ? mcpSessionManager.getSession(sessionId) : undefined;
        const transport = session?.transport as SSEServerTransport | undefined;
        if (!sessionId || !transport) {
          safeWriteError(reply, HTTP_STATUS.BAD_REQUEST, 'No transport found for sessionId');
          return;
        }

        await transport.handlePostMessage(req.raw, reply.raw, req.body);
      } catch (error) {
        safeWriteError(
          reply,
          HTTP_STATUS.INTERNAL_SERVER_ERROR,
          ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        );
      }
    });

    // MCP POST endpoint
    this.fastify.post('/mcp', async (request, reply) => {
      reply.hijack();
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? mcpSessionManager.getSession(sessionId) : undefined;
      let transport: StreamableHTTPServerTransport | undefined = session?.transport as
        StreamableHTTPServerTransport | undefined;

      const body = request.body;
      const isInit = Array.isArray(body)
        ? body.some(isInitializeRequest)
        : isInitializeRequest(body);

      if (!transport && !sessionId && isInit) {
        const newSessionId = randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
        });
        await mcpSessionManager.createSession(transport, newSessionId);
      } else if (!transport) {
        const status = sessionId ? HTTP_STATUS.NOT_FOUND : HTTP_STATUS.BAD_REQUEST;
        const message = sessionId
          ? ERROR_MESSAGES.INVALID_SESSION_ID
          : ERROR_MESSAGES.INVALID_MCP_REQUEST;
        const hint = !sessionId
          ? 'MCP 2024-11-05 Streamable HTTP transport requires an initialize handshake first, followed by passing the mcp-session-id header on subsequent requests.'
          : 'The specified MCP session ID was not found or has expired. Please re-initialize.';
        safeWriteError(reply, status, { error: message, hint });
        return;
      }

      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        safeWriteError(reply, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
          error: ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR,
        });
      }
    });

    // MCP GET endpoint (SSE stream)
    this.fastify.get('/mcp', async (request, reply) => {
      reply.hijack();
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? mcpSessionManager.getSession(sessionId) : undefined;
      const transport = session?.transport as StreamableHTTPServerTransport | undefined;

      if (!transport) {
        safeWriteError(reply, HTTP_STATUS.BAD_REQUEST, {
          error: ERROR_MESSAGES.INVALID_SSE_SESSION,
        });
        return;
      }

      try {
        await transport.handleRequest(request.raw, reply.raw);
      } catch (error) {
        if (!reply.raw.writableEnded) {
          try {
            reply.raw.end();
          } catch {}
        }
      }

      request.socket.on('close', () => {
        request.log.info(`SSE client disconnected for session: ${sessionId}`);
      });
    });

    // MCP DELETE endpoint
    this.fastify.delete('/mcp', async (request, reply) => {
      reply.hijack();
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? mcpSessionManager.getSession(sessionId) : undefined;
      const transport = session?.transport as StreamableHTTPServerTransport | undefined;

      if (!transport) {
        safeWriteError(reply, HTTP_STATUS.NOT_FOUND, { error: ERROR_MESSAGES.INVALID_SESSION_ID });
        return;
      }

      try {
        await transport.handleRequest(request.raw, reply.raw);
        if (!reply.raw.writableEnded && !reply.raw.headersSent) {
          reply.raw.writeHead(HTTP_STATUS.NO_CONTENT);
          reply.raw.end();
        } else if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      } catch (error) {
        safeWriteError(reply, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
          error: ERROR_MESSAGES.MCP_SESSION_DELETION_ERROR,
        });
      } finally {
        if (sessionId) {
          await mcpSessionManager.closeSession(sessionId);
        }
      }
    });
  }

  // ============================================================
  // Server Lifecycle
  // ============================================================

  public async start(port = NATIVE_SERVER_PORT, nativeHost: NativeMessagingHost): Promise<void> {
    if (!this.nativeHost) {
      this.nativeHost = nativeHost;
    } else if (this.nativeHost !== nativeHost) {
      this.nativeHost = nativeHost;
    }

    if (this.isRunning) {
      return;
    }

    try {
      const token = resolveBridgeToken();

      await this.fastify.listen({ port, host: SERVER_CONFIG.HOST });
      this.port = port;

      // Set port environment variables after successful listen for Chrome MCP URL resolution
      process.env.CHROME_MCP_PORT = String(port);
      process.env.MCP_HTTP_PORT = String(port);
      process.env.CHROME_MCP_TOKEN = token;

      this.isRunning = true;
    } catch (err) {
      this.isRunning = false;
      throw err;
    }
  }

  public async stop(): Promise<void> {
    try {
      await mcpSessionManager.closeAllSessions();
      if (this.fastify.server) {
        if (typeof (this.fastify.server as any).closeAllConnections === 'function') {
          (this.fastify.server as any).closeAllConnections();
        }
        if (typeof (this.fastify.server as any).closeIdleConnections === 'function') {
          (this.fastify.server as any).closeIdleConnections();
        }
      }
      if (this.isRunning || (this.fastify.server && (this.fastify.server as any).listening)) {
        await this.fastify.close();
      }
      this.isRunning = false;
    } catch (err) {
      this.isRunning = false;
      throw err;
    }
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }
}

const serverInstance = new Server();
export default serverInstance;
