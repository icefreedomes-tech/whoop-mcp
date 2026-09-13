import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stat, rm, readFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "../../src/auth/token-store.js";
import {
  isTokenExpired,
  saveTokens,
  loadTokens,
  deleteTokens,
} from "../../src/auth/token-store.js";

// ---------------------------------------------------------------------------
// Task 3a: Token types + expiry check
// ---------------------------------------------------------------------------

describe("OAuthTokens", () => {
  it("accepts a valid token object", () => {
    const tokens: OAuthTokens = {
      access_token: "abc123",
      refresh_token: "def456",
      expires_at: Date.now() + 3600 * 1000,
      token_type: "Bearer",
    };

    expect(tokens.access_token).toBe("abc123");
    expect(tokens.refresh_token).toBe("def456");
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_at).toBeGreaterThan(Date.now());
  });
});

describe("isTokenExpired", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const NOW = new Date("2026-04-10T12:00:00.000Z").getTime();
  const BUFFER_MS = 60_000; // 60 seconds

  it("returns true when token is already expired", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW - 1000, // expired 1s ago
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(true);
  });

  it("returns true when token expires within the 60s buffer", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW + 30_000, // expires in 30s (within 60s buffer)
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(true);
  });

  it("returns true when token expires exactly at the buffer boundary", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW + BUFFER_MS, // expires exactly at buffer
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(true);
  });

  it("returns false when token expires well beyond the buffer", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW + 3600_000, // expires in 1 hour
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(false);
  });

  it("returns false when token expires 1ms beyond the buffer", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW + BUFFER_MS + 1, // just past the buffer
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 3b: Save tokens to disk
// ---------------------------------------------------------------------------

describe("saveTokens", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "whoop-mcp-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  const sampleTokens: OAuthTokens = {
    access_token: "access_abc",
    refresh_token: "refresh_xyz",
    expires_at: Date.now() + 3600_000,
    token_type: "Bearer",
  };

  it("writes valid JSON to the token file", async () => {
    await saveTokens(sampleTokens, tempDir);

    const raw = await readFile(join(tempDir, "tokens.json"), "utf-8");
    const parsed = JSON.parse(raw) as OAuthTokens;

    expect(parsed.access_token).toBe("access_abc");
    expect(parsed.refresh_token).toBe("refresh_xyz");
    expect(parsed.token_type).toBe("Bearer");
    expect(parsed.expires_at).toBe(sampleTokens.expires_at);
  });

  it("creates the directory if it does not exist", async () => {
    const nestedDir = join(tempDir, "nested");
    await saveTokens(sampleTokens, nestedDir);

    const dirStat = await stat(nestedDir);
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("creates the directory with 0700 permissions", async () => {
    const mkdirSpy = vi.spyOn(fs, "mkdir");
    const nestedDir = join(tempDir, "nested");
    await saveTokens(sampleTokens, nestedDir);

    const dirStat = await stat(nestedDir);
    // 0o700 = owner rwx, group/other none. mode & 0o777 masks file type bits.
    const dirMode = dirStat.mode & 0o777;
    expect(mkdirSpy).toHaveBeenCalledWith(nestedDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") expect(dirMode).toBe(0o700);
    mkdirSpy.mockRestore();
  });

  it("creates the token file with 0600 permissions", async () => {
    const writeSpy = vi.spyOn(fs, "writeFile");
    await saveTokens(sampleTokens, tempDir);

    const fileStat = await stat(join(tempDir, "tokens.json"));
    const fileMode = fileStat.mode & 0o777;
    expect(writeSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ mode: 0o600 })
    );
    if (process.platform !== "win32") expect(fileMode).toBe(0o600);
    writeSpy.mockRestore();
  });

  it("preserves the old token if replacing the file fails", async () => {
    await saveTokens(sampleTokens, tempDir);
    const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk unavailable"));
    try {
      await expect(saveTokens({ ...sampleTokens, access_token: "new" }, tempDir)).rejects.toThrow(
        "disk unavailable"
      );
      expect(await loadTokens(tempDir)).toEqual(sampleTokens);
      expect(await fs.readdir(tempDir)).toEqual(["tokens.json"]);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("overwrites existing token file", async () => {
    await saveTokens(sampleTokens, tempDir);

    const updatedTokens: OAuthTokens = {
      ...sampleTokens,
      access_token: "new_access",
    };
    await saveTokens(updatedTokens, tempDir);

    const raw = await readFile(join(tempDir, "tokens.json"), "utf-8");
    const parsed = JSON.parse(raw) as OAuthTokens;
    expect(parsed.access_token).toBe("new_access");
  });
});

// ---------------------------------------------------------------------------
// Task 3c: Load tokens from disk
// ---------------------------------------------------------------------------

describe("loadTokens", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "whoop-mcp-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  const sampleTokens: OAuthTokens = {
    access_token: "access_abc",
    refresh_token: "refresh_xyz",
    expires_at: Date.now() + 3600_000,
    token_type: "Bearer",
  };

  it("returns parsed OAuthTokens when file exists with valid JSON", async () => {
    await saveTokens(sampleTokens, tempDir);

    const loaded = await loadTokens(tempDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.access_token).toBe("access_abc");
    expect(loaded!.refresh_token).toBe("refresh_xyz");
    expect(loaded!.token_type).toBe("Bearer");
    expect(loaded!.expires_at).toBe(sampleTokens.expires_at);
  });

  it("returns null when file does not exist", async () => {
    const loaded = await loadTokens(tempDir);

    expect(loaded).toBeNull();
  });

  it("returns null when file contains invalid JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tempDir, "tokens.json"), "not valid json{{{", "utf-8");

    const loaded = await loadTokens(tempDir);

    expect(loaded).toBeNull();
  });

  it("round-trips: saveTokens then loadTokens returns same data", async () => {
    await saveTokens(sampleTokens, tempDir);
    const loaded = await loadTokens(tempDir);

    expect(loaded).toEqual(sampleTokens);
  });

  it("returns null when file contains JSON with missing access_token", async () => {
    const { writeFile } = await import("node:fs/promises");
    const invalid = { refresh_token: "r", expires_at: 123, token_type: "Bearer" };
    await writeFile(join(tempDir, "tokens.json"), JSON.stringify(invalid), "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when file contains JSON with missing refresh_token", async () => {
    const { writeFile } = await import("node:fs/promises");
    const invalid = { access_token: "a", expires_at: 123, token_type: "Bearer" };
    await writeFile(join(tempDir, "tokens.json"), JSON.stringify(invalid), "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when file contains JSON with missing expires_at", async () => {
    const { writeFile } = await import("node:fs/promises");
    const invalid = { access_token: "a", refresh_token: "r", token_type: "Bearer" };
    await writeFile(join(tempDir, "tokens.json"), JSON.stringify(invalid), "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when file contains JSON with wrong types", async () => {
    const { writeFile } = await import("node:fs/promises");
    const invalid = { access_token: 123, refresh_token: "r", expires_at: "not-a-number" };
    await writeFile(join(tempDir, "tokens.json"), JSON.stringify(invalid), "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when file contains a JSON array instead of object", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tempDir, "tokens.json"), "[]", "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when file contains JSON null", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tempDir, "tokens.json"), "null", "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when access_token is an empty string", async () => {
    const { writeFile } = await import("node:fs/promises");
    const invalid = { access_token: "", refresh_token: "r", expires_at: 123, token_type: "Bearer" };
    await writeFile(join(tempDir, "tokens.json"), JSON.stringify(invalid), "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when refresh_token is an empty string", async () => {
    const { writeFile } = await import("node:fs/promises");
    const invalid = { access_token: "a", refresh_token: "", expires_at: 123, token_type: "Bearer" };
    await writeFile(join(tempDir, "tokens.json"), JSON.stringify(invalid), "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 3d: Delete tokens from disk
// ---------------------------------------------------------------------------

describe("deleteTokens", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "whoop-mcp-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  const sampleTokens: OAuthTokens = {
    access_token: "access_abc",
    refresh_token: "refresh_xyz",
    expires_at: Date.now() + 3600_000,
    token_type: "Bearer",
  };

  it("removes the token file", async () => {
    await saveTokens(sampleTokens, tempDir);
    await deleteTokens(tempDir);

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("does not throw if file does not exist", async () => {
    // tempDir exists but has no tokens.json — should not throw
    await expect(deleteTokens(tempDir)).resolves.toBeUndefined();
  });

  it("after delete, loadTokens returns null", async () => {
    await saveTokens(sampleTokens, tempDir);

    // Confirm it exists
    const before = await loadTokens(tempDir);
    expect(before).not.toBeNull();

    // Delete and confirm
    await deleteTokens(tempDir);
    const after = await loadTokens(tempDir);
    expect(after).toBeNull();
  });

  it("rethrows non-ENOENT errors (e.g., permission denied)", async () => {
    await saveTokens(sampleTokens, tempDir);

    const denied = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    const unlinkSpy = vi.spyOn(fs, "unlink").mockRejectedValueOnce(denied);
    try {
      await expect(deleteTokens(tempDir)).rejects.toBe(denied);
    } finally {
      unlinkSpy.mockRestore();
    }
  });
});
