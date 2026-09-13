import { describe, expect, it, vi, afterEach } from "vitest";
import { MemoryCache } from "../src/cache/memory-cache.js";
import { createWhoopClient } from "../src/api/client.js";
import { resolveDateExpression } from "../src/tools/date-utils.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("refactor regressions", () => {
  it("keeps deduplicating the new generation when an old fetch finishes", async () => {
    const cache = new MemoryCache();
    let first!: (n: number) => void;
    let second!: (n: number) => void;
    const old = cache.getOrFetch(
      "key",
      1000,
      () =>
        new Promise<number>((r) => {
          first = r;
        })
    );
    cache.clear();
    const current = cache.getOrFetch(
      "key",
      1000,
      () =>
        new Promise<number>((r) => {
          second = r;
        })
    );
    first(1);
    await old;
    const extra = vi.fn(async () => 3);
    const joined = cache.getOrFetch("key", 1000, extra);
    second(2);
    expect(await current).toBe(2);
    expect(await joined).toBe(2);
    expect(extra).not.toHaveBeenCalled();
  });

  it("retries rate limits encountered after refreshing authorization", async () => {
    vi.useFakeTimers();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchFn);
    const options = { accessToken: "old", onTokenRefresh: vi.fn(async () => "new") };
    const result = createWhoopClient(options).get("/v2/recovery");
    const assertion = expect(result).resolves.toEqual({ ok: true });
    await vi.runAllTimersAsync();
    await assertion;
    expect(options.onTokenRefresh).toHaveBeenCalledTimes(1);
    expect(options.accessToken).toBe("old");
  });

  it.each([
    "2026-02-30T10:00Z",
    "2026-01-01T25:00Z",
    "2026-01-01T10:60Z",
    "2026-01-01T10:00+25:00",
  ])("rejects impossible datetime %s before an upstream call", (value) => {
    expect(() => resolveDateExpression(value)).toThrow();
  });
});
