import { describe, expect, it } from "vitest";
import type { PolicyConfig } from "../src/policy.js";
import { ShadowVerifier } from "../src/shadow.js";
import { MemoryTraceSink } from "../src/trace.js";
import type { Verification, Verifier } from "../src/types.js";

const testPolicy: PolicyConfig = {
  id: "test-policy-v1",
  rubricVersion: "1.0",
  thresholds: {
    failContradictedThreshold: 0.2,
    passSupportedThreshold: 0.8,
  },
};

describe("ShadowVerifier", () => {
  it("never blocks, throws, or alters user output in shadow mode even on FAIL", async () => {
    const mockDelegate: Verifier = {
      async verify({ claim }) {
        return {
          claim,
          verdict: "contradicted",
          probabilities: { supported: 0.05, contradicted: 0.9, insufficient: 0.05 },
          confidence: 0.9,
          evidenceIds: ["doc-1"],
          provider: "fake-provider",
        };
      },
    };

    const sink = new MemoryTraceSink();
    const shadow = new ShadowVerifier(mockDelegate, {
      policy: testPolicy,
      traceSink: sink,
    });

    const input = {
      claim: "The earth is flat.",
      evidence: [{ id: "doc-1", text: "The earth is an oblate spheroid." }],
    };

    const result = await shadow.verify(input);

    // Standard output returned unchanged!
    expect(result.verdict).toBe("contradicted");
    expect(result.probabilities.contradicted).toBe(0.9);

    // Decision trace captured in background!
    expect(sink.traces).toHaveLength(1);
    const trace = sink.traces[0];
    expect(trace.policyDecision).toBe("FAIL");
    expect(trace.provider).toBe("fake-provider");
    expect(trace.rawClaim).toBeUndefined(); // Safe privacy default
  });

  it("stores raw claim/evidence text ONLY when verbose opt-in is enabled", async () => {
    const mockDelegate: Verifier = {
      async verify({ claim }) {
        return {
          claim,
          verdict: "supported",
          probabilities: { supported: 0.95, contradicted: 0.01, insufficient: 0.04 },
          confidence: 0.95,
          evidenceIds: ["doc-1"],
        };
      },
    };

    const sink = new MemoryTraceSink();
    const shadowVerbose = new ShadowVerifier(mockDelegate, {
      policy: testPolicy,
      traceSink: sink,
      verbose: true,
    });

    const input = {
      claim: "Water freezes at 0 degrees Celsius.",
      evidence: [{ id: "doc-1", text: "At standard pressure, water freezes at 0 C." }],
    };

    await shadowVerbose.verify(input);
    expect(sink.traces[0].rawClaim).toBe("Water freezes at 0 degrees Celsius.");
    expect(sink.traces[0].rawEvidence).toHaveLength(1);
  });
});
