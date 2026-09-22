import type { Evidence, Verification, VerificationVerdict, Verifier } from "../types.js";

export interface BenchmarkItem {
  id: string;
  claim: string;
  evidence: Evidence[];
  goldVerdict: VerificationVerdict;
  metadata?: Record<string, unknown>;
}

export interface ClassMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export type ConfusionMatrix = Record<
  VerificationVerdict,
  Record<VerificationVerdict, number>
>;

export interface LatencyMetrics {
  totalMs: number;
  meanMs: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
}

export interface TokenCostMetrics {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  totalCost?: number;
}

export interface BenchmarkPrediction {
  item: BenchmarkItem;
  verification?: Verification;
  latencyMs: number;
  tokens?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  cost?: number;
  error?: string;
}

export interface BenchmarkResult {
  timestamp: string;
  verifierName: string;
  datasetSize: number;
  accuracy: number;
  macroMetrics: {
    precision: number;
    recall: number;
    f1: number;
  };
  perClassMetrics: Record<VerificationVerdict, ClassMetrics>;
  confusionMatrix: ConfusionMatrix;
  latency: LatencyMetrics;
  tokenCost?: TokenCostMetrics;
  predictions: BenchmarkPrediction[];
}

export interface BenchmarkOptions {
  verifier: Verifier;
  dataset: BenchmarkItem[] | string;
  verifierName?: string;
  outputPath?: string;
}
