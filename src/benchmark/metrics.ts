import type { VerificationVerdict } from "../types.js";
import type {
  BenchmarkPrediction,
  ClassMetrics,
  ConfusionMatrix,
  LatencyMetrics,
  TokenCostMetrics,
} from "./types.js";

export const VERDICTS: VerificationVerdict[] = [
  "supported",
  "contradicted",
  "insufficient",
];

export function createEmptyConfusionMatrix(): ConfusionMatrix {
  return {
    supported: { supported: 0, contradicted: 0, insufficient: 0 },
    contradicted: { supported: 0, contradicted: 0, insufficient: 0 },
    insufficient: { supported: 0, contradicted: 0, insufficient: 0 },
  };
}

export function computeConfusionMatrix(
  predictions: BenchmarkPrediction[],
): ConfusionMatrix {
  const matrix = createEmptyConfusionMatrix();

  for (const pred of predictions) {
    const gold = pred.item.goldVerdict;
    const predicted = pred.verification?.verdict ?? "insufficient";
    matrix[gold][predicted] += 1;
  }

  return matrix;
}

export function computeClassMetrics(confusionMatrix: ConfusionMatrix): {
  perClassMetrics: Record<VerificationVerdict, ClassMetrics>;
  macroMetrics: { precision: number; recall: number; f1: number };
  accuracy: number;
  totalSamples: number;
} {
  let totalCorrect = 0;
  let totalSamples = 0;

  const perClassMetrics: Record<VerificationVerdict, ClassMetrics> = {
    supported: { precision: 0, recall: 0, f1: 0, support: 0 },
    contradicted: { precision: 0, recall: 0, f1: 0, support: 0 },
    insufficient: { precision: 0, recall: 0, f1: 0, support: 0 },
  };

  for (const gold of VERDICTS) {
    for (const pred of VERDICTS) {
      const count = confusionMatrix[gold][pred];
      totalSamples += count;
      if (gold === pred) {
        totalCorrect += count;
      }
    }
  }

  for (const cls of VERDICTS) {
    const tp = confusionMatrix[cls][cls];

    let support = 0; // gold count for cls
    for (const pred of VERDICTS) {
      support += confusionMatrix[cls][pred];
    }

    let predictedCount = 0; // predicted count for cls
    for (const gold of VERDICTS) {
      predictedCount += confusionMatrix[gold][cls];
    }

    const precision = predictedCount > 0 ? tp / predictedCount : 0;
    const recall = support > 0 ? tp / support : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    perClassMetrics[cls] = {
      precision: roundToFourDecimals(precision),
      recall: roundToFourDecimals(recall),
      f1: roundToFourDecimals(f1),
      support,
    };
  }

  const macroPrecision =
    VERDICTS.reduce((acc, cls) => acc + perClassMetrics[cls].precision, 0) /
    VERDICTS.length;

  const macroRecall =
    VERDICTS.reduce((acc, cls) => acc + perClassMetrics[cls].recall, 0) /
    VERDICTS.length;

  const macroF1 =
    VERDICTS.reduce((acc, cls) => acc + perClassMetrics[cls].f1, 0) /
    VERDICTS.length;

  const accuracy = totalSamples > 0 ? totalCorrect / totalSamples : 0;

  return {
    perClassMetrics,
    macroMetrics: {
      precision: roundToFourDecimals(macroPrecision),
      recall: roundToFourDecimals(macroRecall),
      f1: roundToFourDecimals(macroF1),
    },
    accuracy: roundToFourDecimals(accuracy),
    totalSamples,
  };
}

export function computeLatencyMetrics(latencies: number[]): LatencyMetrics {
  if (latencies.length === 0) {
    return {
      totalMs: 0,
      meanMs: 0,
      medianMs: 0,
      minMs: 0,
      maxMs: 0,
      p95Ms: 0,
    };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const totalMs = sorted.reduce((sum, v) => sum + v, 0);
  const meanMs = totalMs / sorted.length;
  const minMs = sorted[0];
  const maxMs = sorted[sorted.length - 1];

  const medianMs = getPercentile(sorted, 0.5);
  const p95Ms = getPercentile(sorted, 0.95);

  return {
    totalMs: roundToTwoDecimals(totalMs),
    meanMs: roundToTwoDecimals(meanMs),
    medianMs: roundToTwoDecimals(medianMs),
    minMs: roundToTwoDecimals(minMs),
    maxMs: roundToTwoDecimals(maxMs),
    p95Ms: roundToTwoDecimals(p95Ms),
  };
}

export function aggregateTokenCost(
  predictions: BenchmarkPrediction[],
): TokenCostMetrics | undefined {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let hasTokenCostData = false;

  for (const pred of predictions) {
    let pTokens = pred.tokens?.promptTokens;
    let cTokens = pred.tokens?.completionTokens;
    let tTokens = pred.tokens?.totalTokens;
    let itemCost = pred.cost;

    // Check verification.raw for metadata if not directly in pred
    if (pred.verification?.raw && typeof pred.verification.raw === "object") {
      const raw = pred.verification.raw as Record<string, unknown>;

      if (typeof raw.cost === "number" && itemCost === undefined) {
        itemCost = raw.cost;
      }

      if (raw.usage && typeof raw.usage === "object") {
        const usage = raw.usage as Record<string, unknown>;
        if (typeof usage.promptTokens === "number" && pTokens === undefined) {
          pTokens = usage.promptTokens;
        }
        if (typeof usage.completionTokens === "number" && cTokens === undefined) {
          cTokens = usage.completionTokens;
        }
        if (typeof usage.totalTokens === "number" && tTokens === undefined) {
          tTokens = usage.totalTokens;
        }
      } else if (raw.tokens && typeof raw.tokens === "object") {
        const tokens = raw.tokens as Record<string, unknown>;
        if (typeof tokens.prompt === "number" && pTokens === undefined) {
          pTokens = tokens.prompt;
        }
        if (typeof tokens.completion === "number" && cTokens === undefined) {
          cTokens = tokens.completion;
        }
        if (typeof tokens.total === "number" && tTokens === undefined) {
          tTokens = tokens.total;
        }
      }
    }

    if (
      pTokens !== undefined ||
      cTokens !== undefined ||
      tTokens !== undefined ||
      itemCost !== undefined
    ) {
      hasTokenCostData = true;
      promptTokens += pTokens ?? 0;
      completionTokens += cTokens ?? 0;
      totalTokens += tTokens ?? (pTokens ?? 0) + (cTokens ?? 0);
      totalCost += itemCost ?? 0;
    }
  }

  if (!hasTokenCostData) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    totalCost: roundToFourDecimals(totalCost),
  };
}

function getPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function roundToFourDecimals(val: number): number {
  return Math.round(val * 10000) / 10000;
}

function roundToTwoDecimals(val: number): number {
  return Math.round(val * 100) / 100;
}
