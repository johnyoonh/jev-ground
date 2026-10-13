import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Verifier } from "../types.js";
import {
  buildCategoryMetrics,
  buildConfusionMatrix,
  calculateMacroMetrics,
  evaluateMetamorphicChecks,
} from "./eval.js";
import type {
  BenchmarkItem,
  BenchmarkReport,
  CasePrediction,
  RegressionThresholds,
} from "./types.js";

export async function loadJsonlDataset(filePath: string): Promise<BenchmarkItem[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const items: BenchmarkItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (!parsed.id || !parsed.claim || !Array.isArray(parsed.evidence) || !parsed.goldVerdict) {
        throw new Error(`Invalid benchmark item schema at line ${i + 1}`);
      }
      items.push({
        id: String(parsed.id),
        claim: String(parsed.claim),
        evidence: parsed.evidence,
        goldVerdict: parsed.goldVerdict,
        category: parsed.category || "uncategorized",
        rationale: parsed.rationale,
        metamorphic: parsed.metamorphic,
        metadata: parsed.metadata,
      });
    } catch (err) {
      throw new Error(`Failed to parse JSONL line ${i + 1} in ${filePath}: ${(err as Error).message}`);
    }
  }

  return items;
}

export interface RunBenchmarkOptions {
  verifier: Verifier;
  dataset: BenchmarkItem[] | string;
  verifierName?: string;
  outputPath?: string;
  thresholds?: RegressionThresholds;
}

export async function runBenchmark(options: RunBenchmarkOptions): Promise<BenchmarkReport> {
  const { verifier, verifierName = "verifier", outputPath, thresholds } = options;

  const dataset = typeof options.dataset === "string"
    ? await loadJsonlDataset(options.dataset)
    : options.dataset;

  const predictions: CasePrediction[] = [];
  const predictionMap = new Map<string, CasePrediction>();

  for (const item of dataset) {
    try {
      const result = await verifier.verify({
        claim: item.claim,
        evidence: item.evidence,
      });

      const prediction: CasePrediction = {
        id: item.id,
        claim: item.claim,
        goldVerdict: item.goldVerdict,
        predictedVerdict: result.verdict,
        confidence: result.confidence,
        probabilities: result.probabilities,
        category: item.category,
        correct: result.verdict === item.goldVerdict,
        raw: result.raw,
      };

      predictions.push(prediction);
      predictionMap.set(item.id, prediction);
    } catch (err) {
      const errorMsg = (err as Error).message;
      const prediction: CasePrediction = {
        id: item.id,
        claim: item.claim,
        goldVerdict: item.goldVerdict,
        predictedVerdict: "insufficient",
        confidence: 0,
        probabilities: { supported: 0, contradicted: 0, insufficient: 1 },
        category: item.category,
        correct: false,
        error: errorMsg,
      };

      predictions.push(prediction);
      predictionMap.set(item.id, prediction);
    }
  }

  const overallConfusion = buildConfusionMatrix(predictions);
  const { accuracy, macroF1 } = calculateMacroMetrics(predictions);
  const categories = buildCategoryMetrics(predictions);

  const metamorphicResults = evaluateMetamorphicChecks(dataset, predictionMap);
  const metamorphicPassedCount = metamorphicResults.filter((r) => r.passed).length;
  const metamorphicPassRate = metamorphicResults.length > 0
    ? metamorphicPassedCount / metamorphicResults.length
    : 1.0;

  const thresholdFailures: string[] = [];

  if (thresholds) {
    if (thresholds.minOverallAccuracy !== undefined && accuracy < thresholds.minOverallAccuracy) {
      thresholdFailures.push(
        `Overall accuracy ${accuracy.toFixed(3)} below threshold ${thresholds.minOverallAccuracy.toFixed(3)}`
      );
    }
    if (thresholds.minMetamorphicPassRate !== undefined && metamorphicPassRate < thresholds.minMetamorphicPassRate) {
      thresholdFailures.push(
        `Metamorphic pass rate ${metamorphicPassRate.toFixed(3)} below threshold ${thresholds.minMetamorphicPassRate.toFixed(3)}`
      );
    }
    if (thresholds.minCategoryAccuracy) {
      for (const [cat, minAcc] of Object.entries(thresholds.minCategoryAccuracy)) {
        const catMetrics = categories[cat];
        const catAcc = catMetrics ? catMetrics.accuracy : 0;
        if (catAcc < minAcc) {
          thresholdFailures.push(
            `Category '${cat}' accuracy ${catAcc.toFixed(3)} below threshold ${minAcc.toFixed(3)}`
          );
        }
      }
    }
  }

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    verifierName,
    totalCases: dataset.length,
    accuracy,
    macroF1,
    overallConfusion,
    categories,
    metamorphicResults,
    metamorphicPassRate,
    predictions,
    thresholdsPassed: thresholdFailures.length === 0,
    thresholdFailures,
  };

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(report, null, 2), "utf-8");
  }

  return report;
}
