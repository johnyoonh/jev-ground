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

  const verified = await Promise.all(
    claims.map(async (claim, index) => ({
      ...(await verifier.verify({ claim, evidence })),
      index,
    })),
  );

  return {
    verdict: aggregateVerdict(verified),
    probabilities: aggregateProbabilities(verified),
    claims: verified,
  };
}
