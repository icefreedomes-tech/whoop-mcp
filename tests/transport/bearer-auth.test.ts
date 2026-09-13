import { describe, expect, it } from "vitest";
import { createBearerValidator } from "../../src/transport/bearer-auth.js";
import { OAuthConnectorProvider } from "../../src/transport/oauth-connector.js";
import { signToken } from "../../src/transport/oauth-jwt.js";

describe("connector bearer authorization", () => {
  it("accepts access JWTs and static tokens, rejects wrong grants, expiry and refresh tokens", async () => {
    const secret = new TextEncoder().encode("a".repeat(32));
    const provider = new OAuthConnectorProvider({
      client: { clientId: "test", clientName: "test", redirectUris: ["https://claude.ai/cb"] },
      allowedRedirectUris: ["https://claude.ai/cb"],
      jwtSecret: secret,
      scopes: ["mcp"],
    });
    const resource = new URL("https://whoop.example/mcp");
    const validate = createBearerValidator("static-token", provider, resource);
    const defaults = { clientId: "test", scopes: ["mcp"], type: "access" as const, ttlSeconds: 60 };
    try {
      expect(await validate("static-token")).toBe(true);
      expect(await validate(await signToken(defaults, secret))).toBe(true);
      expect(
        await validate(await signToken({ ...defaults, resource: resource.href }, secret))
      ).toBe(true);
      for (const overrides of [
        { resource: "https://other.example/mcp" },
        { scopes: [] },
        { type: "refresh" as const },
        { ttlSeconds: -1 },
      ]) {
        expect(await validate(await signToken({ ...defaults, ...overrides }, secret))).toBe(false);
      }
      expect(await validate("invalid.jwt")).toBe(false);
    } finally {
      provider.stop();
    }
  });
});
