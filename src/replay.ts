import { evaluatePolicy, type PolicyConfig, type PolicyDecision } from "./policy.js";
import type { DecisionTrace } from "./trace.js";
import type { VerificationVerdict } from "./types.js";

export function replayPolicyOnTrace(
  trace: DecisionTrace,
  policy: PolicyConfig,
): DecisionTrace {
  const evaluation = evaluatePolicy(policy, {
    probabilities: trace.probabilities,
    verdict: trace.verdict,
    confidence: trace.confidence,
  });

  return {
    ...trace,
    policyId: policy.id,
    rubricVersion: policy.rubricVersion,
    policyDecision: evaluation.decision,
    reasons: evaluation.reasons,
    escalationPath: evaluation.escalationPath,
    fallbackPath: evaluation.fallbackPath ?? trace.fallbackPath,
  };
}

export function replayPolicy(
  traces: DecisionTrace[],
  policy: PolicyConfig,
): DecisionTrace[] {
  return traces.map((trace) => replayPolicyOnTrace(trace, policy));
}

export interface ComparePolicyOptions {
  traces: DecisionTrace[];
  policyA: PolicyConfig;
  policyB: PolicyConfig;
  /** Optional ground truth map keyed by requestId or claimHash */
  goldVerdicts?: Record<string, VerificationVerdict>;
  runMetadata?: Record<string, unknown>;
}

export interface DecisionTransitionMatrix {
  PASS: Record<PolicyDecision, number>;
  REVIEW: Record<PolicyDecision, number>;
  FAIL: Record<PolicyDecision, number>;
}

export interface PolicyComparisonReport {
  timestamp: string;
  runMetadata?: Record<string, unknown>;
  policyA: { id: string; rubricVersion: string };
  policyB: { id: string; rubricVersion: string };
  totalTraces: number;
  distributionA: Record<PolicyDecision, number>;
  distributionB: Record<PolicyDecision, number>;
  decisionTransitions: DecisionTransitionMatrix;
  deltas: {
    decisionChangesCount: number;
    falsePasses: number;
    falseFails: number;
    reviewRateA: number;
    reviewRateB: number;
    reviewRateDelta: number;
  };
  changedTraces: Array<{
    requestId: string;
    claimHash: string;
    decisionA: PolicyDecision;
    decisionB: PolicyDecision;
    reasonsA: string[];
    reasonsB: string[];
  }>;
}

export function comparePolicySnapshots(
  options: ComparePolicyOptions,
): PolicyComparisonReport {
  const { traces, policyA, policyB, goldVerdicts, runMetadata } = options;
  const totalTraces = traces.length;

  const distributionA: Record<PolicyDecision, number> = { PASS: 0, REVIEW: 0, FAIL: 0 };
  const distributionB: Record<PolicyDecision, number> = { PASS: 0, REVIEW: 0, FAIL: 0 };

  const decisionTransitions: DecisionTransitionMatrix = {
    PASS: { PASS: 0, REVIEW: 0, FAIL: 0 },
    REVIEW: { PASS: 0, REVIEW: 0, FAIL: 0 },
    FAIL: { PASS: 0, REVIEW: 0, FAIL: 0 },
  };

  const changedTraces: PolicyComparisonReport["changedTraces"] = [];
  let falsePasses = 0;
  let falseFails = 0;
  let decisionChangesCount = 0;

  for (const trace of traces) {
    const traceA = replayPolicyOnTrace(trace, policyA);
    const traceB = replayPolicyOnTrace(trace, policyB);

    const decA = traceA.policyDecision;
    const decB = traceB.policyDecision;

    distributionA[decA]++;
    distributionB[decB]++;
    decisionTransitions[decA][decB]++;

    if (decA !== decB) {
      decisionChangesCount++;
      changedTraces.push({
        requestId: trace.requestId,
        claimHash: trace.claimHash,
        decisionA: decA,
        decisionB: decB,
        reasonsA: traceA.reasons,
        reasonsB: traceB.reasons,
      });
    }

    // False pass / false fail calculation
    const gold = goldVerdicts?.[trace.requestId] ?? goldVerdicts?.[trace.claimHash];
    if (gold !== undefined) {
      // Gold truth available
      const isGoldSupported = gold === "supported";
      // False pass: Candidate policy (B) passed, but gold is NOT supported
      if (decB === "PASS" && !isGoldSupported) {
        falsePasses++;
      }
      // False fail: Candidate policy (B) is FAIL or REVIEW, but gold IS supported
      if (decB !== "PASS" && isGoldSupported) {
        falseFails++;
      }
    } else {
      // Relative comparison between Policy A and Policy B
      // False pass: Policy A was FAIL or REVIEW, but Policy B passed
      if (decA !== "PASS" && decB === "PASS") {
        falsePasses++;
      }
      // False fail: Policy A was PASS, but Policy B was FAIL or REVIEW
      if (decA === "PASS" && decB !== "PASS") {
        falseFails++;
      }
    }
  }

  const reviewRateA = totalTraces > 0 ? distributionA.REVIEW / totalTraces : 0;
  const reviewRateB = totalTraces > 0 ? distributionB.REVIEW / totalTraces : 0;
  const reviewRateDelta = reviewRateB - reviewRateA;

  return {
    timestamp: new Date().toISOString(),
    runMetadata,
    policyA: { id: policyA.id, rubricVersion: policyA.rubricVersion },
    policyB: { id: policyB.id, rubricVersion: policyB.rubricVersion },
    totalTraces,
    distributionA,
    distributionB,
    decisionTransitions,
    deltas: {
      decisionChangesCount,
      falsePasses,
      falseFails,
      reviewRateA,
      reviewRateB,
      reviewRateDelta,
    },
    changedTraces,
  };
}
