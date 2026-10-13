import { describe, expect, it, vi } from "vitest";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { InvalidJevResponseError, JevVerifier, JEV_RUBRIC_FINGERPRINT } from "../src/providers/jev.js";
import { verifyAnswer } from "../src/verify.js";

const evidence = [
  { id: "relevant", text: "Acme launched in 2018." },
  { id: "distractor", text: "Acme has 40 employees." },
];

function makeAnswer(override: Record<string, unknown> = {}) {
  return {
    type: "choice", choice: "supported", confidence: 0.91,
    probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
    ...override,
  };
}
function fakeClient(changes: Record<string, unknown> = {}) {
  const systemOne = vi.fn(async (request: { questions: Record<string, unknown> }) => {
    const answers: Record<string, unknown> = {};
    for (const name of Object.keys(request.questions)) {
      if (name.startsWith("factuality")) answers[name] = makeAnswer(changes);
      else if (name.startsWith("ev_")) {
        answers[name] = { type: "noul", noul: name.endsWith("_0") || name === "ev_0" ? 0.9 : 0.01 };
      }
    }
    return { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 5 } };
  });
  return { client: { systemOne } as unknown as TypeSafeClient, systemOne };
}

describe("P0 validated batched Jev verifier", () => {
  it("batches ten independently scored claims in one Jev API call", async () => {
    const { client, systemOne } = fakeClient();
    const verifier = new JevVerifier({ client, model: "jev-1.13.0" });
    const answer = Array.from({ length: 10 }, (_, i) => "Claim number " + (i + 1) + ".").join(" ");
    const result = await verifyAnswer({ answer, evidence, verifier });
    expect(result.claims).toHaveLength(10);
    expect(result.verdict).toBe("supported");
    expect(systemOne).toHaveBeenCalledTimes(1);
    expect(Object.keys(systemOne.mock.calls[0][0].questions)).toHaveLength(30);
    expect(systemOne.mock.calls[0][1]).toEqual({ retry: { maxRetries: 0 } });
    expect(result.claims.every(x => x.model === "jev-1.13.0")).toBe(true);
    expect(result.claims.every(x => x.rubricFingerprint === JEV_RUBRIC_FINGERPRINT)).toBe(true);
    expect(result.claims.every(x => x.evidenceIds.includes("relevant"))).toBe(true);
    expect(result.claims.every(x => !x.evidenceIds.includes("distractor"))).toBe(true);
  });

  it("chunks at maxQuestions and never drops evidence", async () => {
    const { client, systemOne } = fakeClient();
    const verifier = new JevVerifier({ client, maxQuestionsPerRequest: 6 });
    const result = await verifier.verifyMany(Array.from({ length: 7 }, (_, i) => ({
      claim: "Claim " + i, evidence,
    })));
    expect(result.map(x => x.claim)).toEqual(Array.from({ length: 7 }, (_, i) => "Claim " + i));
    expect(systemOne).toHaveBeenCalledTimes(4);
    expect(systemOne.mock.calls.every(c => Object.keys(c[0].questions).length <= 6)).toBe(true);
  });

  it("falls back to separate requests when evidence differs", async () => {
    const { client, systemOne } = fakeClient();
    const verifier = new JevVerifier({ client });
    await verifier.verifyMany([
      { claim: "A", evidence: [evidence[0]] },
      { claim: "B", evidence: [evidence[1]] },
    ]);
    expect(systemOne).toHaveBeenCalledTimes(2);
  });

  it("fails on missing API key before any network request, without dummy credentials", async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    try {
      delete process.env.TYPESAFE_API_KEY;
      const verifier = new JevVerifier();
      await expect(verifier.verify({ claim: "Acme launched", evidence })).rejects.toThrow(
        "TYPESAFE_API_KEY is required",
      );
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it.each([
    { name: "missing label", change: { probabilities: { supported: 0.95, contradicted: 0.05 } } },
    { name: "NaN", change: { probabilities: { supported: NaN, contradicted: 0, insufficient: 1 } } },
    { name: "not normalized", change: { probabilities: { supported: 0.1, contradicted: 0.1, insufficient: 0.1 } } },
    { name: "wrong winner", change: { choice: "contradicted" } },
    { name: "wrong confidence", change: { confidence: 2 } },
  ])("rejects $name instead of inventing a factuality score", async ({ change }) => {
    const { client } = fakeClient(change);
    const verifier = new JevVerifier({ client });
    await expect(verifier.verify({ claim: "A", evidence }))
      .rejects.toBeInstanceOf(InvalidJevResponseError);
  });

  it("rejects incomplete attribution responses, duplicates, or oversized evidence", async () => {
    const client = { systemOne: vi.fn(async () => ({
      model: "jev-1.13.0", usage: {}, answers: { factuality: makeAnswer() },
    })) } as unknown as TypeSafeClient;
    await expect(new JevVerifier({ client }).verify({ claim: "A", evidence }))
      .rejects.toBeInstanceOf(InvalidJevResponseError);
    await expect(new JevVerifier({ client }).verify({
      claim: "A", evidence: [evidence[0], evidence[0]],
    })).rejects.toThrow("unique");
    await expect(new JevVerifier({ client, maxStateChars: 10 }).verify({
      claim: "A", evidence,
    })).rejects.toThrow("exceeds");
  });

  it("rejects misaligned batch results rather than silently reassigning claims", async () => {
    const verifier = {
      async verify() { throw new Error("must not run per-claim"); },
      async verifyMany() {
        return [{ claim: "not the requested claim", verdict: "supported" as const,
          probabilities: { supported: 1, contradicted: 0, insufficient: 0 },
          confidence: 1, evidenceIds: ["relevant"] }];
      },
    };
    await expect(verifyAnswer({
      answer: "Acme launched in 2018.", evidence, verifier,
    })).rejects.toThrow("out-of-order");
  });

  it("uses deterministic insufficient for zero evidence without billing", async () => {
    const { client, systemOne } = fakeClient();
    const verifier = new JevVerifier({ client });
    const result = await verifier.verify({ claim: "A", evidence: [] });
    expect(result.verdict).toBe("insufficient");
    expect(result.provider).toBe("deterministic-no-evidence");
    expect(systemOne).not.toHaveBeenCalled();
  });
});
