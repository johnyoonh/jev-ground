import type {
  ClaimVerification,
  VerificationProbabilities,
  VerificationVerdict,
} from "./types.js";

export function aggregateProbabilities(
  claims: ClaimVerification[],
): VerificationProbabilities {
  if (claims.length === 0) {
    return { supported: 0, contradicted: 0, insufficient: 1 };
  }

  const totals = claims.reduce(
    (acc, claim) => ({
      supported: acc.supported + claim.probabilities.supported,
      contradicted: acc.contradicted + claim.probabilities.contradicted,
      insufficient: acc.insufficient + claim.probabilities.insufficient,
    }),
    { supported: 0, contradicted: 0, insufficient: 0 },
  );

  return {
    supported: totals.supported / claims.length,
    contradicted: totals.contradicted / claims.length,
    insufficient: totals.insufficient / claims.length,
  };
}

export function aggregateVerdict(
  claims: ClaimVerification[],
): VerificationVerdict {
  if (claims.some((claim) => claim.verdict === "contradicted")) {
    return "contradicted";
  }
  if (claims.some((claim) => claim.verdict === "insufficient")) {
    return "insufficient";
  }
  return claims.length > 0 ? "supported" : "insufficient";
}
