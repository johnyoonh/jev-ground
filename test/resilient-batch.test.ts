import { describe, expect, it, vi } from "vitest";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { CachedVerifier, MemoryVerificationCache } from "../src/resilience/cache.js";
import { RetryingVerifier } from "../src/resilience/retry.js";
import { JevVerifier } from "../src/providers/jev.js";
import { verifyAnswer } from "../src/verify.js";

describe("Batching survives resilience wrappers", () => {
  it("makes one SDK request for uncached claims, and none on repeat", async () => {
    const systemOne = vi.fn(async (req: { questions: Record<string, unknown> }) => {
      const answers: Record<string, unknown> = {};
      for (const q of Object.keys(req.questions)) {
        answers[q] = q.startsWith("factuality")
          ? { type: "choice", choice: "supported", confidence: 0.9,
              probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 } }
          : { type: "noul", noul: 0.95 };
      }
      return { model: "jev-1.13.0", usage: { input_tokens: 50, output_tokens: 0 }, answers };
    });
    const jev = new JevVerifier({
      client: { systemOne } as unknown as TypeSafeClient,
      model: "jev-1.13.0",
    });
    const retry = new RetryingVerifier(jev, { maxAttempts: 2 });
    const cached = new CachedVerifier(retry, {
      namespace: jev.cacheNamespace, cache: new MemoryVerificationCache(),
    });
    const args = {
      answer: "Alpha was founded. Beta was founded. Gamma was founded.",
      evidence: [{ id: "source", text: "Alpha Beta Gamma were founded." }],
      verifier: cached,
    };
    const one = await verifyAnswer(args);
    expect(one.claims).toHaveLength(3);
    expect(one.claims.every(r => r.cacheHit === false)).toBe(true);
    expect(systemOne).toHaveBeenCalledTimes(1);
    const two = await verifyAnswer(args);
    expect(two.claims.every(r => r.cacheHit === true)).toBe(true);
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(cached.stats.misses).toBe(3);
    expect(cached.stats.hits).toBe(3);
    expect(retry.stats.calls).toBe(1);
  });

  it("retries the entire batch once on transient errors, not forever", async () => {
    let calls = 0;
    const retried = new RetryingVerifier({
      async verify() { throw new Error("must use batch"); },
      async verifyMany(inputs) {
        calls++;
        if (calls === 1) throw { status: 429, headers: { "retry-after": "0" } };
        return inputs.map(input => ({
          claim: input.claim, verdict: "supported" as const, confidence: 1,
          probabilities: { supported: 1, contradicted: 0, insufficient: 0 }, evidenceIds: [],
        }));
      },
    }, { maxAttempts: 2, sleep: async () => undefined });
    const results = await retried.verifyMany([
      { claim: "A", evidence: [] }, { claim: "B", evidence: [] },
    ]);
    expect(results).toHaveLength(2);
    expect(calls).toBe(2);
    expect(retried.stats.retries).toBe(1);
  });
});
