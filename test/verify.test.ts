import { describe, expect, it } from "vitest";
import { verifyAnswer } from "../src/verify.js";
import type { Verifier } from "../src/types.js";

describe("verifyAnswer", () => {
  it("aggregates claim verdicts conservatively", async () => {
    const verifier: Verifier = {
      async verify({ claim, evidence }) {
        const contradicted = claim.includes("2019");
        return {
          claim,
          verdict: contradicted ? "contradicted" : "supported",
          probabilities: contradicted
            ? { supported: 0.05, contradicted: 0.9, insufficient: 0.05 }
            : { supported: 0.95, contradicted: 0.02, insufficient: 0.03 },
          confidence: contradicted ? 0.9 : 0.95,
          evidenceIds: evidence.map((item) => item.id),
          provider: "fake",
        };
      },
    };

    const result = await verifyAnswer({
      answer: "Acme was founded in 2018. It launched in 2019.",
      evidence: [{ id: "doc-1", text: "Acme was founded in 2018." }],
      verifier,
    });

    expect(result.claims).toHaveLength(2);
    expect(result.verdict).toBe("contradicted");
    expect(result.probabilities.supported).toBeCloseTo(0.5);
  });

  it("treats an empty answer as insufficient", async () => {
    const verifier: Verifier = {
      async verify() {
        throw new Error("should not be called");
      },
    };

    const result = await verifyAnswer({
      answer: "",
      evidence: [],
      verifier,
    });

    expect(result.verdict).toBe("insufficient");
    expect(result.claims).toEqual([]);
  });
});
