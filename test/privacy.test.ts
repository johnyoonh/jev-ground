import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EgressControlVerifier,
  FileVerificationCache,
  CachedVerifier,
  RetryingVerifier,
  redactEvidence,
  verifyAnswer,
  type Evidence,
  type Verifier,
} from "../src/index.js";

describe("Sensitive evidence egress control & privacy", () => {
  it("blocks restricted evidence on remote provider with 0 network calls and 0 disk files", async () => {
    let networkCalls = 0;
    const remoteSpyVerifier: Verifier = {
      isLocal: false,
      provider: "remote-llm",
      async verify() {
        networkCalls++;
        throw new Error("Network call should not happen for restricted evidence");
      },
    };

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "jev-privacy-test-"));
    try {
      const cache = new FileVerificationCache(tempDir);
      const cached = new CachedVerifier(remoteSpyVerifier, {
        namespace: "test-v1",
        cache,
      });
      const controlled = new EgressControlVerifier(cached);

      const restrictedEvidence: Evidence[] = [
        {
          id: "doc-secret",
          text: "User SSN is 123-45-6789 and credit card is 4111-2222-3333-4444.",
          access: "restricted",
        },
      ];

      const result = await controlled.verify({
        claim: "The user's account is verified",
        evidence: restrictedEvidence,
      });

      expect(networkCalls).toBe(0);
      expect(result.executionState).toBe("BLOCKED");
      expect(result.privacyBlockReason).toContain("prohibited from remote egress");

      // Verify zero disk files created in temp cache directory
      const files = await readdir(tempDir);
      expect(files).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("honors noStore per-request option bypassing memory and disk caches without raw retention", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "jev-nostore-test-"));
    try {
      const cache = new FileVerificationCache(tempDir);
      let providerCalls = 0;

      const provider: Verifier = {
        isLocal: false,
        provider: "mock-remote",
        async verify({ claim, evidence }) {
          providerCalls++;
          return {
            claim,
            verdict: "supported",
            probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
            confidence: 0.9,
            evidenceIds: evidence.map((e) => e.id),
            raw: { secretApiKey: "sk_live_1234567890abcdef" },
          };
        },
      };

      const cachedVerifier = new CachedVerifier(provider, {
        namespace: "test-nostore",
        cache,
      });

      const inputEvidence: Evidence[] = [
        { id: "e1", text: "Public information statement", access: "public" },
      ];

      // First call with noStore: true
      const res1 = await cachedVerifier.verify({
        claim: "Test claim",
        evidence: inputEvidence,
        noStore: true,
      });

      expect(res1.cacheHit).toBe(false);
      expect(res1.raw).toBeUndefined();
      expect(providerCalls).toBe(1);

      // Check disk: zero cache files created
      const subdirs = await readdir(tempDir);
      expect(subdirs).toHaveLength(0);

      // Second call with noStore: true
      const res2 = await cachedVerifier.verify({
        claim: "Test claim",
        evidence: inputEvidence,
        noStore: true,
      });

      expect(res2.cacheHit).toBe(false);
      expect(providerCalls).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts sensitive fields (SSN, API keys, email) and marks transformedEvidence", async () => {
    let capturedEvidenceText = "";
    const mockRemote: Verifier = {
      isLocal: false,
      async verify({ claim, evidence }) {
        capturedEvidenceText = evidence[0].text;
        return {
          claim,
          verdict: "supported",
          probabilities: { supported: 0.95, contradicted: 0.01, insufficient: 0.04 },
          confidence: 0.95,
          evidenceIds: evidence.map((e) => e.id),
        };
      },
    };

    const controlled = new EgressControlVerifier(mockRemote, {
      defaultSensitiveAction: "redact",
    });

    const sensitiveEvidence: Evidence[] = [
      {
        id: "doc-sensitive",
        text: "Contact john@example.com with key sk_live_1234567890abcdef123 and SSN 123-45-6789.",
        access: "sensitive",
      },
    ];

    const result = await controlled.verify({
      claim: "Contact info provided",
      evidence: sensitiveEvidence,
    });

    expect(result.executionState).toBe("EXECUTED");
    expect(result.transformedEvidence).toBe(true);
    expect(capturedEvidenceText).not.toContain("john@example.com");
    expect(capturedEvidenceText).not.toContain("sk_live_1234567890abcdef123");
    expect(capturedEvidenceText).not.toContain("123-45-6789");
    expect(capturedEvidenceText).toContain("[REDACTED]");
  });

  it("routes restricted evidence to an explicitly configured local verifier", async () => {
    let localCalls = 0;
    let remoteCalls = 0;

    const localVerifier: Verifier = {
      isLocal: true,
      provider: "local-nli",
      async verify({ claim, evidence }) {
        localCalls++;
        return {
          claim,
          verdict: "supported",
          probabilities: { supported: 0.99, contradicted: 0.0, insufficient: 0.01 },
          confidence: 0.99,
          evidenceIds: evidence.map((e) => e.id),
        };
      },
    };

    const remoteVerifier: Verifier = {
      isLocal: false,
      provider: "remote-api",
      async verify() {
        remoteCalls++;
        throw new Error("Should not reach remote");
      },
    };

    const controlled = new EgressControlVerifier(remoteVerifier, {
      localVerifier,
    });

    const result = await controlled.verify({
      claim: "Confidential record verified",
      evidence: [
        { id: "conf-1", text: "Top secret internal record", access: "restricted" },
      ],
    });

    expect(remoteCalls).toBe(0);
    expect(localCalls).toBe(1);
    expect(result.executionState).toBe("EXECUTED");
    expect(result.verdict).toBe("supported");
  });

  it("supports custom egressPolicy hooks", async () => {
    const remoteVerifier: Verifier = {
      isLocal: false,
      async verify({ claim, evidence }) {
        return {
          claim,
          verdict: "supported",
          probabilities: { supported: 0.8, contradicted: 0.1, insufficient: 0.1 },
          confidence: 0.8,
          evidenceIds: evidence.map((e) => e.id),
        };
      },
    };

    const controlled = new EgressControlVerifier(remoteVerifier, {
      egressPolicy: async ({ evidence }) => {
        const hasCustomBlock = evidence.some((e) => e.metadata?.customTag === "forbidden");
        if (hasCustomBlock) {
          return { action: "block", reason: "Custom policy hook blocked forbidden tag" };
        }
        return { action: "allow" };
      },
    });

    const blockedRes = await controlled.verify({
      claim: "Test claim",
      evidence: [{ id: "e1", text: "Text", metadata: { customTag: "forbidden" } }],
    });
    expect(blockedRes.executionState).toBe("BLOCKED");
    expect(blockedRes.privacyBlockReason).toBe("Custom policy hook blocked forbidden tag");

    const allowedRes = await controlled.verify({
      claim: "Test claim",
      evidence: [{ id: "e2", text: "Text", metadata: { customTag: "allowed" } }],
    });
    expect(allowedRes.executionState).toBe("EXECUTED");
  });

  it("purges stale and expired cache entries from FileVerificationCache", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "jev-purge-test-"));
    try {
      const cache = new FileVerificationCache(tempDir);

      // Write 3 entries manually with different timestamps
      await cache.set("1111111111111111111111111111111111111111111111111111111111111111", {
        storedAt: 1000,
        value: {
          claim: "Old claim 1",
          verdict: "supported",
          probabilities: { supported: 1, contradicted: 0, insufficient: 0 },
          confidence: 1,
          evidenceIds: ["e1"],
        },
      });

      await cache.set("2222222222222222222222222222222222222222222222222222222222222222", {
        storedAt: 2000,
        value: {
          claim: "Old claim 2",
          verdict: "supported",
          probabilities: { supported: 1, contradicted: 0, insufficient: 0 },
          confidence: 1,
          evidenceIds: ["e2"],
        },
      });

      await cache.set("3333333333333333333333333333333333333333333333333333333333333333", {
        storedAt: 9000,
        value: {
          claim: "Fresh claim",
          verdict: "supported",
          probabilities: { supported: 1, contradicted: 0, insufficient: 0 },
          confidence: 1,
          evidenceIds: ["e3"],
        },
      });

      // Purge entries older than 5000ms relative to now = 10000
      const purged = await cache.purge({ maxAgeMs: 5000, now: () => 10000 });
      expect(purged).toBe(2);

      // Verify fresh entry still exists
      const fresh = await cache.get("3333333333333333333333333333333333333333333333333333333333333333");
      expect(fresh).toBeDefined();
      expect(fresh?.value.claim).toBe("Fresh claim");

      // Verify old entries removed
      const old1 = await cache.get("1111111111111111111111111111111111111111111111111111111111111111");
      expect(old1).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("verifies pipeline priority order: EgressControl -> CachedVerifier -> RetryingVerifier -> Provider", async () => {
    let networkCalls = 0;
    let retryCalls = 0;

    const baseProvider: Verifier = {
      isLocal: false,
      provider: "flaky-remote",
      async verify({ claim, evidence }) {
        networkCalls++;
        return {
          claim,
          verdict: "supported",
          probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          confidence: 0.9,
          evidenceIds: evidence.map((e) => e.id),
        };
      },
    };

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "jev-priority-test-"));
    try {
      const retrying = new RetryingVerifier(baseProvider, {
        onRetry: () => {
          retryCalls++;
        },
      });
      const cached = new CachedVerifier(retrying, {
        namespace: "priority-v1",
        cache: new FileVerificationCache(tempDir),
      });
      const egressControl = new EgressControlVerifier(cached);

      // 1. Restricted call: egress policy blocks immediately (0 network calls, 0 retries, 0 cache entries)
      const blockedRes = await egressControl.verify({
        claim: "Secret claim",
        evidence: [{ id: "sec-1", text: "Restricted text", access: "restricted" }],
      });
      expect(blockedRes.executionState).toBe("BLOCKED");
      expect(networkCalls).toBe(0);
      expect(retryCalls).toBe(0);

      // 2. Public call: allowed through egress, checked cache (miss), called provider
      const publicRes1 = await egressControl.verify({
        claim: "Public claim",
        evidence: [{ id: "pub-1", text: "Public text", access: "public" }],
      });
      expect(publicRes1.executionState).toBe("EXECUTED");
      expect(publicRes1.cacheHit).toBe(false);
      expect(networkCalls).toBe(1);

      // 3. Repeated public call: allowed through egress, served from cache (no extra network call)
      const publicRes2 = await egressControl.verify({
        claim: "Public claim",
        evidence: [{ id: "pub-1", text: "Public text", access: "public" }],
      });
      expect(publicRes2.cacheHit).toBe(true);
      expect(networkCalls).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("benchmarks redacted path vs raw path", async () => {
    const rawEvidence: Evidence[] = [
      {
        id: "e-raw",
        text: "User profile: Alice Smith, email alice@company.org, SSN 987-65-4321, key sk_live_9998887776665554.",
        access: "sensitive",
      },
    ];

    const startRaw = performance.now();
    for (let i = 0; i < 500; i++) {
      // Raw inspection without transformation
      const _access = rawEvidence[0].access;
    }
    const rawDurationMs = performance.now() - startRaw;

    const startRedact = performance.now();
    for (let i = 0; i < 500; i++) {
      redactEvidence(rawEvidence);
    }
    const redactDurationMs = performance.now() - startRedact;

    expect(rawDurationMs).toBeGreaterThanOrEqual(0);
    expect(redactDurationMs).toBeGreaterThanOrEqual(0);

    const redacted = redactEvidence(rawEvidence);
    expect(redacted.transformed).toBe(true);
    expect(redacted.evidence[0].metadata?.originalLabelEquivalent).toBe(false);
  });

  it("integrates egressPolicy and noStore into verifyAnswer", async () => {
    let networkCalls = 0;
    const verifier: Verifier = {
      isLocal: false,
      provider: "jev",
      async verify({ claim, evidence }) {
        networkCalls++;
        return {
          claim,
          verdict: "supported",
          probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          confidence: 0.9,
          evidenceIds: evidence.map((e) => e.id),
        };
      },
    };

    const answerRes = await verifyAnswer({
      answer: "Acme was founded in 2018.",
      evidence: [{ id: "d1", text: "Acme was founded in 2018.", access: "restricted" }],
      verifier,
      noStore: true,
    });

    // Default behavior for restricted evidence with remote verifier: blocked!
    expect(networkCalls).toBe(0);
    expect(answerRes.claims[0].executionState).toBe("BLOCKED");
  });
});
