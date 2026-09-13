# Refactoring report — 2026-09-13

HTTP requests now accept the connector's OAuth access tokens through the same
authorization policy used for SSE revalidation. Unauthorized responses advertise
the resource metadata URL. Access tokens with the wrong resource or scope are rejected.

Session allocation, idle expiry, capacity limits and cleanup are isolated in
`src/transport/mcp-sessions.ts`. Sessions are capped at 128 and expire after 30
minutes of inactivity, with cleanup on the next MCP request.

The API client uses one retry loop for rate limits and token refresh, without
mutating its caller's options. Cache invalidation no longer lets an old request
remove a newer in-flight request. Invalid calendar datetimes are rejected before
upstream calls. Token files are replaced atomically through unique private files.

Other changes include complete CORS headers, OAuth form redirect origins, strict
port parsing, Railway PORT precedence, explicit declarations of existing runtime
dependencies, and Windows-compatible filesystem tests. Tool names, token paths
and token file formats are preserved.

Validation: 838 tests passed; type checking, ESLint and production build passed.
Coverage: 92.13% lines, 91.61% branches, 95.03% functions. Production npm audit
reported zero known vulnerabilities. Local runtime: Windows, Node 24.11.0.
CI now covers Linux and Windows with Node 20, 22 and 24.

Upstream responses are mocked in automated tests. The production deployment and
real client reconnection require separate post-deployment verification. Sessions
and refresh-token replay tracking remain process-local; legacy access tokens
without a resource claim remain supported. This refactoring does not add dynamic
client registration or durable OAuth state.

Run `npm run check` and `npm run test:coverage` to reproduce validation.
