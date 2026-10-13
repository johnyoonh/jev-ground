import { randomUUID } from "node:crypto";
import { evaluatePolicy, type PolicyConfig } from "./policy.js";
import {
  hashText,
  redactSecrets,
  type DecisionTrace,
  type TraceSink,
} from "./trace.js";
import type { Verification, Verifier, VerifyClaimInput } from "./types.js";

export interface ShadowVerifierOptions {
  policy: PolicyConfig;
  provider?: string;
  model?: string;
  /** Explicit opt-in for storing raw claim and evidence text in local debug traces */
  verbose?: boolean;
  traceSink?: TraceSink;
  onTrace?: (trace: DecisionTrace) => void | Promise<void>;
  generateRequestId?: () => string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export class ShadowVerifier implements Verifier {
  private readonly traces: DecisionTrace[] = [];

  constructor(
    private readonly delegate: Verifier,
    private readonly options: ShadowVerifierOptions,
  ) {}

  /** Returns all recorded traces captured in-memory by this ShadowVerifier instance */
  getRecordedTraces(): DecisionTrace[] {
    return [...this.traces];
  }

  async verify(input: VerifyClaimInput): Promise<Verification> {
    const start = Date.now();
    const requestId = this.options.generateRequestId?.() ?? randomUUID();
    const claimHash = hashText(input.claim);
    const evidenceHashes = input.evidence.map((e) => ({
      id: e.id,
      hash: hashText(e.text),
    }));
    const allowedEvidenceIds = input.evidence.map((e) => e.id);

    let verification: Verification;
    let errorClass: string | null = null;

    try {
      verification = await this.delegate.verify(input);
    } catch (err) {
      errorClass = err instanceof Error ? err.name || "Error" : "UnknownError";
      const durationMs = Date.now() - start;
      const evaluation = evaluatePolicy(this.options.policy, {
        probabilities: { supported: 0, contradicted: 0, insufficient: 1 },
      });

      const errorTrace: DecisionTrace = redactSecrets({
        requestId,
        correlationId: this.options.correlationId,
        claimHash,
        evidenceHashes,
        allowedEvidenceIds,
        provider: this.options.provider ?? "unknown",
        model: this.options.model ?? "unknown",
        rubricVersion: this.options.policy.rubricVersion,
        policyId: this.options.policy.id,
        probabilities: { supported: 0, contradicted: 0, insufficient: 1 },
        policyDecision: evaluation.decision,
        reasons: [...evaluation.reasons, `Error during verification: ${errorClass}`],
        escalationPath: evaluation.escalationPath,
        fallbackPath: evaluation.fallbackPath,
        timestamp: new Date().toISOString(),
        durationMs,
        cacheHit: false,
        errorClass,
        metadata: this.options.metadata,
        ...(this.options.verbose
          ? {
              rawClaim: input.claim,
              rawEvidence: input.evidence.map((e) => ({ id: e.id, text: e.text })),
            }
          : {}),
      });

      this.traces.push(errorTrace);
      await this.options.traceSink?.record(errorTrace);
      await this.options.onTrace?.(errorTrace);

      throw err;
    }

    const durationMs = Date.now() - start;
    const evaluation = evaluatePolicy(this.options.policy, {
      probabilities: verification.probabilities,
      verdict: verification.verdict,
      confidence: verification.confidence,
    });

    // Extract token usage or cost if available in raw response object
    let tokenUsage: DecisionTrace["tokenUsage"] | undefined;
    let cost: DecisionTrace["cost"] | undefined;

    if (
      verification.raw &&
      typeof verification.raw === "object" &&
      verification.raw !== null
    ) {
      const rawObj = verification.raw as Record<string, unknown>;
      if (rawObj.usage && typeof rawObj.usage === "object") {
        const usage = rawObj.usage as Record<string, unknown>;
        tokenUsage = {
          promptTokens: typeof usage.promptTokens === "number" ? usage.promptTokens : undefined,
          completionTokens: typeof usage.completionTokens === "number" ? usage.completionTokens : undefined,
          totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
        };
      }
      if (typeof rawObj.cost === "number") {
        cost = { estimatedCost: rawObj.cost };
      }
    }

    const trace: DecisionTrace = redactSecrets({
      requestId,
      correlationId: this.options.correlationId,
      claimHash,
      evidenceHashes,
      allowedEvidenceIds,
      provider: verification.provider ?? this.options.provider ?? "unknown",
      model: this.options.model ?? "unknown",
      rubricVersion: this.options.policy.rubricVersion,
      policyId: this.options.policy.id,
      probabilities: verification.probabilities,
      policyDecision: evaluation.decision,
      reasons: evaluation.reasons,
      escalationPath: evaluation.escalationPath,
      fallbackPath: evaluation.fallbackPath,
      timestamp: new Date().toISOString(),
      durationMs,
      tokenUsage,
      cost,
      cacheHit: Boolean(verification.cacheHit),
      errorClass: null,
      verdict: verification.verdict,
      confidence: verification.confidence,
      metadata: this.options.metadata,
      ...(this.options.verbose
        ? {
            rawClaim: input.claim,
            rawEvidence: input.evidence.map((e) => ({ id: e.id, text: e.text })),
          }
        : {}),
    });

    this.traces.push(trace);
    await this.options.traceSink?.record(trace);
    await this.options.onTrace?.(trace);

    // Shadow mode NEVER modifies or blocks the original verifier result!
    return verification;
  }
}
