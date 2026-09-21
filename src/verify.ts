import { aggregateProbabilities, aggregateVerdict } from "./aggregate.js";
import { splitClaims, type ClaimExtractor } from "./claims.js";
import type {
  AnswerVerification,
  Evidence,
  Verifier,
} from "./types.js";

export interface VerifyAnswerInput {
  answer: string;
  evidence: Evidence[];
  verifier: Verifier;
  extractClaims?: ClaimExtractor;
}

export async function verifyAnswer({
  answer,
  evidence,
  verifier,
  extractClaims = splitClaims,
}: VerifyAnswerInput): Promise<AnswerVerification> {
  const claims = await extractClaims(answer);
  const validEvidenceIds = new Set(evidence.map((item) => item.id));

  const verified = await Promise.all(
    claims.map(async (claim, index) => {
      const result = await verifier.verify({ claim, evidence });
      // Validate that returned evidenceIds only contain IDs present in supplied evidence
      const safeEvidenceIds = (result.evidenceIds ?? []).filter((id) =>
        validEvidenceIds.has(id),
      );
      return {
        ...result,
        evidenceIds: safeEvidenceIds,
        index,
      };
    }),
  );

  return {
    verdict: aggregateVerdict(verified),
    probabilities: aggregateProbabilities(verified),
    claims: verified,
  };
}
