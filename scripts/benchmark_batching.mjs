#!/usr/bin/env node
import { runBatchBenchmark } from "../dist/index.js";

const report = await runBatchBenchmark([1,5,20]);
console.log("Synthetic/offline request-count comparison (NOT Jev API latency or cost)");
console.table(report.results.map(r => ({
  claims:r.claimCount,sequentialCalls:r.sequentialCalls,
  batchedCalls:r.batchedCalls,verdictParity:r.verdictParity,
  sequentialMs:r.sequentialMs.toFixed(2),batchedMs:r.batchedMs.toFixed(2),
})));
if (!report.allParity) process.exitCode = 1;
