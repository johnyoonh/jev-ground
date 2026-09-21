import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type {
  Verification,
  VerificationProbabilities,
  VerificationVerdict,
  Verifier,
  VerifyClaimInput,
} from "../types.js";

export interface JevVerifierOptions {
  client?: TypeSafeClient;
  model?: string;
}

const criteria = {
  supported:
    "The evidence is sufficient to establish the claim as written, without adding material unstated assumptions.",
  contradicted:
    "The evidence directly conflicts with a material part of the claim.",
  insufficient:
    "The evidence neither establishes nor directly contradicts the claim, or is too incomplete/ambiguous to decide.",
} as const;

function normalizeProbabilities(
  probabilities: Record<string, number> | undefined,
): VerificationProbabilities {
  return {
    supported: probabilities?.supported ?? 0,
    contradicted: probabilities?.contradicted ?? 0,
    insufficient: probabilities?.insufficient ?? 0,
  };
}

function asVerdict(choiceValue: string): VerificationVerdict {
  if (
    choiceValue === "supported" ||
    choiceValue === "contradicted" ||
    choiceValue === "insufficient"
  ) {
    return choiceValue;
  }
  throw new Error(`Unexpected Jev verdict: ${choiceValue}`);
}

export class JevVerifier implements Verifier {
  private readonly client: TypeSafeClient;
  private readonly model?: string;

  constructor(options: JevVerifierOptions = {}) {
    this.client = options.client ?? new TypeSafeClient();
    this.model = options.model;
  }

  async verify({ claim, evidence }: VerifyClaimInput): Promise<Verification> {
    const response = await this.client.systemOne({
      state: {
        claim,
        evidence: evidence.map(({ id, text }) => ({ id, text })),
      },
      ...(this.model ? { model: this.model } : {}),
      questions: {
        factuality: choice(
          "Classify whether the claim is grounded in the supplied evidence. Judge only the evidence provided; do not rely on outside knowledge.",
          criteria,
        ),
      },
    });

    const answer = response.answers.factuality;
    const verdict = asVerdict(answer.choice);
    const probabilities = normalizeProbabilities(answer.probabilities);

    return {
      claim,
      verdict,
      probabilities,
      confidence:
        answer.confidence ??
        Math.max(
          probabilities.supported,
          probabilities.contradicted,
          probabilities.insufficient,
        ),
      evidenceIds: evidence.map((item) => item.id),
      provider: "jev",
      raw: answer,
    };
  }
}
