import type { VerificationVerdict } from "../types.js";
import type {
  BenchmarkCategory,
  BenchmarkItem,
  CasePrediction,
  CategoryMetrics,
  ConfusionMatrix,
  MetamorphicCheckResult,
} from "./types.js";

const VERDICTS: VerificationVerdict[] = ["supported", "contradicted", "insufficient"];

export function createEmptyConfusionMatrix(): ConfusionMatrix {
  const matrix: Record<VerificationVerdict, Record<VerificationVerdict, number>> = {
    supported: { supported: 0, contradicted: 0, insufficient: 0 },
    contradicted: { supported: 0, contradicted: 0, insufficient: 0 },
    insufficient: { supported: 0, contradicted: 0, insufficient: 0 },
  };
  return { matrix, total: 0 };
}

export function buildConfusionMatrix(predictions: CasePrediction[]): ConfusionMatrix {
  const conf = createEmptyConfusionMatrix();
  for (const p of predictions) {
    if (VERDICTS.includes(p.goldVerdict) && VERDICTS.includes(p.predictedVerdict)) {
      conf.matrix[p.goldVerdict][p.predictedVerdict]++;
      conf.total++;
    }
  }
  return conf;
}

export function calculateMacroMetrics(predictions: CasePrediction[]): { accuracy: number; macroF1: number } {
  if (predictions.length === 0) {
    return { accuracy: 0, macroF1: 0 };
  }

  const correctCount = predictions.filter((p) => p.correct).length;
  const accuracy = correctCount / predictions.length;

  const f1s: number[] = [];
  for (const v of VERDICTS) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const p of predictions) {
      if (p.predictedVerdict === v && p.goldVerdict === v) tp++;
      else if (p.predictedVerdict === v && p.goldVerdict !== v) fp++;
      else if (p.predictedVerdict !== v && p.goldVerdict === v) fn++;
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    // Only include verdict class in macro F1 if present in gold or predicted
    if (tp + fp + fn > 0) {
      f1s.push(f1);
    }
  }

  const macroF1 = f1s.length > 0 ? f1s.reduce((a, b) => a + b, 0) / f1s.length : 0;
  return { accuracy, macroF1 };
}

export function buildCategoryMetrics(
  predictions: CasePrediction[],
): Record<BenchmarkCategory, CategoryMetrics> {
  const grouped: Record<string, CasePrediction[]> = {};
  for (const p of predictions) {
    if (!grouped[p.category]) {
      grouped[p.category] = [];
    }
    grouped[p.category].push(p);
  }

  const result: Record<string, CategoryMetrics> = {};
  for (const [cat, items] of Object.entries(grouped)) {
    const { accuracy, macroF1 } = calculateMacroMetrics(items);
    const confusion = buildConfusionMatrix(items);
    const correct = items.filter((i) => i.correct).length;

    result[cat] = {
      category: cat,
      count: items.length,
      correct,
      accuracy,
      f1: macroF1,
      confusion,
    };
  }

  return result;
}

export function evaluateMetamorphicChecks(
  items: BenchmarkItem[],
  predictionMap: Map<string, CasePrediction>,
): MetamorphicCheckResult[] {
  const results: MetamorphicCheckResult[] = [];

  for (const item of items) {
    if (!item.metamorphic) continue;

    const basePred = predictionMap.get(item.metamorphic.baseId);
    const variantPred = predictionMap.get(item.id);

    if (!basePred || !variantPred) {
      results.push({
        id: item.id,
        baseId: item.metamorphic.baseId,
        relationType: item.metamorphic.type,
        expectedChange: item.metamorphic.expectedChange,
        basePredictedVerdict: basePred?.predictedVerdict ?? "insufficient",
        variantPredictedVerdict: variantPred?.predictedVerdict ?? "insufficient",
        passed: false,
        failureReason: "Missing prediction for base or variant case",
      });
      continue;
    }

    let passed = false;
    let failureReason: string | undefined;

    if (item.metamorphic.expectedChange === "invariant") {
      passed = variantPred.predictedVerdict === basePred.predictedVerdict;
      if (!passed) {
        failureReason = `Expected invariant verdict (${basePred.predictedVerdict}), but got (${variantPred.predictedVerdict})`;
      }
    } else if (item.metamorphic.expectedChange === "verdict_flip") {
      passed = variantPred.predictedVerdict !== basePred.predictedVerdict;
      if (!passed) {
        failureReason = `Expected verdict flip from (${basePred.predictedVerdict}), but remained (${variantPred.predictedVerdict})`;
      }
    } else {
      passed = variantPred.predictedVerdict === item.goldVerdict;
      if (!passed) {
        failureReason = `Custom relation check failed: expected ${item.goldVerdict}, got ${variantPred.predictedVerdict}`;
      }
    }

    results.push({
      id: item.id,
      baseId: item.metamorphic.baseId,
      relationType: item.metamorphic.type,
      expectedChange: item.metamorphic.expectedChange,
      basePredictedVerdict: basePred.predictedVerdict,
      variantPredictedVerdict: variantPred.predictedVerdict,
      passed,
      failureReason,
    });
  }

  return results;
}
