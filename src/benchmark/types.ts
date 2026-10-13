import type { Evidence, VerificationProbabilities, VerificationVerdict } from "../types.js";

export type BenchmarkCategory =
  | "prompt_injection"
  | "conflicting_stale"
  | "semantic_robustness"
  | "distractor_passages"
  | "insufficient_vs_contradicted"
  | string;

export interface MetamorphicRelation {
  type: "distractor_insertion" | "date_swap" | "number_swap" | "reorder_evidence" | string;
  baseId: string;
  expectedChange: "invariant" | "verdict_flip" | string;
}

export interface BenchmarkItem {
  id: string;
  claim: string;
  evidence: Evidence[];
  goldVerdict: VerificationVerdict;
  category: BenchmarkCategory;
  rationale?: string;
  metamorphic?: MetamorphicRelation;
  metadata?: Record<string, unknown>;
}

export interface CasePrediction {
  id: string;
  claim: string;
  goldVerdict: VerificationVerdict;
  predictedVerdict: VerificationVerdict;
  confidence: number;
  probabilities: VerificationProbabilities;
  category: BenchmarkCategory;
  correct: boolean;
  error?: string;
  raw?: unknown;
}

export interface ConfusionMatrix {
  matrix: Record<VerificationVerdict, Record<VerificationVerdict, number>>;
  total: number;
}

export interface CategoryMetrics {
  category: BenchmarkCategory;
  count: number;
  correct: number;
  accuracy: number;
  f1: number;
  confusion: ConfusionMatrix;
}

export interface MetamorphicCheckResult {
  id: string;
  baseId: string;
  relationType: string;
  expectedChange: string;
  basePredictedVerdict: VerificationVerdict;
  variantPredictedVerdict: VerificationVerdict;
  passed: boolean;
  failureReason?: string;
}

export interface BenchmarkReport {
  timestamp: string;
  verifierName: string;
  totalCases: number;
  accuracy: number;
  macroF1: number;
  overallConfusion: ConfusionMatrix;
  categories: Record<BenchmarkCategory, CategoryMetrics>;
  metamorphicResults: MetamorphicCheckResult[];
  metamorphicPassRate: number;
  predictions: CasePrediction[];
  thresholdsPassed?: boolean;
  thresholdFailures?: string[];
}

export interface RegressionThresholds {
  minOverallAccuracy?: number;
  minCategoryAccuracy?: Record<string, number>;
  minMetamorphicPassRate?: number;
}
