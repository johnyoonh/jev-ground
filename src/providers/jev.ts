import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type {
  BatchVerifier,
  Verification,
  VerificationProbabilities,
  VerificationVerdict,
  VerifyClaimInput,
} from "../types.js";

export interface JevVerifierOptions {
  client?: TypeSafeClient;
  model?: string;
  maxQuestionsPerBatch?: number;
  maxInputSize?: number;
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

function evidenceKey(evidence: VerifyClaimInput["evidence"]): string {
  return evidence.map((e) => `${e.id}:${e.text}`).join("\0");
}

function calculateInputSize(input: VerifyClaimInput): number {
  const claimLen = input.claim.length;
  const evidenceLen = input.evidence.reduce((sum, e) => sum + e.text.length, 0);
  return claimLen + evidenceLen;
}

export class JevVerifier implements BatchVerifier {
  private readonly client: TypeSafeClient;
  private readonly model?: string;
  private readonly maxQuestionsPerBatch: number;
  private readonly maxInputSize: number;

  constructor(options: JevVerifierOptions = {}) {
    this.client = options.client ?? new TypeSafeClient();
    this.model = options.model;
    this.maxQuestionsPerBatch = options.maxQuestionsPerBatch ?? 10;
    this.maxInputSize = options.maxInputSize ?? 100000;
  }

  async verify(input: VerifyClaimInput): Promise<Verification> {
    const [result] = await this.verifyMany([input]);
    return result;
  }

  async verifyMany(inputs: VerifyClaimInput[]): Promise<Verification[]> {
    if (inputs.length === 0) return [];

    const chunks = this.chunkInputs(inputs);
    const results: Verification[] = [];

    for (const chunk of chunks) {
      const chunkResults = await this.verifyChunk(chunk);
      results.push(...chunkResults);
    }

    return results;
  }

  private chunkInputs(inputs: VerifyClaimInput[]): VerifyClaimInput[][] {
    const chunks: VerifyClaimInput[][] = [];
    let currentChunk: VerifyClaimInput[] = [];
    let currentKey: string | null = null;
    let currentSize = 0;

    for (const input of inputs) {
      const eKey = evidenceKey(input.evidence);
      const inputSize = calculateInputSize(input);

      const exceedsCount = currentChunk.length >= this.maxQuestionsPerBatch;
      const exceedsSize = currentChunk.length > 0 && currentSize + inputSize > this.maxInputSize;
      const evidenceMismatch = currentKey !== null && currentKey !== eKey;

      if (exceedsCount || exceedsSize || evidenceMismatch) {
        if (currentChunk.length > 0) {
          chunks.push(currentChunk);
        }
        currentChunk = [input];
        currentKey = eKey;
        currentSize = inputSize;
      } else {
        currentChunk.push(input);
        currentKey = eKey;
        currentSize += inputSize;
      }
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  private async verifyChunk(chunk: VerifyClaimInput[]): Promise<Verification[]> {
    const questions: Record<string, ReturnType<typeof choice>> = {};

    chunk.forEach((item, index) => {
      const qKey = `claim_${index}`;
      questions[qKey] = choice(
        `Classify whether the claim "${item.claim}" is grounded in the supplied evidence. Judge only the evidence provided; do not rely on outside knowledge.`,
        criteria,
      );
    });

    const sharedEvidence = chunk[0].evidence;

    const response = await this.client.systemOne({
      state: {
        evidence: sharedEvidence.map(({ id, text }) => ({ id, text })),
      },
      ...(this.model ? { model: this.model } : {}),
      questions,
    });

    if (!response || typeof response !== "object" || !response.answers) {
      throw new Error("Invalid response from Jev provider: missing answers object");
    }

    const results: Verification[] = [];

    for (let index = 0; index < chunk.length; index++) {
      const input = chunk[index];
      const qKey = `claim_${index}`;
      const answer = response.answers[qKey];

      if (!answer) {
        throw new Error(
          `Missing answer for claim key '${qKey}' (claim index ${index}): "${input.claim}"`,
        );
      }

      if (typeof answer.choice !== "string") {
        throw new Error(`Missing or invalid choice in answer for claim key '${qKey}'`);
      }

      const verdict = asVerdict(answer.choice);
      const probabilities = normalizeProbabilities(answer.probabilities);

      if (
        typeof probabilities.supported !== "number" ||
        typeof probabilities.contradicted !== "number" ||
        typeof probabilities.insufficient !== "number" ||
        Number.isNaN(probabilities.supported) ||
        Number.isNaN(probabilities.contradicted) ||
        Number.isNaN(probabilities.insufficient)
      ) {
        throw new Error(`Invalid probability distribution for claim key '${qKey}'`);
      }

      const confidence =
        answer.confidence ??
        Math.max(
          probabilities.supported,
          probabilities.contradicted,
          probabilities.insufficient,
        );

      results.push({
        claim: input.claim,
        verdict,
        probabilities,
        confidence,
        evidenceIds: input.evidence.map((item) => item.id),
        provider: "jev",
        raw: answer,
      });
    }

    return results;
  }
}
