import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadJsonlDataset } from "./dataset.js";
import {
  aggregateTokenCost,
  computeClassMetrics,
  computeCalibrationMetrics,
  computeConfusionMatrix,
  computeLatencyMetrics,
  VERDICTS,
} from "./metrics.js";
import type {
  BenchmarkItem,
  BenchmarkOptions,
  BenchmarkPrediction,
  BenchmarkResult,
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
  const startRun = performance.now();

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

  const confusionMatrix = computeConfusionMatrix(predictions);
  const { perClassMetrics, macroMetrics, accuracy } =
    computeClassMetrics(confusionMatrix);
  const latency = computeLatencyMetrics(latencies);
  const success = predictions.filter(p => p.verification && !p.error);
  const failures = predictions.filter(p => p.error || !p.verification);
  const calibration = computeCalibrationMetrics(predictions);
  const errorBreakdown: Record<string, number> = {};
  for (const p of failures) {
    const reason = p.error?.split(":")[0] ?? "MissingVerification";
    errorBreakdown[reason] = (errorBreakdown[reason] ?? 0) + 1;
  }
  const cached = success.filter(p => p.verification?.cacheHit === true).map(p => p.latencyMs);
  const uncached = success.filter(p => p.verification?.cacheHit !== true).map(p => p.latencyMs);
  const seconds = (performance.now() - startRun) / 1000;
  const tokenCost = aggregateTokenCost(predictions);

  const result: BenchmarkResult = {
    timestamp: new Date().toISOString(),
    verifierName: resolvedName,
    datasetSize: items.length,
    scored: success.length,
    failed: failures.length,
    failureRate: items.length ? failures.length / items.length : 0,
    throughput: seconds > 0 ? items.length / seconds : 0,
    errorBreakdown,
    ...(calibration ? { calibration } : {}),
    ...(cached.length ? { cachedLatency: computeLatencyMetrics(cached) } : {}),
    ...(uncached.length ? { uncachedLatency: computeLatencyMetrics(uncached) } : {}),
    accuracy,
    macroMetrics,
    perClassMetrics,
    confusionMatrix,
    latency,
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
  lines.push(`Dataset Size: ${result.datasetSize} samples`);
  lines.push(`Scored: ${result.scored} | Provider failures: ${result.failed} | Failure rate: ${((result.failureRate ?? 0)*100).toFixed(1)}%`);
  lines.push(result.scored > 0 ? `Accuracy:     ${(result.accuracy * 100).toFixed(2)}%` : "Accuracy:     N/A (no valid model predictions)");
  lines.push(
    `Macro Avg:    Precision: ${(result.macroMetrics.precision * 100).toFixed(2)}% | Recall: ${(result.macroMetrics.recall * 100).toFixed(2)}% | F1: ${(result.macroMetrics.f1 * 100).toFixed(2)}%`,
  );
  lines.push("");
  if (result.calibration) lines.push(`Calibration: ECE ${result.calibration.ece.toFixed(4)} | Brier ${result.calibration.brierScore.toFixed(4)}`);
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
    `Total: ${result.latency.totalMs.toFixed(2)} ms | Mean: ${result.latency.meanMs.toFixed(2)} ms | Median: ${result.latency.medianMs.toFixed(2)} ms | Min: ${result.latency.minMs.toFixed(2)} ms | Max: ${result.latency.maxMs.toFixed(2)} ms | P95: ${result.latency.p95Ms.toFixed(2)} ms`,
  );

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
