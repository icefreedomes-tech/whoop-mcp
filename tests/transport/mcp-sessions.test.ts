import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpSessions } from "../../src/transport/mcp-sessions.js";

describe("MCP session lifecycle over HTTP", () => {
  it("limits sessions, releases deleted sessions, expires idle sessions and cleans rejected initialization", async () => {
    const sessions = createMcpSessions(() => new McpServer({ name: "test", version: "1" }), {
      maxSessions: 1,
    });
    const http = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      await sessions.handle(req, res, text ? (JSON.parse(text) as unknown) : undefined);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    async function initialize(): Promise<Response> {
      const response = await fetch(url, { method: "POST", headers, body });
      await response.text();
      return response;
    }
    try {
      const rejected = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      await rejected.text();
      expect(rejected.status).toBe(406);
      expect(sessions.size()).toBe(0);
      const first = await initialize();
      expect(first.status).toBe(200);
      const firstId = first.headers.get("mcp-session-id")!;
      expect((await initialize()).status).toBe(503);
      expect(sessions.size()).toBe(1);
      const deleted = await fetch(url, {
        method: "DELETE",
        headers: { ...headers, "mcp-session-id": firstId },
      });
      await deleted.text();
      expect(deleted.status).toBe(200);
      expect(sessions.size()).toBe(0);
      const second = await initialize();
      expect(second.status).toBe(200);
      const secondId = second.headers.get("mcp-session-id")!;
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
      expect((await initialize()).status).toBe(200);
      expect(sessions.has(secondId)).toBe(false);
      expect(sessions.size()).toBe(1);
      const stale = await fetch(url, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": secondId },
        body,
      });
      await stale.text();
      expect(stale.status).toBe(404);
    } finally {
      vi.restoreAllMocks();
      await sessions.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
    expect(sessions.size()).toBe(0);
  });
});
