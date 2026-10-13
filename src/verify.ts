import { aggregateProbabilities, aggregateVerdict } from "./aggregate.js";
import { splitClaims, type ClaimExtractor } from "./claims.js";
import type {
  AnswerVerification, BatchVerifier, Evidence, Verification, Verifier,
} from "./types.js";

export interface VerifyAnswerInput {
  answer: string;
  evidence: Evidence[];
  verifier: Verifier;
  extractClaims?: ClaimExtractor;
}
function supportsBatch(verifier: Verifier): verifier is BatchVerifier {
  return typeof (verifier as Partial<BatchVerifier>).verifyMany === "function";
}

export async function verifyAnswer({
  answer, evidence, verifier, extractClaims = splitClaims,
}: VerifyAnswerInput): Promise<AnswerVerification> {
  const claims = await extractClaims(answer);
  if (!Array.isArray(claims) || !claims.every(item => typeof item === "string")) {
    throw new TypeError("Claim extractor must return an array of strings");
  }
  const inputs = claims.map(claim => ({ claim, evidence }));
  const verified: Verification[] = supportsBatch(verifier)
    ? await verifier.verifyMany(inputs)
    : await Promise.all(inputs.map(input => verifier.verify(input)));
  if (verified.length !== claims.length) {
    throw new Error("Verifier returned wrong number of claim results");
  }
  const allowed = new Set(evidence.map(item => item.id));
  const results = verified.map((item, index) => {
    if (!item || item.claim !== claims[index]) {
      throw new Error("Verifier returned out-of-order or unrelated claim result");
    }
    return {
      ...item,
      evidenceIds: item.evidenceIds.filter(id => allowed.has(id)),
      index,
    };
  });
  return {
    verdict: aggregateVerdict(results),
    probabilities: aggregateProbabilities(results),
    claims: results,
  };
}
