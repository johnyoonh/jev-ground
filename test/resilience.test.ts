import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CachedVerifier, FileVerificationCache, MemoryVerificationCache, verificationCacheKey } from "../src/resilience/cache.js";
import { RetryingVerifier, isTransientError } from "../src/resilience/retry.js";
import type { Verification, Verifier, VerifyClaimInput } from "../src/types.js";

const input: VerifyClaimInput = {
  claim: "The moon is rocky",
  evidence: [{ id: "doc", text: "The moon is a rocky body." }],
};
const result: Verification = {
  claim: input.claim,
  verdict: "supported",
  probabilities: { supported: 0.95, contradicted: 0.01, insufficient: 0.04 },
  confidence: 0.95,
  evidenceIds: ["doc"],
  raw: { secret: "raw provider content" },
};

describe("CachedVerifier", () => {
  it("keys on evidence content and the model/prompt namespace", async () => {
    expect(verificationCacheKey("model-v1", input))
      .not.toBe(verificationCacheKey("model-v2", input));
    expect(verificationCacheKey("model-v1", input))
      .not.toBe(verificationCacheKey("model-v1", {
        ...input, evidence: [{ id: "doc", text: "Other evidence" }],
      }));
  });

  it("returns a cache hit without calling the provider again", async () => {
    let calls = 0;
    const verifier: Verifier = { verify: async () => { calls++; return result; } };
    const cached = new CachedVerifier(verifier, {
      namespace: "jev-latest:grounding-v1",
      cache: new MemoryVerificationCache(),
    });
    expect((await cached.verify(input)).cacheHit).toBe(false);
    expect((await cached.verify(input)).cacheHit).toBe(true);
    expect(calls).toBe(1);
    expect(cached.stats.hits).toBe(1);
  });

  it("coalesces concurrent identical calls", async () => {
    let calls = 0;
    const verifier: Verifier = { verify: async () => {
      calls++;
      await Promise.resolve();
      return result;
    }};
    const cached = new CachedVerifier(verifier, {
      namespace: "model-v1",
      cache: new MemoryVerificationCache(),
    });
    await Promise.all(Array.from({ length: 8 }, () => cached.verify(input)));
    expect(calls).toBe(1);
    expect(cached.stats.shared).toBe(7);
  });

  it("expires cache entries and never caches failed calls", async () => {
    let now = 0;
    let calls = 0;
    const verifier: Verifier = { verify: async () => {
      calls++;
      if (calls === 1) throw new Error("temporary failure");
      return result;
    }};
    const cached = new CachedVerifier(verifier, {
      namespace: "model-v1",
      cache: new MemoryVerificationCache(),
      ttlMs: 100,
      now: () => now,
    });
    await expect(cached.verify(input)).rejects.toThrow("temporary failure");
    expect((await cached.verify(input)).cacheHit).toBe(false);
    now = 10;
    expect((await cached.verify(input)).cacheHit).toBe(true);
    now = 101;
    expect((await cached.verify(input)).cacheHit).toBe(false);
    expect(calls).toBe(3);
  });

  it("persists safely across instances without storing raw response", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "jev-ground-cache-"));
    try {
      const cache = new FileVerificationCache(directory);
      const initial = new CachedVerifier({ verify: async () => result }, {
        namespace: "jev-v1", cache,
      });
      expect((await initial.verify(input)).cacheHit).toBe(false);
      const second = new CachedVerifier({
        verify: async () => { throw new Error("should not call provider"); },
      }, { namespace: "jev-v1", cache });
      const response = await second.verify(input);
      expect(response.cacheHit).toBe(true);
      expect(response.raw).toBeUndefined();
      const key = verificationCacheKey("jev-v1", input);
      const contents = await readFile(path.join(directory, key.slice(0, 2), key + ".json"), "utf8");
      expect(contents).not.toContain("raw provider content");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("RetryingVerifier", () => {
  it("retries 429/5xx and honors Retry-After within the configured ceiling", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const retried = new RetryingVerifier({ verify: async () => {
      attempts++;
      if (attempts < 3) throw { status: 429, headers: { "retry-after": "1" } };
      return result;
    }}, {
      maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 2000,
      random: () => 0, sleep: async ms => { waits.push(ms); },
    });
    expect((await retried.verify(input)).verdict).toBe("supported");
    expect(attempts).toBe(3);
    expect(waits).toEqual([1000, 1000]);
    expect(retried.stats.retries).toBe(2);
  });

  it("does not retry auth errors or programming errors", async () => {
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ cause: { code: "ECONNRESET" } })).toBe(true);
    let calls = 0;
    const retried = new RetryingVerifier({ verify: async () => {
      calls++;
      throw { status: 401 };
    }}, { sleep: async () => undefined });
    await expect(retried.verify(input)).rejects.toEqual({ status: 401 });
    expect(calls).toBe(1);
  });

  it("bounds attempts on repeated transient errors", async () => {
    let calls = 0;
    const retried = new RetryingVerifier({ verify: async () => {
      calls++;
      throw { status: 503 };
    }}, { maxAttempts: 3, baseDelayMs: 0, sleep: async () => undefined });
    await expect(retried.verify(input)).rejects.toEqual({ status: 503 });
    expect(calls).toBe(3);
  });
});
