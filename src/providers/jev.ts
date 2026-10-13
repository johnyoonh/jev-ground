import { createHash } from "node:crypto";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type {
  Verification,
  VerificationProbabilities,
  VerificationVerdict,
  Verifier,
  VerifyClaimInput,
} from "../types.js";

export type JevErrorCode =
  | "MISSING_ANSWER"
  | "INVALID_RESPONSE"
  | "MALFORMED_PROBABILITIES"
  | "LABEL_MISMATCH";

export class JevVerificationError extends Error {
  readonly code: JevErrorCode;
  readonly details?: unknown;

  constructor(code: JevErrorCode, message: string, details?: unknown) {
    super(`[JevVerificationError:${code}] ${message}`);
    this.name = "JevVerificationError";
    this.code = code;
    this.details = details;
  }
}

export interface JevVerifierOptions {
  client?: TypeSafeClient;
  model?: string;
  probabilitiesTolerance?: number; // default 0.02, allowing sum in [0.98, 1.02]
}

export const JEV_CRITERIA = {
  supported:
    "The evidence is sufficient to establish the claim as written, without adding material unstated assumptions.",
  contradicted:
    "The evidence directly conflicts with a material part of the claim.",
  insufficient:
    "The evidence neither establishes nor directly contradicts the claim, or is too incomplete/ambiguous to decide.",
} as const;

export const JEV_INSTRUCTION =
  "Classify whether the claim is grounded in the supplied evidence. Judge only the evidence provided; do not rely on outside knowledge.";

export const JEV_RUBRIC_VERSION = "v1";

/**
 * Calculates a deterministic fingerprint of the prompt instruction, criteria, and rubric version.
 */
export function getJevRubricFingerprint(
  instruction: string = JEV_INSTRUCTION,
  criteria: Record<string, string> = JEV_CRITERIA,
  version: string = JEV_RUBRIC_VERSION,
): string {
  const payload = JSON.stringify({ version, instruction, criteria });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Constructs a cache namespace that incorporates the model alias/version and rubric fingerprint.
 * Any change to model or rubric fingerprint will yield a new namespace, invalidating stale cache entries.
 */
export function getJevCacheNamespace(
  model: string = "default",
  rubricFingerprint: string = getJevRubricFingerprint(),
): string {
  return `jev-ground:jev-provider:${model}:${rubricFingerprint}`;
}

const REQUIRED_LABELS: VerificationVerdict[] = [
  "supported",
  "contradicted",
  "insufficient",
];

function validateAndExtractProbabilities(
  probs: unknown,
  tolerance: number = 0.02,
): VerificationProbabilities {
  if (typeof probs !== "object" || probs === null) {
    throw new JevVerificationError(
      "MALFORMED_PROBABILITIES",
      "Probabilities object is missing or invalid",
      { probabilities: probs },
    );
  }

  const record = probs as Record<string, unknown>;
  const result: Partial<VerificationProbabilities> = {};

  for (const label of REQUIRED_LABELS) {
    const val = record[label];
    if (typeof val !== "number" || !Number.isFinite(val)) {
      throw new JevVerificationError(
        "MALFORMED_PROBABILITIES",
        `Probability for label '${label}' must be a finite number, received ${val}`,
        { label, value: val, probabilities: probs },
      );
    }
    if (val < 0 || val > 1) {
      throw new JevVerificationError(
        "MALFORMED_PROBABILITIES",
        `Probability for label '${label}' must be between 0 and 1 inclusive, received ${val}`,
        { label, value: val, probabilities: probs },
      );
    }
    result[label] = val;
  }

  const validatedProbs = result as VerificationProbabilities;
  const sum =
    validatedProbs.supported +
    validatedProbs.contradicted +
    validatedProbs.insufficient;

  if (Math.abs(sum - 1.0) > tolerance) {
    throw new JevVerificationError(
      "MALFORMED_PROBABILITIES",
      `Probabilities sum to ${sum}, which is outside allowed tolerance [${1 - tolerance}, ${1 + tolerance}]`,
      { sum, tolerance, probabilities: validatedProbs },
    );
  }

  return validatedProbs;
}

function validateChoiceAgreement(
  choice: string,
  probs: VerificationProbabilities,
): VerificationVerdict {
  if (!REQUIRED_LABELS.includes(choice as VerificationVerdict)) {
    throw new JevVerificationError(
      "INVALID_RESPONSE",
      `Choice '${choice}' is not one of the allowed labels (${REQUIRED_LABELS.join(", ")})`,
      { choice },
    );
  }

  const verdict = choice as VerificationVerdict;
  const chosenProb = probs[verdict];
  const maxProb = Math.max(
    probs.supported,
    probs.contradicted,
    probs.insufficient,
  );

  // Allow floating point epsilon in comparison
  if (chosenProb < maxProb - 1e-6) {
    throw new JevVerificationError(
      "LABEL_MISMATCH",
      `Chosen label '${choice}' (probability ${chosenProb}) does not match distribution argmax (${maxProb})`,
      { choice, chosenProb, maxProb, probabilities: probs },
    );
  }

  return verdict;
}

export class JevVerifier implements Verifier {
  private readonly client: TypeSafeClient;
  private readonly model?: string;
  private readonly probabilitiesTolerance: number;

  constructor(options: JevVerifierOptions = {}) {
    this.client = options.client ?? new TypeSafeClient();
    this.model = options.model;
    this.probabilitiesTolerance = options.probabilitiesTolerance ?? 0.02;
  }

  async verify({ claim, evidence }: VerifyClaimInput): Promise<Verification> {
    const startTime = Date.now();

    let response: any;
    try {
      response = await this.client.systemOne({
        state: {
          claim,
          evidence: evidence.map(({ id, text }) => ({ id, text })),
        },
        ...(this.model ? { model: this.model } : {}),
        questions: {
          factuality: choice(JEV_INSTRUCTION, JEV_CRITERIA),
        },
      });
    } catch (error) {
      if (error instanceof JevVerificationError) {
        throw error;
      }
      throw new JevVerificationError(
        "INVALID_RESPONSE",
        `TypeSafe SDK call failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const latencyMs = Date.now() - startTime;

    if (!response || typeof response !== "object") {
      throw new JevVerificationError(
        "INVALID_RESPONSE",
        "SDK response is not an object",
        { response },
      );
    }

    const answers = response.answers;
    if (!answers || typeof answers !== "object" || !answers.factuality) {
      throw new JevVerificationError(
        "MISSING_ANSWER",
        "SDK response missing 'factuality' answer",
        { response },
      );
    }

    const answer = answers.factuality;
    if (!answer || typeof answer !== "object" || typeof answer.choice !== "string") {
      throw new JevVerificationError(
        "MISSING_ANSWER",
        "Answer missing string 'choice'",
        { answer },
      );
    }

    const probabilities = validateAndExtractProbabilities(
      answer.probabilities,
      this.probabilitiesTolerance,
    );
    const verdict = validateChoiceAgreement(answer.choice, probabilities);

    const resolvedModel = response.model ?? this.model ?? "default";
    const usage = response.usage ?? response.meta?.usage;

    const confidence =
      typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
        ? answer.confidence
        : Math.max(
            probabilities.supported,
            probabilities.contradicted,
            probabilities.insufficient,
          );

    const rubricFingerprint = getJevRubricFingerprint();

    return {
      claim,
      verdict,
      probabilities,
      confidence,
      evidenceIds: evidence.map((item) => item.id),
      provider: "jev",
      raw: answer,
      metadata: {
        model: resolvedModel,
        rubricFingerprint,
        latencyMs,
        ...(usage ? { usage } : {}),
      },
    };
  }
}
