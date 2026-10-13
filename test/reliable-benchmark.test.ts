import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runReliableBenchmark } from "../src/benchmark/reliable.js";
import type { Verifier } from "../src/types.js";

const evidence = [{ id: "evidence", text: "The source confirms the claim." }];
function items(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: "item-" + i, claim: "Claim " + i, evidence, goldVerdict: "supported" as const,
  }));
}
const response = (claim: string) => ({
  claim, verdict: "supported" as const,
  probabilities: { supported: 0.9, contradicted: 0.05, insufficient: 0.05 },
  confidence: 0.9, evidenceIds: ["evidence"],
});

describe("P0 reliable benchmark runner", () => {
  it("rejects invalid provider preflight before launching bulk calls", async () => {
    const verifier: Verifier = { verify: vi.fn(async ({ claim }) => response(claim)) };
    const preflight: Verifier = {
      verify: vi.fn(async () => { throw { status: 401, message: "Unauthorized" }; }),
    };
    await expect(runReliableBenchmark({
      dataset: items(9), verifier, preflightVerifier: preflight, concurrency: 4,
    })).rejects.toThrow("Preflight failed");
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(preflight.verify).toHaveBeenCalledTimes(1);
  });

  it("preflight fails if supplied cached response is not a live canary", async () => {
    const verifier: Verifier = { verify: vi.fn(async ({ claim }) => ({
      ...response(claim), cacheHit: true,
    })) };
    await expect(runReliableBenchmark({
      dataset: items(4), verifier,
    })).rejects.toThrow("was cached");
    expect(verifier.verify).toHaveBeenCalledTimes(1);
  });

  it("limits concurrent provider requests", async () => {
    let active = 0;
    let highWater = 0;
    const verifier: Verifier = { async verify({ claim }) {
      active++;
      highWater = Math.max(highWater, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return response(claim);
    }};
    const result = await runReliableBenchmark({
      dataset: items(16), verifier, concurrency: 3,
    });
    expect(result.failed).toBe(0);
    expect(result.scored).toBe(16);
    expect(highWater).toBeLessThanOrEqual(3);
    expect(highWater).toBeGreaterThan(1);
  });

  it("resumes successful cases without re-paying and prevents stale fingerprints", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jev-ground-resume-"));
    const checkpointPath = path.join(dir, "benchmark.jsonl");
    const controller = new AbortController();
    let firstCount = 0;
    const verifier: Verifier = { async verify({ claim }) {
      firstCount++;
      if (claim === "Claim 1") controller.abort();
      return response(claim);
    }};
    const options = {
      dataset: items(4), verifier, checkpointPath,
      runFingerprint: "jev-1.13.0:grounding-v2", concurrency: 1,
    };
    try {
      await expect(runReliableBenchmark({
        ...options, signal: controller.signal,
      })).rejects.toThrow("aborted");
      expect(firstCount).toBe(2); // one preflight and one worker
      let remaining = 0;
      const recovered: Verifier = { async verify({ claim }) {
        remaining++;
        return response(claim);
      }};
      const result = await runReliableBenchmark({
        ...options, verifier: recovered, resume: true,
      });
      expect(result.resumed).toBe(2);
      expect(result.scored).toBe(4);
      expect(result.failed).toBe(0);
      expect(remaining).toBe(2);
      await expect(runReliableBenchmark({
        ...options, verifier: recovered, resume: true,
        runFingerprint: "jev-another-version",
      })).rejects.toThrow("fingerprint");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not count a failed request as an insufficient prediction", async () => {
    let started = 0;
    const verifier: Verifier = { async verify({claim}) {
      started++;
      if (claim === "Claim 2") throw { status: 503 };
      return response(claim);
    }};
    const result = await runReliableBenchmark({
      dataset: items(4), verifier, concurrency: 2,
    });
    expect(started).toBe(4);
    expect(result.scored).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.confusionMatrix.insufficient.insufficient).toBe(0);
  });
});
