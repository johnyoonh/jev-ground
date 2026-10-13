import { describe, expect, it } from "vitest";
import {
  JevVerificationError,
  JevVerifier,
  getJevCacheNamespace,
  getJevRubricFingerprint,
} from "../src/providers/jev.js";
import type { VerifyClaimInput } from "../src/types.js";

const dummyInput: VerifyClaimInput = {
  claim: "Water boils at 100 degrees Celsius at sea level.",
  evidence: [
    { id: "e1", text: "At 1 atm pressure, water's boiling point is 100 °C." },
  ],
};

function createMockClient(systemOneImpl: (params: any) => Promise<any>): any {
  return {
    systemOne: systemOneImpl,
  };
}

describe("JevVerifier validation and contract handling", () => {
  it("successfully parses valid response and records metadata", async () => {
    const mockClient = createMockClient(async () => ({
      model: "jev-v1.2.0",
      usage: { prompt_tokens: 120, completion_tokens: 15 },
      answers: {
        factuality: {
          choice: "supported",
          probabilities: {
            supported: 0.92,
            contradicted: 0.03,
            insufficient: 0.05,
          },
          confidence: 0.92,
        },
      },
    }));

    const verifier = new JevVerifier({ client: mockClient, model: "jev-alias" });
    const result = await verifier.verify(dummyInput);

    expect(result.verdict).toBe("supported");
    expect(result.probabilities).toEqual({
      supported: 0.92,
      contradicted: 0.03,
      insufficient: 0.05,
    });
    expect(result.confidence).toBe(0.92);
    expect(result.provider).toBe("jev");
    expect(result.metadata?.model).toBe("jev-v1.2.0");
    expect(result.metadata?.rubricFingerprint).toBe(getJevRubricFingerprint());
    expect(result.metadata?.usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 15,
    });
    expect(typeof result.metadata?.latencyMs).toBe("number");
  });

  it("throws MISSING_ANSWER when answers or factuality is missing", async () => {
    const mockClient = createMockClient(async () => ({
      answers: {},
    }));

    const verifier = new JevVerifier({ client: mockClient });
    await expect(verifier.verify(dummyInput)).rejects.toThrow(JevVerificationError);
    await expect(verifier.verify(dummyInput)).rejects.toHaveProperty(
      "code",
      "MISSING_ANSWER",
    );
  });

  it("throws MALFORMED_PROBABILITIES when probabilities are missing or missing required labels", async () => {
    const mockClient = createMockClient(async () => ({
      answers: {
        factuality: {
          choice: "supported",
          probabilities: {
            supported: 0.9,
            contradicted: 0.1,
            // insufficient label missing
          },
        },
      },
    }));

    const verifier = new JevVerifier({ client: mockClient });
    try {
      await verifier.verify(dummyInput);
      expect.fail("Should have thrown JevVerificationError");
    } catch (err: any) {
      expect(err).toBeInstanceOf(JevVerificationError);
      expect(err.code).toBe("MALFORMED_PROBABILITIES");
    }
  });

  it("throws MALFORMED_PROBABILITIES on NaN or out-of-range probabilities", async () => {
    const mockClient = createMockClient(async () => ({
      answers: {
        factuality: {
          choice: "supported",
          probabilities: {
            supported: Number.NaN,
            contradicted: 0.1,
            insufficient: 0.9,
          },
        },
      },
    }));

    const verifier = new JevVerifier({ client: mockClient });
    await expect(verifier.verify(dummyInput)).rejects.toHaveProperty(
      "code",
      "MALFORMED_PROBABILITIES",
    );
  });

  it("throws MALFORMED_PROBABILITIES when probability sum exceeds tolerance", async () => {
    const mockClient = createMockClient(async () => ({
      answers: {
        factuality: {
          choice: "supported",
          probabilities: {
            supported: 0.8,
            contradicted: 0.1,
            insufficient: 0.0, // sum = 0.9, default tolerance is 0.02 ([0.98, 1.02])
          },
        },
      },
    }));

    const verifier = new JevVerifier({ client: mockClient });
    await expect(verifier.verify(dummyInput)).rejects.toHaveProperty(
      "code",
      "MALFORMED_PROBABILITIES",
    );
  });

  it("throws LABEL_MISMATCH when choice does not match distribution argmax", async () => {
    const mockClient = createMockClient(async () => ({
      answers: {
        factuality: {
          choice: "supported", // prob = 0.1
          probabilities: {
            supported: 0.1,
            contradicted: 0.8, // max prob is 0.8!
            insufficient: 0.1,
          },
        },
      },
    }));

    const verifier = new JevVerifier({ client: mockClient });
    try {
      await verifier.verify(dummyInput);
      expect.fail("Should have thrown JevVerificationError");
    } catch (err: any) {
      expect(err).toBeInstanceOf(JevVerificationError);
      expect(err.code).toBe("LABEL_MISMATCH");
    }
  });

  it("allows tie-breaker when choice matches equal highest probability", async () => {
    const mockClient = createMockClient(async () => ({
      answers: {
        factuality: {
          choice: "supported",
          probabilities: {
            supported: 0.5,
            contradicted: 0.5,
            insufficient: 0.0,
          },
        },
      },
    }));

    const verifier = new JevVerifier({ client: mockClient });
    const result = await verifier.verify(dummyInput);
    expect(result.verdict).toBe("supported");
  });

  it("generates distinct cache namespaces for different models or rubric fingerprints", () => {
    const ns1 = getJevCacheNamespace("model-a", "fingerprint-1");
    const ns2 = getJevCacheNamespace("model-b", "fingerprint-1");
    const ns3 = getJevCacheNamespace("model-a", "fingerprint-2");

    expect(ns1).not.toBe(ns2);
    expect(ns1).not.toBe(ns3);
  });
});

describe("JevVerifier live canary (opt-in)", () => {
  it.runIf(Boolean(process.env.JEV_LIVE_CANARY && process.env.TYPESAFE_API_KEY))(
    "executes live API call against TypeSafe SDK when explicitly opted in",
    async () => {
      const verifier = new JevVerifier();
      const result = await verifier.verify(dummyInput);
      expect(["supported", "contradicted", "insufficient"]).includes(result.verdict);
      expect(result.probabilities.supported).toBeGreaterThanOrEqual(0);
      expect(result.probabilities.supported).toBeLessThanOrEqual(1);
    },
  );
});
