import { describe, expect, it } from "vitest";
import { JevVerifier } from "../src/providers/jev.js";
import { verifyAnswer } from "../src/verify.js";
import { CachedVerifier, MemoryVerificationCache } from "../src/resilience/cache.js";
import { RetryingVerifier } from "../src/resilience/retry.js";
import type { BatchVerifier, Verifier, VerifyClaimInput } from "../src/types.js";

describe("JevVerifier batching", () => {
  it("batches 10 claims sharing evidence into 1 Jev request", async () => {
    let systemOneCalls = 0;
    let receivedQuestionsCount = 0;

    const mockClient = {
      systemOne: async (params: any) => {
        systemOneCalls++;
        receivedQuestionsCount = Object.keys(params.questions).length;

        const answers: Record<string, any> = {};
        for (const key of Object.keys(params.questions)) {
          answers[key] = {
            choice: key.endsWith("0") ? "contradicted" : "supported",
            probabilities: key.endsWith("0")
              ? { supported: 0.1, contradicted: 0.8, insufficient: 0.1 }
              : { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
            confidence: 0.9,
          };
        }
        return { answers };
      },
    } as any;

    const verifier = new JevVerifier({ client: mockClient });
    const evidence = [{ id: "doc-1", text: "The Earth revolves around the Sun." }];
    const inputs: VerifyClaimInput[] = Array.from({ length: 10 }, (_, i) => ({
      claim: `Claim ${i}: statement ${i}`,
      evidence,
    }));

    const results = await verifier.verifyMany(inputs);

    expect(systemOneCalls).toBe(1);
    expect(receivedQuestionsCount).toBe(10);
    expect(results).toHaveLength(10);
    expect(results[0].verdict).toBe("contradicted");
    expect(results[1].verdict).toBe("supported");
    expect(results[9].verdict).toBe("supported");
  });

  it("throws an explicit error when an answer is missing in the provider response", async () => {
    const mockClient = {
      systemOne: async () => ({
        answers: {
          claim_0: { choice: "supported", probabilities: { supported: 1, contradicted: 0, insufficient: 0 } },
          // claim_1 missing intentionally
        },
      }),
    } as any;

    const verifier = new JevVerifier({ client: mockClient });
    const evidence = [{ id: "doc-1", text: "Sample evidence" }];
    const inputs: VerifyClaimInput[] = [
      { claim: "Claim 0", evidence },
      { claim: "Claim 1", evidence },
    ];

    await expect(verifier.verifyMany(inputs)).rejects.toThrow(
      "Missing answer for claim key 'claim_1'",
    );
  });

  it("chunks requests based on maxQuestionsPerBatch limit", async () => {
    let systemOneCalls = 0;
    const mockClient = {
      systemOne: async (params: any) => {
        systemOneCalls++;
        const answers: Record<string, any> = {};
        for (const key of Object.keys(params.questions)) {
          answers[key] = {
            choice: "supported",
            probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          };
        }
        return { answers };
      },
    } as any;

    const verifier = new JevVerifier({
      client: mockClient,
      maxQuestionsPerBatch: 4,
    });

    const evidence = [{ id: "doc-1", text: "Evidence text" }];
    const inputs: VerifyClaimInput[] = Array.from({ length: 10 }, (_, i) => ({
      claim: `Claim ${i}`,
      evidence,
    }));

    const results = await verifier.verifyMany(inputs);

    expect(systemOneCalls).toBe(3); // 4 + 4 + 2
    expect(results).toHaveLength(10);
  });

  it("chunks requests based on maxInputSize limit", async () => {
    let systemOneCalls = 0;
    const mockClient = {
      systemOne: async (params: any) => {
        systemOneCalls++;
        const answers: Record<string, any> = {};
        for (const key of Object.keys(params.questions)) {
          answers[key] = {
            choice: "supported",
            probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          };
        }
        return { answers };
      },
    } as any;

    const verifier = new JevVerifier({
      client: mockClient,
      maxInputSize: 50, // Small max input size
    });

    const evidence = [{ id: "doc-1", text: "1234567890" }]; // 10 chars
    const inputs: VerifyClaimInput[] = [
      { claim: "A".repeat(35), evidence }, // 35 + 10 = 45 chars
      { claim: "B".repeat(35), evidence }, // 35 + 10 = 45 chars
    ];

    const results = await verifier.verifyMany(inputs);

    expect(systemOneCalls).toBe(2); // Each claim exceeds 50 total chars together
    expect(results).toHaveLength(2);
  });

  it("chunks when evidence differs across inputs", async () => {
    let systemOneCalls = 0;
    const mockClient = {
      systemOne: async (params: any) => {
        systemOneCalls++;
        const answers: Record<string, any> = {};
        for (const key of Object.keys(params.questions)) {
          answers[key] = {
            choice: "supported",
            probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          };
        }
        return { answers };
      },
    } as any;

    const verifier = new JevVerifier({ client: mockClient });
    const inputs: VerifyClaimInput[] = [
      { claim: "Claim 0", evidence: [{ id: "doc-1", text: "Text A" }] },
      { claim: "Claim 1", evidence: [{ id: "doc-2", text: "Text B" }] },
    ];

    const results = await verifier.verifyMany(inputs);

    expect(systemOneCalls).toBe(2);
    expect(results).toHaveLength(2);
  });
});

describe("verifyAnswer with batching and nonbatching verifiers", () => {
  it("falls back cleanly for nonbatch verifiers", async () => {
    let verifyCalls = 0;
    const nonBatchVerifier: Verifier = {
      async verify({ claim, evidence }) {
        verifyCalls++;
        return {
          claim,
          verdict: "supported",
          probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          confidence: 0.9,
          evidenceIds: evidence.map((e) => e.id),
          provider: "non-batch",
        };
      },
    };

    const result = await verifyAnswer({
      answer: "First sentence. Second sentence.",
      evidence: [{ id: "doc-1", text: "Evidence text" }],
      verifier: nonBatchVerifier,
    });

    expect(verifyCalls).toBe(2);
    expect(result.claims).toHaveLength(2);
    expect(result.verdict).toBe("supported");
  });

  it("uses verifyMany for batch verifiers", async () => {
    let verifyManyCalls = 0;
    const batchVerifier: BatchVerifier = {
      async verify({ claim, evidence }) {
        const [res] = await this.verifyMany([{ claim, evidence }]);
        return res;
      },
      async verifyMany(inputs) {
        verifyManyCalls++;
        return inputs.map((input) => ({
          claim: input.claim,
          verdict: "supported",
          probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          confidence: 0.9,
          evidenceIds: input.evidence.map((e) => e.id),
          provider: "batch",
        }));
      },
    };

    const result = await verifyAnswer({
      answer: "Sentence one. Sentence two. Sentence three.",
      evidence: [{ id: "doc-1", text: "Evidence text" }],
      verifier: batchVerifier,
    });

    expect(verifyManyCalls).toBe(1);
    expect(result.claims).toHaveLength(3);
    expect(result.verdict).toBe("supported");
  });
});

describe("Resilience wrappers with verifyMany", () => {
  it("CachedVerifier handles partial cache hits and batched delegate misses", async () => {
    let delegateVerifyManyCalls = 0;
    const delegate: BatchVerifier = {
      async verify(input) {
        const [res] = await this.verifyMany([input]);
        return res;
      },
      async verifyMany(inputs) {
        delegateVerifyManyCalls++;
        return inputs.map((input) => ({
          claim: input.claim,
          verdict: "supported",
          probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          confidence: 0.9,
          evidenceIds: input.evidence.map((e) => e.id),
        }));
      },
    };

    const cache = new MemoryVerificationCache();
    const cached = new CachedVerifier(delegate, {
      namespace: "test-ns",
      cache,
    });

    const evidence = [{ id: "doc-1", text: "Text" }];
    const claim1 = { claim: "Claim 1", evidence };
    const claim2 = { claim: "Claim 2", evidence };

    // Prime cache with claim1
    await cached.verify(claim1);
    expect(delegateVerifyManyCalls).toBe(1);

    // Call verifyMany with claim1 (hit) and claim2 (miss)
    const results = await cached.verifyMany([claim1, claim2]);
    expect(delegateVerifyManyCalls).toBe(2);
    expect(results[0].cacheHit).toBe(true);
    expect(results[1].cacheHit).toBe(false);
  });

  it("RetryingVerifier retries batch requests on transient errors", async () => {
    let attempts = 0;
    const delegate: BatchVerifier = {
      async verify(input) {
        const [res] = await this.verifyMany([input]);
        return res;
      },
      async verifyMany(inputs) {
        attempts++;
        if (attempts === 1) {
          throw { status: 503, message: "Service Unavailable" };
        }
        return inputs.map((input) => ({
          claim: input.claim,
          verdict: "supported",
          probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          confidence: 0.9,
          evidenceIds: input.evidence.map((e) => e.id),
        }));
      },
    };

    const retrying = new RetryingVerifier(delegate, {
      maxAttempts: 3,
      baseDelayMs: 1,
      sleep: async () => {},
    });

    const evidence = [{ id: "doc-1", text: "Text" }];
    const results = await retrying.verifyMany([
      { claim: "Claim 1", evidence },
      { claim: "Claim 2", evidence },
    ]);

    expect(attempts).toBe(2);
    expect(results).toHaveLength(2);
  });
});
