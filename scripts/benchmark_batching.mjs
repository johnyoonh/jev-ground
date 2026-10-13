#!/usr/bin/env node
import { runBatchBenchmark } from "../dist/index.js";

async function main() {
  console.log("=== Jev-Ground Batch Verifier Benchmark ===");
  console.log("Evaluating 1, 5, and 20 claims (baseline vs batched)...");

  const report = await runBatchBenchmark({ claimCounts: [1, 5, 20] });

  console.table(
    report.results.map((r) => ({
      Claims: r.claimCount,
      "Baseline Calls": r.baseline.calls,
      "Batched Calls": r.batched.calls,
      "Call Reduction": `${r.callReductionRatio}x`,
      "Baseline Latency (ms)": r.baseline.uncachedLatencyMs,
      "Batched Latency (ms)": r.batched.uncachedLatencyMs,
      "Speedup": `${r.speedupRatio}x`,
      "Parity Match": r.outcomeParity ? "YES" : "NO",
    })),
  );

  console.log("\nSummary:");
  console.log(`- Outcome Parity Maintained across all claim counts: ${report.summary.allParitiesMatch}`);
  console.log(`- Total Baseline Provider Calls: ${report.summary.totalBaselineCalls}`);
  console.log(`- Total Batched Provider Calls: ${report.summary.totalBatchedCalls}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exitCode = 1;
});
