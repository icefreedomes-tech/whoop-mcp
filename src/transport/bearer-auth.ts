import { createHash, timingSafeEqual } from "node:crypto";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";

export function safeTokenCompare(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest()
  );
}

/** One policy for HTTP requests and long-lived SSE connections. */
export function createBearerValidator(
  authToken: string,
  provider: Pick<OAuthServerProvider, "verifyAccessToken">,
  resourceUrl: URL
): (token: string) => Promise<boolean> {
  return async (token) => {
    if (safeTokenCompare(token, authToken)) return true;
    try {
      const auth = await provider.verifyAccessToken(token);
      return (
        auth.scopes.includes("mcp") &&
        (auth.resource === undefined || auth.resource.href === resourceUrl.href)
      );
    } catch {
      return false;
    }
  };
}
