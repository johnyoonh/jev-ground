import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CachedVerifier, FileVerificationCache, MemoryVerificationCache, verificationCacheKey } from "../src/resilience/cache.js";
import { RetryingVerifier, isTransientError } from "../src/resilience/retry.js";
import {
  BudgetedVerifier,
  BudgetExhaustedError,
  RunBudgetController,
} from "../src/resilience/budget.js";
import {
  CircuitBreakerController,
  CircuitBreakerOpenError,
  CircuitBreakerVerifier,
} from "../src/resilience/circuit-breaker.js";
import { createResilientVerifier } from "../src/resilience/index.js";
import { verifyAnswer } from "../src/verify.js";
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

describe("RunBudgetController & BudgetedVerifier", () => {
  it("bounds actual provider call attempts to maxAttempts even under concurrency 10", async () => {
    let providerCalls = 0;
    const provider: Verifier = {
      verify: async (inp) => {
        providerCalls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ...result, claim: inp.claim };
      },
    };

    const budget = new RunBudgetController({
      maxAttempts: 5,
      paidCallsAllowed: true,
    });
    const budgeted = new BudgetedVerifier(provider, budget);

    const inputs: VerifyClaimInput[] = Array.from({ length: 10 }, (_, i) => ({
      claim: `Claim ${i}`,
      evidence: [{ id: "e", text: "Text" }],
    }));

    const results = await Promise.allSettled(
      inputs.map((inp) => budgeted.verify(inp))
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(providerCalls).toBeLessThanOrEqual(5);
    expect(succeeded.length).toBe(5);
    expect(failed.length).toBe(5);

    const stats = budget.getStats();
    expect(stats.actualAttempts).toBe(5);
    expect(stats.exhaustedReason).toBe("maxAttempts");

    for (const f of failed) {
      if (f.status === "rejected") {
        expect(f.reason).toBeInstanceOf(BudgetExhaustedError);
        expect((f.reason as BudgetExhaustedError).reason).toBe("maxAttempts");
      }
    }
  });

  it("consumes attempt budget across retries", async () => {
    let providerCalls = 0;
    const provider: Verifier = {
      verify: async () => {
        providerCalls++;
        throw { status: 503 };
      },
    };

    const budget = new RunBudgetController({
      maxAttempts: 3,
      paidCallsAllowed: true,
    });
    const budgeted = new BudgetedVerifier(provider, budget);
    const retrying = new RetryingVerifier(budgeted, {
      maxAttempts: 10,
      baseDelayMs: 1,
      sleep: async () => {},
    });

    await expect(retrying.verify(input)).rejects.toThrow(BudgetExhaustedError);
    expect(providerCalls).toBe(3);
    expect(budget.getStats().actualAttempts).toBe(3);
    expect(budget.getStats().exhaustedReason).toBe("maxAttempts");
  });

  it("enforces run wall-clock timeout", async () => {
    let clock = 1000;
    const budget = new RunBudgetController({
      timeoutMs: 500,
      paidCallsAllowed: true,
      now: () => clock,
    });
    const budgeted = new BudgetedVerifier({ verify: async () => result }, budget);

    expect((await budgeted.verify(input)).verdict).toBe("supported");

    clock += 600;

    await expect(budgeted.verify(input)).rejects.toThrow(BudgetExhaustedError);
    expect(budget.getStats().exhaustedReason).toBe("timeout");
  });

  it("projects dry-run calls and token cost when paidCallsAllowed is false", async () => {
    const budget = new RunBudgetController({
      paidCallsAllowed: false,
      pricing: {
        promptTokenPricePer1k: 0.002,
        fixedCostPerCall: 0.001,
      },
    });

    const estTokens = 500;
    for (let i = 0; i < 3; i++) {
      await expect(budget.reserveCall(estTokens)).rejects.toThrow(BudgetExhaustedError);
    }

    const stats = budget.getStats();
    expect(stats.actualAttempts).toBe(0);
    expect(stats.estimatedAttempts).toBe(3);
    expect(stats.estimatedPromptTokens).toBe(1500);
    expect(stats.estimatedCostUsd).toBeCloseTo(0.006);
    expect(stats.exhaustedReason).toBe("paidCallsDisabled");
  });
});

