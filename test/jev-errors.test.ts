import { describe, expect, it } from "vitest";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  getJevCacheNamespace, InvalidJevResponseError, JevVerifier,
  JEV_RUBRIC_FINGERPRINT,
} from "../src/providers/jev.js";

const evidence = [{ id: "doc", text: "The contract states a 30-day notice period." }];
const valid = () => ({
  model: "jev-1.13.0", usage: { input_tokens: 20, output_tokens: 8 },
  answers: {
    factuality: {
      type: "choice", choice: "supported", confidence: 0.9,
      probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
    },
    ev_0: { type: "noul", noul: 0.97 },
  },
});
function mock(response: unknown): JevVerifier {
  return new JevVerifier({ client: {
    systemOne: async () => response,
  } as unknown as TypeSafeClient });
}

describe("Jules #23 typed provider diagnostics", () => {
  it("preserves resolved model and valid evidence attribution", async () => {
    const verifier = mock(valid());
    const outcome = await verifier.verify({ claim: "Thirty days' notice is needed.", evidence });
    expect(outcome.model).toBe("jev-1.13.0");
    expect(outcome.rubricFingerprint).toBe(JEV_RUBRIC_FINGERPRINT);
    expect(outcome.evidenceIds).toEqual(["doc"]);
  });
  it("distinguishes missing answers from missing probabilities", async () => {
    const input = { claim: "A", evidence };
    await expect(mock({model:"jev-1.13.0",answers:{}}).verify(input))
      .rejects.toMatchObject({code:"JEV_RESPONSE_INVALID",reason:"MISSING_ANSWER"});
    const malformed = valid();
    (malformed.answers.factuality as {probabilities?: unknown}).probabilities = undefined;
    await expect(mock(malformed).verify(input))
      .rejects.toMatchObject({reason:"MALFORMED_PROBABILITIES"});
  });
  it("rejects choice/distribution disagreement without fabricating a verdict", async () => {
    const reply = valid();
    reply.answers.factuality.choice = "contradicted";
    await expect(mock(reply).verify({claim:"A",evidence}))
      .rejects.toMatchObject({reason:"LABEL_MISMATCH"});
  });
  it("preserves transient SDK errors instead of classifying them as malformed answers", async () => {
    const error = {status:429,headers:{"retry-after":"1"}};
    const verifier = new JevVerifier({client:{
      systemOne: async () => {throw error;},
    } as unknown as TypeSafeClient});
    await expect(verifier.verify({claim:"A",evidence})).rejects.toBe(error);
  });
  it("invalidates cache namespaces for each model or rubric fingerprint", () => {
    const a=getJevCacheNamespace("jev-v1","rubric-a");
    expect(a).not.toBe(getJevCacheNamespace("jev-v2","rubric-a"));
    expect(a).not.toBe(getJevCacheNamespace("jev-v1","rubric-b"));
    expect(() => getJevCacheNamespace("", "rubric")).toThrow();
    expect(new InvalidJevResponseError("bad","MISSING_ANSWER").reason).toBe("MISSING_ANSWER");
  });
});
