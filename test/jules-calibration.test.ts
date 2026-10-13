import { describe, expect, it } from "vitest";
import { computeCalibrationMetrics, computeConfusionMatrix, computeClassMetrics } from "../src/benchmark/metrics.js";
import { runReliableBenchmark } from "../src/benchmark/reliable.js";
import type { BenchmarkPrediction } from "../src/benchmark/types.js";

const passed: BenchmarkPrediction = {
  item: { id: "ok", claim: "Valid", evidence: [], goldVerdict: "supported" },
  verification: {
    claim: "Valid", verdict: "supported", confidence: 0.8, evidenceIds: [],
    probabilities: { supported: 0.8, contradicted: 0.1, insufficient: 0.1 },
  },
  latencyMs: 10,
};
const failed: BenchmarkPrediction = {
  item: { id: "fail", claim: "Unavailable", evidence: [], goldVerdict: "insufficient" },
  latencyMs: 20, error: "RateLimitError: exhausted",
};
describe("Jules #22 calibration and failure accounting", () => {
  it("excludes errors from calibration, Brier and confusion matrix", () => {
    const cal = computeCalibrationMetrics([passed, failed]);
    expect(cal?.ece).toBeCloseTo(0.2, 4);
    expect(cal?.brierScore).toBeCloseTo(0.06, 4);
    const matrix = computeConfusionMatrix([passed, failed]);
    const m = computeClassMetrics(matrix);
    expect(m.totalSamples).toBe(1);
    expect(m.accuracy).toBe(1);
    expect(matrix.insufficient.insufficient).toBe(0);
    expect(computeCalibrationMetrics([failed])).toBeUndefined();
  });
  it("reports failure ratio and cache latency split on resumable runner", async () => {
    const dataset = [
      {id:"1",claim:"Good",goldVerdict:"supported" as const,evidence:[{id:"e",text:"Good"}]},
      {id:"2",claim:"Bad",goldVerdict:"insufficient" as const,evidence:[{id:"e",text:"Bad"}]},
    ];
    const verifier = {async verify({claim}: {claim:string}) {
      if (claim === "Bad") throw new Error("RateLimitError: unavailable");
      return {
        claim, verdict: "supported" as const, cacheHit: false, confidence: 0.8, evidenceIds: [],
        probabilities: { supported: 0.8, contradicted: 0.1, insufficient: 0.1 },
      };
    }};
    const result = await runReliableBenchmark({dataset,verifier,concurrency:1});
    expect(result.scored).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failureRate).toBe(0.5);
    expect(result.errorBreakdown?.Error).toBe(1);
    expect(result.calibration?.brierScore).toBeCloseTo(0.06, 4);
    expect(result.uncachedLatency).toBeDefined();
    expect(result.cachedLatency).toBeUndefined();
  });
});
