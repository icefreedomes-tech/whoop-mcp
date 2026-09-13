/**
 * HTTP transport for the WHOOP MCP server.
 *
 * Provides bearer-token authenticated HTTP access to the MCP server
 * using the SDK's StreamableHTTPServerTransport.
 *
 * All logging goes to stderr — stdout is reserved for stdio MCP channel.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { safeTokenCompare } from "./bearer-auth.js";
export { safeTokenCompare } from "./bearer-auth.js";
import { createMcpSessions, type SessionOptions } from "./mcp-sessions.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpServerOptions extends SessionOptions {
  /**
   * Factory producing a fresh MCP server for each new session. One server
   * instance may only be connected to one transport, so a remote deployment
   * serving several concurrent clients needs one of each per session.
   */
  createMcpServer: () => McpServer;
  /** Bearer token required for /mcp routes */
  authToken: string;
  /** Port to listen on (0 = dynamic, used in tests) */
  port: number;
  /** Hostname to bind to (default: 0.0.0.0) */
  host?: string;
  /** Maximum concurrent connections (default: 5) */
  maxConnections?: number;
  /** Allowed CORS origins (default: deny all) */
  allowedOrigins?: string[];
  /** Whether to trust proxy headers (default: false) */
  trustProxy?: boolean;
  /**
   * Optional async probe used by GET /health (with valid bearer) to report
   * upstream WHOOP API status. Resolves true if reachable, false otherwise.
   * Probe failures are caught and reported as `whoopApi: "error"`.
   */
  healthCheck?: () => Promise<boolean>;
  /**
   * Optional handler for OAuth-related routes. When provided, requests whose
   * pathname starts with `/authorize`, `/token`, `/register`, or
   * `/.well-known/` are forwarded to it (typically an Express app from
   * `createOAuthApp`). Allows the connector + MCP transport to share a port.
   */
  oauthHandler?: (req: IncomingMessage, res: ServerResponse) => void;
  /**
   * Per-IP rate limit for /mcp (default: 100 requests / 60s window).
   * Set both to 0 to disable.
   */
  mcpRateLimit?: { windowMs: number; max: number };
  /**
   * SSE re-validation interval in ms (default: 5 * 60 * 1000 = 5 min).
   * Active /mcp GET (SSE) connections whose bearer token no longer matches
   * are terminated. Set to 0 to disable.
   */
  sseReauthIntervalMs?: number;
  /** Complete auth policy for requests and SSE revalidation; defaults to the static token. */
  validateBearerToken?: (token: string) => boolean | Promise<boolean>;
  /** OAuth discovery URL advertised when authentication is required. */
  resourceMetadataUrl?: string;
  /**
   * Receives a warning for every /mcp request from an authenticated client that
   * is answered with a 4xx or 5xx status.
   */
  logger?: Pick<Logger, "warn">;
}

export interface HttpServerResult {
  server: Server;
  /** Number of live MCP sessions currently held open */
  sessionCount: () => number;
  /** Gracefully close the server and drain connections */
  close: () => Promise<void>;
}

export interface HealthResponse {
  status: "ok";
  uptime?: number;
  version?: string;
  /** Upstream WHOOP API reachability — only present on authed /health */
  whoopApi?: "ok" | "error" | "unknown";
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

// ---------------------------------------------------------------------------
// CORS handling
// ---------------------------------------------------------------------------

function handleCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): boolean {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version"
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(origin && allowedOrigins.includes(origin) ? 204 : 403);
    res.end();
    return true; // request fully handled
  }

  return false; // not a preflight, continue processing
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** JSON-RPC method names in a parsed body, for logging. Never params. */
function rpcMethodsOf(body: unknown): string[] {
  const messages = Array.isArray(body) ? body.slice(0, 10) : [body];
  return messages.map((message) =>
    message !== null &&
    typeof message === "object" &&
    "method" in message &&
    typeof message.method === "string"
      ? message.method.slice(0, 64)
      : "(none)"
  );
}

