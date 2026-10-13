export type VerificationVerdict =
  | "supported"
  | "contradicted"
  | "insufficient";

export interface Evidence {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface VerificationProbabilities {
  supported: number;
  contradicted: number;
  insufficient: number;
}

export interface Verification {
  claim: string;
  verdict: VerificationVerdict;
  probabilities: VerificationProbabilities;
  confidence: number;
  evidenceIds: string[];
  provider?: string;
  /** Resolved provider model, not necessarily the alias requested. */
  model?: string;
  rubricFingerprint?: string;
  /** True when served from cache; false when evaluated live. */
  cacheHit?: boolean;
  raw?: unknown;
}

export interface VerifyClaimInput {
  claim: string;
  evidence: Evidence[];
}

export interface Verifier {
  verify(input: VerifyClaimInput): Promise<Verification>;
}

/** Optional capability: coalesce independent atomic judgments without merging them. */
export interface BatchVerifier extends Verifier {
  verifyMany(inputs: VerifyClaimInput[]): Promise<Verification[]>;
}

export interface ClaimVerification extends Verification {
  index: number;
}

export interface AnswerVerification {
  verdict: VerificationVerdict;
  claims: ClaimVerification[];
  probabilities: VerificationProbabilities;
}
