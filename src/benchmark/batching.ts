import { performance } from "node:perf_hooks";
import type { Verification, VerifyClaimInput } from "../types.js";

export interface BatchComparison {
  claimCount: number;
  sequentialCalls: number;
  batchedCalls: number;
  verdictParity: boolean;
  sequentialMs: number;
  batchedMs: number;
}
export interface BatchComparisonReport {
  mode: "synthetic-offline";
  /** Request-count comparison, not a statement about Jev model latency or cost. */
  results: BatchComparison[];
  allParity: boolean;
}

function fixture(count: number): VerifyClaimInput[] {
  const evidence = [{ id: "doc", text: "Acme was founded in 2010." }];
  return Array.from({ length: count }, (_, i) => ({
    claim: "Acme was founded in " + (i % 2 === 0 ? "2010" : "1990") + ". #" + i,
    evidence,
  }));
}

function fakeJudge(inputs: VerifyClaimInput[]): Verification[] {
  return inputs.map(input => {
    const supported = input.claim.includes("2010");
    return {
      claim: input.claim,
      verdict: supported ? "supported" as const : "contradicted" as const,
      probabilities: supported
        ? {supported:.9,contradicted:.05,insufficient:.05}
        : {supported:.05,contradicted:.9,insufficient:.05},
      confidence:.9,
      evidenceIds:["doc"],
      provider:"synthetic-offline",
    };
  });
}

/**
 * Based on Jules PR #25, with fake caching/real-network speedup claims removed.
 * All results are reproducible request-count tests against a synthetic handler.
 */
export async function runBatchBenchmark(
  counts: readonly number[] = [1,5,20],
): Promise<BatchComparisonReport> {
  if (!counts.length || counts.some(n => !Number.isInteger(n) || n < 1 || n > 200)) {
    throw new RangeError("All batch claim counts must be integers in [1,200]");
  }
  const results: BatchComparison[] = [];
  for (const claimCount of counts) {
    const inputs = fixture(claimCount);
    let sequentialCalls = 0;
    const startSequential = performance.now();
    const sequential = await Promise.all(inputs.map(async input => {
      sequentialCalls++;
      return fakeJudge([input])[0];
    }));
    const sequentialMs = performance.now() - startSequential;
    let batchedCalls = 0;
    const startBatched = performance.now();
    batchedCalls++;
    const batched = fakeJudge(inputs);
    const batchedMs = performance.now() - startBatched;
    results.push({
      claimCount, sequentialCalls, batchedCalls,
      verdictParity: sequential.length === batched.length &&
        sequential.every((r,i) => r.verdict === batched[i].verdict),
      sequentialMs, batchedMs,
    });
  }
  return {
    mode:"synthetic-offline",results,
    allParity:results.every(r => r.verdictParity),
  };
}
