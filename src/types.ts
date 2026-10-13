export type VerificationVerdict =
  | "supported"
  | "contradicted"
  | "insufficient";

export type AccessLevel = "public" | "sensitive" | "restricted";

export type VerificationExecutionState =
  | "EXECUTED"
  | "BLOCKED"
  | "SKIPPED"
  | "PRIVACY_ERROR";

export interface Evidence {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  /** Explicit access level/sensitivity. Defaults to metadata.access / "public". */
  access?: AccessLevel;
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
  /** True when served from cache; false when evaluated live. */
  cacheHit?: boolean;
  raw?: unknown;
  /** Execution status of the verification request. */
  executionState?: VerificationExecutionState;
  /** Detailed reason if the verification was blocked, skipped, or failed due to privacy policy. */
  privacyBlockReason?: string;
  /** True if evidence was redacted, minimized, or transformed before verification. */
  transformedEvidence?: boolean;
}

export interface VerifyClaimInput {
  claim: string;
  evidence: Evidence[];
  /** When true, bypasses caches, prevents raw response persistence, and omits sensitive logs. */
  noStore?: boolean;
}

export interface Verifier {
  verify(input: VerifyClaimInput): Promise<Verification>;
  /** Indicates whether this verifier runs locally on-machine without external network egress. */
  isLocal?: boolean;
  /** Provider identifier. */
  provider?: string;
}

export interface ClaimVerification extends Verification {
  index: number;
}

export interface AnswerVerification {
  verdict: VerificationVerdict;
  claims: ClaimVerification[];
  probabilities: VerificationProbabilities;
}