// ---------------------------------------------------------------------------
// Body parser (reads raw body for POST requests)
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1024 * 1024; // 1MB limit

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// createHttpServer
// ---------------------------------------------------------------------------

/**
 * Create an HTTP server with bearer-token auth for the MCP transport.
 *
 * The server exposes:
 * - POST /mcp — MCP protocol (requires bearer token)
 * - GET /mcp — SSE stream (requires bearer token)
 * - DELETE /mcp — Session termination (requires bearer token)
 * - GET /health — Health check (public: basic, authed: detailed)
 *
 * @throws Error if authToken is empty
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerResult> {
  const {
    createMcpServer,
    authToken,
    port,
    host = "0.0.0.0",
    maxConnections = 5,
    allowedOrigins = [],
    trustProxy = false,
    healthCheck,
    oauthHandler,
    mcpRateLimit = { windowMs: 60_000, max: 100 },
    sseReauthIntervalMs = 5 * 60 * 1000,
    validateBearerToken,
    logger,
  } = options;

  async function isAuthorized(token: string | null): Promise<boolean> {
    if (!token) return false;
    try {
      return validateBearerToken
        ? await validateBearerToken(token)
        : safeTokenCompare(token, authToken);
    } catch {
      return false;
    }
  }

  if (!authToken) {
    throw new Error(
      "MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http or MCP_TRANSPORT=both. " +
        "Set it to a secure random string (32+ characters recommended)."
    );
  }

  // Track active connections for limiting
  let activeConnections = 0;
  const startTime = Date.now();

  // Per-IP fixed-window rate limiter for /mcp (no extra deps).
  const mcpRateBuckets = new Map<string, { count: number; resetAt: number }>();
  let nextBucketSweep = 0;
  function checkMcpRateLimit(ip: string): boolean {
    if (mcpRateLimit.max <= 0 || mcpRateLimit.windowMs <= 0) return true;
    const now = Date.now();
    if (now >= nextBucketSweep) {
      for (const [key, entry] of mcpRateBuckets) {
        if (entry.resetAt <= now) mcpRateBuckets.delete(key);
      }
      nextBucketSweep = now + mcpRateLimit.windowMs;
    }
    const bucket = mcpRateBuckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      mcpRateBuckets.set(ip, { count: 1, resetAt: now + mcpRateLimit.windowMs });
      return true;
    }
    if (bucket.count >= mcpRateLimit.max) return false;
    bucket.count++;
    return true;
  }

  function clientIp(req: IncomingMessage): string {
    if (trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      if (typeof xff === "string" && xff.length > 0) {
        const nearest = xff.split(",").at(-1)?.trim();
        if (nearest) return nearest;
      }
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  // Track live SSE responses so we can re-validate the bearer token periodically.
  const sseConnections = new Set<{ res: ServerResponse; token: string }>();
  let sseTimer: NodeJS.Timeout | null = null;
  if (sseReauthIntervalMs > 0) {
    sseTimer = setInterval(() => {
      for (const c of sseConnections) {
        void isAuthorized(c.token).then((valid) => {
          if (!valid) {
            c.res.end();
            sseConnections.delete(c);
          }
        });
      }
    }, sseReauthIntervalMs);
    sseTimer.unref();
  }

  const sessions = createMcpSessions(createMcpServer, options);

  function sessionIdOf(req: IncomingMessage): string | undefined {
    const raw = req.headers["mcp-session-id"];
    if (typeof raw === "string") return raw.length > 0 ? raw : undefined;
    if (Array.isArray(raw)) return raw[0];
    return undefined;
  }

  // Create HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // CORS handling
    if (handleCors(req, res, allowedOrigins)) {
      return; // preflight handled
    }

    // Route: /health
    if (pathname === "/health") {
      const token = extractBearerToken(req);
      const isAuthed = await isAuthorized(token);

      const health: HealthResponse = { status: "ok" };
      if (isAuthed) {
        health.uptime = Math.floor((Date.now() - startTime) / 1000);
        if (healthCheck) {
          try {
            health.whoopApi = (await healthCheck()) ? "ok" : "error";
          } catch {
            health.whoopApi = "error";
          }
        } else {
          health.whoopApi = "unknown";
        }
      }
      sendJson(res, 200, health);
      return;
    }

    // OAuth connector routes — forward to mounted handler if configured
    if (
      oauthHandler &&
      (pathname === "/authorize" ||
        pathname === "/token" ||
        pathname === "/register" ||
        pathname.startsWith("/.well-known/"))
    ) {
      oauthHandler(req, res);
      return;
    }

    // Route: /mcp (all methods)
    if (pathname === "/mcp") {
      // Auth check
      const token = extractBearerToken(req);
      if (!token || !(await isAuthorized(token))) {
        if (options.resourceMetadataUrl) {
          res.setHeader(
            "WWW-Authenticate",
            `Bearer resource_metadata="${options.resourceMetadataUrl}"`
          );
        }
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      // Clients such as claude.ai report a rejected request as a failed tool
      // call, and the response body is gone by the time anyone investigates.
      // Log protocol metadata only; unauthenticated noise is skipped above.
      let parsedBody: unknown = undefined;
      const arrivingSessionId = sessionIdOf(req);
      const sessionKnownOnArrival =
        arrivingSessionId !== undefined && sessions.has(arrivingSessionId);
      if (logger) {
        res.on("finish", () => {
          if (res.statusCode < 400) return;
          const protocolVersion = req.headers["mcp-protocol-version"];
          logger.warn("mcp request rejected", {
            status: res.statusCode,
            httpMethod: req.method,
            rpcMethods: rpcMethodsOf(parsedBody),
            sessionIdPresent: arrivingSessionId !== undefined,
            sessionKnown: sessionKnownOnArrival,
            protocolVersion:
              typeof protocolVersion === "string" ? protocolVersion.slice(0, 32) : null,
          });
        });
      }

      // Per-IP rate limit (100/min default)
      if (!checkMcpRateLimit(clientIp(req))) {
        res.setHeader("Retry-After", String(Math.ceil(mcpRateLimit.windowMs / 1000)));
        sendJson(res, 429, { error: "Too Many Requests" });
        return;
      }

      // Connection limit check
      if (activeConnections >= maxConnections) {
        sendJson(res, 503, {
          error: "Service Unavailable",
          message: "Maximum connections reached",
        });
        return;
      }

      // Track connection
      activeConnections++;
      const sseEntry = { res, token };
      if (req.method === "GET") {
        sseConnections.add(sseEntry);
      }
      res.on("close", () => {
        activeConnections--;
        sseConnections.delete(sseEntry);
      });

      // Parse body for POST requests
      if (req.method === "POST") {
        try {
          const rawBody = await readBody(req);
          parsedBody = JSON.parse(rawBody) as unknown;
        } catch {
          sendJson(res, 400, { error: "Bad Request", message: "Invalid JSON body" });
          // res.on("close") handles activeConnections decrement
          return;
        }
      }

      // Route to the session named by the header, or open one on initialize
      try {
        await sessions.handle(req, res, parsedBody);
      } catch {
        // If response hasn't been sent yet
        if (!res.headersSent) {
          sendJson(res, 500, { error: "Internal Server Error", message: "Internal server error" });
        }
      }
      return;
    }

    // Unknown routes
    sendJson(res, 404, { error: "Not Found" });
  });

  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch((error: unknown) => {
    if (sseTimer) clearInterval(sseTimer);
    throw error;
  });

  // Graceful shutdown
  const close = async (): Promise<void> => {
    if (sseTimer) {
      clearInterval(sseTimer);
      sseTimer = null;
    }
    await sessions.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return { server, sessionCount: sessions.size, close };
}
