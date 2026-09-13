import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export interface SessionOptions {
  maxSessions?: number;
  sessionIdleMs?: number;
}

/** Owns session allocation, expiry and disposal independently of HTTP auth. */
export function createMcpSessions(
  createServer: () => McpServer,
  options: SessionOptions = {}
): {
  size: () => number;
  has: (id: string) => boolean;
  handle: (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void>;
  close: () => Promise<void>;
} {
  const max = options.maxSessions ?? 128;
  const idleMs = options.sessionIdleMs ?? 30 * 60_000;
  if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(idleMs) || idleMs < 1) {
    throw new Error("Session limits must be positive integers.");
  }
  type Session = {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
    lastUsed: number;
    active: number;
  };
  const sessions = new Map<string, Session>();
  let pending = 0;
  let closed = false;

  async function dispose(session: Session): Promise<void> {
    const id = session.transport.sessionId;
    if (id) sessions.delete(id);
    await session.server.close().catch(() => {});
    await session.transport.close().catch(() => {});
  }

  function error(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  }

  async function handle(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void> {
    if (closed) {
      error(res, 503, "Server is shutting down.");
      return;
    }
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (session.active === 0 && now - session.lastUsed >= idleMs) await dispose(session);
    }
    const rawId = req.headers["mcp-session-id"];
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (id) {
      const session = sessions.get(id);
      if (!session) {
        error(res, 404, "Unknown or expired MCP session. Re-initialize.");
        return;
      }
      session.active++;
      try {
        await session.transport.handleRequest(req, res, body);
      } finally {
        session.active--;
        session.lastUsed = Date.now();
      }
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(body)) {
      error(res, 400, "Missing Mcp-Session-Id header. Send an initialize request first.");
      return;
    }
    if (sessions.size + pending >= max) {
      res.setHeader("Retry-After", "60");
      error(res, 503, "Maximum MCP sessions reached. Close an unused session and retry.");
      return;
    }
    pending++;
    let session: Session | undefined;
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          if (session && !closed) sessions.set(sessionId, session);
        },
      });
      session = { server, transport, lastUsed: now, active: 1 };
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      pending--;
      if (session) {
        session.active--;
        session.lastUsed = Date.now();
        if (!session.transport.sessionId || !sessions.has(session.transport.sessionId))
          await dispose(session);
      }
    }
  }

  return {
    size: () => sessions.size,
    has: (id) => sessions.has(id),
    handle,
    close: async () => {
      closed = true;
      await Promise.all([...sessions.values()].map(dispose));
    },
  };
}
