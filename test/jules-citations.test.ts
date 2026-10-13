import { describe, expect, it, vi } from "vitest";
import { JevVerifier } from "../src/providers/jev.js";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { verifyAnswer } from "../src/verify.js";

describe("JevVerifier evidence attribution", () => {
  it("identifies one relevant chunk among several distractors", async () => {
    const mockSystemOne = vi.fn().mockResolvedValue({
      model: "jev-latest",
      usage: { input_tokens: 10, output_tokens: 10 },
      answers: {
        factuality: {
          type: "choice",
          choice: "supported",
          confidence: 0.95,
          probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
        },
        ev_0: { type: "noul", noul: 0.02 }, // distractor doc-1
        ev_1: { type: "noul", noul: 0.98 }, // relevant doc-2
        ev_2: { type: "noul", noul: 0.01 }, // distractor doc-3
      },
    });

    const client = { systemOne: mockSystemOne } as unknown as TypeSafeClient;
    const verifier = new JevVerifier({ client });

    const result = await verifier.verify({
      claim: "Acme was founded in 2018.",
      evidence: [
        { id: "doc-1", text: "Acme is based in New York." },
        { id: "doc-2", text: "Acme was founded in 2018." },
        { id: "doc-3", text: "Acme has 50 employees." },
      ],
    });

    expect(result.verdict).toBe("supported");
    expect(result.evidenceIds).toEqual(["doc-2"]);
    expect(result.probabilities).toEqual({
      supported: 0.9,
      contradicted: 0.05,
      insufficient: 0.05,
    });
    expect(result.confidence).toBe(0.95);
  });

  it("returns empty evidenceIds when claim is insufficient", async () => {
    const mockSystemOne = vi.fn().mockResolvedValue({
      model: "jev-latest",
      usage: { input_tokens: 10, output_tokens: 10 },
      answers: {
        factuality: {
          type: "choice",
          choice: "insufficient",
          confidence: 0.85,
          probabilities: { supported: 0.1, contradicted: 0.1, insufficient: 0.8 },
        },
        ev_0: { type: "noul", noul: 0.9 }, // even if high noul, verdict is insufficient
      },
    });

    const client = { systemOne: mockSystemOne } as unknown as TypeSafeClient;
    const verifier = new JevVerifier({ client });

    const result = await verifier.verify({
      claim: "Acme went public in 2020.",
      evidence: [{ id: "doc-1", text: "Acme was founded in 2018." }],
    });

    expect(result.verdict).toBe("insufficient");
    expect(result.evidenceIds).toEqual([]);
    expect(result.probabilities).toEqual({
      supported: 0.1,
      contradicted: 0.1,
      insufficient: 0.8,
    });
  });

  it("filters out unknown/hallucinated evidence IDs safely in verifyAnswer", async () => {
    const verifier = {
      async verify() {
        return {
          claim: "Acme was founded in 2018.",
          verdict: "supported" as const,
          probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
          confidence: 0.9,
          evidenceIds: ["doc-1", "hallucinated-doc-99"],
          provider: "mock",
        };
      },
    };

    const result = await verifyAnswer({
      answer: "Acme was founded in 2018.",
      evidence: [{ id: "doc-1", text: "Acme was founded in 2018." }],
      verifier,
    });

    expect(result.claims[0].evidenceIds).toEqual(["doc-1"]);
  });
});
