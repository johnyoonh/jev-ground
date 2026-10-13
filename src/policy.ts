import type { VerificationProbabilities, VerificationVerdict } from "./types.js";

export type PolicyDecision = "PASS" | "REVIEW" | "FAIL";

export interface PolicyThresholds {
  /** If contradicted probability is >= this threshold, evaluate as FAIL. Default 0.20 */
  failContradictedThreshold?: number;
  /** If insufficient probability is >= this threshold, evaluate as FAIL. Default 0.80 */
  failInsufficientThreshold?: number;
  /** If contradicted probability is >= this threshold, evaluate as REVIEW. Default 0.05 */
  reviewContradictedThreshold?: number;
  /** If insufficient probability is >= this threshold, evaluate as REVIEW. Default 0.20 */
  reviewInsufficientThreshold?: number;
  /** If supported probability is >= this threshold, evaluate as PASS. Default 0.80 */
  passSupportedThreshold?: number;
}

export interface PolicyEscalationPaths {
  FAIL?: string;
  REVIEW?: string;
  PASS?: string;
}

export interface PolicyConfig {
  id: string;
  rubricVersion: string;
  thresholds?: PolicyThresholds;
  escalationPaths?: PolicyEscalationPaths;
  fallbackPath?: string;
}

export interface PolicyEvaluationInput {
  probabilities: VerificationProbabilities;
  verdict?: VerificationVerdict;
  confidence?: number;
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  reasons: string[];
  escalationPath: string;
  fallbackPath?: string;
}

export const DEFAULT_POLICY_THRESHOLDS: Required<PolicyThresholds> = {
  failContradictedThreshold: 0.2,
  failInsufficientThreshold: 0.8,
  reviewContradictedThreshold: 0.05,
  reviewInsufficientThreshold: 0.2,
  passSupportedThreshold: 0.8,
};

export const DEFAULT_POLICY_ESCALATION_PATHS: Required<PolicyEscalationPaths> = {
  FAIL: "block",
  REVIEW: "flag_for_audit",
  PASS: "none",
};

export function evaluatePolicy(
  policy: PolicyConfig,
  input: PolicyEvaluationInput,
): PolicyEvaluationResult {
  const thresholds: Required<PolicyThresholds> = {
    ...DEFAULT_POLICY_THRESHOLDS,
    ...policy.thresholds,
  };

  // Never silently PASS on NaN, missing classes, or malformed evaluator output.
  const values = [
    input.probabilities.supported,
    input.probabilities.contradicted,
    input.probabilities.insufficient,
  ];
  if (values.some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) ||
      Math.abs(values.reduce((sum, v) => sum + v, 0) - 1) > 0.02) {
    throw new TypeError("Invalid three-class policy probability distribution");
  }
  for (const [key, threshold] of Object.entries(thresholds)) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError("Invalid policy threshold: " + key);
    }
  }

  const escalationPaths: Required<PolicyEscalationPaths> = {
    ...DEFAULT_POLICY_ESCALATION_PATHS,
    ...policy.escalationPaths,
  };

  const { probabilities, verdict } = input;
  const reasons: string[] = [];

  // 1. FAIL checks
  if (probabilities.contradicted >= thresholds.failContradictedThreshold) {
    reasons.push(
      `Contradicted probability (${probabilities.contradicted.toFixed(4)}) >= fail threshold (${thresholds.failContradictedThreshold})`,
    );
    return {
      decision: "FAIL",
      reasons,
      escalationPath: escalationPaths.FAIL,
      fallbackPath: policy.fallbackPath,
    };
  }

  if (verdict === "contradicted") {
    reasons.push("Verdict is contradicted");
    return {
      decision: "FAIL",
      reasons,
      escalationPath: escalationPaths.FAIL,
      fallbackPath: policy.fallbackPath,
    };
  }

  if (probabilities.insufficient >= thresholds.failInsufficientThreshold) {
    reasons.push(
      `Insufficient probability (${probabilities.insufficient.toFixed(4)}) >= fail threshold (${thresholds.failInsufficientThreshold})`,
    );
    return {
      decision: "FAIL",
      reasons,
      escalationPath: escalationPaths.FAIL,
      fallbackPath: policy.fallbackPath,
    };
  }

  // 2. REVIEW checks
  if (probabilities.contradicted >= thresholds.reviewContradictedThreshold) {
    reasons.push(
      `Contradicted probability (${probabilities.contradicted.toFixed(4)}) >= review threshold (${thresholds.reviewContradictedThreshold})`,
    );
  }

  if (probabilities.insufficient >= thresholds.reviewInsufficientThreshold) {
    reasons.push(
      `Insufficient probability (${probabilities.insufficient.toFixed(4)}) >= review threshold (${thresholds.reviewInsufficientThreshold})`,
    );
  }

  if (verdict === "insufficient" && reasons.length === 0) {
    reasons.push("Verdict is insufficient");
  }

  if (reasons.length > 0) {
    return {
      decision: "REVIEW",
      reasons,
      escalationPath: escalationPaths.REVIEW,
      fallbackPath: policy.fallbackPath,
    };
  }

  // 3. PASS check
  if (probabilities.supported >= thresholds.passSupportedThreshold) {
    reasons.push(
      `Supported probability (${probabilities.supported.toFixed(4)}) >= pass threshold (${thresholds.passSupportedThreshold})`,
    );
  } else {
    reasons.push(
      `Supported probability (${probabilities.supported.toFixed(4)}) < pass threshold (${thresholds.passSupportedThreshold}), defaulting to REVIEW`,
    );
    return {
      decision: "REVIEW",
      reasons,
      escalationPath: escalationPaths.REVIEW,
      fallbackPath: policy.fallbackPath,
    };
  }

  return {
    decision: "PASS",
    reasons,
    escalationPath: escalationPaths.PASS,
    fallbackPath: policy.fallbackPath,
  };
}
