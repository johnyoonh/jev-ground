import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadJsonlDataset } from "./dataset.js";
import {
  aggregateTokenCost,
  computeCalibrationMetrics,
  computeClassMetrics,
  computeConfusionMatrix,
  computeLatencyMetrics,
  VERDICTS,
} from "./metrics.js";
import type {
  BenchmarkItem,
  BenchmarkOptions,
  BenchmarkPrediction,
  BenchmarkResult,
  LatencyMetrics,
} from "./types.js";

export async function runBenchmark({
  verifier,
  dataset,
  verifierName,
  outputPath,
}: BenchmarkOptions): Promise<BenchmarkResult> {
  const items: BenchmarkItem[] =
    typeof dataset === "string" ? await loadJsonlDataset(dataset) : dataset;

  const resolvedName =
    verifierName ??
    (verifier.constructor ? verifier.constructor.name : undefined) ??
    "Verifier";

  const predictions: BenchmarkPrediction[] = [];
  const latencies: number[] = [];

  const overallStartTime = performance.now();

  for (const item of items) {
    const startTime = performance.now();
    try {
      const verification = await verifier.verify({
        claim: item.claim,
        evidence: item.evidence,
      });
      const endTime = performance.now();
      const latencyMs = endTime - startTime;
      latencies.push(latencyMs);

      predictions.push({
        item,
        verification,
        latencyMs,
      });
    } catch (err: unknown) {
      const endTime = performance.now();
      const latencyMs = endTime - startTime;
      latencies.push(latencyMs);

      predictions.push({
        item,
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const overallEndTime = performance.now();
  const totalExecutionTimeSec = (overallEndTime - overallStartTime) / 1000;

  const scoredPredictions = predictions.filter(
    (p) => !p.error && p.verification !== undefined,
  );
  const failedPredictions = predictions.filter(
    (p) => p.error !== undefined || !p.verification,
  );

  const scoredCount = scoredPredictions.length;
  const failedCount = failedPredictions.length;
  const failureRate =
    items.length > 0 ? Math.round((failedCount / items.length) * 10000) / 10000 : 0;
  const throughput =
    totalExecutionTimeSec > 0
      ? Math.round((items.length / totalExecutionTimeSec) * 100) / 100
      : 0;

  const errorBreakdown: Record<string, number> = {};
  for (const failed of failedPredictions) {
    const errMsg = failed.error ?? "Unknown error";
    errorBreakdown[errMsg] = (errorBreakdown[errMsg] ?? 0) + 1;
  }

  const confusionMatrix = computeConfusionMatrix(predictions);
  const { perClassMetrics, macroMetrics, accuracy } =
    computeClassMetrics(confusionMatrix);
  const calibration = computeCalibrationMetrics(predictions);

  const latency = computeLatencyMetrics(latencies);

  let cachedLatency: LatencyMetrics | undefined;
  let uncachedLatency: LatencyMetrics | undefined;

  const cachedLatencies = predictions
    .filter((p) => p.verification?.cacheHit === true)
    .map((p) => p.latencyMs);

  const uncachedLatencies = predictions
    .filter((p) => p.verification && p.verification.cacheHit !== true)
    .map((p) => p.latencyMs);

  if (cachedLatencies.length > 0) {
    cachedLatency = computeLatencyMetrics(cachedLatencies);
  }
  if (uncachedLatencies.length > 0) {
    uncachedLatency = computeLatencyMetrics(uncachedLatencies);
  }

  const tokenCost = aggregateTokenCost(predictions);

  const result: BenchmarkResult = {
    timestamp: new Date().toISOString(),
    verifierName: resolvedName,
    datasetSize: items.length,
    scoredCount,
    failedCount,
    failureRate,
    throughput,
    errorBreakdown,
    accuracy,
    macroMetrics,
    perClassMetrics,
    confusionMatrix,
    calibration,
    latency,
    ...(cachedLatency ? { cachedLatency } : {}),
    ...(uncachedLatency ? { uncachedLatency } : {}),
    ...(tokenCost ? { tokenCost } : {}),
    predictions,
  };

  if (outputPath) {
    const dir = path.dirname(outputPath);
    if (dir && dir !== ".") {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf-8");
  }

  return result;
}

export function formatConsoleSummary(result: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push("=================================================");
  lines.push(` Factuality Benchmark Summary: ${result.verifierName}`);
  lines.push("=================================================");
  lines.push(`Timestamp:    ${result.timestamp}`);
  lines.push(
    `Dataset Size: ${result.datasetSize} samples (Scored: ${result.scoredCount}, Failed: ${result.failedCount}, Failure Rate: ${(result.failureRate * 100).toFixed(2)}%)`,
  );
  lines.push(`Throughput:   ${result.throughput.toFixed(2)} items/sec`);
  lines.push(`Accuracy:     ${(result.accuracy * 100).toFixed(2)}%`);
  lines.push(
    `Macro Avg:    Precision: ${(result.macroMetrics.precision * 100).toFixed(2)}% | Recall: ${(result.macroMetrics.recall * 100).toFixed(2)}% | F1: ${(result.macroMetrics.f1 * 100).toFixed(2)}%`,
  );
  lines.push(
    `Calibration:  ECE: ${result.calibration.ece.toFixed(4)} | Brier Score: ${result.calibration.brierScore.toFixed(4)}`,
  );
  lines.push("");
  lines.push("--- Per-Class Metrics ---");
  lines.push(
    `${"Class".padEnd(14)} | ${"Precision".padStart(9)} | ${"Recall".padStart(9)} | ${"F1".padStart(9)} | ${"Support".padStart(7)}`,
  );
  lines.push("-".repeat(58));

  for (const verdict of VERDICTS) {
    const m = result.perClassMetrics[verdict];
    lines.push(
      `${verdict.padEnd(14)} | ${(m.precision * 100).toFixed(2).padStart(8)}% | ${(m.recall * 100).toFixed(2).padStart(8)}% | ${(m.f1 * 100).toFixed(2).padStart(8)}% | ${String(m.support).padStart(7)}`,
    );
  }

  lines.push("");
  lines.push("--- Confusion Matrix (Gold \\ Predicted) ---");
  lines.push(
    `${"Gold \\ Pred".padEnd(14)} | ${"Supported".padStart(11)} | ${"Contradicted".padStart(12)} | ${"Insufficient".padStart(12)}`,
  );
  lines.push("-".repeat(58));

  for (const gold of VERDICTS) {
    const row = result.confusionMatrix[gold];
    lines.push(
      `${gold.padEnd(14)} | ${String(row.supported).padStart(11)} | ${String(row.contradicted).padStart(12)} | ${String(row.insufficient).padStart(12)}`,
    );
  }

  lines.push("");
  lines.push("--- Latency ---");
  lines.push(
    `Overall:  Total: ${result.latency.totalMs.toFixed(2)} ms | Mean: ${result.latency.meanMs.toFixed(2)} ms | Median: ${result.latency.medianMs.toFixed(2)} ms | Min: ${result.latency.minMs.toFixed(2)} ms | Max: ${result.latency.maxMs.toFixed(2)} ms | P95: ${result.latency.p95Ms.toFixed(2)} ms`,
  );

  if (result.cachedLatency) {
    lines.push(
      `Cached:   Mean: ${result.cachedLatency.meanMs.toFixed(2)} ms | Median: ${result.cachedLatency.medianMs.toFixed(2)} ms | P95: ${result.cachedLatency.p95Ms.toFixed(2)} ms`,
    );
  }

  if (result.uncachedLatency) {
    lines.push(
      `Uncached: Mean: ${result.uncachedLatency.meanMs.toFixed(2)} ms | Median: ${result.uncachedLatency.medianMs.toFixed(2)} ms | P95: ${result.uncachedLatency.p95Ms.toFixed(2)} ms`,
    );
  }

  if (result.failedCount > 0 && Object.keys(result.errorBreakdown).length > 0) {
    lines.push("");
    lines.push("--- Provider Error Breakdown ---");
    for (const [err, count] of Object.entries(result.errorBreakdown)) {
      lines.push(`  ${err}: ${count}`);
    }
  }

  if (result.tokenCost) {
    lines.push("");
    lines.push("--- Token & Cost Metadata ---");
    if (result.tokenCost.promptTokens !== undefined) {
      lines.push(`Prompt Tokens:     ${result.tokenCost.promptTokens}`);
    }
    if (result.tokenCost.completionTokens !== undefined) {
      lines.push(`Completion Tokens: ${result.tokenCost.completionTokens}`);
    }
    if (result.tokenCost.totalTokens !== undefined) {
      lines.push(`Total Tokens:      ${result.tokenCost.totalTokens}`);
    }
    if (result.tokenCost.totalCost !== undefined) {
      lines.push(`Total Cost:        $${result.tokenCost.totalCost.toFixed(4)}`);
    }
  }

  lines.push("=================================================");
  return lines.join("\n");
}
