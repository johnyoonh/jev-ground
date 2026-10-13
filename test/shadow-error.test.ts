import { describe, expect, it } from "vitest";
import { mkdtemp, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ShadowVerifier } from "../src/shadow.js";
import { FileTraceSink } from "../src/trace.js";
import { replayPolicyOnTrace, comparePolicySnapshots } from "../src/replay.js";
import { evaluatePolicy } from "../src/policy.js";

const policy = { id: "shadow-v1", rubricVersion: "rubric-1" };
const input = { claim: "X", evidence: [{ id: "doc", text: "X" }] };

describe("Jules shadow-mode integration safeguards", () => {
  it("does not misclassify a failed provider call as factual insufficiency", async () => {
    const original = new Error("network broke");
    const shadow = new ShadowVerifier({ async verify() { throw original; } }, {
      policy, traceSink: { record() { throw new Error("telemetry broke"); } },
    });
    await expect(shadow.verify(input)).rejects.toBe(original);
    const trace = shadow.getRecordedTraces()[0];
    expect(trace.errorClass).toBe("Error");
    expect(trace.probabilities).toBeUndefined();
    expect(trace.verdict).toBeUndefined();
    expect(trace.policyDecision).toBe("REVIEW");
    const replay = replayPolicyOnTrace(trace, policy);
    expect(replay.policyDecision).toBe("REVIEW");
    expect(replay.probabilities).toBeUndefined();
  });

  it("never changes successful verification when telemetry sinks fail", async () => {
    const verification = { claim: "X", verdict: "supported" as const,
      confidence: 0.9, evidenceIds: ["doc"], provider: "mock",
      probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 } };
    const shadow = new ShadowVerifier({ async verify() { return verification; } }, {
      policy,
      traceSink: { record() { throw new Error("sink failed"); } },
      onTrace() { throw new Error("callback failed"); },
      metadata: { privateEmail: "secret@example.com" },
    });
    expect(await shadow.verify(input)).toBe(verification);
    const trace = shadow.getRecordedTraces()[0];
    expect(trace.metadata).toBeUndefined();
    expect(trace.rawClaim).toBeUndefined();
  });

  it("treats unlabeled PASS transitions as policy changes, not false positives", async () => {
    const shadow = new ShadowVerifier({ async verify() {
      return { claim: "X", verdict: "supported" as const,
        confidence: .92, evidenceIds: ["doc"],
        probabilities: { supported: .92, contradicted: .04, insufficient: .04 } };
    } }, { policy });
    await shadow.verify(input);
    const permissive = { id: "pass", rubricVersion: "1",
      thresholds: {passSupportedThreshold:.8,failContradictedThreshold:.95,reviewContradictedThreshold:.99,reviewInsufficientThreshold:.99} };
    const conservative = { id:"review", rubricVersion:"1", thresholds:{
      passSupportedThreshold:.99,failContradictedThreshold:.95,reviewContradictedThreshold:.99,reviewInsufficientThreshold:.99 } };
    const report = comparePolicySnapshots({ traces: shadow.getRecordedTraces(),
      policyA: conservative, policyB: permissive });
    expect(report.deltas.falsePasses).toBe(0);
    expect(report.deltas.newPassesWithoutGold).toBe(1);
    expect(report.deltas.labeledCount).toBe(0);
  });

  it("validates policy probability distribution before any PASS", () => {
    expect(() => evaluatePolicy(policy, {
      probabilities: { supported: NaN, contradicted: 0, insufficient: 1 },
    })).toThrow("Invalid three-class");
  });

  it("uses restrictive permissions on disk traces", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jev-shadow-"));
    try {
      const file = path.join(dir, "private.jsonl");
      const shadow = new ShadowVerifier({ async verify() {
        return { claim: "X", verdict: "supported" as const,
          probabilities: {supported:.9,contradicted:.05,insufficient:.05},
          confidence:.9,evidenceIds:[] };
      }}, {policy,traceSink:new FileTraceSink(file)});
      await shadow.verify(input);
      const info = await stat(file);
      if (process.platform !== "win32") expect(info.mode & 0o077).toBe(0);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
