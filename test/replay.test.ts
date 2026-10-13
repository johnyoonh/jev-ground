import { describe, expect, it } from "vitest";
import type { PolicyConfig } from "../src/policy.js";
import { comparePolicySnapshots, replayPolicy } from "../src/replay.js";
import { ShadowVerifier } from "../src/shadow.js";
import {
  exportTracesToJsonl,
  MemoryTraceSink,
  parseJsonlTraces,
} from "../src/trace.js";
import type { Verifier, VerifyClaimInput } from "../src/types.js";

const baselinePolicy: PolicyConfig = {
  id: "policy-permissive-v1",
  rubricVersion: "1.0",
  thresholds: {
    failContradictedThreshold: 0.5,
    failInsufficientThreshold: 0.9,
    reviewContradictedThreshold: 0.1,
    reviewInsufficientThreshold: 0.4,
    passSupportedThreshold: 0.6,
  },
};

const candidatePolicy: PolicyConfig = {
  id: "policy-strict-v2",
  rubricVersion: "2.0",
  thresholds: {
    failContradictedThreshold: 0.2,
    failInsufficientThreshold: 0.7,
    reviewContradictedThreshold: 0.05,
    reviewInsufficientThreshold: 0.2,
    passSupportedThreshold: 0.85,
  },
};

const fixtureInputs: VerifyClaimInput[] = [
  {
    claim: "Mars is the fourth planet from the Sun.",
    evidence: [{ id: "doc-1", text: "Mars is the fourth planet from the Sun in our Solar System." }],
  },
  {
    claim: "Venus is larger than Jupiter.",
    evidence: [{ id: "doc-2", text: "Jupiter is the largest planet in the Solar System, far larger than Venus." }],
  },
  {
    claim: "Exoplanet Proxima b supports complex cellular life.",
    evidence: [{ id: "doc-3", text: "Proxima Centauri b is an exoplanet orbiting in the habitable zone." }],
  },
  {
    claim: "Water boils at 100C at sea level.",
    evidence: [{ id: "doc-4", text: "At standard atmospheric pressure, water boils at 100 degrees Celsius." }],
  },
];

describe("Offline Policy Replay and Comparison", () => {
  it("runs N fixture results in shadow mode, exports traces, replays offline without provider calls, and generates reproducible delta reports", async () => {
    let providerCalls = 0;
    const mockProvider: Verifier = {
      async verify({ claim }) {
        providerCalls++;
        if (claim.includes("fourth planet")) {
          return {
            claim,
            verdict: "supported",
            probabilities: { supported: 0.95, contradicted: 0.01, insufficient: 0.04 },
            confidence: 0.95,
            evidenceIds: ["doc-1"],
            provider: "mock-llm",
          };
        }
        if (claim.includes("Venus is larger")) {
          return {
            claim,
            verdict: "contradicted",
            probabilities: { supported: 0.02, contradicted: 0.9, insufficient: 0.08 },
            confidence: 0.9,
            evidenceIds: ["doc-2"],
            provider: "mock-llm",
          };
        }
        if (claim.includes("complex cellular life")) {
          return {
            claim,
            verdict: "insufficient",
            probabilities: { supported: 0.3, contradicted: 0.1, insufficient: 0.6 },
            confidence: 0.6,
            evidenceIds: ["doc-3"],
            provider: "mock-llm",
          };
        }
        return {
          claim,
          verdict: "supported",
          probabilities: { supported: 0.7, contradicted: 0.05, insufficient: 0.25 },
          confidence: 0.7,
          evidenceIds: ["doc-4"],
          provider: "mock-llm",
        };
      },
    };

    const sink = new MemoryTraceSink();
    const shadowVerifier = new ShadowVerifier(mockProvider, {
      policy: baselinePolicy,
      traceSink: sink,
      provider: "mock-llm",
      model: "test-model-v1",
    });

    // 1. Run N fixture results online in shadow mode
    for (const item of fixtureInputs) {
      await shadowVerifier.verify(item);
    }

    expect(providerCalls).toBe(4);
    expect(sink.traces).toHaveLength(4);

    // 2. Export traces to JSONL and verify privacy (no raw claim text or secrets)
    const jsonl = exportTracesToJsonl(sink.traces);
    expect(jsonl).not.toContain("Mars is the fourth planet"); // Privacy by default!
    expect(jsonl).toContain("claimHash");

    // 3. Reset provider calls counter to 0 to guarantee NO provider calls occur during replay!
    providerCalls = 0;

    // 4. Import JSONL traces back
    const importedTraces = parseJsonlTraces(jsonl);
    expect(importedTraces).toHaveLength(4);

    // 5. Replay candidate policy offline without calling provider once
    const replayedCandidate = replayPolicy(importedTraces, candidatePolicy);
    expect(providerCalls).toBe(0); // Provider was NOT called!
    expect(replayedCandidate).toHaveLength(4);

    // Replay identity & online vs offline equivalence check
    const trace1ReplayedBaseline = replayPolicy([importedTraces[0]], baselinePolicy)[0];
    expect(trace1ReplayedBaseline.policyDecision).toBe("PASS");
    expect(trace1ReplayedBaseline.policyDecision).toBe(importedTraces[0].policyDecision);

    // 6. Compare policy snapshots on trace and generate delta report
    const report = comparePolicySnapshots({
      traces: importedTraces,
      policyA: baselinePolicy,
      policyB: candidatePolicy,
      runMetadata: { suite: "unit-replay-test", seed: 42 },
    });

    expect(report.totalTraces).toBe(4);
    expect(report.policyA.id).toBe("policy-permissive-v1");
    expect(report.policyB.id).toBe("policy-strict-v2");
    expect(report.deltas.decisionChangesCount).toBeGreaterThanOrEqual(1);
    expect(report.runMetadata).toEqual({ suite: "unit-replay-test", seed: 42 });

    // Zero provider calls throughout replay and comparison!
    expect(providerCalls).toBe(0);
  });
});