describe("CircuitBreakerController & CircuitBreakerVerifier", () => {
  it("trips open on sustained failures, permits single canary in half-open, and resets on success", async () => {
    let nowMs = 1000;
    let providerShouldFail = true;
    let callsMade = 0;

    const provider: Verifier = {
      verify: async () => {
        callsMade++;
        if (providerShouldFail) throw { status: 503 };
        return result;
      },
    };

    const breaker = new CircuitBreakerController({
      failureThreshold: 2,
      cooldownMs: 1000,
      now: () => nowMs,
    });

    const cbVerifier = new CircuitBreakerVerifier(provider, breaker);

    expect(breaker.getState()).toBe("closed");

    // Failure 1
    await expect(cbVerifier.verify(input)).rejects.toEqual({ status: 503 });
    expect(breaker.getState()).toBe("closed");

    // Failure 2 -> trips to OPEN
    await expect(cbVerifier.verify(input)).rejects.toEqual({ status: 503 });
    expect(breaker.getState()).toBe("open");

    // Fast reject while OPEN
    const openCallsBefore = callsMade;
    await expect(cbVerifier.verify(input)).rejects.toThrow(CircuitBreakerOpenError);
    expect(callsMade).toBe(openCallsBefore);

    // Advance past cooldownMs -> HALF-OPEN
    nowMs += 1050;
    expect(breaker.getState()).toBe("half-open");

    // Concurrency test in HALF-OPEN state
    providerShouldFail = false;

    let resolveCanary!: () => void;
    const canaryPromise = new Promise<void>((res) => { resolveCanary = res; });

    const canaryProvider: Verifier = {
      verify: async () => {
        await canaryPromise;
        return result;
      },
    };

    const cbCanaryVerifier = new CircuitBreakerVerifier(canaryProvider, breaker);

    const p1 = cbCanaryVerifier.verify(input); // Canary probe
    const p2 = cbCanaryVerifier.verify(input); // Rejected
    const p3 = cbCanaryVerifier.verify(input); // Rejected

    await expect(p2).rejects.toThrow(CircuitBreakerOpenError);
    await expect(p3).rejects.toThrow(CircuitBreakerOpenError);

    resolveCanary();
    const canaryResult = await p1;
    expect(canaryResult.verdict).toBe("supported");

    expect(breaker.getState()).toBe("closed");
    expect(breaker.getFailureCount()).toBe(0);
  });

  it("re-opens circuit if canary probe fails in half-open state", async () => {
    let nowMs = 1000;
    const breaker = new CircuitBreakerController({
      failureThreshold: 1,
      cooldownMs: 500,
      now: () => nowMs,
    });

    const failingVerifier = new CircuitBreakerVerifier({
      verify: async () => { throw { status: 500 }; },
    }, breaker);

    await expect(failingVerifier.verify(input)).rejects.toEqual({ status: 500 });
    expect(breaker.getState()).toBe("open");

    nowMs += 600;
    expect(breaker.getState()).toBe("half-open");

    await expect(failingVerifier.verify(input)).rejects.toEqual({ status: 500 });
    expect(breaker.getState()).toBe("open");
  });
});

describe("Resilience Integration & Factuality Integrity", () => {
  it("creates composed resilient verifier with createResilientVerifier", async () => {
    let calls = 0;
    const mockProvider: Verifier = {
      verify: async () => {
        calls++;
        return result;
      },
    };

    const resilient = createResilientVerifier(mockProvider, {
      budget: { maxAttempts: 5, paidCallsAllowed: true },
      circuitBreaker: { failureThreshold: 3 },
      retry: { maxAttempts: 2, baseDelayMs: 1 },
      cache: { namespace: "test-v1", cache: new MemoryVerificationCache() },
    });

    const res1 = await resilient.verify(input);
    expect(res1.cacheHit).toBe(false);
    expect(calls).toBe(1);

    const res2 = await resilient.verify(input);
    expect(res2.cacheHit).toBe(true);
    expect(calls).toBe(1);
  });

  it("never scores budget exhaustion or backend outage as a factuality verdict", async () => {
    const budgetExhaustedVerifier: Verifier = {
      verify: async () => {
        throw new BudgetExhaustedError("Budget exhausted", "maxAttempts", {
          actualAttempts: 5,
          actualPromptTokens: 1000,
          actualCompletionTokens: 0,
          actualCostUsd: 0,
          estimatedAttempts: 5,
          estimatedPromptTokens: 1000,
          estimatedCostUsd: 0,
          peakInFlight: 1,
          exhaustedReason: "maxAttempts",
        });
      },
    };

    const circuitOpenVerifier: Verifier = {
      verify: async () => {
        throw new CircuitBreakerOpenError("Circuit open", "open", 1000);
      },
    };

    await expect(
      verifyAnswer({
        answer: "The earth revolves around the sun.",
        evidence: [{ id: "1", text: "Earth revolves around the Sun." }],
        verifier: budgetExhaustedVerifier,
      })
    ).rejects.toThrow(BudgetExhaustedError);

    await expect(
      verifyAnswer({
        answer: "The earth revolves around the sun.",
        evidence: [{ id: "1", text: "Earth revolves around the Sun." }],
        verifier: circuitOpenVerifier,
      })
    ).rejects.toThrow(CircuitBreakerOpenError);
  });
});
