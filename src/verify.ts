import { aggregateProbabilities, aggregateVerdict } from "./aggregate.js";
import { splitClaims, type ClaimExtractor } from "./claims.js";
import {
  EgressControlVerifier,
  type EgressControlVerifierOptions,
  type EgressHook,
} from "./privacy/index.js";
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
  /** When true, bypasses caches, prevents raw response persistence, and omits sensitive logs. */
  noStore?: boolean;
  /** Application-supplied egress decision hook. */
  egressPolicy?: EgressHook;
  /** Detailed egress control options. */
  egressControl?: EgressControlVerifierOptions;
}

export async function verifyAnswer({
  answer,
  evidence,
  verifier,
  extractClaims = splitClaims,
  noStore,
  egressPolicy,
  egressControl,
}: VerifyAnswerInput): Promise<AnswerVerification> {
  const claims = await extractClaims(answer);

  let effectiveVerifier = verifier;
  if (!(verifier instanceof EgressControlVerifier)) {
    effectiveVerifier = new EgressControlVerifier(verifier, {
      ...egressControl,
      ...(egressPolicy ? { egressPolicy } : {}),
    });
  } else if (egressPolicy || egressControl) {
    effectiveVerifier = new EgressControlVerifier(verifier, {
      ...egressControl,
      ...(egressPolicy ? { egressPolicy } : {}),
    });
  }

  const verified = await Promise.all(
    claims.map(async (claim, index) => ({
      ...(await effectiveVerifier.verify({ claim, evidence, noStore })),
      index,
    })),
  );

  return {
    verdict: aggregateVerdict(verified),
    probabilities: aggregateProbabilities(verified),
    claims: verified,
  };
}
