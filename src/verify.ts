import { aggregateProbabilities, aggregateVerdict } from "./aggregate.js";
import { splitClaims, type ClaimExtractor } from "./claims.js";
import type {
  AnswerVerification,
  ClaimVerification,
  Evidence,
  Verification,
  Verifier,
  VerifyClaimInput,
} from "./types.js";
import { isBatchVerifier } from "./types.js";

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

  if (claims.length === 0) {
    return {
      verdict: aggregateVerdict([]),
      probabilities: aggregateProbabilities([]),
      claims: [],
    };
  }

  const inputs: VerifyClaimInput[] = claims.map((claim) => ({ claim, evidence }));

  let verifiedList: Verification[];
  if (isBatchVerifier(verifier)) {
    verifiedList = await verifier.verifyMany(inputs);
  } else {
    verifiedList = await Promise.all(
      inputs.map((input) => verifier.verify(input)),
    );
  }

  const verified: ClaimVerification[] = verifiedList.map((item, index) => ({
    ...item,
    index,
  }));

  return {
    verdict: aggregateVerdict(verified),
    probabilities: aggregateProbabilities(verified),
    claims: verified,
  };
}
