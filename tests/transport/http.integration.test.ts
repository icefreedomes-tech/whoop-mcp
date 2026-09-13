/**
 * End-to-end integration test for HTTP transport.
 *
 * Exercises the full MCP wire protocol — initialize → tools/list → tools/call —
 * over the real HTTP transport with a real McpServer wired to `get_profile`.
 * The underlying WHOOP API is mocked at the global `fetch` level so no
 * external network call is made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer, type HttpServerResult } from "../../src/transport/http.js";
import { createWhoopClient } from "../../src/api/client.js";
import { createWhoopServer } from "../../src/server.js";
import type { UserProfile } from "../../src/api/types.js";
import { createBearerValidator } from "../../src/transport/bearer-auth.js";
import { createOAuthApp } from "../../src/transport/oauth-connector.js";
import { signToken } from "../../src/transport/oauth-jwt.js";
import { createHash } from "node:crypto";

const AUTH_TOKEN = "integration-test-token-1234567890abcdef";

const PROFILE_FIXTURE: UserProfile = {
  user_id: 12345,
  email: "athlete@example.com",
  first_name: "Test",
  last_name: "Athlete",
};

function getServerUrl(http: HttpServerResult): URL {
  const addr = http.server.address();
  if (!addr || typeof addr === "string") throw new Error("server not listening");
  return new URL(`http://127.0.0.1:${addr.port}/mcp`);
}

describe("HTTP transport — MCP integration", () => {
  let httpResult: HttpServerResult | null = null;
  let client: Client | null = null;
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    // Intercept only WHOOP API calls; pass through localhost so the MCP
    // client transport (which also uses fetch) reaches our HTTP server.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("https://api.prod.whoop.com")) {
          return new Response(JSON.stringify(PROFILE_FIXTURE), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return realFetch(input as Parameters<typeof realFetch>[0], init);
      })
    );
  });

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => {});
      client = null;
    }
    if (httpResult) {
      await httpResult.close().catch(() => {});
      httpResult = null;
    }
    vi.unstubAllGlobals();
  });

  it("initialize → tools/list → tools/call get_profile returns mocked WHOOP data", async () => {
    // Wire a real WhoopClient + McpServer behind the HTTP transport.
    const whoopClient = createWhoopClient({ accessToken: "fake-access-token" });

    httpResult = await createHttpServer({
      createMcpServer: () => createWhoopServer(whoopClient, { disableResources: true }).server,
      authToken: AUTH_TOKEN,
      port: 0,
      host: "127.0.0.1",
      sseReauthIntervalMs: 0,
    });

    client = new Client({ name: "integration-test-client", version: "0.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(getServerUrl(httpResult), {
      requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
    });
    await client.connect(clientTransport);

    const toolList = await client.listTools();
    const profileTool = toolList.tools.find((t) => t.name === "get_profile");
    expect(profileTool).toBeDefined();

    const result = await client.callTool({ name: "get_profile", arguments: {} });
    expect(result.isError).not.toBe(true);

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    const payload = JSON.parse(content[0]?.text ?? "{}") as UserProfile;
    expect(payload).toEqual(PROFILE_FIXTURE);
  });

  it("accepts connector-issued JWTs through the HTTP transport", async () => {
    const secret = new TextEncoder().encode("a".repeat(32));
    const oauth = createOAuthApp({
      connectorPassword: "a-long-test-password",
      publicUrl: "https://whoop.example",
      allowedRedirectUris: ["https://claude.ai/cb"],
      jwtSecret: secret,
      scopes: ["mcp"],
      client: { clientId: "test", clientName: "test", redirectUris: ["https://claude.ai/cb"] },
    });
    try {
      httpResult = await createHttpServer({
        createMcpServer: () =>
          createWhoopServer(createWhoopClient({ accessToken: "upstream" })).server,
        authToken: AUTH_TOKEN,
        port: 0,
        host: "127.0.0.1",
        sseReauthIntervalMs: 0,
        validateBearerToken: createBearerValidator(
          AUTH_TOKEN,
          oauth.provider,
          new URL("https://whoop.example/mcp")
        ),
        oauthHandler: oauth.app,
        resourceMetadataUrl: "https://whoop.example/.well-known/oauth-protected-resource/mcp",
      });
      const base = getServerUrl(httpResult).origin;
      const unauthenticated = await fetch(`${base}/mcp`);
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("www-authenticate")).toContain("resource_metadata=");
      await unauthenticated.text();
      const verifier = "a".repeat(43);
      const authorized = await fetch(`${base}/authorize`, {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({
          client_id: "test",
          redirect_uri: "https://claude.ai/cb",
          response_type: "code",
          scope: "mcp",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          connector_password: "a-long-test-password",
          resource: "https://whoop.example/mcp",
        }),
      });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;
      await authorized.text();
      const exchanged = await fetch(`${base}/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "test",
          code,
          code_verifier: verifier,
          redirect_uri: "https://claude.ai/cb",
          resource: "https://whoop.example/mcp",
        }),
      });
      expect(exchanged.status).toBe(200);
      const { access_token: jwt } = (await exchanged.json()) as { access_token: string };
      client = new Client({ name: "oauth-integration", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(getServerUrl(httpResult), {
          requestInit: { headers: { Authorization: `Bearer ${jwt}` } },
        })
      );
      expect((await client.callTool({ name: "get_profile", arguments: {} })).isError).not.toBe(
        true
      );
      const wrongResource = await signToken(
        {
          clientId: "test",
          scopes: ["mcp"],
          type: "access",
          ttlSeconds: 60,
          resource: "https://other.example/mcp",
        },
        secret
      );
      const rejected = await fetch(`${base}/mcp`, {
        headers: { Authorization: `Bearer ${wrongResource}` },
      });
      expect(rejected.status).toBe(401);
      await rejected.text();
    } finally {
      oauth.close();
    }
  });
});
